import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { freemem } from "node:os";
import { join, resolve } from "node:path";
import {
  capEvent,
  classifyRisk,
  defaultProjectConfig,
  estimateCost,
  EVENT_LIMITS,
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
  type Profile,
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
  type SessionSeen,
  type SpendCap,
  type StartRequest,
  type TaskChangeCause,
  type TaskDetail,
  type TaskSize,
  type TaskSummary,
  type TasksIpc,
  type TasksTopics,
  type UnpricedSpend,
  utf8Length,
} from "@crewyard/core";
import type { Store } from "../store.ts";
import { Bootstrapper } from "../worktrees/bootstrap.ts";
import { admit, DEFAULT_LIMITS, type AdmissionLimits } from "./admission.ts";
import { AdapterRegistry } from "./adapters.ts";
import { classifyTask } from "./classify.ts";
import { eligible, estimateFor, MIN_HEADROOM, modelKey, proposeCrew, rankForRole, readOnlyConflict, sameModel, scoreCandidate, sumEstimates, type ScoringContext } from "./crew.ts";
import { OrchestratorDb, type MemberRow, type ProjectRow, type RequestRow, type RunRow, type TaskRow, type WorktreeRow } from "./db.ts";
import { EMPTY_DIRECTORY, type Candidate, type ProfileDirectory } from "./directory.ts";
import { errorCode, errorDetail, OrchestratorError, redactDetail } from "./errors.ts";
import { classifyFailure, RETRY, retryDelayMs, type Failure, type FailureClass } from "./failures.ts";
import { checkpoint, defaultWorktreeRoot, diffStat, ensureWorktree, headSha, taskSlug, writeFileAtomic } from "./git.ts";
import { applyResult, outputSchemaFor } from "./results.ts";
import { LimitMonitor } from "./limits.ts";
import { handoffPackage, rolePrompt } from "./prompts.ts";
import { onlyDocPaths, ROLES } from "./roles.ts";
import { capResetsAt, capWindow, credentialCaps, overCap, reachedCaps, recordRunSpend, reservedUsd, reserveSpend, settleReservation, spendCredential } from "./spend.ts";
import { joinMessages } from "./queue.ts";
import { StallMonitor } from "./stall.ts";
import { snapshotTranscript, transcriptPath } from "./transcripts.ts";
import { TurnControl } from "./turns.ts";

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
  /** How often the stall rules run (feature scan A7). 0 disables the timer; tests call checkStalls(). */
  stallCheckMs?: number;
}

interface Live {
  adapter: AgentAdapter;
  handle: RunHandle;
  candidate: Candidate;
  done: Promise<void>;
  /** A turn is running: follow-ups wait in the step's queue for its boundary (StartRequest.nextTurn). */
  inTurn: boolean;
}

type ProposeParams = TasksIpc["tasks.propose"]["params"];
type Ended = { reason: EndReason; detail: string | null };
type HandoffInfo = { trigger: HandoffTrigger | "unpriced"; window: LimitWindow | null; resetsAt: string | null; cap?: SpendCap | null; unpriced?: UnpricedSpend | null; failure?: FailureClass };
type LaunchSpec = {
  /** Set when the caller must record something about the run before it can fail (a retry). */
  runId?: string;
  task: TaskRow;
  member: MemberRow;
  target: Pick<CandidateView, "profileId" | "runner" | "model">;
  cwd?: string;
  prompt?: string;
  resumeRef?: NativeSessionRef | null;
  resumedFrom?: string | null;
  handoffId?: string | null;
};

/** How many handoffs one crew step may take on its own before it asks you (the standby chain is 2 long). */
const MAX_AUTO_HANDOFFS = 2;

/** Largest tool output kept whole on disk when its event is cut; bigger ones keep only the head. */
const KEEP_FULL_MAX = 8 * 1024 * 1024;

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
  /** Worktree setup, cleanup, include list, port and park (packages/daemon/src/worktrees). */
  readonly bootstrap: Bootstrapper;
  /** Turn checkpoints, the follow-up queue, Steer now and Undo (turns.ts, queue.ts). */
  readonly turns: TurnControl;
  readonly stalls: StallMonitor;
  private stallTimer: NodeJS.Timeout | null = null;
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
  /** Runs a spend cap held back before their process started, with what they need to start later. */
  private readonly held = new Map<string, LaunchSpec>();
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
    this.bootstrap = new Bootstrapper({
      store: opts.store,
      now: this.now,
      gitBin: opts.gitBin,
      emit: opts.emit,
      requestApproval: (taskId, runId, payload) => this.insertRequest(taskId, runId, null, "high", payload),
      audit: (taskId, runId, kind, payload) => this.audit(taskId, runId, kind, payload),
      config: (projectId) => this.config(this.db.project(projectId)).config,
    });
    this.turns = new TurnControl({
      store: opts.store,
      db: this.db,
      now: this.now,
      gitBin: opts.gitBin,
      live: (runId) => this.live.get(runId),
      adapter: (runner) => this.adapters.get(runner) ?? undefined,
      session: (run) => this.sessionFor(run),
      audit: (taskId, runId, kind, payload) => this.audit(taskId, runId, kind, payload),
    });
    this.stalls = new StallMonitor({ store: opts.store, db: this.db, now: this.now, inTurn: (runId) => this.live.get(runId)?.inTurn ?? false, emit: (topic, payload) => this.emit(topic, payload) });
    this.db.runExtras = (r) => ({
      queue: this.turns.queue.pending(r.member_id),
      controls: this.turns.controls(r),
      transcriptPath: transcriptPath(opts.store, r.id),
    });
  }

  /** Recovers from the last session, then starts scheduling. */
  start(): void {
    this.recover();
    const ms = this.opts.tickMs ?? 5_000;
    if (ms > 0) this.interval = setInterval(() => void this.tick(), ms).unref();
    const stallMs = this.opts.stallCheckMs ?? 30_000;
    if (stallMs > 0) this.stallTimer = setInterval(() => this.checkStalls(), stallMs).unref();
    void this.tick();
  }

  /** One pass of the stall rules; a failure (the store closing on exit) waits for the next one. */
  checkStalls(): void {
    if (this.closed) return;
    try {
      this.stalls.check();
    } catch {
      // Same as a failed scheduling pass: the next timer tick tries again.
    }
  }

  /**
   * Daemon exit: stops every agent process tree (the daemon owns them, nothing may linger) but
   * leaves the facts alone, so the next start() marks those runs interrupted and offers resume.
   */
  shutdown(): void {
    this.closed = true;
    if (this.interval) clearInterval(this.interval);
    if (this.stallTimer) clearInterval(this.stallTimer);
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

    const candidates = await this.candidates(project);
    if (p.edits?.length) {
      const ctx = this.scoring(project.id, task.size, task.budget_usd);
      for (const edit of p.edits) {
        const m = members.find((x) => x.id === edit.memberId);
        if (!m) throw new OrchestratorError("crew.member_not_found", { memberId: edit.memberId });
        const c = candidates.find((x) => x.profile.id === edit.profileId);
        if (c && readOnlyConflict(c, m.role)) throw new OrchestratorError("crew.read_only_profile", { profileId: c.profile.id, role: m.role });
        if (!c || !eligible(c, m.role, ctx)) throw new OrchestratorError("crew.unknown_profile", { profileId: edit.profileId });
        const v = scoreCandidate(c, m.role, ctx);
        if (edit.model) v.model = edit.model;
        views.set(m.id, v);
      }
    }

    for (const m of members) {
      const v = views.get(m.id);
      if (!v) throw new OrchestratorError("crew.missing_profile", { role: m.role });
      // Checked for every member, not only edited ones: the profile may have been marked read-only after the proposal.
      const c = candidates.find((x) => x.profile.id === v.profileId);
      if (c && readOnlyConflict(c, m.role)) throw new OrchestratorError("crew.read_only_profile", { profileId: c.profile.id, role: m.role });
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
      for (const r of this.db.runs(task.id).filter((r) => r.ended_at && r.resume_at)) this.cancelAutoRetry(r.id);
      for (const r of this.db.runs(task.id).filter((r) => !r.ended_at)) await this.stopRun(r.id, "task_cancelled");
      for (const q of this.db.requests({ taskId: task.id })) this.closeRequest(q, "system");
      for (const h of this.db.handoffs(task.id).filter((h) => !h.closed_at)) this.closeHandoff(h.id, "cancelled", null);
      this.audit(task.id, null, "task.cancelled", {});
      this.emitTask(task.id, "cancelled");
    }
    return this.get(task.id);
  }

  // ---------------------------------------------------------------- runs

  async pause(runId: string, seen?: SessionSeen): Promise<RunView> {
    const run = this.db.run(runId);
    this.checkSeen(run, seen);
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
      // Going past a spend cap, or spending without a price, needs its own approval in the Inbox; resume never skips it.
      if (run.limit_reached && this.unpricedOpen(runId)) throw new OrchestratorError("run.price_unknown");
      const cap = run.limit_reached ? this.capFor(task.id, runId, await this.candidateFor(run)) : null;
      if (cap) throw new OrchestratorError("run.still_limited", { window: capWindow(cap), resetsAt: capResetsAt(cap, this.now()) ?? "" });
      this.clearTimer(runId);
      this.db.exec("update runs set paused_at = null, resume_at = null, limit_reached = 0 where id = ?", runId);
      for (const q of this.db.openRequestsForRun(runId).filter((q) => q.kind === "handoff")) this.closeRequest(q, "system");
      await this.proceed(runId, "Continue the task where you stopped.");
      this.emitTask(run.task_id, "run_resumed");
      return this.db.runView(this.db.run(runId));
    }
    if (this.superseded(run) || !["interrupted", "stopped", "failed"].includes(run.end_reason ?? "")) throw new OrchestratorError("run.not_resumable");
    const adapter = this.adapters.get(run.runner);
    if (!adapter?.capabilities.resume || !run.native_session_id) throw new OrchestratorError("run.resume_unsupported", { runner: run.runner });
    this.cancelAutoRetry(run.id);
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

  async stop(runId: string, seen?: SessionSeen): Promise<RunView> {
    const run = this.db.run(runId);
    this.checkSeen(run, seen);
    if (run.ended_at && run.resume_at) this.cancelAutoRetry(runId);
    if (!run.ended_at) await this.stopRun(runId, "user_stop");
    return this.db.runView(this.db.run(runId));
  }

  /**
   * Manual hand off ("Change AI"): the same durable protocol as a limit handoff, with trigger
   * `manual`. Validates the target first, so a refusal is an error code instead of an Inbox item.
   */
  async handoff(runId: string, targetProfileId: string): Promise<RunView> {
    const source = this.db.run(runId);
    const task = this.db.task(source.task_id);
    if (task.cancelled_at) throw new OrchestratorError("task.cancelled");
    if (source.end_reason === "completed") throw new OrchestratorError("run.ended");
    if (this.superseded(source)) throw new OrchestratorError("run.superseded");
    if (this.db.openHandoffs().some((h) => h.from_run_id === source.id)) throw new OrchestratorError("handoff.open");
    if (targetProfileId === source.profile_id) throw new OrchestratorError("handoff.same_profile");
    const target = await this.preflightTarget(source, task, targetProfileId);
    const handoffId = this.claimHandoff(source, task, target, "manual");
    if (!handoffId) throw new OrchestratorError("handoff.open");
    this.cancelAutoRetry(source.id);
    // Your choice answers any limit or crash question still open for this run.
    for (const q of this.db.openRequestsForRun(source.id).filter((q) => q.kind === "handoff")) this.closeRequest(q, "system");
    this.track(this.executeHandoff(handoffId, source.id, target, "manual"));
    return this.db.runView(this.db.run(runId));
  }

  /**
   * "Check again". An ended step (failed, stopped, interrupted) starts a fresh run of the same
   * member on the same profile. A run paused on a limit or a spend cap continues once it cleared.
   * Anything else re-runs admission for queued steps.
   */
  async retry(runId: string): Promise<RunView> {
    const run = this.db.run(runId);
    const task = this.db.task(run.task_id);
    if (task.cancelled_at) throw new OrchestratorError("task.cancelled");
    if (run.end_reason === "completed") throw new OrchestratorError("run.ended");
    if (this.superseded(run)) throw new OrchestratorError("run.superseded");
    if (run.ended_at) {
      this.cancelAutoRetry(run.id);
      // The crash or limit question about the old run is answered by retrying it.
      for (const q of this.db.openRequestsForRun(run.id).filter((q) => q.kind === "handoff")) this.closeRequest(q, "system");
      const id = await this.launch({ task, member: this.db.member(run.member_id), target: { profileId: run.profile_id, runner: run.runner, model: run.model }, resumedFrom: run.id });
      this.audit(task.id, id, "run.retried", { from: run.id });
      this.emitTask(task.id, "retried");
      return this.db.runView(this.db.run(id));
    }
    if (run.limit_reached || run.resume_at) {
      if (this.unpricedOpen(run.id)) throw new OrchestratorError("run.price_unknown");
      const cap = this.capFor(task.id, run.id, await this.candidateFor(run));
      if (cap) throw new OrchestratorError("run.still_limited", { window: capWindow(cap), resetsAt: capResetsAt(cap, this.now()) ?? "" });
      const reached = this.db.reachedWindow(run.profile_id, this.now());
      if (reached) throw new OrchestratorError("run.still_limited", { window: reached.window, resetsAt: reached.resetsAt });
      this.clearTimer(run.id);
      this.db.exec("update runs set limit_reached = 0, paused_at = null, resume_at = null where id = ?", run.id);
      for (const q of this.db.openRequestsForRun(run.id).filter((q) => q.kind === "handoff")) this.closeRequest(q, "system");
      this.audit(task.id, run.id, "run.retried", { after: "limit" });
      try {
        await this.proceed(run.id, "Your limit has cleared. Continue the task where you stopped.");
        this.emitTask(task.id, "run_resumed");
      } catch (err) {
        this.db.exec("update runs set paused_at = ? where id = ?", this.iso(), run.id);
        await this.offerHandoff(this.db.run(run.id), task, "manual", { trigger: "limit", window: null, resetsAt: null }, errorCode(err));
        this.emitTask(task.id, "limit");
      }
      return this.db.runView(this.db.run(run.id));
    }
    await this.tick();
    return this.db.runView(this.db.run(run.id));
  }

  async message(runId: string, text: string, seen?: SessionSeen): Promise<RunView> {
    const run = this.db.run(runId);
    this.checkSeen(run, seen);
    if (run.end_reason === "completed" || this.db.task(run.task_id).cancelled_at) throw new OrchestratorError("run.ended");
    // Every message joins the step's queue first (feature scan A13): it belongs to the step, not to
    // this process, and stays queued and editable until a run takes it. A running turn takes it at
    // its boundary, a paused run on resume, and whichever run continues the step otherwise.
    this.turns.queue.add(run.task_id, run.member_id, text);
    const live = this.live.get(runId);
    this.audit(run.task_id, runId, "run.message", { chars: text.length, queued: !live || Boolean(run.paused_at) || live.inTurn });
    await this.flushOutbox(run.task_id, run.member_id);
    this.emitTask(run.task_id, "queue");
    return this.db.runView(this.db.run(runId));
  }

  // ---------------------------------------------------------------- follow-up queue and undo

  queueEdit(runId: string, messageId: string, text: string): RunView {
    const run = this.db.run(runId);
    this.turns.queue.edit(run.member_id, messageId, text);
    this.audit(run.task_id, runId, "queue.edited", { messageId, chars: text.length });
    this.emitTask(run.task_id, "queue");
    return this.db.runView(this.db.run(runId));
  }

  queueDelete(runId: string, messageId: string): RunView {
    const run = this.db.run(runId);
    this.turns.queue.remove(run.member_id, messageId);
    this.audit(run.task_id, runId, "queue.deleted", { messageId });
    this.emitTask(run.task_id, "queue");
    return this.db.runView(this.db.run(runId));
  }

  queueMove(runId: string, messageId: string, index: number): RunView {
    const run = this.db.run(runId);
    this.turns.queue.move(run.member_id, messageId, index);
    this.emitTask(run.task_id, "queue");
    return this.db.runView(this.db.run(runId));
  }

  /** "Steer now": one queued message into the turn in flight, where the runner supports it. */
  async queueSteer(runId: string, messageId: string, seen?: SessionSeen): Promise<RunView> {
    const run = this.db.run(runId);
    this.checkSeen(run, seen);
    const message = this.turns.queue.get(run.member_id, messageId);
    const state = this.turns.steerState(run);
    if (!state.ok) throw new OrchestratorError("run.not_steerable", { reason: state.reason ?? "" });
    const live = this.live.get(runId)!;
    try {
      await live.adapter.steer!(live.handle, { kind: "text", text: message.text });
    } catch (err) {
      // The turn ended between the check and the call; the message stays queued for the boundary.
      throw new OrchestratorError("run.not_steerable", { reason: "steer.no_turn", detail: err instanceof Error ? err.message.slice(0, 200) : "" });
    }
    this.turns.queue.deliver(messageId, runId, true);
    this.audit(run.task_id, runId, "queue.steered", { messageId, chars: message.text.length });
    this.emitTask(run.task_id, "queue");
    return this.db.runView(this.db.run(runId));
  }

  undoPreview(runId: string) {
    return this.turns.preview(runId);
  }

  /** Undo last turn, after you confirmed the preview. Never while a turn runs (checked again here). */
  async undo(runId: string, turnId: string): Promise<RunView> {
    const run = this.db.run(runId);
    try {
      await this.turns.undo(runId, turnId);
    } finally {
      this.emitTask(run.task_id, "undone");
      void this.tick();
    }
    return this.db.runView(this.db.run(runId));
  }

  /**
   * Feedback for a step after its run finished, e.g. failing checks or review comments on the
   * task's PR (the GitHub work calls this only from your "Send to agent" click). An unfinished run
   * takes it through `message`. A completed one gets a new run of the same step on the same
   * profile, natively resumed when the runner can, with the feedback as its prompt.
   */
  async followUp(runId: string, text: string): Promise<RunView> {
    const run = this.db.run(runId);
    const task = this.db.task(run.task_id);
    if (task.cancelled_at) throw new OrchestratorError("task.cancelled");
    if (run.end_reason !== "completed") return this.message(runId, text);
    if (this.superseded(run)) throw new OrchestratorError("run.superseded");
    const adapter = this.adapters.get(run.runner);
    const native = Boolean(adapter?.capabilities.resume && run.native_session_id);
    const member = this.db.member(run.member_id);
    const wt = this.db.worktree(task.id);
    const prompt = native ? text : `${rolePrompt(member.role, task, { plan: this.latestPlan(task.id), branch: wt?.branch ?? null })}\n\n${text}`;
    const id = await this.launch({
      task,
      member,
      target: { profileId: run.profile_id, runner: run.runner, model: run.model },
      cwd: run.cwd,
      prompt,
      resumeRef: native ? { runner: run.runner, sessionId: run.native_session_id! } : null,
      resumedFrom: run.id,
    });
    this.audit(task.id, id, "run.follow_up", { from: run.id, chars: text.length, native });
    return this.db.runView(this.db.run(id));
  }

  /**
   * Hands a step's queued messages to its live run as one new turn, when no turn is running there.
   * A running turn takes them at its boundary instead (nextTurn), so they stay editable until then.
   */
  private async flushOutbox(taskId: string, memberId: string): Promise<void> {
    const target = this.db.runs(taskId).find((r) => r.member_id === memberId && !r.ended_at && !r.paused_at && this.live.has(r.id));
    const live = target ? this.live.get(target.id) : undefined;
    if (!target || !live || live.inTurn) return;
    const queued = this.turns.queue.pending(memberId);
    if (queued.length === 0) return;
    live.inTurn = true;
    try {
      await this.turns.begin(target.id);
      await live.adapter.send(live.handle, { kind: "text", text: joinMessages(queued.map((m) => m.text)) });
    } catch {
      // The process is finishing; the messages stay queued for whichever run continues the step.
      live.inTurn = false;
      this.turns.end(target.id);
      return;
    }
    for (const m of queued) this.turns.queue.deliver(m.id, target.id);
  }

  /**
   * StartRequest.nextTurn: called by the adapter at a turn boundary. Returns the step's queued
   * follow-ups as the next turn's text, or null to let the run finish (nothing queued, or the run
   * was paused, stopped, limited or cancelled meanwhile).
   */
  private async nextTurn(runId: string): Promise<string | null> {
    this.turns.end(runId);
    const live = this.live.get(runId);
    const run = this.db.run(runId);
    const stop = !live || this.closed || run.ended_at !== null || run.paused_at !== null || run.limit_reached === 1 || this.stopping.has(runId) || this.db.task(run.task_id).cancelled_at !== null;
    const queued = stop ? [] : this.turns.queue.pending(run.member_id);
    if (!live || queued.length === 0) {
      if (live) live.inTurn = false;
      return null;
    }
    await this.turns.begin(runId);
    for (const m of queued) this.turns.queue.deliver(m.id, runId);
    this.audit(run.task_id, runId, "queue.flushed", { count: queued.length });
    this.emitTask(run.task_id, "queue");
    return joinMessages(queued.map((m) => m.text));
  }

  /**
   * The prompt a run starts or resumes with, plus the step's queued messages. A note left by an
   * undo only makes sense to the same conversation, so a new session drops it.
   */
  private withQueued(memberId: string, prompt: string, sameSession: boolean): { prompt: string; ids: string[] } {
    const queued = this.turns.queue.pending(memberId);
    const texts = queued.filter((m) => sameSession || m.kind !== "note").map((m) => m.text);
    return { prompt: joinMessages([prompt, ...texts]), ids: queued.map((m) => m.id) };
  }

  /** Profile and secrets for talking to a runner about a run's session (undo, transcript). */
  private async sessionFor(run: RunRow): Promise<{ profile: Profile; env: Record<string, string> } | null> {
    const candidate = await this.candidateFor(run);
    if (!candidate) return null;
    return { profile: candidate.profile, env: await this.directory.envFor(run.profile_id) };
  }

  /** Copies the runner's own transcript into the task folder (feature scan A18); returns our copy's path. */
  private async copyTranscript(runId: string): Promise<string | null> {
    const run = this.db.run(runId);
    const adapter = this.adapters.get(run.runner);
    if (!adapter || !run.native_session_id) return null;
    try {
      const session = await this.sessionFor(run);
      if (!session) return null;
      const copy = await snapshotTranscript({
        store: this.opts.store,
        dataDir: this.opts.dataDir,
        taskId: run.task_id,
        runId,
        adapter,
        req: { ...session, cwd: run.cwd, session: { runner: run.runner, sessionId: run.native_session_id } },
        now: this.now(),
      });
      if (copy) this.audit(run.task_id, runId, "transcript.copied", { bytes: copy.copiedBytes, sourceBytes: copy.sourceBytes, truncated: copy.truncated, kept: copy.kept });
      return copy?.path ?? null;
    } catch (err) {
      this.audit(run.task_id, runId, "transcript.failed", { detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      return null;
    }
  }

  // ---------------------------------------------------------------- requests

  requests(filter: { projectId?: string; taskId?: string; includeAnswered?: boolean }): RequestView[] {
    return this.db.requests(filter).map((q) => this.db.requestView(q));
  }

  async answer(requestId: string, answer: RequestAnswer, seen?: SessionSeen & { runId: string | null }): Promise<RequestView> {
    const q = this.db.request(requestId);
    if (q.answered_at) throw new OrchestratorError("request.answered");
    if (answer.kind !== "cancel" && answer.kind !== q.kind) throw new OrchestratorError("request.answer_kind");
    const payload = JSON.parse(q.payload) as RequestPayload;
    const run = q.run_id ? this.db.run(q.run_id) : null;
    if (seen && seen.runId !== q.run_id) throw new OrchestratorError("run.session_changed", { runId: q.run_id ?? "" });
    if (run) this.checkSeen(run, seen);
    // A reason goes to the agent as typed, trimmed and bounded; an empty one is no reason.
    if (answer.kind === "approval") answer = withReason(answer);
    const live = run ? this.live.get(run.id) : undefined;

    if (answer.kind === "approval" && answer.decision === "allow_always" && q.risk === "high") throw new OrchestratorError("request.always_high_risk");
    // A worktree bootstrap step is answered by the daemon itself, so its run need not be live (it is held).
    const boot = payload.kind === "approval" ? (payload.bootstrap ?? null) : null;
    if ((answer.kind === "approval" || answer.kind === "question") && !live && !boot) throw new OrchestratorError("run.not_live");
    let target: CandidateView | null = null;
    if (answer.kind === "handoff" && payload.kind === "handoff") {
      if (answer.decision === "hand_off") {
        target = await this.resolveTarget(run!, answer.targetProfileId ?? payload.proposedTarget?.profileId ?? null, payload);
        if (!target) throw new OrchestratorError("request.no_target");
      }
      if (answer.decision === "wait_for_reset" && !payload.resetsAt) throw new OrchestratorError("request.no_reset");
      if (answer.decision === "continue" && ((payload.trigger !== "budget" && payload.trigger !== "unpriced") || !run)) throw new OrchestratorError("request.not_budget");
    }

    this.db.exec("update requests set answered_at = ?, answer = ?, answered_by = 'user' where id = ?", this.iso(), JSON.stringify(answer), q.id);
    this.emitRequest(q.id);
    this.audit(q.task_id, q.run_id, "request.answered", { requestId: q.id, nativeId: q.native_id, by: "user", kind: answer.kind, ...(answer.kind === "approval" ? { decision: answer.decision, reason: Boolean(answer.message) } : {}) });

    if (live && run && q.native_id && (answer.kind === "approval" || answer.kind === "question" || answer.kind === "cancel")) {
      await this.safe(() => live.adapter.answer(live.handle, q.native_id!, toCoreAnswer(answer)));
    }
    if (answer.kind === "approval" && answer.decision === "allow_always" && payload.kind === "approval" && payload.command) {
      const task = this.db.task(q.task_id);
      this.db.exec("insert or ignore into allow_rules (project_id, command, added_at) values (?, ?, ?)", task.project_id, payload.command.trim(), this.iso());
    }
    if (boot && (answer.kind === "approval" || answer.kind === "cancel")) {
      const next = this.bootstrap.answered(q.id, answer.kind === "approval" ? answer.decision : "cancel");
      for (const id of next.ready) if (this.held.has(id) && !this.live.has(id)) this.track(this.proceed(id, ""));
      if (next.denied && !this.db.run(next.denied).ended_at) this.endRun(next.denied, "failed", "bootstrap.denied");
    }
    if (answer.kind === "handoff" && run && payload.kind === "handoff") {
      if (answer.decision === "hand_off" && target) this.track(this.performHandoff(run.id, target, payload.trigger === "handoff_failed" ? "limit" : payload.trigger === "unpriced" ? "budget" : payload.trigger));
      else if (answer.decision === "wait_for_reset" && payload.resetsAt) this.scheduleResume(run.id, payload.resetsAt);
      else if (answer.decision === "stop" && !run.ended_at) await this.stopRun(run.id, "user_stop", "limit");
      else if (answer.decision === "continue" && !run.ended_at) await this.continuePastCap(run.id);
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
      let candidates: Candidate[] | null = null;
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
              : (this.admission(task, m, chosen.profileId, config.rules.slots) ?? this.budgetHold(task, m, (candidates ??= await this.candidates(project)).find((c) => c.profile.id === chosen.profileId)));
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

  /**
   * A paid step waits in the queue while other unfinished runs hold the part of a cap it needs
   * (feature scan F3). If it would not fit even once they finish, it is not held here: it starts
   * and pauses with a cap request in the Inbox, as before.
   */
  private budgetHold(task: TaskRow, m: MemberRow, candidate: Candidate | undefined): Reason | null {
    if (candidate?.profile.credential.kind !== "api_key") return null;
    const amount = this.reservationFor(task, m, candidate);
    const cap = this.capFor(task.id, null, candidate, amount);
    if (!cap?.reservedUsd || overCap(cap.spentUsd, 0, amount, cap.capUsd)) return null;
    return { code: "admission.budget_reserved", params: { reservedUsd: cap.reservedUsd, capUsd: cap.capUsd, cap: cap.kind } };
  }

  /** What a paid step holds before it starts: its estimate less what earlier runs of the step already spent. */
  private reservationFor(task: TaskRow, m: MemberRow, candidate: Candidate): number {
    const usd = estimateFor(candidate, m.role, task.size).usd ?? 0;
    const spent = this.db.runs(task.id).filter((r) => r.member_id === m.id).reduce((n, r) => n + (r.cost_usd ?? 0), 0);
    return Math.max(0, usd - spent);
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
        // An undo rewrites the worktree; nothing starts in it until that is done.
        worktreeBusy: (m.writes_code === 1 && owner !== null && owner.ended_at === null) || this.turns.busy(task.id),
        profileId,
      },
      { ...DEFAULT_LIMITS, ...this.opts.limits, projectSlots },
    );
  }

  /**
   * Starts one run of a crew step. The run row goes in before any await, so admission control
   * counts it at once; a failure to start ends it as failed with a code.
   */
  private async launch(spec: LaunchSpec): Promise<string> {
    const { task, member, target } = spec;
    const project = this.db.project(task.project_id);
    const runId = spec.runId ?? randomUUID();
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
    await this.boot(runId, spec);
    return runId;
  }

  /**
   * Prepares the worktree and starts the process of a run row. A paid run whose key is past a
   * spend cap is held here instead, paused with an Inbox request, and booted once you approve.
   */
  private async boot(runId: string, spec: LaunchSpec): Promise<void> {
    const { task, member, target } = spec;
    const project = this.db.project(task.project_id);
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
      // A capped task never starts on a model nobody can price without your click (feature scan F4).
      const unpriced = this.unpricedFor(task, runId, candidate, target.model, estimateFor(candidate, member.role, task.size).usd === null);
      if (unpriced) {
        this.held.set(runId, spec);
        await this.onLimitReached(runId, { trigger: "unpriced", window: null, resetsAt: null, unpriced });
        return;
      }
      // Check and hold in one synchronous step, so a parallel step cannot slip in between (F3).
      const amount = candidate.profile.credential.kind === "api_key" ? this.reservationFor(task, member, candidate) : 0;
      const cap = this.capFor(task.id, runId, candidate, amount);
      if (cap) {
        this.held.set(runId, spec);
        await this.pauseForCap(runId, cap, this.iso());
        return;
      }
      // Worktree bootstrap: setup steps wait for their Inbox approval (the run is held, like a cap) and must pass.
      const boot = wt && worktreeId ? await this.bootstrap.prepare({ taskId: task.id, projectId: project.id, repoPath: wt.repo_path, path: wt.path, branch: wt.branch }, runId, config) : null;
      if (boot?.status === "waiting") {
        this.held.set(runId, spec);
        return;
      }
      this.held.delete(runId);
      if (candidate.profile.credential.kind === "api_key") reserveSpend(this.opts.store.db, { runId, taskId: task.id, credentialId: spendCredential(candidate), amountUsd: amount }, this.now());
      // Messages typed for the step while it had no process go with the first prompt.
      const base = spec.prompt ?? rolePrompt(member.role, task, { plan: this.latestPlan(task.id), branch: worktreeId ? (wt?.branch ?? null) : null });
      const queued = this.withQueued(member.id, base, Boolean(spec.resumeRef));
      const req: StartRequest = {
        profile: candidate.profile,
        cwd,
        model: target.model,
        prompt: queued.prompt,
        policy: this.policyFor(member.role, config),
        env: { ...(await this.directory.envFor(target.profileId)), ...(boot?.status === "ready" ? boot.env : {}) },
        outputSchema: outputSchemaFor(member.role),
        nextTurn: () => this.nextTurn(runId),
      };
      await this.turns.begin(runId);
      const handle = spec.resumeRef ? await adapter.resume(spec.resumeRef, req) : await adapter.start(req);
      for (const id of queued.ids) this.turns.queue.deliver(id, runId);
      this.db.exec("update runs set native_session_id = ?, pid = ? where id = ?", handle.nativeSession?.sessionId ?? null, handle.pid, runId);
      this.attach(runId, adapter, handle, candidate);
      this.audit(task.id, runId, "run.started", { role: member.role, profileId: target.profileId, runner: target.runner, resumed: Boolean(spec.resumeRef) });
    } catch (err) {
      this.held.delete(runId);
      this.confirming.delete(runId);
      // The reason stays with the run (redacted), so the UI can say why it never started.
      this.endRun(runId, "failed", errorDetail(err, await this.secretsFor(target.profileId)));
    }
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
    // Every start and resume hands over a prompt, so a turn runs from here; its boundary takes what is queued.
    const live: Live = { adapter, handle, candidate, done: new Promise<void>((r) => (finish = r)), inTurn: true };
    this.live.set(runId, live);
    this.track(this.pump(runId, live).finally(finish));
  }

  private async pump(runId: string, live: Live): Promise<void> {
    let ended: Ended | null = null;
    try {
      for await (const ev of live.adapter.events(live.handle)) {
        if (this.live.get(runId) !== live) return;
        if (this.confirming.has(runId)) await this.confirmHandoff(runId);
        if (ev.type === "run.ended") {
          this.record(runId, ev);
          applyResult(this.db, runId, ev, (kind, payload) => this.audit(this.db.run(runId).task_id, runId, kind, payload));
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
      case "turn.started":
        this.turns.ref(runId, ev.turnRef);
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
    // Runners report provider errors as they got them; what we keep and show is redacted and bounded.
    const detail = ended.detail === null ? null : redactDetail(ended.detail, await this.secretsFor(run.profile_id)) || null;
    this.endRun(runId, ended.reason, detail);
    if (ended.reason === "failed") await this.onFailure(runId, detail);
  }

  private endRun(runId: string, reason: EndReason, detail: string | null): void {
    const run = this.db.run(runId);
    if (run.ended_at) return;
    this.db.exec("update runs set ended_at = ?, end_reason = ?, end_detail = ? where id = ? and ended_at is null", this.iso(), reason, detail, runId);
    this.clearTimer(runId);
    this.held.delete(runId);
    this.turns.end(runId);
    // The runner may expire its own record; ours stays with the task (feature scan A18).
    if (run.native_session_id) this.track(this.copyTranscript(runId));
    settleReservation(this.opts.store.db, runId, this.now());
    // A handoff target that ends before it confirmed leaves the source paused and asks you.
    const pendingHandoff = this.confirming.get(runId);
    if (pendingHandoff) {
      this.confirming.delete(runId);
      this.track(this.failHandoff(pendingHandoff, detail ?? "target_ended"));
    }
    // Nobody is left to receive these answers; they close instead of lingering as "needs input".
    // A run that finished its work needs no hand off either (e.g. a cap tripped on its last report).
    for (const q of this.db.openRequestsForRun(runId).filter((q) => q.kind !== "handoff" || reason === "completed")) this.closeRequest(q, "system");
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
    const run = this.db.run(runId);
    // What you queued while it was paused goes with the continue prompt, in the same turn.
    const queued = this.withQueued(run.member_id, text, true);
    if (live) {
      live.inTurn = true;
      await this.turns.begin(runId);
      await live.adapter.send(live.handle, { kind: "text", text: queued.prompt });
      for (const id of queued.ids) this.turns.queue.deliver(id, runId);
      return;
    }
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
      prompt: queued.prompt,
      policy: this.policyFor(run.role, this.config(project).config),
      env: { ...(await this.directory.envFor(run.profile_id)), ...this.bootstrapEnv(run, project) },
      outputSchema: outputSchemaFor(run.role),
      nextTurn: () => this.nextTurn(runId),
    };
    await this.turns.begin(runId);
    const handle = await adapter.resume({ runner: run.runner, sessionId: run.native_session_id }, req);
    for (const id of queued.ids) this.turns.queue.deliver(id, runId);
    this.db.exec("update runs set native_session_id = ?, pid = ? where id = ?", handle.nativeSession?.sessionId ?? run.native_session_id, handle.pid, runId);
    this.attach(runId, adapter, handle, candidate);
  }

  /** Continues a run however it can: a live turn, a native resume, or a first start if a cap held it. */
  private async proceed(runId: string, text: string): Promise<void> {
    const spec = this.held.get(runId);
    if (spec && !this.live.has(runId)) {
      this.held.delete(runId);
      await this.boot(runId, { ...spec, task: this.db.task(spec.task.id) });
      return;
    }
    await this.continueRun(runId, text);
  }

  /** "Continue" on a budget request: the approval is stored on the request, so later checks skip that cap for this run. */
  private async continuePastCap(runId: string): Promise<void> {
    const run = this.db.run(runId);
    this.clearTimer(runId);
    this.db.exec("update runs set limit_reached = 0, paused_at = null, resume_at = null where id = ?", runId);
    this.audit(run.task_id, runId, "run.cap_approved", {});
    try {
      await this.proceed(runId, "Spending past the cap was approved. Continue the task where you stopped.");
      this.emitTask(run.task_id, "run_resumed");
    } catch (err) {
      this.db.exec("update runs set paused_at = ? where id = ?", this.iso(), runId);
      await this.offerHandoff(this.db.run(runId), this.db.task(run.task_id), "manual", { trigger: "budget", window: null, resetsAt: null }, errorCode(err));
    }
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
      if (live) await this.safe(() => live.adapter.answer(live.handle, ev.requestId, { kind: "approval", decision, ...(rule ? { message: POLICY_DENIAL[rule] ?? rule } : {}) }));
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
    // The timeline pairs this with the runner's request event, so a policy answer does not read as waiting.
    if (answeredByPolicy) this.audit(taskId, runId, "request.answered", { requestId: id, nativeId, by: "policy", kind: answeredByPolicy.kind });
    else this.emitTask(taskId, "request");
    return id;
  }

  private closeRequest(q: RequestRow, by: "system" | "policy"): void {
    const closed = this.db.db.prepare("update requests set answered_at = ?, answer = ?, answered_by = ? where id = ? and answered_at is null").run(this.iso(), JSON.stringify({ kind: "cancel" }), by, q.id);
    if (Number(closed.changes) > 0) this.audit(q.task_id, q.run_id, "request.answered", { requestId: q.id, nativeId: q.native_id, by, kind: "cancel" });
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
    if (live && dCost !== null) {
      recordRunSpend(
        this.opts.store.db,
        live.candidate,
        {
          taskId: task.id,
          runId: run.id,
          profileId: run.profile_id,
          model: run.model ?? model?.id ?? null,
          tokensIn: dIn,
          tokensOut: dOut,
          tokensCache: dCache,
          tokensReasoning: ev.reasoning,
          costUsd: dCost,
          billed: ev.costUsd !== null && ev.costProvenance === "reported",
          fromCatalog: ev.costUsd === null,
        },
        this.now(),
      );
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
    if (run.limit_reached === 0) {
      // Tokens nobody could price count against no cap, so a capped task stops and asks (F4).
      const unpriced = dCost === null && dIn + dOut + dCache > 0 ? this.unpricedFor(task, run.id, live?.candidate, run.model, true) : null;
      const cap = unpriced ? null : this.capFor(task.id, run.id, live?.candidate);
      if (unpriced) await this.onLimitReached(run.id, { trigger: "unpriced", window: null, resetsAt: null, unpriced });
      else if (cap) await this.pauseForCap(run.id, cap, ev.at);
    }
  }

  /**
   * The first spend limit this run may not pass: the key's daily cap, its per-task cap, then the
   * task's own budget. Committed spend counts what other unfinished runs still hold, and `addUsd`
   * (a step's estimate before it starts) must fit too. Caps you approved for this run with
   * "continue" are skipped; plans and local models never spend, so only paid keys are held.
   */
  private capFor(taskId: string, runId: string | null, candidate: Candidate | undefined, addUsd = 0, alsoApproved: Set<string> = new Set()): SpendCap | null {
    if (candidate?.profile.credential.kind !== "api_key") return null;
    const approved = new Set([...(runId ? this.approvalsFor(runId) : []), ...alsoApproved]);
    const db = this.opts.store.db;
    const caps = reachedCaps(db, spendCredential(candidate), taskId, this.now(), { addUsd, excludeRunId: runId });
    const task = this.db.task(taskId);
    if (task.budget_usd !== null) {
      const spent = this.db.spend(this.db.runs(taskId)).usd;
      const held = reservedUsd(db, { taskId, excludeRunId: runId });
      if (spent !== null && overCap(spent, held, addUsd, task.budget_usd)) {
        caps.push({ kind: "task_budget", spentUsd: spent, capUsd: task.budget_usd, credentialId: null, ...(held > 0 ? { reservedUsd: held } : {}), ...(addUsd > 0 ? { estimateUsd: addUsd } : {}) });
      }
    }
    return caps.find((c) => !approved.has(c.kind)) ?? null;
  }

  /**
   * Feature scan F4: spend on a model without a price (no catalog price, and the runner gave none)
   * counts against no cap. So on a paid key, a task with any cap (its budget, the key's daily or
   * per-task cap) needs your "continue" in the Inbox first. Without any cap there is nothing to protect.
   */
  private unpricedFor(task: TaskRow, runId: string, candidate: Candidate | undefined, model: string | null, unknownPrice: boolean): UnpricedSpend | null {
    if (!unknownPrice || candidate?.profile.credential.kind !== "api_key") return null;
    if (this.db.approvedCaps(runId).has("unpriced")) return null;
    const keyCaps = credentialCaps(this.opts.store.db, spendCredential(candidate));
    const caps: UnpricedSpend["caps"] = [];
    if (keyCaps?.dailyUsd != null) caps.push("daily_cap");
    if (keyCaps?.taskUsd != null) caps.push("task_cap");
    if (task.budget_usd !== null) caps.push("task_budget");
    return caps.length > 0 ? { model: model ?? candidate.model?.id ?? candidate.profile.defaultModel, caps } : null;
  }

  /**
   * Caps you approved for this run, plus a "continue" past the task's own budget given to the run
   * a manual handoff ("Change AI") continues: that budget belongs to the step, and moving the step
   * is your own click. Key caps stay with their key, and a resume or retry still asks again.
   */
  private approvalsFor(runId: string): Set<string> {
    const out = this.db.approvedCaps(runId);
    for (const k of this.stepApprovals(this.db.run(runId))) out.add(k);
    return out;
  }

  private stepApprovals(run: RunRow): Set<string> {
    const out = new Set<string>();
    let r = run;
    for (let guard = 0; guard < 50; guard++) {
      const h = this.db.handoffInto(r.id);
      if (h?.trigger_kind !== "manual") break;
      r = this.db.run(h.from_run_id);
      if (this.db.approvedCaps(r.id).has("task_budget")) out.add("task_budget");
    }
    return out;
  }

  /** The run waits on an unanswered unknown-price request; only that answer lets it go on. */
  private unpricedOpen(runId: string): boolean {
    return this.db.openRequestsForRun(runId).some((q) => q.kind === "handoff" && (JSON.parse(q.payload) as Extract<RequestPayload, { kind: "handoff" }>).trigger === "unpriced");
  }

  /**
   * Feature scan F11: a stop, pause, message or answer acts only on the run and session you saw. If
   * a handoff, resume or retry took over the step, or the native session changed, it is refused
   * and the UI re-reads. Internal callers pass nothing and are not checked.
   */
  private checkSeen(run: RunRow, seen: SessionSeen | undefined): void {
    if (!seen) return;
    // A handoff target that failed never took the step over, so the source's own questions stay answerable.
    const next = this.db.successor(run);
    if (next) throw new OrchestratorError("run.session_changed", { runId: next.id });
    if (seen.sessionId !== null && run.native_session_id !== seen.sessionId) throw new OrchestratorError("run.session_changed", { runId: run.id });
  }

  private async pauseForCap(runId: string, cap: SpendCap, at: string): Promise<void> {
    const run = this.db.run(runId);
    const resetsAt = capResetsAt(cap, this.now());
    this.limits.ingest({ profileId: run.profile_id, window: capWindow(cap), usedPct: 100, resetsAt, provenance: "estimated", observedAt: at }, { runId, taskId: run.task_id, reached: true });
    await this.onLimitReached(runId, { trigger: "budget", window: capWindow(cap), resetsAt, cap });
  }

  /** The candidate a run uses: its live one, or a fresh read from the directory. */
  private async candidateFor(run: RunRow): Promise<Candidate | undefined> {
    const live = this.live.get(run.id);
    if (live) return live.candidate;
    const project = this.db.project(this.db.task(run.task_id).project_id);
    return (await this.candidates(project)).find((c) => c.profile.id === run.profile_id);
  }

  private superseded(run: RunRow): boolean {
    return this.db.successor(run) !== null;
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
    // A budget cap, or a model without a price, never continues on a paid key without your click.
    let mode: FallbackMode = info.trigger === "budget" || info.trigger === "unpriced" ? "manual" : task.fallback;
    if (mode === "wait_for_reset") {
      if (info.resetsAt && Date.parse(info.resetsAt) - this.now().getTime() <= task.wait_reset_minutes * 60_000) {
        this.scheduleResume(runId, info.resetsAt);
        return;
      }
      mode = "ask";
    }
    await this.offerHandoff(this.db.run(runId), task, mode, info, null);
  }

  /**
   * A run that failed after it started (feature scan F8). A request every provider would refuse
   * stays failed: no handoff, no fallback, no retry. A transient error moves to the next profile at
   * once when Auto has one, and otherwise retries the same profile after a jittered backoff, a few
   * times. Anything else, and a transient error out of retries, is handed off like a limit, per
   * the task's mode.
   */
  private async onFailure(runId: string, detail: string | null): Promise<void> {
    const run = this.db.run(runId);
    const task = this.db.task(run.task_id);
    if (task.cancelled_at) return;
    const failure = classifyFailure(detail);
    this.audit(task.id, runId, "run.failure", { kind: failure.kind, status: failure.status, retryAfterMs: failure.retryAfterMs });
    if (failure.kind === "request_invalid") return;
    const mode = task.fallback === "wait_for_reset" ? "ask" : task.fallback;
    // An empty prepaid balance is a spend stop, not a crash: no retry on the same key, and the
    // handoff (per the task's mode) only offers keys that are not the one out of credit.
    if (failure.kind === "credit") {
      await this.offerHandoff(run, task, mode, { trigger: "limit", window: null, resetsAt: null, failure: "credit" }, "credit_depleted");
      return;
    }
    if (failure.kind === "transient") {
      // Never wait when the next step is another profile: Auto with a target switches now.
      const switching = mode === "auto" && this.handoffsTaken(run) < MAX_AUTO_HANDOFFS && (await this.handoffCandidates(run, task, { trigger: "crashed", failure: "transient" })).length > 0;
      const attempt = this.db.retryAttempt(run.id) + 1;
      const delay = !switching && attempt <= RETRY.max ? retryDelayMs(attempt, failure.retryAfterMs) : null;
      if (delay !== null) {
        this.scheduleRetry(run, attempt, delay, failure);
        return;
      }
    }
    await this.offerHandoff(run, task, mode, { trigger: "crashed", window: null, resetsAt: null, failure: failure.kind }, null);
  }

  private handoffsTaken(run: RunRow): number {
    return this.db.handoffs(run.task_id).filter((h) => this.db.run(h.from_run_id).member_id === run.member_id).length;
  }

  /** Same-profile retry after a transient error; the failed run shows when (resumeAt) until it starts. */
  private scheduleRetry(run: RunRow, attempt: number, delayMs: number, failure: Failure): void {
    const at = new Date(this.now().getTime() + delayMs).toISOString();
    this.clearTimer(run.id);
    this.db.exec("update runs set resume_at = ? where id = ?", at, run.id);
    this.audit(run.task_id, run.id, "run.retry_scheduled", { attempt, delayMs, failure: failure.kind, status: failure.status });
    const timer = setTimeout(() => {
      this.timers.delete(run.id);
      this.track(this.autoRetry(run.id, attempt, delayMs, failure));
    }, delayMs);
    timer.unref();
    this.timers.set(run.id, timer);
    this.emitTask(run.task_id, "retried");
  }

  private async autoRetry(runId: string, attempt: number, delayMs: number, failure: Failure): Promise<void> {
    const run = this.db.run(runId);
    const task = this.db.task(run.task_id);
    // A stop, retry, resume, handoff or cancel in the meantime cleared resume_at.
    if (run.resume_at === null || task.cancelled_at || this.superseded(run)) return;
    this.db.exec("update runs set resume_at = null where id = ?", runId);
    const adapter = this.adapters.get(run.runner);
    const native = Boolean(adapter?.capabilities.resume && run.native_session_id);
    const id = randomUUID();
    // Recorded before the run exists, so a run that fails at once already counts as this attempt.
    this.db.exec("insert into run_retries (run_id, from_run_id, attempt, failure, status, delay_ms, created_at) values (?, ?, ?, ?, ?, ?, ?)", id, run.id, attempt, failure.kind, failure.status, delayMs, this.iso());
    const resume = native
      ? { cwd: run.cwd, prompt: "The last attempt stopped on a temporary provider error. Check `git status`, then continue the task where you stopped.", resumeRef: { runner: run.runner, sessionId: run.native_session_id! } }
      : {};
    await this.launch({ runId: id, task, member: this.db.member(run.member_id), target: { profileId: run.profile_id, runner: run.runner, model: run.model }, ...resume, resumedFrom: run.id });
    this.audit(task.id, id, "run.auto_retry", { from: run.id, attempt, delayMs, native });
    this.emitTask(task.id, "retried");
  }

  /** Drops a pending same-profile retry; whatever you chose instead takes over the step. */
  private cancelAutoRetry(runId: string): void {
    this.clearTimer(runId);
    this.db.exec("update runs set resume_at = null where id = ? and ended_at is not null", runId);
  }

  private async offerHandoff(run: RunRow, task: TaskRow, mode: FallbackMode, info: HandoffInfo, detail: string | null): Promise<void> {
    const candidates = await this.handoffCandidates(run, task, info);
    if (mode === "auto" && candidates[0] && this.handoffsTaken(run) < MAX_AUTO_HANDOFFS) {
      this.track(this.performHandoff(run.id, candidates[0], info.trigger === "unpriced" ? "budget" : info.trigger));
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
      cap: info.cap ?? null,
      ...(info.unpriced ? { unpriced: info.unpriced } : {}),
    });
  }

  /**
   * Preflight (PLAN.md §8.2 step 2): standby candidates that are ready, have an adapter, keep the
   * role's permissions and the independence rule, have more than 20% headroom (Unknown passes and
   * says so) and fit the remaining budget. After a crash, a profile on the model that just failed
   * and a profile whose last run could not even start are skipped (both failed again in the live
   * run); after a credit stop, so is every profile on the key that ran out.
   */
  private async handoffCandidates(run: RunRow, task: TaskRow, info?: Pick<HandoffInfo, "trigger" | "failure">): Promise<CandidateView[]> {
    const project = this.db.project(task.project_id);
    const member = this.db.member(run.member_id);
    const all = await this.candidates(project);
    const ctx = this.scoring(project.id, task.size, task.budget_usd);
    const avoid = this.avoidFor(member);
    const chain = (JSON.parse(member.standby) as CandidateView[]).map((s) => s.profileId);
    const original = member.chosen ? (JSON.parse(member.chosen) as CandidateView).profileId : null;
    const order = [...chain, ...(original ? [original] : [])].filter((id, i, a) => a.indexOf(id) === i && id !== run.profile_id);
    const spent = this.db.spend(this.db.runs(task.id)).usd ?? 0;
    const crashed = info?.trigger === "crashed" || info?.failure === "credit";
    const failedModel = (run.model ?? `profile:${run.profile_id}`).toLowerCase();
    const source = all.find((c) => c.profile.id === run.profile_id);
    const emptyKey = info?.failure === "credit" && source ? spendCredential(source) : null;
    const usable = (c: Candidate) =>
      !(crashed && modelKey(c) === failedModel) && !(crashed && this.db.failedToStart(c.profile.id)) && !(emptyKey !== null && spendCredential(c) === emptyKey);
    return order
      .map((id) => all.find((c) => c.profile.id === id))
      .filter((c): c is Candidate => c !== undefined && eligible(c, member.role, ctx) && !avoid.models.has(modelKey(c)) && usable(c))
      // Budget left (PLAN.md §8.2 step 2): a key past its daily or task cap is no target.
      .filter((c) => reachedCaps(this.opts.store.db, spendCredential(c), task.id, this.now(), { excludeRunId: run.id }).length === 0)
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
    const handoffId = this.claimHandoff(source, task, target, trigger);
    if (!handoffId) return;
    await this.executeHandoff(handoffId, source.id, target, trigger);
  }

  /** The checks runs.handoff makes before it touches the source; each failure is an error code. */
  private async preflightTarget(source: RunRow, task: TaskRow, profileId: string): Promise<CandidateView> {
    const project = this.db.project(task.project_id);
    const member = this.db.member(source.member_id);
    const c = (await this.candidates(project)).find((x) => x.profile.id === profileId);
    if (!c) throw new OrchestratorError("crew.unknown_profile", { profileId });
    if (!c.ready || !this.adapters.has(c.profile.runner)) throw new OrchestratorError("handoff.target_not_ready", { profileId });
    if (readOnlyConflict(c, member.role)) throw new OrchestratorError("crew.read_only_profile", { profileId, role: member.role });
    const ctx = this.scoring(project.id, task.size, task.budget_usd);
    if (!eligible(c, member.role, ctx)) throw new OrchestratorError("crew.unknown_profile", { profileId });
    const avoid = this.avoidFor(member);
    if (avoid.models.has(modelKey(c))) throw new OrchestratorError("crew.independence", { role: member.role });
    // Your "continue" past the task budget on this step carries over to the AI you move it to.
    const stepApproved = new Set([...this.approvalsFor(source.id)].filter((k) => k === "task_budget"));
    const cap = this.capFor(task.id, null, c, 0, stepApproved);
    if (cap?.kind === "task_budget") throw new OrchestratorError("handoff.over_budget", { spentUsd: cap.spentUsd, capUsd: cap.capUsd });
    if (cap) throw new OrchestratorError("handoff.over_cap", { profileId, cap: cap.kind });
    return scoreCandidate(c, member.role, ctx, avoid);
  }

  /**
   * Claim: one open handoff per source run (also a unique index). A second click, or Auto racing
   * a click, gets null instead of starting a second target.
   */
  private claimHandoff(source: RunRow, task: TaskRow, target: CandidateView, trigger: HandoffTrigger): string | null {
    const handoffId = this.db.tx(() => {
      if (this.db.openHandoffs().some((h) => h.from_run_id === source.id)) return null;
      const id = randomUUID();
      this.db.exec(
        "insert into handoffs (id, task_id, from_run_id, target_profile_id, mode, trigger_kind, phase, opened_at) values (?, ?, ?, ?, ?, ?, 'stopping_source', ?)",
        id,
        task.id,
        source.id,
        target.profileId,
        trigger === "manual" ? "manual" : task.fallback,
        trigger,
        this.iso(),
      );
      return id;
    });
    if (!handoffId) return null;
    this.audit(task.id, source.id, "handoff.opened", { handoffId, target: target.profileId, trigger });
    this.emitTask(task.id, "handoff_opened");
    return handoffId;
  }

  private async executeHandoff(handoffId: string, sourceRunId: string, target: CandidateView, trigger: HandoffTrigger): Promise<void> {
    const source = this.db.run(sourceRunId);
    const task = this.db.task(source.task_id);
    const phase = (p: HandoffPhase) => this.db.exec("update handoffs set phase = ? where id = ? and closed_at is null", p, handoffId);
    try {
      // Stop the source at a turn boundary; never replay a half-finished tool call.
      const live = this.live.get(source.id);
      if (live) {
        this.db.exec("update runs set paused_at = coalesce(paused_at, ?) where id = ?", this.iso(), source.id);
        await this.safe(() => live.adapter.interrupt(live.handle));
        if (!(await this.within(live.done, this.opts.stopTimeoutMs ?? 30_000))) await this.safe(() => live.adapter.stop(live.handle));
      }
      // A source a cap held before it ever started has nothing to hand over: the target starts the step fresh.
      const neverStarted = !live && source.native_session_id === null && source.tokens_in + source.tokens_out === 0;
      this.held.delete(source.id);
      // The stopped source spends no more; its hold must not block the target on the same key.
      settleReservation(this.opts.store.db, source.id, this.now());

      phase("checkpoint");
      const wt = this.db.worktree(task.id);
      let sha: string | null = null;
      let stat: string | null = null;
      if (wt && sameDir(wt.path, source.cwd)) {
        sha = (await checkpoint(wt.path, `wip: handoff from ${source.id}`, this.opts.gitBin)).sha;
        stat = await diffStat(wt.path, wt.base_sha, this.opts.gitBin);
      }
      // The package cites our copy: the runner's own may expire before anyone reads it.
      const transcript = await this.copyTranscript(source.id);
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
        transcript: transcript ? `${transcript} (copy of the ${source.runner} session record; the event log of run ${source.id} is in the Crewyard database)` : `Event log of run ${source.id} in the Crewyard database.`,
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
        prompt: native ? "Continue the task." : neverStarted ? undefined : text,
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
    // A hand off you asked for is not a limit; the source simply stopped in favour of the target.
    this.endRun(h.from_run_id, h.trigger_kind === "manual" ? "stopped" : "limit", "handed_off");
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
      await this.proceed(runId, "Your usage window has reset. Continue the task where you stopped.");
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
      settleReservation(this.opts.store.db, r.id, this.now());
      for (const q of this.db.openRequestsForRun(r.id)) this.closeRequest(q, "system");
      this.audit(r.task_id, r.id, "run.recovered", { detail });
      tasks.add(r.task_id);
    }
    // Same-profile retries were timers of the last daemon; the failed run is offered for Retry instead.
    for (const r of this.db.pendingRetries()) {
      this.db.exec("update runs set resume_at = null where id = ?", r.id);
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

  /** Port and worktree variables for a run continuing in its task worktree (worktree bootstrap). */
  private bootstrapEnv(run: RunRow, project: ProjectRow): Record<string, string> {
    const wt = run.worktree_id ? this.db.worktree(run.task_id) : null;
    if (!wt || wt.id !== run.worktree_id) return {};
    return this.bootstrap.env({ taskId: run.task_id, projectId: project.id, repoPath: wt.repo_path, path: wt.path, branch: wt.branch }, this.config(project).config);
  }

  /** The profile's secret values, only to cut them out of error text; never stored or logged. */
  private async secretsFor(profileId: string): Promise<string[]> {
    try {
      const env = await this.directory.envFor(profileId);
      return Object.entries(env)
        .filter(([k, v]) => SECRET_ENV.test(k) && v.length >= 8)
        .map(([, v]) => v);
    } catch {
      return [];
    }
  }

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
    // The log and the window get a capped copy; the caller keeps the full event for its rules
    // (risk is classified on the whole command).
    const { event } = capEvent(ev, EVENT_LIMITS, (field, full) => this.keepFull(task.id, runId, ev.seq, field, full));
    this.opts.store.appendEvent({ kind: `run.${ev.type}`, source: ev.source.adapter, payload: event, projectId: task.project_id, taskId: task.id, runId });
    this.emit("runs.event", { taskId: task.id, runId, event });
  }

  /**
   * The full text of a cut tool output, in the task's folder under the data folder: the same
   * per-user place as the event log that already holds its head, never sent to the window or to an
   * agent. Past KEEP_FULL_MAX only the head is kept.
   */
  private keepFull(taskId: string, runId: string, seq: number, field: string, full: string): string | null {
    if (utf8Length(full) > KEEP_FULL_MAX) return null;
    const path = join(this.opts.dataDir, "tasks", taskId, "output", `${runId}-${seq}-${field}.txt`);
    try {
      writeFileAtomic(path, full);
      return path;
    } catch {
      return null;
    }
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

/** Child environment names that hold a secret (DEEPSEEK_API_KEY, ANTHROPIC_AUTH_TOKEN, ...). */
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|AUTH/i;

const RANK: Record<Provenance, number> = { reported: 2, estimated: 1, unknown: 0 };
const weakest = (a: Provenance, b: Provenance): Provenance => (RANK[a] <= RANK[b] ? a : b);

/** Plain words for the agent when a role policy denies a call, so it adapts instead of retrying. */
const POLICY_DENIAL: Record<string, string> = {
  "policy.role_read_only": "Denied by Crewyard: this role is read-only and may not change files.",
  "policy.role_docs_only": "Denied by Crewyard: this role may only change documentation files.",
  "policy.role_no_network": "Denied by Crewyard: this role has no network access.",
};

/** Longest deny reason passed on; a reason is a sentence or two, not a document. */
const MAX_REASON = 2_000;

function withReason(a: Extract<RequestAnswer, { kind: "approval" }>): Extract<RequestAnswer, { kind: "approval" }> {
  const reason = a.decision === "deny" ? a.message?.trim().slice(0, MAX_REASON) : undefined;
  return { kind: "approval", decision: a.decision, ...(reason ? { message: reason } : {}) };
}

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

