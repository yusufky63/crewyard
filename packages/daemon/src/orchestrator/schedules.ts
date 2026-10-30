import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  MAX_CATCH_UP,
  splitCommand,
  type FallbackMode,
  type ScheduleInput,
  type ScheduleOutcome,
  type ScheduleRunView,
  type ScheduleView,
  type TaskDetail,
  type TaskKind,
  type TaskSize,
  type TaskStatus,
  type TasksIpc,
  type TasksTopics,
} from "@crewyard/core";
import { runSteps } from "../worktrees/steps.ts";
import { errorCode, OrchestratorError } from "./errors.ts";
import { nextSlot, slotsBetween, validTimeZone, type SlotRule } from "./schedule-time.ts";

// Scheduled tasks (orca cli/automations.mdx and agent-orchestrator lifecycle-automation.mdx gave
// the idea; the rules are ours). A template proposes a task on a daily or weekly slot. The timer is
// the daemon's own: nothing runs while Crewyard is closed, and no OS scheduler is registered.
//
//  - New schedules are disabled; enabling one starts counting slots from that moment.
//  - An optional precheck runs first in the project folder. Exit code 0 lets the run go on;
//    anything else, an error or a timeout records `skipped_precheck`, and no agent runs.
//  - A schedule never overlaps its own previous run: while that task is still active (proposed,
//    queued, running, waiting on you) its due slots wait.
//  - After sleep or a restart at most MAX_CATCH_UP missed slots are caught up, one at a time;
//    older ones are recorded as `skipped_missed` with their count.
//  - Every run goes through crew approval like any task, unless the template says "auto-approve
//    this crew"; that is audited, and caps and Inbox approvals still apply.

const ACTIVE: TaskStatus[] = ["proposed", "queued", "running", "needs_input", "limited", "handing_off"];
const KINDS: TaskKind[] = ["code", "research", "review", "docs"];
const SIZES: TaskSize[] = ["S", "M", "L"];
const FALLBACKS: FallbackMode[] = ["manual", "ask", "auto", "wait_for_reset"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_RUNS_SHOWN = 200;

interface ScheduleRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  kind: TaskKind | null;
  size: TaskSize | null;
  fallback: FallbackMode | null;
  budget_usd: number | null;
  best_of: number | null;
  cadence: "daily" | "weekly";
  time: string;
  weekday: number | null;
  time_zone: string;
  precheck: string | null;
  precheck_timeout_sec: number;
  auto_approve: number;
  enabled: number;
  cursor_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  schedule_id: string;
  slot_at: string | null;
  started_at: string;
  finished_at: string | null;
  outcome: ScheduleOutcome;
  precheck_exit: number | null;
  precheck_tail: string | null;
  task_id: string | null;
  count: number;
  detail: string | null;
  manual: number;
}

export interface ScheduleHost {
  db: DatabaseSync;
  now(): Date;
  emit<K extends keyof TasksTopics>(topic: K, payload: TasksTopics[K]): void;
  propose(p: TasksIpc["tasks.propose"]["params"]): Promise<TaskDetail>;
  approve(p: { taskId: string }): Promise<TaskDetail>;
  status(taskId: string): TaskStatus | null;
  projectPath(projectId: string): string;
  audit(projectId: string, taskId: string | null, kind: string, payload: unknown): void;
  track(p: Promise<unknown>): void;
}

const rule = (s: ScheduleRow): SlotRule => ({ cadence: s.cadence, time: s.time, weekday: s.weekday, timeZone: s.time_zone });

const bad = (field: string): never => {
  throw new OrchestratorError("schedule.invalid", { field });
};

/** The template as stored, checked field by field; `schedule.invalid` names the first bad one. */
export function validateSchedule(p: ScheduleInput): Omit<ScheduleRow, "id" | "enabled" | "cursor_at" | "created_at" | "updated_at"> {
  const title = typeof p.title === "string" ? p.title.trim() : "";
  if (title.length === 0 || title.length > 200) bad("title");
  if (typeof p.description !== "string" || p.description.length > 20_000) bad("description");
  if (p.kind !== undefined && !KINDS.includes(p.kind)) bad("kind");
  if (p.size !== undefined && !SIZES.includes(p.size)) bad("size");
  if (p.fallback !== undefined && !FALLBACKS.includes(p.fallback)) bad("fallback");
  if (p.budgetUsd != null && !(typeof p.budgetUsd === "number" && Number.isFinite(p.budgetUsd) && p.budgetUsd >= 0)) bad("budgetUsd");
  if (p.bestOf != null && !(Number.isInteger(p.bestOf) && p.bestOf >= 2 && p.bestOf <= 4)) bad("bestOf");
  if (p.cadence !== "daily" && p.cadence !== "weekly") bad("cadence");
  if (typeof p.time !== "string" || !HHMM.test(p.time)) bad("time");
  const weekday = p.cadence === "weekly" ? p.weekday : null;
  if (p.cadence === "weekly" && !(Number.isInteger(weekday) && weekday! >= 0 && weekday! <= 6)) bad("weekday");
  if (!validTimeZone(p.timeZone)) bad("timeZone");
  const precheck = typeof p.precheck === "string" && p.precheck.trim() ? p.precheck.trim() : null;
  // The same rules as a setup step: one program with plain arguments, no shell syntax.
  if (precheck !== null && (precheck.length > 2_000 || "problem" in splitCommand(precheck))) bad("precheck");
  const timeout = p.precheckTimeoutSec ?? 60;
  if (!(Number.isInteger(timeout) && timeout >= 5 && timeout <= 600)) bad("precheckTimeoutSec");
  if (p.autoApprove !== undefined && typeof p.autoApprove !== "boolean") bad("autoApprove");
  return {
    project_id: p.projectId,
    title,
    description: p.description,
    kind: p.kind ?? null,
    size: p.size ?? null,
    fallback: p.fallback ?? null,
    budget_usd: p.budgetUsd ?? null,
    best_of: p.bestOf ?? null,
    cadence: p.cadence,
    time: p.time,
    weekday: weekday ?? null,
    time_zone: p.timeZone,
    precheck,
    precheck_timeout_sec: timeout,
    auto_approve: p.autoApprove ? 1 : 0,
  };
}

export class Scheduler {
  /** Schedules whose precheck or proposal is in flight; their next slot waits. */
  private readonly busy = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly host: ScheduleHost) {}

  private one<T>(sql: string, ...args: Array<string | number | null>): T | undefined {
    return this.host.db.prepare(sql).get(...args) as T | undefined;
  }

  private all<T>(sql: string, ...args: Array<string | number | null>): T[] {
    return this.host.db.prepare(sql).all(...args) as unknown as T[];
  }

  private exec(sql: string, ...args: Array<string | number | null>): void {
    this.host.db.prepare(sql).run(...args);
  }

  private iso(): string {
    return this.host.now().toISOString();
  }

  /** Daemon start: a precheck the last daemon left running never finished; then the timer. */
  start(intervalMs: number): void {
    const open = this.all<RunRow>("select * from schedule_runs where outcome = 'running_precheck' and finished_at is null");
    for (const r of open) this.finish(r.id, { outcome: "failed", detail: "precheck.interrupted" });
    if (intervalMs > 0) this.timer = setInterval(() => void this.check(), intervalMs).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private row(id: string): ScheduleRow {
    const s = this.one<ScheduleRow>("select * from schedules where id = ?", id);
    if (!s) throw new OrchestratorError("schedule.not_found", { scheduleId: id });
    return s;
  }

  list(projectId?: string): ScheduleView[] {
    const rows = projectId ? this.all<ScheduleRow>("select * from schedules where project_id = ? order by created_at, id", projectId) : this.all<ScheduleRow>("select * from schedules order by created_at, id");
    return rows.map((r) => this.view(r));
  }

  get(id: string): ScheduleView {
    return this.view(this.row(id));
  }

  save(p: ScheduleInput & { id?: string }): ScheduleView {
    const v = validateSchedule(p);
    if (!this.one("select 1 as x from projects where id = ?", v.project_id)) throw new OrchestratorError("project.not_found", { projectId: v.project_id });
    const at = this.iso();
    const cols = ["project_id", "title", "description", "kind", "size", "fallback", "budget_usd", "best_of", "cadence", "time", "weekday", "time_zone", "precheck", "precheck_timeout_sec", "auto_approve"] as const;
    const values = cols.map((c) => v[c]);
    let id = p.id;
    if (id) {
      const cur = this.row(id);
      if (cur.project_id !== v.project_id) bad("projectId");
      this.exec(`update schedules set ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? where id = ?`, ...values, at, id);
    } else {
      id = randomUUID();
      // Created disabled: switching it on is your click.
      this.exec(`insert into schedules (id, ${cols.join(", ")}, enabled, created_at, updated_at) values (?, ${cols.map(() => "?").join(", ")}, 0, ?, ?)`, id, ...values, at, at);
    }
    this.host.audit(v.project_id, null, "schedule.saved", { scheduleId: id, cadence: v.cadence, time: v.time, weekday: v.weekday, timeZone: v.time_zone, precheck: v.precheck !== null, autoApprove: v.auto_approve === 1 });
    this.changed(id, v.project_id);
    return this.get(id);
  }

  setEnabled(id: string, enabled: boolean): ScheduleView {
    const s = this.row(id);
    if ((s.enabled === 1) !== enabled) {
      // Slots count from the moment it is switched on; nothing from before is caught up.
      this.exec("update schedules set enabled = ?, cursor_at = ?, updated_at = ? where id = ?", enabled ? 1 : 0, enabled ? this.iso() : s.cursor_at, this.iso(), id);
      this.host.audit(s.project_id, null, enabled ? "schedule.enabled" : "schedule.disabled", { scheduleId: id, autoApprove: s.auto_approve === 1 });
      this.changed(id, s.project_id);
    }
    return this.get(id);
  }

  delete(id: string): { id: string } {
    const s = this.row(id);
    this.exec("delete from schedule_runs where schedule_id = ?", id);
    this.exec("delete from schedules where id = ?", id);
    this.host.audit(s.project_id, null, "schedule.deleted", { scheduleId: id });
    this.changed(id, s.project_id);
    return { id };
  }

  runs(id: string, limit = 50): ScheduleRunView[] {
    this.row(id);
    return this.all<RunRow>("select * from schedule_runs where schedule_id = ? order by started_at desc, rowid desc limit ?", id, Math.max(1, Math.min(MAX_RUNS_SHOWN, limit))).map(runView);
  }

  /** The schedule a task came from, for its row in the task list. */
  taskOrigin(taskId: string): { scheduleId: string; title: string; autoApproved: boolean } | null {
    const r = this.one<{ id: string; title: string; outcome: ScheduleOutcome }>("select s.id, s.title, r.outcome from schedule_runs r join schedules s on s.id = r.schedule_id where r.task_id = ?", taskId);
    return r ? { scheduleId: r.id, title: r.title, autoApproved: r.outcome === "approved" } : null;
  }

  /** You asked for it now: no precheck, but never on top of its own previous run. */
  async runNow(id: string): Promise<ScheduleRunView> {
    const s = this.row(id);
    if (this.busy.has(id) || this.previousActive(id)) throw new OrchestratorError("schedule.busy");
    const runId = this.begin(s, null, true);
    this.busy.add(id);
    try {
      await this.propose(s, runId);
    } finally {
      this.busy.delete(id);
    }
    return runView(this.one<RunRow>("select * from schedule_runs where id = ?", runId)!);
  }

  /**
   * One pass of the timer. Each enabled schedule takes at most one due slot per pass; the rest
   * stay pending for the next pass, so caught-up runs go one after another, never together.
   */
  async check(): Promise<void> {
    const now = this.host.now();
    for (const s of this.all<ScheduleRow>("select * from schedules where enabled = 1 order by created_at, id")) {
      try {
        await this.checkOne(s, now);
      } catch (err) {
        this.host.audit(s.project_id, null, "schedule.error", { scheduleId: s.id, code: errorCode(err) });
      }
    }
  }

  private async checkOne(s: ScheduleRow, now: Date): Promise<void> {
    if (this.busy.has(s.id)) return;
    let due = slotsBetween(rule(s), new Date(s.cursor_at ?? s.updated_at), now);
    if (due.length === 0) return;
    if (due.length > MAX_CATCH_UP) {
      const dropped = due.slice(0, due.length - MAX_CATCH_UP);
      const last = dropped.at(-1)!;
      const at = this.iso();
      this.exec(
        "insert into schedule_runs (id, schedule_id, slot_at, started_at, finished_at, outcome, count) values (?, ?, ?, ?, ?, 'skipped_missed', ?)",
        randomUUID(),
        s.id,
        last.toISOString(),
        at,
        at,
        dropped.length,
      );
      this.exec("update schedules set cursor_at = ? where id = ?", last.toISOString(), s.id);
      this.host.audit(s.project_id, null, "schedule.missed", { scheduleId: s.id, count: dropped.length });
      due = due.slice(-MAX_CATCH_UP);
      this.changed(s.id, s.project_id);
    }
    // No overlap: the slot waits until the previous run is no longer active.
    if (this.previousActive(s.id)) return;
    const slot = due[0]!;
    this.exec("update schedules set cursor_at = ? where id = ?", slot.toISOString(), s.id);
    const runId = this.begin(s, slot, false);
    this.busy.add(s.id);
    try {
      if (s.precheck && !(await this.precheck(s, runId))) return;
      await this.propose(s, runId);
    } finally {
      this.busy.delete(s.id);
    }
  }

  private begin(s: ScheduleRow, slot: Date | null, manual: boolean): string {
    const id = randomUUID();
    const outcome: ScheduleOutcome = s.precheck && !manual ? "running_precheck" : "proposed";
    this.exec("insert into schedule_runs (id, schedule_id, slot_at, started_at, outcome, manual) values (?, ?, ?, ?, ?, ?)", id, s.id, slot?.toISOString() ?? null, this.iso(), outcome, manual ? 1 : 0);
    this.changed(s.id, s.project_id);
    return id;
  }

  /** Runs the precheck; false when it skipped the run (recorded, free: no agent started). */
  private async precheck(s: ScheduleRow, runId: string): Promise<boolean> {
    const res = await runSteps([{ command: s.precheck!, timeoutSec: s.precheck_timeout_sec }], this.host.projectPath(s.project_id), process.env).catch((err: unknown) => ({
      ok: false,
      failure: { command: s.precheck!, code: null, timedOut: false, tail: err instanceof Error ? err.message.slice(0, 400) : "precheck.error" },
    }));
    if (res.ok) {
      this.exec("update schedule_runs set precheck_exit = 0 where id = ?", runId);
      return true;
    }
    const f = res.failure!;
    this.finish(runId, { outcome: "skipped_precheck", precheckExit: f.code, precheckTail: f.tail, detail: f.timedOut ? "precheck.timeout" : f.code === null ? "precheck.error" : null });
    this.host.audit(s.project_id, null, "schedule.skipped_precheck", { scheduleId: s.id, runId, exitCode: f.code, timedOut: f.timedOut });
    return false;
  }

  private async propose(s: ScheduleRow, runId: string): Promise<void> {
    let task: TaskDetail;
    try {
      task = await this.host.propose({
        projectId: s.project_id,
        title: s.title,
        description: s.description,
        ...(s.kind ? { kind: s.kind } : {}),
        ...(s.size ? { size: s.size } : {}),
        ...(s.fallback ? { fallback: s.fallback } : {}),
        ...(s.budget_usd !== null ? { budgetUsd: s.budget_usd } : {}),
        ...(s.best_of !== null ? { bestOf: s.best_of } : {}),
      });
    } catch (err) {
      this.finish(runId, { outcome: "failed", detail: errorCode(err) });
      return;
    }
    this.exec("update schedule_runs set task_id = ? where id = ?", task.id, runId);
    if (s.auto_approve !== 1) {
      this.finish(runId, { outcome: "proposed" });
      return;
    }
    try {
      await this.host.approve({ taskId: task.id });
      // D8: Auto is opt-in per template and still leaves an audit record.
      this.host.audit(s.project_id, task.id, "schedule.auto_approved", { scheduleId: s.id, runId });
      this.finish(runId, { outcome: "approved" });
    } catch (err) {
      // The crew needs an edit (no profile, independence): the task waits for you like any proposal.
      this.finish(runId, { outcome: "proposed", detail: errorCode(err) });
    }
  }

  private finish(runId: string, r: { outcome: ScheduleOutcome; precheckExit?: number | null; precheckTail?: string | null; detail?: string | null }): void {
    this.exec(
      "update schedule_runs set finished_at = ?, outcome = ?, precheck_exit = coalesce(?, precheck_exit), precheck_tail = coalesce(?, precheck_tail), detail = ? where id = ?",
      this.iso(),
      r.outcome,
      r.precheckExit ?? null,
      r.precheckTail ?? null,
      r.detail ?? null,
      runId,
    );
    const s = this.one<{ schedule_id: string; project_id: string }>("select r.schedule_id, s.project_id from schedule_runs r join schedules s on s.id = r.schedule_id where r.id = ?", runId);
    if (s) this.changed(s.schedule_id, s.project_id);
  }

  /** The schedule's last task is still active, or its precheck still runs. */
  private previousActive(scheduleId: string): boolean {
    const last = this.one<RunRow>("select * from schedule_runs where schedule_id = ? and outcome <> 'skipped_missed' order by started_at desc, rowid desc limit 1", scheduleId);
    if (!last) return false;
    if (last.finished_at === null) return true;
    if (!last.task_id) return false;
    const status = this.host.status(last.task_id);
    return status !== null && ACTIVE.includes(status);
  }

  private view(s: ScheduleRow): ScheduleView {
    const now = this.host.now();
    const last = this.one<RunRow>("select * from schedule_runs where schedule_id = ? order by started_at desc, rowid desc limit 1", s.id);
    const enabled = s.enabled === 1;
    return {
      id: s.id,
      projectId: s.project_id,
      title: s.title,
      description: s.description,
      kind: s.kind ?? "code",
      size: s.size ?? "M",
      fallback: s.fallback ?? "manual",
      budgetUsd: s.budget_usd,
      bestOf: s.best_of,
      cadence: s.cadence,
      time: s.time,
      weekday: s.weekday,
      timeZone: s.time_zone,
      precheck: s.precheck,
      precheckTimeoutSec: s.precheck_timeout_sec,
      autoApprove: s.auto_approve === 1,
      enabled,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      nextAt: enabled ? nextSlot(rule(s), now).toISOString() : null,
      pending: enabled ? Math.min(MAX_CATCH_UP, slotsBetween(rule(s), new Date(s.cursor_at ?? s.updated_at), now).length) : 0,
      lastRun: last ? runView(last) : null,
    };
  }

  private changed(scheduleId: string, projectId: string): void {
    this.host.emit("schedules.changed", { scheduleId, projectId });
  }
}

const runView = (r: RunRow): ScheduleRunView => ({
  id: r.id,
  scheduleId: r.schedule_id,
  slotAt: r.slot_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  outcome: r.outcome,
  precheckExit: r.precheck_exit,
  precheckTail: r.precheck_tail,
  taskId: r.task_id,
  count: r.count,
  detail: r.detail,
  manual: r.manual === 1,
});
