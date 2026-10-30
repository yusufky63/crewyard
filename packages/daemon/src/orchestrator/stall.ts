import { randomUUID } from "node:crypto";
import type { StallAlertView, StallNoticePayload, StallRule, StallSettings, TasksTopics } from "@crewyard/core";
import type { Store } from "../store.ts";
import { readStalls, STALLS_KEY } from "../settings/values.ts";
import type { OrchestratorDb, RunRow } from "./db.ts";
import { OrchestratorError } from "./errors.ts";
import { classifyFailure } from "./failures.ts";

// Stall rules (feature scan A7; the idea of rules with a cooldown is Agent Monitor's
// `server/lib/alerts.js`, the code is ours). §7.3 covers limits only, so a hung run, a step that
// keeps failing the same way, or a question nobody saw could sit unnoticed overnight. Each rule
// fires a `stall.notice` (shaped like a limit notice) and a persisted Inbox item, then stays quiet
// for the cooldown. An item closes on its own once its condition is gone. Nothing here stops,
// retries or answers anything: what to do stays your call.

interface AlertRow {
  id: string;
  rule: StallRule;
  subject: string;
  project_id: string;
  task_id: string;
  run_id: string | null;
  request_id: string | null;
  minutes: number | null;
  count: number | null;
  detail: string | null;
  created_at: string;
  dismissed_at: string | null;
  cleared_at: string | null;
}

export interface StallHost {
  store: Store;
  db: OrchestratorDb;
  now(): Date;
  /** Whether a turn is running in the run's live process right now. */
  inTurn(runId: string): boolean;
  emit<K extends keyof TasksTopics>(topic: K, payload: TasksTopics[K]): void;
}

const minutesBetween = (from: string, to: Date) => Math.floor((to.getTime() - Date.parse(from)) / 60_000);

/** Two failures are "the same" by class and status; unreadable ones by their text without numbers (ids, times). */
export function failureKey(detail: string | null): { key: string; label: string } {
  const f = classifyFailure(detail);
  if (f.kind !== "other" || f.status !== null) return { key: `${f.kind}:${f.status ?? ""}`, label: f.status === null ? f.kind : `${f.kind} ${f.status}` };
  const text = (detail ?? "").replace(/[0-9a-f]{8,}|\d+/gi, "#").replace(/\s+/g, " ").trim().slice(0, 160);
  return { key: `other:${text}`, label: "other" };
}

export class StallMonitor {
  constructor(private readonly host: StallHost) {}

  settings(): StallSettings {
    const row = this.host.store.db.prepare("select value from settings where key = ?").get(STALLS_KEY) as { value: string } | undefined;
    return readStalls(row?.value);
  }

  /** One pass over every rule; cheap enough for the scheduler's tick (a few indexed queries). */
  check(): void {
    const s = this.settings();
    const now = this.host.now();
    this.clearResolved(now);
    if (s.noEventsMinutes > 0) this.noEvents(s, now);
    if (s.requestMinutes > 0) this.unanswered(s, now);
    if (s.sameFailureCount > 0) this.repeatedFailures(s, now);
  }

  list(filter: { projectId?: string; taskId?: string; includeClosed?: boolean }): StallAlertView[] {
    const where = ["1 = 1"];
    const args: string[] = [];
    if (!filter.includeClosed) where.push("dismissed_at is null and cleared_at is null");
    if (filter.projectId) {
      where.push("project_id = ?");
      args.push(filter.projectId);
    }
    if (filter.taskId) {
      where.push("task_id = ?");
      args.push(filter.taskId);
    }
    const rows = this.host.store.db.prepare(`select * from stall_alerts where ${where.join(" and ")} order by created_at desc, id`).all(...args) as unknown as AlertRow[];
    return rows.map(view);
  }

  dismiss(alertId: string): StallAlertView {
    const row = this.row(alertId);
    if (!row.dismissed_at) {
      this.host.store.db.prepare("update stall_alerts set dismissed_at = ? where id = ?").run(this.host.now().toISOString(), alertId);
      this.changed(row, false);
    }
    return view(this.row(alertId));
  }

  /** A running turn that has said nothing for N minutes. Waiting on you is the request rule's job. */
  private noEvents(s: StallSettings, now: Date): void {
    for (const r of this.host.db.openRuns()) {
      if (r.paused_at || r.limit_reached || !this.host.inTurn(r.id)) continue;
      if (this.host.db.openRequestsForRun(r.id).length > 0) continue;
      const quiet = minutesBetween(r.last_activity_at ?? r.started_at, now);
      if (quiet >= s.noEventsMinutes) this.fire(s, now, "no_events", r.id, r, { runId: r.id, minutes: quiet });
    }
  }

  private unanswered(s: StallSettings, now: Date): void {
    const open = this.host.store.db.prepare("select id, task_id, run_id, created_at from requests where answered_at is null").all() as Array<{ id: string; task_id: string; run_id: string | null; created_at: string }>;
    for (const q of open) {
      const waited = minutesBetween(q.created_at, now);
      if (waited < s.requestMinutes) continue;
      this.fire(s, now, "request_unanswered", q.id, { task_id: q.task_id }, { runId: q.run_id, requestId: q.id, minutes: waited });
    }
  }

  /** The newest runs of a step, back to the first that did not fail, all with one failure. */
  private repeatedFailures(s: StallSettings, now: Date): void {
    const failed = this.host.store.db
      .prepare("select distinct r.member_id from runs r join tasks t on t.id = r.task_id where r.end_reason = 'failed' and t.cancelled_at is null")
      .all() as Array<{ member_id: string }>;
    for (const { member_id } of failed) {
      const runs = this.host.store.db.prepare("select * from runs where member_id = ? order by started_at desc, rowid desc limit ?").all(member_id, s.sameFailureCount + 1) as unknown as RunRow[];
      const newest = runs[0];
      if (!newest || newest.end_reason !== "failed") continue;
      // Old history is not news: only a step that failed in the last day raises an item.
      if (!newest.ended_at || minutesBetween(newest.ended_at, now) > 24 * 60) continue;
      const { key, label } = failureKey(newest.end_detail);
      let count = 0;
      for (const r of runs) {
        if (r.end_reason !== "failed" || failureKey(r.end_detail).key !== key) break;
        count++;
      }
      if (count >= s.sameFailureCount) this.fire(s, now, "same_failure", `${member_id}|${key}`, newest, { runId: newest.id, count, detail: label });
    }
  }

  private fire(s: StallSettings, now: Date, rule: StallRule, subject: string, about: { task_id: string }, facts: { runId?: string | null; requestId?: string | null; minutes?: number; count?: number; detail?: string }): void {
    const db = this.host.store.db;
    const last = db.prepare("select * from stall_alerts where rule = ? and subject = ? order by created_at desc limit 1").get(rule, subject) as AlertRow | undefined;
    // One open item per condition; after it closes, the cooldown keeps it from coming straight back.
    if (last && !last.dismissed_at && !last.cleared_at) return;
    if (last && minutesBetween(last.created_at, now) < s.cooldownMinutes) return;
    const task = this.host.db.task(about.task_id);
    const row: AlertRow = {
      id: randomUUID(),
      rule,
      subject,
      project_id: task.project_id,
      task_id: task.id,
      run_id: facts.runId ?? null,
      request_id: facts.requestId ?? null,
      minutes: facts.minutes ?? null,
      count: facts.count ?? null,
      detail: facts.detail ?? null,
      created_at: now.toISOString(),
      dismissed_at: null,
      cleared_at: null,
    };
    db.prepare(
      "insert into stall_alerts (id, rule, subject, project_id, task_id, run_id, request_id, minutes, count, detail, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(row.id, row.rule, row.subject, row.project_id, row.task_id, row.run_id, row.request_id, row.minutes, row.count, row.detail, row.created_at);
    this.host.store.appendEvent({ kind: "stall.alert", source: "orchestrator", payload: { rule, minutes: row.minutes, count: row.count, detail: row.detail }, projectId: row.project_id, taskId: row.task_id, runId: row.run_id });
    this.host.emit("stall.notice", notice(row));
    this.changed(row, true);
  }

  /** Closes open items whose condition went away: the run spoke or ended, the request was answered, the step moved on. */
  private clearResolved(now: Date): void {
    const db = this.host.store.db;
    const open = db.prepare("select * from stall_alerts where dismissed_at is null and cleared_at is null").all() as unknown as AlertRow[];
    for (const a of open) {
      if (!this.stillHolds(a)) {
        db.prepare("update stall_alerts set cleared_at = ? where id = ?").run(now.toISOString(), a.id);
        this.changed(a, false);
      }
    }
  }

  private stillHolds(a: AlertRow): boolean {
    const db = this.host.store.db;
    if (this.host.db.task(a.task_id).cancelled_at) return false;
    if (a.rule === "request_unanswered") return (db.prepare("select answered_at from requests where id = ?").get(a.request_id) as { answered_at: string | null } | undefined)?.answered_at === null;
    if (!a.run_id) return false;
    const run = db.prepare("select * from runs where id = ?").get(a.run_id) as RunRow | undefined;
    if (!run) return false;
    if (a.rule === "no_events") return !run.ended_at && !run.paused_at && (run.last_activity_at ?? run.started_at) <= a.created_at && this.host.inTurn(run.id);
    // same_failure: holds until another run of the step starts.
    const newer = db.prepare("select count(*) as n from runs where member_id = ? and started_at > ?").get(run.member_id, run.started_at) as { n: number };
    return Number(newer.n) === 0;
  }

  private changed(a: AlertRow, open: boolean): void {
    this.host.emit("stalls.changed", { alertId: a.id, taskId: a.task_id, projectId: a.project_id, open });
  }

  private row(id: string): AlertRow {
    const row = this.host.store.db.prepare("select * from stall_alerts where id = ?").get(id) as AlertRow | undefined;
    if (!row) throw new OrchestratorError("stall.not_found", { alertId: id });
    return row;
  }
}

function notice(a: AlertRow): StallNoticePayload {
  return { alertId: a.id, rule: a.rule, projectId: a.project_id, taskId: a.task_id, runId: a.run_id, requestId: a.request_id, minutes: a.minutes, count: a.count, detail: a.detail, observedAt: a.created_at };
}

function view(a: AlertRow): StallAlertView {
  return { ...notice(a), dismissedAt: a.dismissed_at, clearedAt: a.cleared_at };
}
