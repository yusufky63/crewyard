import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { freemem } from "node:os";
import { join, resolve } from "node:path";
import {
  classifyRisk,
  defaultProjectConfig,
  estimateCost,
  ProjectConfig,
  type AgentAdapter,
  type AgentEvent,
  type Answer,
  type CandidateView,
  type CrewEdit,
  type EndReason,
  type FallbackMode,
  type HandoffPhase,
  type HandoffTrigger,
  type LimitWindow,
  type NativeSessionRef,
  type Provenance,
  type Reason,
  type RequestAnswer,
  type RequestPayload,
  type RequestView,
  type RoleId,
  type RolePolicy,
  type RunHandle,
  type RunnerId,
  type RunView,
  type StartRequest,
  type TaskChangeCause,
  type TaskDetail,
  type TaskSize,
  type TaskSummary,
  type TasksIpc,
  type TasksTopics,
} from "@crewyard/core";
import type { Store } from "../store.ts";
import { admit, DEFAULT_LIMITS, type AdmissionLimits } from "./admission.ts";
import { AdapterRegistry } from "./adapters.ts";
import { classifyTask } from "./classify.ts";
import { eligible, MIN_HEADROOM, modelKey, proposeCrew, rankForRole, sameModel, scoreCandidate, sumEstimates, type ScoringContext } from "./crew.ts";
import { OrchestratorDb, type MemberRow, type ProjectRow, type RequestRow, type RunRow, type TaskRow, type WorktreeRow } from "./db.ts";
import { EMPTY_DIRECTORY, type Candidate, type ProfileDirectory } from "./directory.ts";
import { errorCode, OrchestratorError } from "./errors.ts";
import { checkpoint, defaultWorktreeRoot, diffStat, ensureWorktree, headSha, taskSlug, writeFileAtomic } from "./git.ts";
import { LimitMonitor } from "./limits.ts";
import { handoffPackage, rolePrompt } from "./prompts.ts";
import { onlyDocPaths, ROLES } from "./roles.ts";

// The deterministic scheduler (PLAN.md D7, D8, §8, §9): it runs the crew you approved as a DAG,
// under admission control, and never lets an agent start another agent. All state lives in the
// store as facts; this class only holds live process handles, timers and the admission notes.

export interface OrchestratorOptions {
  store: Store;
  dataDir: string;
  emit(topic: string, payload: unknown): void;
  adapters?: AdapterRegistry;
  directory?: ProfileDirectory;
  now?: () => Date;
  freeMemoryMb?: () => number;
  limits?: Partial<Omit<AdmissionLimits, "projectSlots">>;
  /** Re-check interval for queued steps (memory frees up, a slot opens). 0 disables the timer. */
  tickMs?: number;
  gitBin?: string;
  /** Whether a recorded pid still runs; used only to label recovered runs. */
  isAlive?: (pid: number) => boolean;
  /** How long to wait for a run to reach a turn boundary before stopping it. */
  stopTimeoutMs?: number;
}

interface Live {
  adapter: AgentAdapter;
  handle: RunHandle;
  candidate: Candidate;
  done: Promise<void>;
}

type ProposeParams = TasksIpc["tasks.propose"]["params"];
type Ended = { reason: EndReason; detail: string | null };
type HandoffInfo = { trigger: HandoffTrigger; window: LimitWindow | null; resetsAt: string | null };

/** How many handoffs one crew step may take on its own before it asks you (the standby chain is 2 long). */
const MAX_AUTO_HANDOFFS = 2;

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sameDir = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

export class Orchestrator {
  readonly db: OrchestratorDb;
  readonly limits: LimitMonitor;
  private directory: ProfileDirectory;
  private readonly adapters: AdapterRegistry;
  private readonly now: () => Date;
  private readonly live = new Map<string, Live>();
  /** Why a ready step is still queued; shown as `blockedBy`, not stored (it changes every tick). */
  private readonly blocked = new Map<string, Reason>();
  private readonly stopping = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Target run -> handoff it must confirm before the handoff record flips. */
  private readonly confirming = new Map<string, string>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly creating = new Map<string, Promise<WorktreeRow>>();
  private ticking = false;
  private tickAgain = false;
  private closed = false;
  private interval: NodeJS.Timeout | null = null;

  constructor(private readonly opts: OrchestratorOptions) {
    this.db = new OrchestratorDb(opts.store.db);
    this.adapters = opts.adapters ?? new AdapterRegistry();
    this.directory = opts.directory ?? EMPTY_DIRECTORY;
    this.now = opts.now ?? (() => new Date());
    this.limits = new LimitMonitor(this.db, (n) => this.emit("limits.notice", n), this.now);
  }

  /** Recovers from the last session, then starts scheduling. */
  start(): void {
    this.recover();
    const ms = this.opts.tickMs ?? 5_000;
    if (ms > 0) this.interval = setInterval(() => void this.tick(), ms).unref();
    void this.tick();
  }

  /**
   * Daemon exit: stops every agent process tree (the daemon owns them, nothing may linger) but
   * leaves the facts alone, so the next start() marks those runs interrupted and offers resume.
   */
  shutdown(): void {
    this.closed = true;
    if (this.interval) clearInterval(this.interval);
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    const live = [...this.live.values()];
    this.live.clear();
    for (const l of live) this.track(this.safe(() => l.adapter.stop(l.handle)));
  }

  /** Called by the providers work once profiles and the catalog are available. */
  setDirectory(directory: ProfileDirectory): void {
    this.directory = directory;
    void this.tick();
  }

  /** Waits until background work (pumps, handoffs, ticks) has settled; for tests and shutdown. */
  async settle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  // ---------------------------------------------------------------- tasks

  list(projectId?: string): TaskSummary[] {
    return this.db.tasks(projectId).map((t) => this.db.summary(t));
  }

  get(taskId: string): TaskDetail {
    return this.db.detail(this.db.task(taskId), this.blocked);
  }

  /** Classifies the task and stores a draft crew. No process, worktree or network call. */
  async propose(p: ProposeParams): Promise<TaskDetail> {
    const project = this.db.project(p.projectId);
    const { config, fromFile } = this.config(project);
    const description = p.description ?? "";
    const cls = classifyTask(p.title, description, { kind: p.kind, size: p.size });
    const budgetUsd = p.budgetUsd ?? (fromFile ? config.budget.perTaskUsd : null);
    const candidates = await this.candidates(project);
    const ctx = this.scoring(project.id, cls.size, budgetUsd, p.pins, p.exclude);
    const crew = proposeCrew(cls.kind, cls.security, candidates, ctx);
    const taskId = randomUUID();
    const crewId = randomUUID();
    const at = this.iso();
    this.db.tx(() => {
      this.db.exec(
        `insert into tasks (id, project_id, title, description, kind, size, base_branch, fallback, wait_reset_minutes, budget_usd, classification, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        taskId,
        project.id,
        p.title,
        description,
        cls.kind,
        cls.size,
        p.baseBranch ?? null,
        p.fallback ?? config.rules.fallback,
        p.waitResetMinutes ?? 20,
        budgetUsd,
        JSON.stringify(cls.reasons),
        at,
      );
      this.db.exec("insert into crews (id, task_id, proposed_at, estimate_usd, estimate_provenance) values (?, ?, ?, ?, ?)", crewId, taskId, at, crew.estimate.usd, crew.estimate.provenance);
      crew.members.forEach((m, i) =>
        this.db.exec(
          `insert into crew_members (id, crew_id, position, step, role, depends_on, required, writes_code, chosen, standby, reasons)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          randomUUID(),
          crewId,
          i,
          m.step,
          m.role,
          JSON.stringify(m.dependsOn),
          m.required ? 1 : 0,
          m.writesCode ? 1 : 0,
          m.chosen ? JSON.stringify(m.chosen) : null,
          JSON.stringify(m.standby),
          JSON.stringify(m.reasons),
        ),
      );
    });
    this.audit(taskId, null, "task.proposed", { kind: cls.kind, size: cls.size, members: crew.members.map((m) => ({ role: m.role, profileId: m.chosen?.profileId ?? null })) });
    this.emitTask(taskId, "proposed");
    return this.get(taskId);
  }

  /** Approves the crew, with optional edits, then lets the scheduler start ready steps. */
  async approve(p: { taskId: string; edits?: CrewEdit[]; fallback?: FallbackMode }): Promise<TaskDetail> {
    const task = this.db.task(p.taskId);
    if (task.cancelled_at) throw new OrchestratorError("task.cancelled");
    const crew = this.db.crew(task.id);
    if (!crew || crew.approved_at) throw new OrchestratorError("task.not_proposed");
    const project = this.db.project(task.project_id);
    const members = this.db.members(crew.id);
    const views = new Map(members.map((m) => [m.id, m.chosen ? (JSON.parse(m.chosen) as CandidateView) : null]));

    if (p.edits?.length) {
      const candidates = await this.candidates(project);
      const ctx = this.scoring(project.id, task.size, task.budget_usd);
      for (const edit of p.edits) {
        const m = members.find((x) => x.id === edit.memberId);
        if (!m) throw new OrchestratorError("crew.member_not_found", { memberId: edit.memberId });
        const c = candidates.find((x) => x.profile.id === edit.profileId);
        if (!c || !eligible(c, m.role, ctx)) throw new OrchestratorError("crew.unknown_profile", { profileId: edit.profileId });
        const v = scoreCandidate(c, m.role, ctx);
        if (edit.model) v.model = edit.model;
        views.set(m.id, v);
      }
    }

    for (const m of members) {
      const v = views.get(m.id);
      if (!v) throw new OrchestratorError("crew.missing_profile", { role: m.role });
      for (const other of ROLES[m.role].independentOf) {
        const o = members.find((x) => x.role === other);
        const ov = o ? views.get(o.id) : null;
        if (ov && sameModel(v, ov)) throw new OrchestratorError("crew.independence", { role: m.role });
      }
    }

    this.db.tx(() => {
      for (const edit of p.edits ?? []) {
        const m = members.find((x) => x.id === edit.memberId)!;
        const v = views.get(m.id)!;
        const before = m.chosen ? (JSON.parse(m.chosen) as CandidateView) : null;
        const standby = (JSON.parse(m.standby) as CandidateView[]).filter((s) => s.profileId !== v.profileId);
        this.db.exec("update crew_members set chosen = ?, standby = ?, edited = 1 where id = ?", JSON.stringify(v), JSON.stringify(standby), m.id);
        // Edits are remembered as preferences (PLAN.md §9 step 6).
        if (before?.profileId !== v.profileId) {
          this.db.bumpPreference(project.id, m.role, v.profileId, 1);
          if (before) this.db.bumpPreference(project.id, m.role, before.profileId, -1);
        }
      }
      const estimate = sumEstimates([...views.values()].map((v) => v?.estimate ?? { usd: null, provenance: "unknown" }));
      this.db.exec("update crews set approved_at = ?, estimate_usd = ?, estimate_provenance = ? where id = ?", this.iso(), estimate.usd, estimate.provenance, crew.id);
      if (p.fallback) this.db.exec("update tasks set fallback = ? where id = ?", p.fallback, task.id);
    });
    this.audit(task.id, null, "task.approved", { edits: p.edits ?? [] });
    this.emitTask(task.id, "approved");
    await this.tick();
    return this.get(task.id);
  }

  /** Stops every run, closes open requests and handoffs. Worktrees are kept. */
  async cancel(taskId: string): Promise<TaskDetail> {
    const task = this.db.task(taskId);
    if (!task.cancelled_at) {
      this.db.exec("update tasks set cancelled_at = ? where id = ?", this.iso(), task.id);
      for (const r of this.db.runs(task.id).filter((r) => !r.ended_at)) await this.stopRun(r.id, "task_cancelled");
      for (const q of this.db.requests({ taskId: task.id })) this.closeRequest(q, "system");
      for (const h of this.db.handoffs(task.id).filter((h) => !h.closed_at)) this.closeHandoff(h.id, "cancelled", null);
      this.audit(task.id, null, "task.cancelled", {});
      this.emitTask(task.id, "cancelled");
    }
    return this.get(task.id);
  }

  // ---------------------------------------------------------------- runs

  async pause(runId: string): Promise<RunView> {
    const run = this.db.run(runId);
    if (run.ended_at) throw new OrchestratorError("run.ended");
    if (!run.paused_at) {
      this.db.exec("update runs set paused_at = ? where id = ?", this.iso(), runId);
      const live = this.live.get(runId);
      if (live) await this.safe(() => live.adapter.interrupt(live.handle));
      // Interrupting the turn cancels its pending prompts; the agent asks again after resume.
      for (const q of this.db.openRequestsForRun(runId).filter((q) => q.kind !== "handoff")) this.closeRequest(q, "system");
      this.emitTask(run.task_id, "run_paused");
      void this.tick();
    }
    return this.db.runView(this.db.run(runId));
  }

  /**
   * Continues a paused run, or resumes an ended one natively as a new run of the same step.
   * Never restarts anything without this call.
   */
  async resume(runId: string): Promise<RunView> {
    const run = this.db.run(runId);
    const task = this.db.task(run.task_id);
    if (task.cancelled_at) throw new OrchestratorError("task.cancelled");
    if (!run.ended_at) {
      if (!run.paused_at) return this.db.runView(run);
      this.clearTimer(runId);
      this.db.exec("update runs set paused_at = null, resume_at = null, limit_reached = 0 where id = ?", runId);
      for (const q of this.db.openRequestsForRun(runId).filter((q) => q.kind === "handoff")) this.closeRequest(q, "system");
      await this.continueRun(runId, "Continue the task where you stopped.");
      this.emitTask(run.task_id, "run_resumed");
      return this.db.runView(this.db.run(runId));
    }
    const superseded = this.db.runs(task.id).some((r) => r.resumed_from === run.id);
    if (superseded || !["interrupted", "stopped", "failed"].includes(run.end_reason ?? "")) throw new OrchestratorError("run.not_resumable");
    const adapter = this.adapters.get(run.runner);
    if (!adapter?.capabilities.resume || !run.native_session_id) throw new OrchestratorError("run.resume_unsupported", { runner: run.runner });
    const newId = await this.launch({
      task,
      member: this.db.member(run.member_id),
      target: { profileId: run.profile_id, runner: run.runner, model: run.model },
      cwd: run.cwd,
      prompt: "You were interrupted. Check `git status`, then continue the task where you stopped.",
      resumeRef: { runner: run.runner, sessionId: run.native_session_id },
      resumedFrom: run.id,
    });
    return this.db.runView(this.db.run(newId));
  }

  async stop(runId: string): Promise<RunView> {
    const run = this.db.run(runId);
    if (!run.ended_at) await this.stopRun(runId, "user_stop");
    return this.db.runView(this.db.run(runId));
  }

  async message(runId: string, text: string): Promise<RunView> {
    const run = this.db.run(runId);
    if (run.end_reason === "completed" || this.db.task(run.task_id).cancelled_at) throw new OrchestratorError("run.ended");
    const live = this.live.get(runId);
    // A paused run keeps its message until resume; sending it now would start a new turn.
    if (live && !run.paused_at) {
      await live.adapter.send(live.handle, { kind: "text", text });
      this.audit(run.task_id, runId, "run.message", { chars: text.length, queued: false });
    } else {
      // No process to talk to right now: the message belongs to the step, not to this process.
      this.db.exec("insert into outbox (id, task_id, member_id, text, created_at) values (?, ?, ?, ?, ?)", randomUUID(), run.task_id, run.member_id, text, this.iso());
      this.audit(run.task_id, runId, "run.message", { chars: text.length, queued: true });
      await this.flushOutbox(run.task_id, run.member_id);
    }
    return this.db.runView(this.db.run(runId));
  }

  /** Delivers a step's queued messages to its live run, if it has one now. */
  private async flushOutbox(taskId: string, memberId: string): Promise<void> {
    const target = this.db.runs(taskId).find((r) => r.member_id === memberId && !r.ended_at && !r.paused_at && this.live.has(r.id));
    const live = target ? this.live.get(target.id) : undefined;
    if (!target || !live) return;
    for (const m of this.db.queued(memberId)) {
      try {
        await live.adapter.send(live.handle, { kind: "text", text: m.text });
      } catch {
        return; // stays queued for the next live run
      }
      this.db.exec("update outbox set delivered_at = ?, delivered_run_id = ? where id = ?", this.iso(), target.id, m.id);
    }
  }

  // ---------------------------------------------------------------- requests

  requests(filter: { projectId?: string; taskId?: string; includeAnswered?: boolean }): RequestView[] {
    return this.db.requests(filter).map((q) => this.db.requestView(q));
  }

  async answer(requestId: string, answer: RequestAnswer): Promise<RequestView> {
    const q = this.db.request(requestId);
    if (q.answered_at) throw new OrchestratorError("request.answered");
    if (answer.kind !== "cancel" && answer.kind !== q.kind) throw new OrchestratorError("request.answer_kind");
    const payload = JSON.parse(q.payload) as RequestPayload;
    const run = q.run_id ? this.db.run(q.run_id) : null;
    const live = run ? this.live.get(run.id) : undefined;

    if (answer.kind === "approval" && answer.decision === "allow_always" && q.risk === "high") throw new OrchestratorError("request.always_high_risk");
    if ((answer.kind === "approval" || answer.kind === "question") && !live) throw new OrchestratorError("run.not_live");
    let target: CandidateView | null = null;
    if (answer.kind === "handoff" && payload.kind === "handoff") {
      if (answer.decision === "hand_off") {
        target = await this.resolveTarget(run!, answer.targetProfileId ?? payload.proposedTarget?.profileId ?? null, payload);
        if (!target) throw new OrchestratorError("request.no_target");
      }
      if (answer.decision === "wait_for_reset" && !payload.resetsAt) throw new OrchestratorError("request.no_reset");
    }

    this.db.exec("update requests set answered_at = ?, answer = ?, answered_by = 'user' where id = ?", this.iso(), JSON.stringify(answer), q.id);
    this.emitRequest(q.id);
    this.audit(q.task_id, q.run_id, "request.answered", { requestId: q.id, kind: answer.kind });

    if (live && run && q.native_id && (answer.kind === "approval" || answer.kind === "question" || answer.kind === "cancel")) {
      await this.safe(() => live.adapter.answer(live.handle, q.native_id!, toCoreAnswer(answer)));
    }
    if (answer.kind === "approval" && answer.decision === "allow_always" && payload.kind === "approval" && payload.command) {
      const task = this.db.task(q.task_id);
      this.db.exec("insert or ignore into allow_rules (project_id, command, added_at) values (?, ?, ?)", task.project_id, payload.command.trim(), this.iso());
    }
    if (answer.kind === "handoff" && run && payload.kind === "handoff") {
      if (answer.decision === "hand_off" && target) this.track(this.performHandoff(run.id, target, payload.trigger === "handoff_failed" ? "limit" : payload.trigger));
      else if (answer.decision === "wait_for_reset" && payload.resetsAt) this.scheduleResume(run.id, payload.resetsAt);
      else if (answer.decision === "stop" && !run.ended_at) await this.stopRun(run.id, "user_stop", "limit");
    }
    this.emitTask(q.task_id, "request");
    void this.tick();
    return this.db.requestView(this.db.request(q.id));
  }

  // ---------------------------------------------------------------- scheduler

  /** One scheduling pass; re-entrant calls fold into one more pass. */
  async tick(): Promise<void> {
    if (this.closed) return;
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.tickAgain = false;
        await this.schedulePass();
      } while (this.tickAgain);
    } catch {
      // A failed pass (e.g. the store closing on exit) must not crash the daemon; the next tick retries.
    } finally {
      this.ticking = false;
    }
  }

  private async schedulePass(): Promise<void> {
    for (const task of this.db.schedulable()) {
      const status = this.db.status(task);
      if (status === "failed" || status === "cancelled") continue;
      const crew = this.db.crew(task.id)!;
      const members = this.db.members(crew.id);
      const project = this.db.project(task.project_id);
      const { config } = this.config(project);
      for (const m of members) {
        const runs = this.db.runs(task.id);
        if (runs.some((r) => r.member_id === m.id)) {
          this.blocked.delete(m.id);
          continue;
        }
        const deps = JSON.parse(m.depends_on) as string[];
        const done = (step: string) => {
          const dep = members.find((x) => x.step === step);
          return dep !== undefined && runs.some((r) => r.member_id === dep.id && r.end_reason === "completed");
        };
        if (!deps.every(done)) continue;
        const chosen = m.chosen ? (JSON.parse(m.chosen) as CandidateView) : null;
        const reason = !chosen
          ? ({ code: "admission.no_profile" } as Reason)
          : !this.adapters.has(chosen.runner)
            ? ({ code: "admission.no_adapter", params: { runner: chosen.runner } } as Reason)
            : this.ranModels(m).has((chosen.model ?? `profile:${chosen.profileId}`).toLowerCase())
              ? ({ code: "no_independent_candidate" } as Reason)
              : this.admission(task, m, chosen.profileId, config.rules.slots);
        if (reason) {
          const prev = this.blocked.get(m.id);
          this.blocked.set(m.id, reason);
          if (prev?.code !== reason.code) this.emitTask(task.id, "admission");
          continue;
        }
        this.blocked.delete(m.id);
        await this.launch({ task, member: m, target: chosen! });
      }
    }
  }

  private admission(task: TaskRow, m: MemberRow, profileId: string, projectSlots: number): Reason | null {
    const counts = this.db.activeCounts();
    const wt = this.db.worktree(task.id);
    const owner = wt?.owner_run_id ? this.db.run(wt.owner_run_id) : null;
    return admit(
      {
        projectActive: counts.byProject.get(task.project_id) ?? 0,
        profileActive: counts.byProfile.get(profileId) ?? 0,
        globalActive: counts.total,
        freeMb: (this.opts.freeMemoryMb ?? (() => freemem() / 1024 / 1024))(),
        worktreeBusy: m.writes_code === 1 && owner !== null && owner.ended_at === null,
        profileId,
      },
      { ...DEFAULT_LIMITS, ...this.opts.limits, projectSlots },
    );
  }

  /**
   * Starts one run of a crew step. The run row goes in before any await, so admission control
   * counts it at once; a failure to start ends it as failed with a code.
   */
  private async launch(spec: {
    task: TaskRow;
    member: MemberRow;
    target: Pick<CandidateView, "profileId" | "runner" | "model">;
    cwd?: string;
    prompt?: string;
    resumeRef?: NativeSessionRef | null;
    resumedFrom?: string | null;
    handoffId?: string | null;
  }): Promise<string> {
    const { task, member, target } = spec;
    const project = this.db.project(task.project_id);
    const runId = randomUUID();
    this.db.exec(
      `insert into runs (id, task_id, member_id, role, profile_id, runner, model, cwd, started_at, last_state, resumed_from, handoff_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?)`,
      runId,
      task.id,
      member.id,
      member.role,
      target.profileId,
      target.runner,
      target.model,
      spec.cwd ?? project.path,
      this.iso(),
      spec.resumedFrom ?? null,
      spec.handoffId ?? null,
    );
    if (spec.handoffId) this.confirming.set(runId, spec.handoffId);
    this.emitTask(task.id, "run_started");
    try {
      const { config } = this.config(project);
      let wt = this.db.worktree(task.id);
      let cwd = spec.cwd ?? null;
      if (!cwd && member.writes_code) wt = await this.ensureTaskWorktree(task, project, config.worktreeRoot);
      cwd ??= wt?.path ?? project.path;
      const worktreeId = wt && sameDir(wt.path, cwd) ? wt.id : null;
      this.db.exec("update runs set cwd = ?, worktree_id = ? where id = ?", cwd, worktreeId, runId);
      if (member.writes_code && worktreeId) this.db.exec("update worktrees set owner_run_id = ?, last_heartbeat_at = ? where id = ?", runId, this.iso(), worktreeId);

      const candidate = (await this.candidates(project)).find((c) => c.profile.id === target.profileId);
      if (!candidate) throw new OrchestratorError("crew.unknown_profile", { profileId: target.profileId });
      const adapter = this.adapters.get(target.runner);
      if (!adapter) throw new OrchestratorError("adapter.failed", { detail: "no_adapter" });
      const req: StartRequest = {
        profile: candidate.profile,
        cwd,
        model: target.model,
        prompt: spec.prompt ?? rolePrompt(member.role, task, { plan: this.latestPlan(task.id), branch: worktreeId ? (wt?.branch ?? null) : null }),
        policy: this.policyFor(member.role, config),
        env: await this.directory.envFor(target.profileId),
      };
      const handle = spec.resumeRef ? await adapter.resume(spec.resumeRef, req) : await adapter.start(req);
      this.db.exec("update runs set native_session_id = ?, pid = ? where id = ?", handle.nativeSession?.sessionId ?? null, handle.pid, runId);
      this.attach(runId, adapter, handle, candidate);
      this.audit(task.id, runId, "run.started", { role: member.role, profileId: target.profileId, runner: target.runner, resumed: Boolean(spec.resumeRef) });
    } catch (err) {
      this.confirming.delete(runId);
      this.endRun(runId, "failed", errorCode(err));
    }
    return runId;
  }

  private ensureTaskWorktree(task: TaskRow, project: ProjectRow, root: string): Promise<WorktreeRow> {
    // One creation per task at a time; a second caller waits for the first instead of racing git.
    const pending = this.creating.get(task.id);
    if (pending) return pending;
    const p = this.createTaskWorktree(task, project, root).finally(() => this.creating.delete(task.id));
    this.creating.set(task.id, p);
    return p;
  }

  private async createTaskWorktree(task: TaskRow, project: ProjectRow, root: string): Promise<WorktreeRow> {
    const existing = this.db.worktree(task.id);
    const slug = taskSlug(task.title, task.id);
    const path = existing?.path ?? join(root, slug);
    const info = await ensureWorktree(project.path, path, existing?.branch ?? `crewyard/${slug}`, task.base_branch, this.opts.gitBin);
    if (!existing) {
      this.db.exec(
        "insert into worktrees (id, task_id, repo_path, path, branch, base_sha, created_at) values (?, ?, ?, ?, ?, ?, ?)",
        randomUUID(),
        task.id,
        project.path,
        info.path,
        info.branch,
        info.baseSha,
        this.iso(),
      );
      this.audit(task.id, null, "worktree.created", { path: info.path, branch: info.branch });
    }
    return this.db.worktree(task.id)!;
  }

  private attach(runId: string, adapter: AgentAdapter, handle: RunHandle, candidate: Candidate): void {
    let finish!: () => void;
    const live: Live = { adapter, handle, candidate, done: new Promise<void>((r) => (finish = r)) };
    this.live.set(runId, live);
    this.track(this.pump(runId, live).finally(finish));
    const run = this.db.run(runId);
    this.track(this.flushOutbox(run.task_id, run.member_id));
  }

  private async pump(runId: string, live: Live): Promise<void> {
    let ended: Ended | null = null;
    try {
      for await (const ev of live.adapter.events(live.handle)) {
        if (this.live.get(runId) !== live) return;
        if (this.confirming.has(runId)) await this.confirmHandoff(runId);
        if (ev.type === "run.ended") {
          this.record(runId, ev);
          ended = { reason: ev.reason, detail: ev.detail ?? null };
          break;
        }
        try {
          await this.onEvent(runId, ev);
        } catch (err) {
          this.audit(this.db.run(runId).task_id, runId, "orchestrator.error", { code: errorCode(err), event: ev.type });
        }
      }
    } catch {
      ended = { reason: "failed", detail: "adapter_error" };
    }
    if (this.live.get(runId) !== live) return;
    this.live.delete(runId);
    await this.onStreamEnd(runId, ended ?? { reason: "failed", detail: "stream_closed" });
  }

  private async onEvent(runId: string, ev: AgentEvent): Promise<void> {
    const run = this.db.run(runId);
    const task = this.db.task(run.task_id);
    this.record(runId, ev);
    this.db.exec("update runs set last_activity_at = ? where id = ?", ev.at, runId);
    switch (ev.type) {
      case "run.state":
        this.db.exec("update runs set last_state = ? where id = ?", ev.state, runId);
        break;
      case "plan.update":
        this.db.exec("update runs set plan = ? where id = ?", JSON.stringify(ev.steps), runId);
        break;
      case "diff.update":
        this.db.exec("update runs set diff = ? where id = ?", JSON.stringify(ev.files), runId);
        break;
      case "usage.update":
        await this.onUsage(run, task, ev);
        break;
      case "limit.update":
        this.limits.ingest({ profileId: run.profile_id, window: ev.window, usedPct: ev.usedPct, resetsAt: ev.resetsAt, provenance: ev.provenance, observedAt: ev.at }, { runId, taskId: task.id, reached: ev.reached });
        if (ev.reached) await this.onLimitReached(runId, { trigger: "limit", window: ev.window, resetsAt: ev.resetsAt });
        break;
      case "request.question":
        this.insertRequest(task.id, runId, ev.requestId, null, { kind: "question", questions: ev.questions });
        break;
      case "request.approval":
        await this.routeApproval(run, task, ev);
        break;
      default:
        break;
    }
  }

  private async onStreamEnd(runId: string, ended: Ended): Promise<void> {
    const run = this.db.run(runId);
    if (run.ended_at) return;
    const stopDetail = this.stopping.get(runId);
    if (stopDetail !== undefined) {
      this.endRun(runId, "stopped", stopDetail);
      return;
    }
    // A pause (by you or by a limit) interrupts the turn; the session stays open for resume or handoff.
    if (run.paused_at && ended.reason === "stopped") {
      this.emitTask(run.task_id, "run_paused");
      void this.tick();
      return;
    }
    if (ended.reason === "limit") {
      await this.onLimitReached(runId, { trigger: "limit", window: null, resetsAt: null });
      return;
    }
    this.endRun(runId, ended.reason, ended.detail);
    if (ended.reason === "failed") await this.onCrash(runId);
  }

  private endRun(runId: string, reason: EndReason, detail: string | null): void {
    const run = this.db.run(runId);
    if (run.ended_at) return;
    this.db.exec("update runs set ended_at = ?, end_reason = ?, end_detail = ? where id = ? and ended_at is null", this.iso(), reason, detail, runId);
    this.clearTimer(runId);
    // Nobody is left to receive these answers; they close instead of lingering as "needs input".
    for (const q of this.db.openRequestsForRun(runId).filter((q) => q.kind !== "handoff")) this.closeRequest(q, "system");
    this.audit(run.task_id, runId, "run.finished", { reason, detail });
    this.emitTask(run.task_id, "run_ended");
    void this.tick();
  }

  private async stopRun(runId: string, detail: string, reason: EndReason = "stopped"): Promise<void> {
    const live = this.live.get(runId);
    this.clearTimer(runId);
    if (live) {
      this.stopping.set(runId, detail);
      await this.safe(() => live.adapter.stop(live.handle));
      await this.within(live.done, this.opts.stopTimeoutMs ?? 30_000);
      this.stopping.delete(runId);
    }
    this.endRun(runId, reason, detail);
  }

  /** Native resume on the same run; used after a pause and at a limit reset. */
  private async continueRun(runId: string, text: string): Promise<void> {
    const live = this.live.get(runId);
    if (live) {
      await live.adapter.send(live.handle, { kind: "text", text });
      const r = this.db.run(runId);
      await this.flushOutbox(r.task_id, r.member_id);
      return;
    }
    const run = this.db.run(runId);
    const adapter = this.adapters.get(run.runner);
    if (!adapter?.capabilities.resume || !run.native_session_id) throw new OrchestratorError("run.resume_unsupported", { runner: run.runner });
    const task = this.db.task(run.task_id);
    const project = this.db.project(task.project_id);
    const candidate = (await this.candidates(project)).find((c) => c.profile.id === run.profile_id);
    if (!candidate) throw new OrchestratorError("crew.unknown_profile", { profileId: run.profile_id });
    const req: StartRequest = {
      profile: candidate.profile,
      cwd: run.cwd,
      model: run.model,
      prompt: text,
      policy: this.policyFor(run.role, this.config(project).config),
      env: await this.directory.envFor(run.profile_id),
    };
    const handle = await adapter.resume({ runner: run.runner, sessionId: run.native_session_id }, req);
    this.db.exec("update runs set native_session_id = ?, pid = ? where id = ?", handle.nativeSession?.sessionId ?? run.native_session_id, handle.pid, runId);
    this.attach(runId, adapter, handle, candidate);
  }

  // ---------------------------------------------------------------- approvals

  /**
   * Role permissions first (a read-only role never writes, whatever it asks), then risk. Only low
   * risk is approved by policy; medium and high always wait for you and never time out.
   */
  private async routeApproval(run: RunRow, task: TaskRow, ev: Extract<AgentEvent, { type: "request.approval" }>): Promise<void> {
    const project = this.db.project(task.project_id);
    const { config } = this.config(project);
    const policy = this.policyFor(run.role, config);
    const allowlist = [...policy.allowCommands, ...this.db.allowRules(project.id)];
    const risk = classifyRisk({ command: ev.command, cwd: ev.cwd, paths: ev.paths, network: ev.network, worktreeRoot: run.cwd, projectRoot: project.path, allowlist });

    let rule: string | null = null;
    if (policy.writes === "none" && ev.paths.length > 0) rule = "policy.role_read_only";
    else if (policy.writes === "docs" && ev.paths.length > 0 && !onlyDocPaths(ev.paths)) rule = "policy.role_docs_only";
    else if (policy.network === "denied" && ev.network) rule = "policy.role_no_network";

    const decision: "deny" | "allow_once" | null = rule ? "deny" : risk === "low" ? "allow_once" : null;
    const payload: RequestPayload = { kind: "approval", toolCallId: ev.toolCallId, command: ev.command, cwd: ev.cwd, paths: ev.paths, network: ev.network, policy: rule ?? (decision ? "policy.allowlisted" : null) };
    const answer: RequestAnswer | null = decision ? { kind: "approval", decision } : null;
    this.insertRequest(task.id, run.id, ev.requestId, risk, payload, answer);
    if (decision) {
      const live = this.live.get(run.id);
      if (live) await this.safe(() => live.adapter.answer(live.handle, ev.requestId, { kind: "approval", decision, ...(rule ? { message: rule } : {}) }));
    }
  }

  private insertRequest(taskId: string, runId: string | null, nativeId: string | null, risk: RequestRow["risk"], payload: RequestPayload, answeredByPolicy: RequestAnswer | null = null): string {
    const id = randomUUID();
    const at = this.iso();
    this.db.exec(
      "insert into requests (id, task_id, run_id, native_id, kind, risk, payload, created_at, answered_at, answer, answered_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      taskId,
      runId,
      nativeId,
      payload.kind,
      risk,
      JSON.stringify(payload),
      at,
      answeredByPolicy ? at : null,
      answeredByPolicy ? JSON.stringify(answeredByPolicy) : null,
      answeredByPolicy ? "policy" : null,
    );
    this.emitRequest(id);
    if (!answeredByPolicy) this.emitTask(taskId, "request");
    return id;
  }

  private closeRequest(q: RequestRow, by: "system" | "policy"): void {
    this.db.exec("update requests set answered_at = ?, answer = ?, answered_by = ? where id = ? and answered_at is null", this.iso(), JSON.stringify({ kind: "cancel" }), by, q.id);
    this.emitRequest(q.id);
  }

  // ---------------------------------------------------------------- usage and limits

  private async onUsage(run: RunRow, task: TaskRow, ev: Extract<AgentEvent, { type: "usage.update" }>): Promise<void> {
    // Runners report running totals for the native session, and a resumed session starts from the
    // totals of the run before it. So a run adds only the growth since the last total seen for
    // that session; a total that went down means the session counter restarted.
    const session = run.native_session_id ?? `run:${run.id}`;
    const seen = this.db.nativeUsage(run.runner, session) ?? { tokensIn: 0, tokensOut: 0, cacheRead: 0, costUsd: null };
    const restarted = ev.tokensIn < seen.tokensIn || ev.tokensOut < seen.tokensOut;
    const grow = (now: number, before: number) => (restarted ? now : Math.max(0, now - before));
    const dIn = grow(ev.tokensIn, seen.tokensIn);
    const dOut = grow(ev.tokensOut, seen.tokensOut);
    const dCache = grow(ev.cacheRead, seen.cacheRead);
    this.db.setNativeUsage(run.runner, session, { tokensIn: ev.tokensIn, tokensOut: ev.tokensOut, cacheRead: ev.cacheRead, costUsd: ev.costUsd }, ev.at);

    const live = this.live.get(run.id);
    const model = live?.candidate.model ?? null;
    let dCost: number | null;
    let provenance: Provenance;
    if (ev.costUsd !== null) {
      dCost = restarted ? ev.costUsd : Math.max(0, ev.costUsd - (seen.costUsd ?? 0));
      provenance = ev.costProvenance;
    } else if (live && live.candidate.profile.credential.kind !== "api_key") {
      [dCost, provenance] = [0, "estimated"];
    } else {
      // The runner could not price these tokens (e.g. Claude Code on DeepSeek): price them from the catalog.
      dCost = model ? estimateCost(model, dIn, dOut, dCache) : null;
      provenance = dCost === null ? "unknown" : "estimated";
    }
    const fresh = run.tokens_in + run.tokens_out === 0;
    const cost = dCost !== null && (fresh || run.cost_usd !== null) ? (run.cost_usd ?? 0) + dCost : null;
    const label: Provenance = cost === null ? "unknown" : fresh ? provenance : weakest(run.cost_provenance, provenance);
    this.db.exec(
      "update runs set tokens_in = ?, tokens_out = ?, cost_usd = ?, cost_provenance = ? where id = ?",
      run.tokens_in + dIn,
      run.tokens_out + dOut,
      cost === null ? null : Math.round(cost * 1_000_000) / 1_000_000,
      label,
      run.id,
    );
    if (ev.contextUsed !== null && ev.contextSize !== null) {
      this.limits.ingest(
        { profileId: run.profile_id, window: "context", usedPct: Math.min(100, (100 * ev.contextUsed) / ev.contextSize), resetsAt: null, provenance: "reported", observedAt: ev.at },
        { runId: run.id, taskId: task.id },
      );
    }
    if (task.budget_usd !== null && run.limit_reached === 0) {
      const spent = this.db.spend(this.db.runs(task.id)).usd;
      if (spent !== null && spent >= task.budget_usd) {
        this.limits.ingest({ profileId: run.profile_id, window: "budget-task", usedPct: 100, resetsAt: null, provenance: "estimated", observedAt: ev.at }, { runId: run.id, taskId: task.id, reached: true });
        await this.onLimitReached(run.id, { trigger: "budget", window: "budget-task", resetsAt: null });
      }
    }
  }

  /** Feeds a sample from outside a run (e.g. a provider balance poll) through the same rules. */
  ingestSample(sample: Parameters<LimitMonitor["ingest"]>[0]): void {
    this.limits.ingest(sample, { runId: null, taskId: null });
  }

  // ---------------------------------------------------------------- handoff (PLAN.md §8)

  private async onLimitReached(runId: string, info: HandoffInfo): Promise<void> {
    const run = this.db.run(runId);
    if (run.limit_reached || run.ended_at) return;
    this.db.exec("update runs set limit_reached = 1, paused_at = coalesce(paused_at, ?) where id = ?", this.iso(), runId);
    this.audit(run.task_id, runId, "run.limit", info);
    // Stop at a turn boundary; the session stays open for resume or handoff.
    const live = this.live.get(runId);
    if (live) await this.safe(() => live.adapter.interrupt(live.handle));
    this.emitTask(run.task_id, "limit");

    const task = this.db.task(run.task_id);
    // A budget cap never continues on a paid key without your click.
    let mode: FallbackMode = info.trigger === "budget" ? "manual" : task.fallback;
    if (mode === "wait_for_reset") {
      if (info.resetsAt && Date.parse(info.resetsAt) - this.now().getTime() <= task.wait_reset_minutes * 60_000) {
        this.scheduleResume(runId, info.resetsAt);
        return;
      }
      mode = "ask";
    }
    await this.offerHandoff(this.db.run(runId), task, mode, info, null);
  }

  /** A crashed run (not a start failure) is handed off like a limit, per the task's mode. */
  private async onCrash(runId: string): Promise<void> {
    const run = this.db.run(runId);
    const task = this.db.task(run.task_id);
    if (task.cancelled_at) return;
    const mode = task.fallback === "wait_for_reset" ? "ask" : task.fallback;
    await this.offerHandoff(run, task, mode, { trigger: "crashed", window: null, resetsAt: null }, null);
  }

  private async offerHandoff(run: RunRow, task: TaskRow, mode: FallbackMode, info: HandoffInfo, detail: string | null): Promise<void> {
    const candidates = await this.handoffCandidates(run, task);
    const taken = this.db.handoffs(task.id).filter((h) => this.db.run(h.from_run_id).member_id === run.member_id).length;
    if (mode === "auto" && candidates[0] && taken < MAX_AUTO_HANDOFFS) {
      this.track(this.performHandoff(run.id, candidates[0], info.trigger));
      return;
    }
    this.insertRequest(task.id, run.id, null, null, {
      kind: "handoff",
      trigger: detail === "handoff_failed" ? "handoff_failed" : info.trigger,
      window: info.window,
      resetsAt: info.resetsAt,
      proposedTarget: mode === "manual" ? null : (candidates[0] ?? null),
      candidates,
      detail: candidates.length === 0 ? "no_target" : detail,
    });
  }

  /**
   * Preflight (PLAN.md §8.2 step 2): standby candidates that are ready, have an adapter, keep the
   * role's permissions and the independence rule, have more than 20% headroom (Unknown passes and
   * says so) and fit the remaining budget.
   */
  private async handoffCandidates(run: RunRow, task: TaskRow): Promise<CandidateView[]> {
    const project = this.db.project(task.project_id);
    const member = this.db.member(run.member_id);
    const all = await this.candidates(project);
    const ctx = this.scoring(project.id, task.size, task.budget_usd);
    const avoid = this.avoidFor(member);
    const chain = (JSON.parse(member.standby) as CandidateView[]).map((s) => s.profileId);
    const original = member.chosen ? (JSON.parse(member.chosen) as CandidateView).profileId : null;
    const order = [...chain, ...(original ? [original] : [])].filter((id, i, a) => a.indexOf(id) === i && id !== run.profile_id);
    const spent = this.db.spend(this.db.runs(task.id)).usd ?? 0;
    return order
      .map((id) => all.find((c) => c.profile.id === id))
      .filter((c): c is Candidate => c !== undefined && eligible(c, member.role, ctx) && !avoid.models.has(modelKey(c)))
      .map((c) => scoreCandidate(c, member.role, ctx, avoid))
      .filter((v) => (v.headroom.pct === null || v.headroom.pct > MIN_HEADROOM) && (task.budget_usd === null || v.estimate.usd === 0 || spent < task.budget_usd));
  }

  private avoidFor(member: MemberRow): { models: Set<string>; providers: Set<string> } {
    // The implementer's model is whatever actually ran, including handoff targets.
    const avoid = { models: this.ranModels(member), providers: new Set<string>() };
    const crewMembers = this.db.members(member.crew_id);
    for (const role of ROLES[member.role].independentOf) {
      const other = crewMembers.find((m) => m.role === role);
      if (!other) continue;
      const chosen = other.chosen ? (JSON.parse(other.chosen) as CandidateView) : null;
      if (chosen) {
        avoid.models.add((chosen.model ?? `profile:${chosen.profileId}`).toLowerCase());
        avoid.providers.add(chosen.providerId);
      }
    }
    // The rule cuts both ways: an implementer's handoff target must not take the approved reviewer's model.
    for (const other of crewMembers.filter((m) => ROLES[m.role].independentOf.includes(member.role))) {
      const chosen = other.chosen ? (JSON.parse(other.chosen) as CandidateView) : null;
      if (chosen) avoid.models.add((chosen.model ?? `profile:${chosen.profileId}`).toLowerCase());
    }
    return avoid;
  }

  /** Models that actually ran for the roles this member must stay independent of. */
  private ranModels(member: MemberRow): Set<string> {
    const out = new Set<string>();
    for (const other of this.db.members(member.crew_id).filter((m) => ROLES[member.role].independentOf.includes(m.role))) {
      const ran = this.db.db.prepare("select profile_id, model from runs where member_id = ?").all(other.id) as Array<{ profile_id: string; model: string | null }>;
      for (const r of ran) out.add((r.model ?? `profile:${r.profile_id}`).toLowerCase());
    }
    return out;
  }

  private async resolveTarget(run: RunRow, profileId: string | null, payload: Extract<RequestPayload, { kind: "handoff" }>): Promise<CandidateView | null> {
    if (!profileId) return null;
    const listed = payload.candidates.find((c) => c.profileId === profileId);
    if (listed) return listed;
    // You may pick a profile outside the chain; it still has to pass the role and independence rules.
    const task = this.db.task(run.task_id);
    const project = this.db.project(task.project_id);
    const member = this.db.member(run.member_id);
    const ctx = this.scoring(project.id, task.size, task.budget_usd);
    const ranked = rankForRole(await this.candidates(project), member.role, ctx, this.avoidFor(member));
    return ranked.find((v) => v.profileId === profileId) ?? null;
  }

  private async performHandoff(sourceRunId: string, target: CandidateView, trigger: HandoffTrigger): Promise<void> {
    const source = this.db.run(sourceRunId);
    const task = this.db.task(source.task_id);
    const project = this.db.project(task.project_id);

    // Preflight before claiming anything, so a target that cannot start never touches the source.
    const candidate = (await this.candidates(project)).find((c) => c.profile.id === target.profileId);
    if (!candidate?.ready || !this.adapters.has(target.runner)) {
      await this.offerHandoff(source, task, "manual", { trigger, window: null, resetsAt: null }, "target_unavailable");
      return;
    }

    // Claim: one open handoff per source run (also a unique index). A second click, or Auto
    // racing a click, stops here instead of starting a second target.
    const handoffId = this.db.tx(() => {
      if (this.db.openHandoffs().some((h) => h.from_run_id === source.id)) return null;
      const id = randomUUID();
      this.db.exec(
        "insert into handoffs (id, task_id, from_run_id, target_profile_id, mode, trigger_kind, phase, opened_at) values (?, ?, ?, ?, ?, ?, 'stopping_source', ?)",
        id,
        task.id,
        source.id,
        target.profileId,
        task.fallback,
        trigger,
        this.iso(),
      );
      return id;
    });
    if (!handoffId) return;
    this.audit(task.id, source.id, "handoff.opened", { handoffId, target: target.profileId, trigger });
    this.emitTask(task.id, "handoff_opened");
    const phase = (p: HandoffPhase) => this.db.exec("update handoffs set phase = ? where id = ? and closed_at is null", p, handoffId);
    try {
      // Stop the source at a turn boundary; never replay a half-finished tool call.
      const live = this.live.get(source.id);
      if (live) {
        this.db.exec("update runs set paused_at = coalesce(paused_at, ?) where id = ?", this.iso(), source.id);
        await this.safe(() => live.adapter.interrupt(live.handle));
        if (!(await this.within(live.done, this.opts.stopTimeoutMs ?? 30_000))) await this.safe(() => live.adapter.stop(live.handle));
      }

      phase("checkpoint");
      const wt = this.db.worktree(task.id);
      let sha: string | null = null;
      let stat: string | null = null;
      if (wt && sameDir(wt.path, source.cwd)) {
        sha = (await checkpoint(wt.path, `wip: handoff from ${source.id}`, this.opts.gitBin)).sha;
        stat = await diffStat(wt.path, wt.base_sha, this.opts.gitBin);
      }
      const text = handoffPackage({
        task,
        source,
        trigger,
        plan: this.latestPlan(task.id, source.id),
        diffStat: stat,
        checkpointSha: sha,
        openQuestions: this.db
          .requests({ taskId: task.id })
          .filter((q) => q.kind === "question")
          .flatMap((q) => (JSON.parse(q.payload) as Extract<RequestPayload, { kind: "question" }>).questions.map((x) => x.prompt)),
        transcript: `Event log of run ${source.id} in the Crewyard database.`,
      });
      const packagePath = join(this.opts.dataDir, "tasks", task.id, `handoff-${handoffId}.md`);
      writeFileAtomic(packagePath, text);
      const native = target.runner === source.runner && target.profileId === source.profile_id && source.native_session_id !== null;
      this.db.exec("update handoffs set package_path = ?, checkpoint_sha = ?, kind = ? where id = ?", packagePath, sha, native ? "native_resume" : "new_session", handoffId);

      phase("starting_target");
      const targetRunId = await this.launch({
        task,
        member: this.db.member(source.member_id),
        target,
        cwd: source.cwd,
        prompt: native ? "Continue the task." : text,
        resumeRef: native ? { runner: source.runner, sessionId: source.native_session_id! } : null,
        resumedFrom: source.id,
        handoffId,
      });
      this.db.exec("update handoffs set to_run_id = ? where id = ?", targetRunId, handoffId);
      phase("confirming");
      const started = this.db.run(targetRunId);
      if (started.ended_at && this.db.handoff(handoffId).closed_at === null) throw new OrchestratorError("adapter.failed", { detail: started.end_detail ?? "target_failed" });
    } catch (err) {
      await this.failHandoff(handoffId, errorCode(err));
    }
  }

  /** PLAN.md §8.2 step 7: the record flips only once the target is talking and git matches. */
  private async confirmHandoff(targetRunId: string): Promise<void> {
    const handoffId = this.confirming.get(targetRunId);
    if (!handoffId) return;
    this.confirming.delete(targetRunId);
    const h = this.db.handoff(handoffId);
    if (h.closed_at) return;
    const target = this.db.run(targetRunId);
    if (h.checkpoint_sha) {
      const head = await headSha(target.cwd, this.opts.gitBin).catch(() => null);
      if (head !== h.checkpoint_sha) {
        await this.failHandoff(handoffId, "git_mismatch");
        // Called from the target's own event pump, so the stop must not wait for that pump.
        this.track(this.stopRun(targetRunId, "handoff_failed"));
        return;
      }
    }
    this.closeHandoff(handoffId, "completed", null);
    this.db.exec("update runs set handoff_id = ? where id = ?", handoffId, h.from_run_id);
    if (target.worktree_id) this.db.exec("update worktrees set owner_run_id = ? where id = ?", targetRunId, target.worktree_id);
    this.endRun(h.from_run_id, "limit", "handed_off");
    this.audit(h.task_id, targetRunId, "handoff.completed", { handoffId, from: h.from_run_id, mode: h.mode });
    this.emitTask(h.task_id, "handoff_completed");
  }

  private async failHandoff(handoffId: string, detail: string): Promise<void> {
    const h = this.db.handoff(handoffId);
    if (h.closed_at) return;
    this.closeHandoff(handoffId, "failed", detail);
    const source = this.db.run(h.from_run_id);
    // The source stays paused and you decide (PLAN.md §8.2 step 7).
    if (!source.ended_at) this.db.exec("update runs set paused_at = coalesce(paused_at, ?) where id = ?", this.iso(), source.id);
    const task = this.db.task(h.task_id);
    this.audit(task.id, source.id, "handoff.failed", { handoffId, detail });
    await this.offerHandoff(source, task, "manual", { trigger: h.trigger_kind, window: null, resetsAt: null }, "handoff_failed");
    this.emitTask(task.id, "handoff_failed");
  }

  private closeHandoff(id: string, outcome: "completed" | "failed" | "cancelled" | "interrupted", detail: string | null): void {
    this.db.exec("update handoffs set closed_at = ?, outcome = ?, detail = ?, phase = 'closed' where id = ? and closed_at is null", this.iso(), outcome, detail, id);
  }

  /** Wait-for-reset: the same session continues when its window resets. */
  private scheduleResume(runId: string, resetsAt: string): void {
    this.clearTimer(runId);
    this.db.exec("update runs set resume_at = ? where id = ?", resetsAt, runId);
    this.audit(this.db.run(runId).task_id, runId, "run.wait_for_reset", { resetsAt });
    const delay = Math.max(0, Date.parse(resetsAt) - this.now().getTime());
    const timer = setTimeout(() => {
      this.timers.delete(runId);
      this.track(this.resumeAfterReset(runId));
    }, delay);
    timer.unref();
    this.timers.set(runId, timer);
    this.emitTask(this.db.run(runId).task_id, "limit");
  }

  private async resumeAfterReset(runId: string): Promise<void> {
    const run = this.db.run(runId);
    if (run.ended_at) return;
    this.db.exec("update runs set limit_reached = 0, paused_at = null, resume_at = null where id = ?", runId);
    try {
      await this.continueRun(runId, "Your usage window has reset. Continue the task where you stopped.");
      this.audit(run.task_id, runId, "run.resumed", { after: "reset" });
      this.emitTask(run.task_id, "run_resumed");
    } catch (err) {
      this.db.exec("update runs set paused_at = ? where id = ?", this.iso(), runId);
      await this.offerHandoff(this.db.run(runId), this.db.task(run.task_id), "manual", { trigger: "limit", window: null, resetsAt: null }, errorCode(err));
    }
  }

  // ---------------------------------------------------------------- recovery (PLAN.md §4)

  /** Runs left open by the last daemon have no process we own any more: they become interrupted. */
  private recover(): void {
    const alive = this.opts.isAlive ?? pidAlive;
    const tasks = new Set<string>();
    for (const r of this.db.openRuns()) {
      // We never kill a recorded pid: Windows reuses pids, and the number may belong to something else now.
      const detail = r.pid !== null && alive(r.pid) ? "process_orphaned" : "process_gone";
      this.db.exec("update runs set ended_at = ?, end_reason = 'interrupted', end_detail = ?, resume_at = null where id = ?", this.iso(), detail, r.id);
      for (const q of this.db.openRequestsForRun(r.id)) this.closeRequest(q, "system");
      this.audit(r.task_id, r.id, "run.recovered", { detail });
      tasks.add(r.task_id);
    }
    for (const h of this.db.openHandoffs()) {
      // The phase it died in tells you how far it got (e.g. a WIP commit exists after "checkpoint").
      this.closeHandoff(h.id, "interrupted", h.phase);
      tasks.add(h.task_id);
    }
    tasks.forEach((t) => this.emitTask(t, "recovered"));
  }

  // ---------------------------------------------------------------- helpers

  private config(project: ProjectRow): { config: ProjectConfig; fromFile: boolean } {
    const file = join(project.path, ".mission", "project.json");
    if (existsSync(file)) {
      try {
        const parsed = ProjectConfig.safeParse(JSON.parse(readFileSync(file, "utf8")));
        if (parsed.success) return { config: parsed.data, fromFile: true };
      } catch {
        // An unreadable file falls back to the wizard defaults below.
      }
    }
    return { config: defaultProjectConfig(project.name, defaultWorktreeRoot(project.path)), fromFile: false };
  }

  private async candidates(project: ProjectRow): Promise<Candidate[]> {
    const { config, fromFile } = this.config(project);
    const all = await this.directory.candidates(project.id);
    return all.filter((c) => !fromFile || ((config.profiles.length === 0 || config.profiles.includes(c.profile.id)) && (config.runners.length === 0 || config.runners.includes(c.profile.runner))));
  }

  private scoring(projectId: string, size: TaskSize, budgetUsd: number | null, pins?: ProposeParams["pins"], exclude?: string[]): ScoringContext {
    return {
      size,
      budgetUsd,
      hasAdapter: (r: RunnerId) => this.adapters.has(r),
      headroom: (id) => this.db.headroom(id, this.now()),
      history: (runner, role) => this.db.history(projectId, runner, role),
      preference: (role, id) => this.db.preference(projectId, role, id),
      pins,
      exclude,
    };
  }

  private policyFor(role: RoleId, config: ProjectConfig): RolePolicy {
    const tpl = ROLES[role].policy;
    const commands = [config.commands.build, config.commands.test].filter((c): c is string => Boolean(c));
    const runsCommands = role === "implementer" || role === "tester" || role === "reviewer";
    return {
      writes: tpl.writes,
      allowCommands: [...config.rules.allowCommands, ...(runsCommands ? commands : [])],
      network: tpl.network === "ask" && config.rules.network === "allowed" ? "allowed" : tpl.network,
    };
  }

  /** The newest plan any run of the task reported, or one run's plan. */
  private latestPlan(taskId: string, runId?: string): Array<{ title: string; status: "pending" | "in_progress" | "completed" }> | null {
    const runs = this.db.runs(taskId).filter((r) => r.plan && (!runId || r.id === runId));
    const last = runs.at(-1);
    return last?.plan ? JSON.parse(last.plan) : null;
  }

  private record(runId: string, ev: AgentEvent): void {
    const run = this.db.run(runId);
    const task = this.db.task(run.task_id);
    this.opts.store.appendEvent({ kind: `run.${ev.type}`, source: ev.source.adapter, payload: ev, projectId: task.project_id, taskId: task.id, runId });
    this.emit("runs.event", { taskId: task.id, runId, event: ev });
  }

  private audit(taskId: string, runId: string | null, kind: string, payload: unknown): void {
    const projectId = this.db.task(taskId).project_id;
    this.opts.store.appendEvent({ kind, source: "orchestrator", payload, projectId, taskId, runId });
  }

  private emit<K extends keyof TasksTopics>(topic: K, payload: TasksTopics[K]): void {
    this.opts.emit(topic, payload);
  }

  private emitTask(taskId: string, cause: TaskChangeCause): void {
    const task = this.db.task(taskId);
    this.emit("tasks.changed", { taskId, projectId: task.project_id, status: this.db.status(task), cause });
  }

  private emitRequest(requestId: string): void {
    const q = this.db.request(requestId);
    this.emit("requests.changed", { requestId, taskId: q.task_id, projectId: this.db.task(q.task_id).project_id, open: q.answered_at === null });
  }

  private clearTimer(runId: string): void {
    const t = this.timers.get(runId);
    if (t) clearTimeout(t);
    this.timers.delete(runId);
  }

  private track<T>(p: Promise<T>): void {
    const tracked = p.catch(() => undefined);
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  private async safe(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch {
      // Adapter control calls are best effort; the event stream reports what really happened.
    }
  }

  private async within(p: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
    const ok = await Promise.race([p.then(() => true as const), timeout]);
    clearTimeout(timer);
    return ok;
  }

  private iso(): string {
    return this.now().toISOString();
  }
}

const RANK: Record<Provenance, number> = { reported: 2, estimated: 1, unknown: 0 };
const weakest = (a: Provenance, b: Provenance): Provenance => (RANK[a] <= RANK[b] ? a : b);

function toCoreAnswer(a: RequestAnswer): Answer {
  switch (a.kind) {
    case "approval":
      return { kind: "approval", decision: a.decision, ...(a.message ? { message: a.message } : {}) };
    case "question":
      return { kind: "question", answers: a.answers };
    default:
      return { kind: "cancel" };
  }
}

