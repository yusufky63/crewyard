import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { freemem } from "node:os";
import { join, resolve } from "node:path";
import {
  type AccountSwitchSkipped,
  capEvent,
  classifyRisk,
  estimateCost,
  EVENT_LIMITS,
  peakFactor,
  type ProjectConfig,
  requestCost,
  type AgentAdapter,
  type AgentEvent,
  type Attachment,
  type Answer,
  type CandidateView,
  type CrewEdit,
  type EndReason,
  type FallbackMode,
  type ForkResult,
  type HandoffStop,
  type LoopDecisionKind,
  type HandoffPhase,
  type HandoffTrigger,
  type LimitWindow,
  type NativeSessionRef,
  type Profile,
  type Provenance,
  type Reason,
  type ReviewTarget,
  type RequestAnswer,
  type RequestPayload,
  type RequestView,
  type RoleId,
  type RolePolicy,
  type RunHandle,
  type RunnerId,
  type RunView,
  type SessionProblem,
  type SessionSeen,
  type SpendCap,
  type StartRequest,
  type TaskChangeCause,
  type TaskDetail,
  type TaskSize,
  type TaskSummary,
  type BestOfView,
  type TasksIpc,
  type TasksTopics,
  type UnpricedSpend,
  sessionProblemOf,
  type UserInput,
  utf8Length,
  withAttachments,
} from "@crewyard/core";
import type { McpHook } from "../mcp/service.ts";
import type { Store } from "../store.ts";
import { Bootstrapper } from "../worktrees/bootstrap.ts";
import { admit, admitGroup, DEFAULT_LIMITS, type AdmissionLimits } from "./admission.ts";
import { BEST_OF_MAX, BEST_OF_MIN, BestOfStore, groupFact, groupPhase, pickVariants, worktreeDiff, type DiffStat, type GroupRow } from "./best-of.ts";
import { AdapterRegistry } from "./adapters.ts";
import { AttachmentStore } from "./attachments.ts";
import { accountOf, AccountSwitches, isClaudeSubscription, refusalOf, sameProviderAccounts, sourceOf, switchOrder, switchTrigger } from "./account-switch.ts";
import { classifyTask } from "./classify.ts";
import { eligible, estimateFor, MIN_HEADROOM, modelKey, proposeCrew, rankForRole, readOnlyConflict, sameModel, scoreCandidate, sumEstimates, type ScoringContext } from "./crew.ts";
import { OrchestratorDb, type MemberRow, type ProjectRow, type RequestRow, type RunRow, type TaskRow, type WorktreeRow } from "./db.ts";
import { EMPTY_DIRECTORY, type Candidate, type ProfileDirectory } from "./directory.ts";
import { errorCode, errorDetail, OrchestratorError, redactDetail } from "./errors.ts";
import { classifyFailure, RETRY, retryDelayMs, type Failure, type FailureClass } from "./failures.ts";
import { addDetachedCheckout, checkpoint, diffStat, ensureWorktree, git, headSha, isClean, removeDetachedCheckout, taskSlug, writeFileAtomic } from "./git.ts";
import { LoopStore, reviewChangesMessage, reviewContext, testFailureMessage } from "./loops.ts";
import { snapshot } from "./checkpoints.ts";
import { runSteps } from "../worktrees/steps.ts";
import { applyResult, outputSchemaFor, type RoleResult } from "./results.ts";
import { LimitMonitor } from "./limits.ts";
import { forkPrompt, handoffPackage, rolePrompt } from "./prompts.ts";
import { projectRoles } from "./role-files.ts";
import { effectivePolicy, onlyDocPaths, type RoleTemplate } from "./roles.ts";
import { capResetsAt, capWindow, credentialCaps, overCap, reachedCaps, recordRunSpend, reservedUsd, reserveSpend, settleReservation, spendCredential } from "./spend.ts";
import { joinMessages } from "./queue.ts";
import { answerAfterSleep, canHibernate, HibernationStore, idleSince, type WakeCause } from "./hibernation.ts";
import { Scheduler } from "./schedules.ts";
import { StallMonitor } from "./stall.ts";
import { snapshotTranscript, transcriptPath } from "./transcripts.ts";
import { TurnControl } from "./turns.ts";
import { effectiveProjectConfig } from "../setup/index.ts";

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
  /** How long a "drain" handoff waits for the turn in flight before it interrupts it. */
  drainTimeoutMs?: number;
  /** MCP servers per run process and the report server's ticket lifecycle (docs/adr/0007). */
  mcp?: McpHook;
  /** How often scheduled tasks look for due slots. 0 disables the timer; tests call schedules.check(). */
  scheduleCheckMs?: number;
  /** How often idle runs are checked for hibernation. 0 disables the timer; tests call checkHibernation(). */
  hibernateCheckMs?: number;
}

interface Live {
  adapter: AgentAdapter;
  handle: RunHandle;
  candidate: Candidate;
  done: Promise<void>;
  /** A turn is running: follow-ups wait in the step's queue for its boundary (StartRequest.nextTurn). */
  inTurn: boolean;
  /** The runner has reported that turn (turn.started); a turn handed over but not begun cannot take a steer. */
  turnBegun: boolean;
  /** The Test step runs the project tests at this run's turn boundary; the agent is idle meanwhile. */
  testing?: boolean;
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
  /**
   * Handoff by fork (feature scan A11): copy this source run's session into the target profile
   * (compacted where the runner can) and resume the copy. Any failure falls back to `prompt`, the
   * written package, in a new session.
   */
  fork?: { sourceRunId: string; prompt: string } | null;
  /** This run replaces a session the runner said is gone or locked; it never replaces again. */
  replacing?: boolean;
};

/** How many handoffs one crew step may take on its own before it asks you (the standby chain is 2 long). */
const MAX_AUTO_HANDOFFS = 2;

/** Longest the Test step may run the project's test command. */
const TEST_TIMEOUT_SEC = 900;

/** Longest a "drain" handoff waits for the turn in flight to end before it interrupts it. */
const DRAIN_TIMEOUT_MS = 10 * 60_000;

/** Roles that read a pinned, detached checkout of the commit they review instead of the live worktree. */
const PINNED_ROLES: RoleId[] = ["reviewer", "security"];

/** Parking a discarded Best of N variant: tries, and the wait before the next one (times the try). */
const PARK_ATTEMPTS = 3;
const PARK_RETRY_MS = 1_500;

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
  /** Best of N groups and their variant tasks (best-of.ts). */
  readonly bestOf: BestOfStore;
  /** Scheduled tasks and their daemon-side timer (schedules.ts). */
  readonly schedules: Scheduler;
  /** Idle runs whose process was stopped and that wake by session id (hibernation.ts). */
  readonly hibernation: HibernationStore;
  /** Same-provider account switches and the tasks held out of them (account-switch.ts, docs/adr/0009). */
  readonly switches: AccountSwitches;
  /** Images and files on task descriptions and queued messages (attachments.ts). */
  readonly attachments: AttachmentStore;
  private hibernateTimer: NodeJS.Timeout | null = null;
  /** Runs whose process is being stopped for hibernation: the stream's end must not end the run. */
  private readonly hibernating = new Set<string>();
  /** Hibernated runs that should wake but wait for an admission slot, with why they wake. */
  private readonly pendingWake = new Map<string, WakeCause>();
  private stallTimer: NodeJS.Timeout | null = null;
  private directory: ProfileDirectory;
  private mcp: McpHook | null;
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
  /** Loop decisions, test results, pinned verdicts, review checkouts, run epochs (loops.ts). */
  readonly loops: LoopStore;
  /** Implementer runs whose loop stopped (cap, no change): they end failed with this detail, not completed. */
  private readonly loopFailed = new Map<string, string>();
  /** Reviewer runs that ended with a verdict; the review loop acts on it once the run has ended. */
  private readonly verdicts = new Map<string, RoleResult>();
  /** Runs started with a native resume, so a "session gone/locked" end can fall back to a fresh run. */
  private readonly resumed = new Set<string>();
  /** Runs whose reviewer reads through the runner's own review (Codex review/start). */
  private readonly nativeReviews = new Set<string>();
  /** Drain handoffs: called at the source's next turn boundary. */
  private readonly draining = new Map<string, () => void>();
  /** Drain handoffs: lets the held turn boundary return once the source has been stopped. */
  private readonly drainRelease = new Map<string, (v: null) => void>();
  /** Spend of a fork's compaction, recorded on the target run once it is attached. */
  private readonly forkSpend = new Map<string, ForkResult>();
  private ticking = false;
  private tickAgain = false;
  private closed = false;
  private interval: NodeJS.Timeout | null = null;

  constructor(private readonly opts: OrchestratorOptions) {
    this.db = new OrchestratorDb(opts.store.db);
    this.adapters = opts.adapters ?? new AdapterRegistry();
    this.directory = opts.directory ?? EMPTY_DIRECTORY;
    this.mcp = opts.mcp ?? null;
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
    this.stalls = new StallMonitor({ store: opts.store, db: this.db, now: this.now, inTurn: (runId) => Boolean(this.live.get(runId)?.inTurn && !this.live.get(runId)?.testing), emit: (topic, payload) => this.emit(topic, payload) });
    this.attachments = new AttachmentStore(opts.store.db, opts.dataDir, this.now);
    try {
      this.attachments.sweep();
    } catch {
      // A locked staging folder is swept on the next start.
    }
    this.db.runExtras = (r) => ({
      queue: this.turns.queue.pending(r.member_id).map((m) => {
        const attachments = this.attachments.messageViews(m.id);
        return attachments.length > 0 ? { ...m, attachments } : m;
      }),
      controls: this.turns.controls(r),
      transcriptPath: transcriptPath(opts.store, r.id),
    });
    this.loops = new LoopStore(opts.store.db, this.now);
    this.bestOf = new BestOfStore(opts.store.db, this.now);
    this.hibernation = new HibernationStore(opts.store.db, this.now);
    this.switches = new AccountSwitches(opts.store.db, this.now, (topic, payload) => this.emit(topic, payload));
    this.db.hibernatedAt = (runId) => this.hibernation.asleep(runId)?.hibernated_at ?? null;
    this.schedules = new Scheduler({
      db: opts.store.db,
      now: this.now,
      emit: (topic, payload) => this.emit(topic, payload),
      propose: (p) => this.propose(p),
      approve: (p) => this.approve(p),
      status: (taskId) => {
        try {
          return this.db.status(this.db.task(taskId));
        } catch {
          return null;
        }
      },
      projectPath: (projectId) => this.db.project(projectId).path,
      audit: (projectId, taskId, kind, payload) => opts.store.appendEvent({ kind, source: "orchestrator", payload, projectId, taskId }),
      track: (p) => this.track(p),
    });
    this.db.taskExtras = (t) => this.taskExtras(t);
    this.db.taskLoop = (t) => this.loopView(t);
    this.db.handoffStop = (id) => this.loops.handoffStop(id);
  }

  /** A verdict may be stale once any writer of the task started after it: the head can have moved. */
  private loopView(task: TaskRow) {
    const writers = this.db.runs(task.id).filter((r) => r.worktree_id !== null && this.db.member(r.member_id).writes_code === 1);
    const max = this.config(this.db.project(task.project_id)).config.loop.maxIterations;
    return this.loops.view(task.id, max, (at) => writers.some((r) => r.started_at > at));
  }

  /** Recovers from the last session, then starts scheduling. */
  start(): void {
    this.recover();
    const ms = this.opts.tickMs ?? 5_000;
    if (ms > 0) this.interval = setInterval(() => void this.tick(), ms).unref();
    const stallMs = this.opts.stallCheckMs ?? 30_000;
    if (stallMs > 0) this.stallTimer = setInterval(() => this.checkStalls(), stallMs).unref();
    const hibernateMs = this.opts.hibernateCheckMs ?? 30_000;
    if (hibernateMs > 0) this.hibernateTimer = setInterval(() => void this.checkHibernation(), hibernateMs).unref();
    const scheduleMs = this.opts.scheduleCheckMs ?? 30_000;
    this.schedules.start(scheduleMs);
    // Slots missed while the app was closed are caught up now (at most MAX_CATCH_UP of them).
    if (scheduleMs > 0) this.track(this.schedules.check());
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
    this.schedules.stop();
    if (this.hibernateTimer) clearInterval(this.hibernateTimer);
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

  /** Called by the MCP work (handlers/mcp.ts) once its service exists. */
  setMcp(hook: McpHook): void {
    this.mcp = hook;
  }

  /** The MCP servers for a new process of this run; a fresh report ticket each time (docs/adr/0007). */
  private async mcpFor(runId: string, taskId: string, projectId: string, policy: RolePolicy, adapter: AgentAdapter): Promise<Pick<StartRequest, "mcpServers">> {
    const servers = this.mcp ? await this.mcp.serversFor({ runId, taskId, projectId, policy, capabilities: adapter.capabilities }) : undefined;
    return servers ? { mcpServers: servers } : {};
  }

  /** Waits until background work (pumps, handoffs, ticks) has settled; for tests and shutdown. */
  async settle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  // ---------------------------------------------------------------- tasks

  /** The task list; a Best of N variant's hidden task shows inside its parent, not as a row. */
  list(projectId?: string): TaskSummary[] {
    const variants = this.bestOf.variantTaskIds();
    return this.db
      .tasks(projectId)
      .filter((t) => !variants.has(t.id))
      .map((t) => this.db.summary(t));
  }

  get(taskId: string): TaskDetail {
    const task = this.db.task(taskId);
    const attachments = this.attachments.taskViews(task.id);
    return { ...this.db.detail(task, this.blocked), bestOfGroup: this.groupView(task), accountSwitch: this.switches.taskEnabled(task.id), ...(attachments.length > 0 ? { attachments } : {}) };
  }

  /** Classifies the task and stores a draft crew. No process, worktree or network call. */
  async propose(p: ProposeParams): Promise<TaskDetail> {
    const project = this.db.project(p.projectId);
    const { config, fromFile } = this.config(project);
    const description = p.description ?? "";
    const attachmentIds = p.attachments ?? [];
    this.attachments.check(attachmentIds);
    const cls = classifyTask(p.title, description, { kind: p.kind, size: p.size });
    const budgetUsd = p.budgetUsd ?? (fromFile ? config.budget.perTaskUsd : null);
    const candidates = await this.candidates(project);
    const ctx = this.scoring(project.id, cls.size, budgetUsd, p.pins, p.exclude);
    const roles = projectRoles(this.opts.dataDir, project.path, config, null);
    const crew = proposeCrew(cls.kind, cls.security, candidates, ctx, { templates: new Map([...roles.set.roles].map(([id, r]) => [id, r.template])), steps: roles.steps });
    for (const m of crew.members) {
      const path = roles.set.roles.get(m.role)?.path;
      if (path) m.reasons.unshift({ code: "role.file", params: { path } });
    }
    const group = p.bestOf === undefined ? null : this.groupCandidates(crew.members, candidates, ctx, p.bestOf);
    const estimate = group ? sumEstimates(crew.members.flatMap((m, i) => (i === group.index ? group.candidates.map((c) => c.estimate) : [m.chosen?.estimate ?? { usd: null, provenance: "unknown" as const }]))) : crew.estimate;
    const taskId = randomUUID();
    const crewId = randomUUID();
    const memberIds = crew.members.map(() => randomUUID());
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
      this.db.exec("insert into crews (id, task_id, proposed_at, estimate_usd, estimate_provenance) values (?, ?, ?, ?, ?)", crewId, taskId, at, estimate.usd, estimate.provenance);
      crew.members.forEach((m, i) =>
        this.db.exec(
          `insert into crew_members (id, crew_id, position, step, role, depends_on, required, writes_code, chosen, standby, reasons)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          memberIds[i]!,
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
      crew.members.forEach((m, i) => {
        const r = roles.set.roles.get(m.role);
        if (r && r.source !== "builtin") this.db.saveRoleTemplate(memberIds[i]!, r);
      });
      if (group) this.bestOf.create(taskId, memberIds[group.index]!, group.candidates);
    });
    if (attachmentIds.length > 0) this.attachments.claim(attachmentIds, taskId, null);
    this.audit(taskId, null, "task.proposed", { kind: cls.kind, size: cls.size, members: crew.members.map((m) => ({ role: m.role, profileId: m.chosen?.profileId ?? null })), bestOf: group?.candidates.map((c) => c.profileId) ?? null, ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}) });
    this.emitTask(taskId, "proposed");
    return this.get(taskId);
  }

  /** Approves the crew, with optional edits, then lets the scheduler start ready steps. */
  async approve(p: TasksIpc["tasks.approve"]["params"]): Promise<TaskDetail> {
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
        if (c && readOnlyConflict(c, this.tpl(m))) throw new OrchestratorError("crew.read_only_profile", { profileId: c.profile.id, role: m.role });
        if (!c || !eligible(c, this.tpl(m), ctx)) throw new OrchestratorError("crew.unknown_profile", { profileId: edit.profileId });
        const v = scoreCandidate(c, this.tpl(m), ctx);
        if (edit.model) v.model = edit.model;
        views.set(m.id, v);
      }
    }

    const group = this.bestOf.group(task.id);
    if (p.bestOf && !group) throw new OrchestratorError("best_of.not_found");
    const groupCands = group ? this.approvedVariants(task, project, members, views, candidates, group, p) : null;

    for (const m of members) {
      const v = views.get(m.id);
      if (!v) throw new OrchestratorError("crew.missing_profile", { role: m.role });
      // Checked for every member, not only edited ones: the profile may have been marked read-only after the proposal.
      const c = candidates.find((x) => x.profile.id === v.profileId);
      if (c && readOnlyConflict(c, this.tpl(m))) throw new OrchestratorError("crew.read_only_profile", { profileId: c.profile.id, role: m.role });
      for (const other of this.tpl(m).independentOf) {
        const o = members.find((x) => x.role === other);
        const ov = o ? views.get(o.id) : null;
        if (ov && sameModel(v, ov)) throw new OrchestratorError("crew.independence", { role: m.role });
        // Any variant may be the one you keep, so a reviewer must be independent of all of them.
        if (o && group?.member_id === o.id && groupCands?.some((g) => sameModel(v, g))) throw new OrchestratorError("crew.independence", { role: m.role });
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
      if (group && groupCands) {
        this.bestOf.replace(group.id, groupCands);
        this.db.exec("update crew_members set chosen = ? where id = ?", JSON.stringify(groupCands[0]), group.member_id);
      }
      const estimate = sumEstimates([...views.entries()].flatMap(([id, v]) => (groupCands && group?.member_id === id ? groupCands.map((g) => g.estimate) : [v?.estimate ?? { usd: null, provenance: "unknown" as const }])));
      this.db.exec("update crews set approved_at = ?, estimate_usd = ?, estimate_provenance = ? where id = ?", this.iso(), estimate.usd, estimate.provenance, crew.id);
      if (p.fallback) this.db.exec("update tasks set fallback = ? where id = ?", p.fallback, task.id);
      if (p.accountSwitch !== undefined) this.switches.setTask(task.id, p.accountSwitch);
    });
    this.audit(task.id, null, "task.approved", { edits: p.edits ?? [], bestOf: groupCands?.map((g) => g.profileId) ?? null });
    this.emitTask(task.id, "approved");
    await this.tick();
    return this.get(task.id);
  }

  /** Lets the task's steps switch to another account of the same provider, or holds them out (docs/adr/0009). */
  setAccountSwitch(taskId: string, enabled: boolean): TaskDetail {
    const task = this.db.task(taskId);
    this.switches.setTask(task.id, enabled);
    this.audit(task.id, null, "task.account_switch", { enabled });
    this.emitTask(task.id, "account_switch");
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
      // The variants of a Best of N group go with their task; their worktrees stay, like the task's.
      for (const id of this.bestOf.variantTasksOf(task.id)) await this.cancel(id);
      this.audit(task.id, null, "task.cancelled", {});
      this.emitTask(task.id, "cancelled");
    }
    return this.get(task.id);
  }

  // ---------------------------------------------------------------- hibernation

  /**
   * One pass: every live run idle past the window, on a runner that resumes sessions, has its
   * process stopped. A failure (the store closing on exit) waits for the next pass.
   */
  async checkHibernation(): Promise<void> {
    if (this.closed) return;
    try {
      const s = this.hibernation.settings();
      if (!s.enabled) return;
      const now = this.now();
      for (const [runId, live] of [...this.live]) {
        const run = this.db.run(runId);
        if (run.ended_at) continue;
        const open = this.db.openRequestsForRun(runId)[0] ?? null;
        const payload = open ? (JSON.parse(open.payload) as RequestPayload) : null;
        const since = idleSince(
          {
            inTurn: live.inTurn,
            busy: Boolean(live.testing) || this.draining.has(runId) || this.drainRelease.has(runId) || this.stopping.has(runId) || this.hibernating.has(runId) || this.confirming.has(runId) || this.db.openHandoffs().some((h) => h.from_run_id === runId),
            paused: run.paused_at !== null,
            limited: run.limit_reached === 1,
            // Only runners whose resume by session id is proven, or an ACP agent that reported loadSession.
            resumable: Boolean(run.native_session_id) && canHibernate(run.runner, live.adapter.capabilities.resume, live.candidate.capabilities.resume),
            lastActivityAt: run.last_activity_at,
            startedAt: run.started_at,
            request: open && payload ? { id: open.id, createdAt: open.created_at, hibernatable: (payload.kind === "question" || (payload.kind === "approval" && !payload.bootstrap)) && open.native_id !== null } : null,
          },
          now,
          s.idleMinutes,
        );
        if (since) await this.hibernate(runId, live, since, open?.id ?? null);
      }
    } catch {
      // Same as a failed scheduling pass: the next timer tick tries again.
    }
  }

  private async hibernate(runId: string, live: Live, since: string, requestId: string | null): Promise<void> {
    const run = this.db.run(runId);
    this.hibernation.sleep(runId, since, requestId);
    this.hibernating.add(runId);
    await this.safe(() => live.adapter.stop(live.handle));
    if (!(await this.within(live.done, this.opts.stopTimeoutMs ?? 30_000)) && this.live.get(runId) === live) {
      // The process tree was killed; the stream may never close, so the run lets go of it here.
      this.live.delete(runId);
      this.hibernating.delete(runId);
    }
    this.turns.end(runId);
    this.db.exec("update runs set pid = null where id = ?", runId);
    this.audit(run.task_id, runId, "run.hibernated", { idleSince: since, requestId });
    this.emitTask(run.task_id, "hibernation");
    void this.tick();
  }

  /**
   * Wakes a hibernated run by its session id, with what is queued for its step (your message, or
   * the answer to its request). It takes an admission slot again; without one it waits, and the
   * scheduler wakes it once a slot is free.
   */
  private async wakeRun(runId: string, cause: WakeCause): Promise<void> {
    const run = this.db.run(runId);
    if (run.ended_at || this.live.has(runId) || run.paused_at || !this.hibernation.asleep(runId)) {
      this.pendingWake.delete(runId);
      return;
    }
    const task = this.db.task(run.task_id);
    const config = this.config(this.db.project(task.project_id)).config;
    const counts = this.db.activeCounts();
    const blocked = admit(
      {
        projectActive: counts.byProject.get(task.project_id) ?? 0,
        profileActive: counts.byProfile.get(run.profile_id) ?? 0,
        globalActive: counts.total,
        freeMb: (this.opts.freeMemoryMb ?? (() => freemem() / 1024 / 1024))(),
        worktreeBusy: false,
        profileId: run.profile_id,
      },
      { ...DEFAULT_LIMITS, ...this.opts.limits, projectSlots: config.rules.slots },
    );
    if (blocked) {
      this.pendingWake.set(runId, cause);
      this.blocked.set(run.member_id, blocked);
      return;
    }
    this.pendingWake.set(runId, cause);
    this.blocked.delete(run.member_id);
    try {
      await this.continueRun(runId, this.turns.queue.pending(run.member_id).length > 0 ? "" : "Continue the task where you stopped.");
      this.emitTask(task.id, "hibernation");
    } catch (err) {
      this.pendingWake.delete(runId);
      // The runner could not resume the session: the run failed, and the usual handoff or retry follows.
      const detail = errorDetail(err, await this.secretsFor(run.profile_id));
      this.endRun(runId, "failed", detail);
      await this.onFailure(runId, detail);
    }
  }

  // ---------------------------------------------------------------- Best of N (feature scan A8)

  /** The task whose budget and per-task caps a task spends on: a variant's parent, or itself. */
  private budgetTask(taskId: string): string {
    return this.bestOf.parentOf(taskId) ?? taskId;
  }

  /** The runs a task's spend is: its own and, for a Best of N parent, every variant's. */
  private budgetRuns(taskId: string): RunRow[] {
    return [...this.db.runs(taskId), ...this.bestOf.variantTasksOf(taskId).flatMap((id) => this.db.runs(id))];
  }

  /** At proposal: the variants for the implement step, never on a reviewer's model. */
  private groupCandidates(members: ReturnType<typeof proposeCrew>["members"], candidates: Candidate[], ctx: ScoringContext, n: number): { index: number; candidates: CandidateView[] } {
    if (!Number.isInteger(n) || n < BEST_OF_MIN || n > BEST_OF_MAX) throw new OrchestratorError("best_of.bad_count", { min: BEST_OF_MIN, max: BEST_OF_MAX });
    const index = members.findIndex((m) => m.role === "implementer" && m.writesCode);
    if (index < 0) throw new OrchestratorError("best_of.not_found");
    const independent = members.filter((m) => m.chosen && m.template.independentOf.includes("implementer")).map((m) => m.chosen!);
    const ranked = rankForRole(candidates, "implementer", ctx, { models: new Set(), providers: new Set() }).filter((c) => !independent.some((r) => sameModel(r, c)));
    const picked = pickVariants(members[index]!.chosen, ranked, n);
    if (picked.length < n) throw new OrchestratorError("best_of.too_few", { found: picked.length, needed: n });
    return { index, candidates: picked };
  }

  /**
   * At approval: the group's variants after your edits, checked against the rules that make the
   * group able to start at all: enough slots for every variant at once, and an estimate that fits
   * the task budget on its own.
   */
  private approvedVariants(task: TaskRow, project: ProjectRow, members: MemberRow[], views: Map<string, CandidateView | null>, candidates: Candidate[], group: GroupRow, p: { edits?: CrewEdit[]; bestOf?: { profileIds: string[] } }): CandidateView[] {
    const ctx = this.scoring(project.id, task.size, task.budget_usd);
    const member = members.find((m) => m.id === group.member_id)!;
    let out = this.bestOf.candidates(group.id);
    if (p.bestOf) {
      const ids = p.bestOf.profileIds;
      if (ids.length < BEST_OF_MIN || ids.length > BEST_OF_MAX || new Set(ids).size !== ids.length) throw new OrchestratorError("best_of.bad_count", { min: BEST_OF_MIN, max: BEST_OF_MAX });
      const before = out;
      out = ids.map((id) => {
        const c = candidates.find((x) => x.profile.id === id);
        if (c && readOnlyConflict(c, this.tpl(member))) throw new OrchestratorError("crew.read_only_profile", { profileId: id, role: member.role });
        if (!c || !eligible(c, this.tpl(member), ctx)) throw new OrchestratorError("crew.unknown_profile", { profileId: id });
        return before.find((v) => v.profileId === id) ?? scoreCandidate(c, this.tpl(member), ctx);
      });
    } else if (p.edits?.some((e) => e.memberId === member.id)) {
      // Changing the implementer in the crew changes the first variant.
      const first = views.get(member.id)!;
      out = [first, ...out.filter((v) => v.profileId !== first.profileId)].slice(0, out.length);
    }
    const slots = Math.min(this.config(project).config.rules.slots, this.opts.limits?.globalSlots ?? DEFAULT_LIMITS.globalSlots);
    if (out.length > slots) throw new OrchestratorError("best_of.slots", { needed: out.length, slots });
    const estimate = sumEstimates(out.map((v) => v.estimate));
    if (task.budget_usd !== null && estimate.usd !== null && estimate.usd > task.budget_usd) throw new OrchestratorError("best_of.over_budget", { estimateUsd: estimate.usd, capUsd: task.budget_usd });
    views.set(member.id, out[0]!);
    return out;
  }

  /**
   * Starts every variant of a group at once, or none: admission for all of them, then every
   * paid variant's estimate reserved against the parent's caps in one step, so parallel steps
   * cannot take the room between two variants. Then one hidden task per variant, and its run.
   */
  private async startGroup(task: TaskRow, m: MemberRow, group: GroupRow, project: ProjectRow, slots: number, candidates: Candidate[]): Promise<void> {
    const variants = this.bestOf.variants(group.id);
    const views = variants.map((v) => JSON.parse(v.candidate) as CandidateView);
    const missing = views.find((v) => !this.adapters.has(v.runner));
    const reason: Reason | null = missing ? { code: "admission.no_adapter", params: { runner: missing.runner } } : (this.groupAdmission(task, views, slots) ?? this.groupBudgetHold(task, m, views, candidates));
    if (reason) {
      const prev = this.blocked.get(m.id);
      this.blocked.set(m.id, reason);
      if (prev?.code !== reason.code) this.emitTask(task.id, "admission");
      return;
    }
    this.blocked.delete(m.id);
    const at = this.iso();
    const created = new Map<string, string>();
    const specs: LaunchSpec[] = [];
    this.db.tx(() => {
      for (const [i, v] of variants.entries()) {
        const view = views[i]!;
        const taskId = randomUUID();
        const crewId = randomUUID();
        const memberId = randomUUID();
        this.db.exec(
          `insert into tasks (id, project_id, title, description, kind, size, base_branch, fallback, wait_reset_minutes, budget_usd, classification, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, '[]', ?)`,
          taskId,
          task.project_id,
          task.title,
          task.description,
          task.kind,
          task.size,
          task.base_branch,
          task.fallback,
          task.wait_reset_minutes,
          at,
        );
        this.db.exec("insert into crews (id, task_id, proposed_at, approved_at, estimate_usd, estimate_provenance) values (?, ?, ?, ?, ?, ?)", crewId, taskId, at, at, view.estimate.usd, view.estimate.provenance);
        this.db.exec(
          "insert into crew_members (id, crew_id, position, step, role, depends_on, required, writes_code, chosen, standby, reasons) values (?, ?, 0, ?, ?, '[]', 1, 1, ?, '[]', '[]')",
          memberId,
          crewId,
          m.step,
          m.role,
          JSON.stringify(view),
        );
        this.db.copyRoleTemplate(m.id, memberId);
        created.set(v.id, taskId);
        specs.push({ runId: randomUUID(), task: this.db.task(taskId), member: this.db.member(memberId), target: view });
      }
      this.bestOf.start(group.id, created);
      for (const spec of specs) {
        const c = candidates.find((x) => x.profile.id === spec.target.profileId);
        if (c?.profile.credential.kind === "api_key") reserveSpend(this.opts.store.db, { runId: spec.runId!, taskId: task.id, credentialId: spendCredential(c), amountUsd: estimateFor(c, this.tpl(m), task.size, this.now()).usd ?? 0 }, this.now());
      }
    });
    for (const spec of specs) this.insertRun(spec);
    this.audit(task.id, null, "best_of.started", { groupId: group.id, variants: views.map((v) => v.profileId), estimate: sumEstimates(views.map((v) => v.estimate)) });
    this.emitTask(task.id, "best_of");
    // One after another: parallel `git worktree add` on one repo races for its locks.
    this.track(
      (async () => {
        for (const spec of specs) await this.boot(spec.runId!, spec);
      })(),
    );
  }

  private groupAdmission(task: TaskRow, views: CandidateView[], projectSlots: number): Reason | null {
    const counts = this.db.activeCounts();
    const needed = new Map<string, number>();
    for (const v of views) needed.set(v.profileId, (needed.get(v.profileId) ?? 0) + 1);
    return admitGroup(
      {
        projectActive: counts.byProject.get(task.project_id) ?? 0,
        globalActive: counts.total,
        freeMb: (this.opts.freeMemoryMb ?? (() => freemem() / 1024 / 1024))(),
        profiles: [...needed].map(([profileId, n]) => ({ profileId, needed: n, active: counts.byProfile.get(profileId) ?? 0 })),
      },
      { ...DEFAULT_LIMITS, ...this.opts.limits, projectSlots },
    );
  }

  /**
   * Like budgetHold for one step, for the whole group: it waits while other unfinished runs hold
   * the room every variant's estimate needs together. A group that would not fit even once they
   * finish starts, and each paid variant pauses on its cap with a request, as a single step does.
   */
  private groupBudgetHold(task: TaskRow, m: MemberRow, views: CandidateView[], candidates: Candidate[]): Reason | null {
    const byCredential = new Map<string, { c: Candidate; usd: number }>();
    let total = 0;
    for (const v of views) {
      const c = candidates.find((x) => x.profile.id === v.profileId);
      if (c?.profile.credential.kind !== "api_key") continue;
      const usd = estimateFor(c, this.tpl(m), task.size, this.now()).usd ?? 0;
      total += usd;
      const key = spendCredential(c) ?? `profile:${c.profile.id}`;
      const cur = byCredential.get(key);
      byCredential.set(key, { c, usd: (cur?.usd ?? 0) + usd });
    }
    for (const { c, usd } of byCredential.values()) {
      const cap = reachedCaps(this.opts.store.db, spendCredential(c), task.id, this.now(), { addUsd: usd }).find((x) => x.reservedUsd);
      if (cap && !overCap(cap.spentUsd, 0, usd, cap.capUsd)) return { code: "admission.budget_reserved", params: { reservedUsd: cap.reservedUsd!, capUsd: cap.capUsd, cap: cap.kind } };
    }
    if (task.budget_usd !== null && total > 0) {
      const spent = this.db.spend(this.budgetRuns(task.id)).usd ?? 0;
      const held = reservedUsd(this.opts.store.db, { taskId: task.id });
      if (held > 0 && overCap(spent, held, total, task.budget_usd) && !overCap(spent, 0, total, task.budget_usd)) {
        return { code: "admission.budget_reserved", params: { reservedUsd: Math.round(held * 1_000_000) / 1_000_000, capUsd: task.budget_usd, cap: "task_budget" } };
      }
    }
    return null;
  }

  private async refreshVariantDiff(variantId: string): Promise<void> {
    const v = this.bestOf.variant(variantId);
    const wt = v?.task_id ? this.db.worktree(v.task_id) : null;
    if (!v || !wt || !existsSync(wt.path)) return;
    try {
      this.bestOf.setDiff(v.id, await worktreeDiff(wt.path, wt.base_sha, this.opts.gitBin));
      this.emitTask(v.task_id!, "best_of");
    } catch (err) {
      this.audit(v.task_id!, null, "best_of.diff_failed", { code: errorCode(err) });
    }
  }

  /**
   * Keeps one finished variant (after you confirmed in the compare view). Its worktree, bootstrap
   * state and session move to the parent task, recorded as a completed run of the implement step,
   * so test, review and PR continue there. Every other variant is stopped, cancelled and parked.
   */
  async keepVariant(taskId: string, variantId: string): Promise<TaskDetail> {
    const task = this.db.task(taskId);
    if (task.cancelled_at) throw new OrchestratorError("task.cancelled");
    const group = this.bestOf.group(task.id);
    const kept = group ? this.bestOf.variant(variantId) : null;
    if (!group || !kept || kept.group_id !== group.id) throw new OrchestratorError("best_of.not_found");
    if (group.kept_variant_id) throw new OrchestratorError("best_of.kept");
    if (!group.started_at || !kept.task_id) throw new OrchestratorError("best_of.not_started");
    const runs = this.db.runs(kept.task_id);
    const last = runs.filter((r) => r.end_reason === "completed" && !this.db.successor(r, runs)).at(-1);
    const wt = this.db.worktree(kept.task_id);
    if (!last || !wt || runs.some((r) => !r.ended_at)) throw new OrchestratorError("best_of.not_finished", { variantId });
    if (this.db.worktree(task.id)) throw new OrchestratorError("best_of.kept");
    const member = this.db.member(group.member_id);
    const variantMember = this.db.member(last.member_id);
    const adoptedId = randomUUID();
    const at = this.iso();
    this.db.tx(() => {
      this.bestOf.keep(group.id, kept.id);
      // The worktree row moves, so its id (and every run that names it) stays valid.
      this.db.exec("update worktrees set task_id = ? where task_id = ?", task.id, kept.task_id);
      this.db.exec("update worktree_bootstrap set task_id = ? where task_id = ?", task.id, kept.task_id);
      this.db.exec(
        `insert into runs (id, task_id, member_id, role, profile_id, runner, model, cwd, worktree_id, native_session_id, started_at, ended_at, end_reason, end_detail, last_state, last_activity_at, cost_provenance, plan, diff)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'best_of.kept', ?, ?, 'estimated', ?, ?)`,
        adoptedId,
        task.id,
        member.id,
        member.role,
        last.profile_id,
        last.runner,
        last.model,
        last.cwd,
        wt.id,
        last.native_session_id,
        at,
        at,
        last.last_state,
        last.last_activity_at,
        last.plan,
        last.diff,
      );
    });
    this.loops.enlist(adoptedId, member.id);
    // The reviewer's prompt cites the last test; it belongs to the kept variant's worktree.
    const test = this.loops.lastTest(variantMember.id);
    if (test) this.loops.addTest({ task_id: task.id, member_id: member.id, run_id: adoptedId, command: test.command, exit_code: test.exit_code, passed: test.passed, tail: test.tail, tree_sha: test.tree_sha, head_sha: test.head_sha, duration_ms: test.duration_ms });
    this.audit(task.id, adoptedId, "best_of.kept", { groupId: group.id, variantId: kept.id, variantTaskId: kept.task_id, fromRun: last.id, profileId: last.profile_id, branch: wt.branch });
    for (const other of this.bestOf.variants(group.id).filter((v) => v.id !== kept.id && v.task_id)) await this.discardVariant(other.id, other.task_id!);
    this.emitTask(task.id, "best_of");
    await this.tick();
    return this.get(task.id);
  }

  private async discardVariant(variantId: string, variantTaskId: string): Promise<void> {
    for (const r of this.db.runs(variantTaskId).filter((r) => !r.ended_at)) await this.stopRun(r.id, "best_of.discarded");
    await this.cancel(variantTaskId);
    const wt = this.db.worktree(variantTaskId);
    if (!wt) {
      this.bestOf.parked(variantId, null);
      return;
    }
    let error: string | null = null;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.bootstrap.park(variantTaskId);
        break;
      } catch (err) {
        // On Windows a process tree killed a moment ago can still hold its folder: git removed the
        // files and the registration but not the folder. Finish that, or try again shortly.
        if (await this.finishHalfRemoved(wt)) break;
        if (attempt >= PARK_ATTEMPTS) {
          // A cleanup step waiting for approval, a locked file: the folder stays and the code says why.
          error = errorCode(err);
          this.audit(variantTaskId, null, "best_of.park_failed", { variantId, code: error, detail: errorDetail(err, []).slice(0, 400) });
          break;
        }
        await new Promise((r) => setTimeout(r, PARK_RETRY_MS * attempt));
      }
    }
    this.bestOf.parked(variantId, error);
    this.audit(variantTaskId, null, "best_of.discarded", { variantId, parked: error === null });
  }

  /** True when a park left only an empty folder behind, which is then removed and pruned from git. */
  private async finishHalfRemoved(wt: WorktreeRow): Promise<boolean> {
    if (!existsSync(wt.path)) return true;
    if (existsSync(join(wt.path, ".git")) || readdirSync(wt.path).length > 0) return false;
    for (let i = 0; i < PARK_ATTEMPTS; i++) {
      try {
        rmdirSync(wt.path);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, PARK_RETRY_MS));
      }
    }
    if (existsSync(wt.path)) return false;
    await git(wt.repo_path, ["worktree", "prune"], this.opts.gitBin).catch(() => "");
    return true;
  }

  private groupView(task: TaskRow): BestOfView | null {
    const group = this.bestOf.group(task.id);
    if (!group) return null;
    const crew = this.db.crew(task.id);
    const max = this.config(this.db.project(task.project_id)).config.loop.maxIterations;
    const variants = this.bestOf.variants(group.id).map((v) => {
      const candidate = JSON.parse(v.candidate) as CandidateView;
      const vt = v.task_id ? this.db.task(v.task_id) : null;
      const summary = vt ? this.db.summary(vt) : null;
      const run = vt ? (this.db.runs(vt.id).at(-1) ?? null) : null;
      const loop = vt ? this.loops.view(vt.id, max, () => false) : null;
      // The kept variant's worktree belongs to the parent now.
      const wt = vt ? (this.db.worktree(vt.id) ?? (v.outcome === "kept" ? this.db.worktree(task.id) : null)) : null;
      // Parked later from the compare view or the Worktrees screen: the folder is gone, so it is parked.
      const parkedLater = v.outcome === "discarded" && !v.parked_at && wt !== null && !existsSync(wt.path);
      return {
        id: v.id,
        position: v.position,
        candidate,
        taskId: v.task_id,
        status: summary?.status ?? null,
        run: run ? this.db.runView(run) : null,
        resumableRunIds: summary?.resumableRunIds ?? [],
        spend: summary?.spend ?? { usd: 0, provenance: "estimated" as const },
        diffStat: v.diff_stat ? (JSON.parse(v.diff_stat) as DiffStat) : null,
        test: loop?.tests.at(-1) ?? null,
        decisions: loop?.decisions ?? [],
        branch: wt?.branch ?? null,
        worktreePath: wt?.path ?? null,
        outcome: v.outcome,
        parkedAt: v.parked_at ?? (parkedLater ? group.kept_at : null),
        parkError: parkedLater ? null : v.park_error,
      };
    });
    return {
      id: group.id,
      memberId: group.member_id,
      n: variants.length,
      phase: groupPhase(group, Boolean(crew?.approved_at), variants.map((v) => ({ status: v.status, finished: v.status === "review" }))),
      estimate: sumEstimates(variants.map((v) => v.candidate.estimate)),
      variants,
      startedAt: group.started_at,
      keptVariantId: group.kept_variant_id,
      keptAt: group.kept_at,
    };
  }

  /** What a task's summary adds from Best of N and schedules; cheap reads, called on every summary. */
  private taskExtras(t: TaskRow): ReturnType<OrchestratorDb["taskExtras"]> {
    const parent = this.bestOf.parentOf(t.id);
    const scheduled = this.schedules.taskOrigin(t.id);
    if (parent) {
      const v = this.bestOf.variantByTask(t.id)!;
      return { scheduled, bestOf: null, variantOf: { taskId: parent, position: v.position, n: this.bestOf.variants(v.group_id).length }, fact: null, groupRuns: [] };
    }
    const group = this.bestOf.group(t.id);
    if (!group) return { scheduled, bestOf: null, variantOf: null, fact: null, groupRuns: [] };
    const variants = this.bestOf.variants(group.id);
    const statuses = variants.map((v) => (v.task_id ? this.db.status(this.db.task(v.task_id)) : null));
    const phase = groupPhase(group, Boolean(this.db.crew(t.id)?.approved_at), statuses.map((status) => ({ status, finished: status === "review" })));
    return {
      scheduled,
      bestOf: { n: variants.length, phase },
      variantOf: null,
      fact: groupFact(phase, statuses),
      groupRuns: variants.flatMap((v) => (v.task_id ? this.db.runs(v.task_id) : [])),
    };
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
      // The pause interrupted the turn; let that stream end as a pause first, or its end would
      // read as a stop once paused_at is cleared.
      const pausing = this.live.get(runId);
      if (pausing) await this.within(pausing.done, this.opts.stopTimeoutMs ?? 30_000);
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
  async handoff(runId: string, targetProfileId: string, stop: HandoffStop = "interrupt"): Promise<RunView> {
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
    // Drain means only something while a turn runs; anything else stops at once.
    this.loops.setHandoff(handoffId, stop);
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

  async message(runId: string, text: string, seen?: SessionSeen, attachmentIds: string[] = []): Promise<RunView> {
    const run = this.db.run(runId);
    this.checkSeen(run, seen);
    if (run.end_reason === "completed" || this.db.task(run.task_id).cancelled_at) throw new OrchestratorError("run.ended");
    this.attachments.check(attachmentIds);
    // Every message joins the step's queue first (feature scan A13): it belongs to the step, not to
    // this process, and stays queued and editable until a run takes it. A running turn takes it at
    // its boundary, a paused run on resume, and whichever run continues the step otherwise.
    const messageId = this.turns.queue.add(run.task_id, run.member_id, text);
    if (attachmentIds.length > 0) this.attachments.claim(attachmentIds, run.task_id, messageId);
    const live = this.live.get(runId);
    this.audit(run.task_id, runId, "run.message", { chars: text.length, queued: !live || Boolean(run.paused_at) || live.inTurn, ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}) });
    // A hibernated run wakes for your message; the queue goes with its resume.
    if (!live && !run.paused_at && this.hibernation.asleep(runId)) await this.wakeRun(runId, "message");
    await this.flushOutbox(run.task_id, run.member_id);
    this.emitTask(run.task_id, "queue");
    return this.db.runView(this.db.run(runId));
  }

  /**
   * Puts a message Crewyard wrote for you (failing checks) into the step's queue and leaves it
   * there: unlike `message`, it never hands it to an idle run or wakes a hibernated one, so you
   * read, edit or delete it before a turn boundary, a resume or a continue takes it.
   */
  enqueue(runId: string, text: string): { run: RunView; messageId: string } {
    const run = this.db.run(runId);
    if (this.db.task(run.task_id).cancelled_at) throw new OrchestratorError("run.ended");
    const messageId = this.turns.queue.add(run.task_id, run.member_id, text);
    this.audit(run.task_id, runId, "run.message", { chars: text.length, queued: true, source: "github.checks" });
    this.emitTask(run.task_id, "queue");
    return { run: this.db.runView(this.db.run(runId)), messageId };
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
    this.attachments.removeForMessage(messageId);
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
      await live.adapter.steer!(live.handle, withAttachments(message.text, this.attachments.forMessage(messageId), live.adapter.capabilities));
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
    const prompt = native ? text : `${rolePrompt(this.tpl(member), task, { plan: this.latestPlan(task.id), branch: wt?.branch ?? null })}\n\n${text}`;
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
    live.turnBegun = false;
    try {
      await this.turns.begin(target.id);
      await live.adapter.send(live.handle, withAttachments(joinMessages(queued.map((m) => m.text)), this.attachments.forMessages(queued.map((m) => m.id)), live.adapter.capabilities));
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
  private async nextTurn(runId: string): Promise<string | UserInput | null> {
    this.turns.end(runId);
    // A one-time grant from a hibernated approval covers only the turn it woke into.
    this.hibernation.dropGrant(runId);
    const live = this.live.get(runId);
    // The turn that called this has ended; whatever comes next begins when the runner says so.
    if (live) live.turnBegun = false;
    const run = this.db.run(runId);
    // A drain handoff waits for exactly this boundary: the source takes no further turn, and the
    // boundary is held until the handoff has stopped it, so the runner never ends it as completed.
    const drain = this.draining.get(runId);
    if (live && drain) {
      live.inTurn = false;
      this.draining.delete(runId);
      drain();
      return new Promise<null>((release) => this.drainRelease.set(runId, release));
    }
    const fenced = this.loops.fenced(runId, run.member_id);
    const stop = fenced || !live || this.closed || run.ended_at !== null || run.paused_at !== null || run.limit_reached === 1 || this.stopping.has(runId) || this.db.task(run.task_id).cancelled_at !== null;
    const queued = stop ? [] : this.turns.queue.pending(run.member_id);
    if (!live || queued.length === 0) {
      // Run until green (feature scan A9): before an implementer finishes, the Test step runs the
      // project's tests; a failure becomes the next turn of the same session.
      const fix = !stop && live ? await this.testGate(runId) : null;
      if (fix && live && this.live.get(runId) === live && !this.stopping.has(runId)) {
        live.inTurn = true;
        await this.turns.begin(runId);
        return fix;
      }
      if (live) live.inTurn = false;
      return null;
    }
    await this.turns.begin(runId);
    for (const m of queued) this.turns.queue.deliver(m.id, runId);
    this.audit(run.task_id, runId, "queue.flushed", { count: queued.length });
    this.emitTask(run.task_id, "queue");
    return withAttachments(joinMessages(queued.map((m) => m.text)), this.attachments.forMessages(queued.map((m) => m.id)), live.adapter.capabilities);
  }

  /**
   * The prompt a run starts or resumes with, plus the step's queued messages. A note left by an
   * undo only makes sense to the same conversation, so a new session drops it.
   */
  private withQueued(memberId: string, prompt: string, sameSession: boolean): { prompt: string; ids: string[]; attachments: Attachment[] } {
    const queued = this.turns.queue.pending(memberId);
    const sent = queued.filter((m) => sameSession || m.kind !== "note");
    return { prompt: joinMessages([prompt, ...sent.map((m) => m.text)]), ids: queued.map((m) => m.id), attachments: this.attachments.forMessages(sent.map((m) => m.id)) };
  }

  // ---------------------------------------------------------------- crew loops (feature scan A9)

  private decide(memberId: string, taskId: string, runId: string | null, kind: LoopDecisionKind, reason: Reason, iteration: number, max: number): void {
    const d = this.loops.decide({ taskId, memberId, runId, iteration, max, kind, reason });
    this.audit(taskId, runId, "loop.decision", { decisionId: d.id, memberId, kind, reason, iteration, max });
    this.emitTask(taskId, "loop");
  }

  /**
   * The Test step at an implementer's turn boundary. Returns the failure as the next turn's text,
   * or null to let the run finish: the tests passed, the project has none, or a stop rule ended
   * the loop (then the run ends failed with the rule as its detail, never as completed).
   */
  private async testGate(runId: string): Promise<string | null> {
    const run = this.db.run(runId);
    const task = this.db.task(run.task_id);
    const member = this.db.member(run.member_id);
    if (task.kind !== "code" || member.role !== "implementer" || !run.worktree_id) return null;
    const project = this.db.project(task.project_id);
    const { config } = this.config(project);
    const max = config.loop.maxIterations;
    const attempts = this.loops.attempts(member.id);
    const command = config.commands.test?.trim() || null;
    if (!command) {
      if (!this.loops.decided(runId, "tests_skipped")) this.decide(member.id, task.id, runId, "tests_skipped", { code: "loop.tests_skipped" }, attempts, max);
      return null;
    }
    const live = this.live.get(runId);
    // The agent is idle while its tests run: the stall rules must not read that as a hung turn,
    // and the turn boundary stays held, so a queued message waits for it instead of racing the tests.
    if (live) live.testing = true;
    try {
      return await this.runTests(runId, run, task, member, project, command, attempts, max, live);
    } finally {
      if (live) live.testing = false;
    }
  }

  private async runTests(runId: string, run: RunRow, task: TaskRow, member: MemberRow, project: ProjectRow, command: string, attempts: number, max: number, live: Live | undefined): Promise<string | null> {
    const tree = await snapshot(run.cwd, null, this.opts.gitBin).then((s) => s.tree).catch(() => null);
    const started = this.now().getTime();
    const res = await runSteps([{ command, timeoutSec: TEST_TIMEOUT_SEC }], run.cwd, { ...process.env, ...this.bootstrapEnv(run, project) });
    const tail = res.failure ? redactDetail(res.failure.tail, await this.secretsFor(run.profile_id)) : "";
    const previous = this.loops.lastTest(member.id);
    this.loops.addTest({ task_id: task.id, member_id: member.id, run_id: runId, command, exit_code: res.ok ? 0 : (res.failure?.code ?? null), passed: res.ok ? 1 : 0, tail, tree_sha: tree, head_sha: null, duration_ms: this.now().getTime() - started });
    if (res.ok) {
      this.decide(member.id, task.id, runId, "tests_passed", { code: "loop.tests_passed", params: { command } }, attempts, max);
      return null;
    }
    const now = this.db.run(runId);
    if (now.ended_at || now.paused_at || this.stopping.has(runId) || this.db.task(task.id).cancelled_at) return null;
    const stopWith = (kind: LoopDecisionKind, reason: Reason, detail: string): null => {
      this.decide(member.id, task.id, runId, kind, reason, attempts, max);
      this.loopFailed.set(runId, detail);
      return null;
    };
    // The same tree as the last failing try: the agent changed nothing, another try would not either.
    if (previous && previous.passed === 0 && tree !== null && previous.tree_sha === tree) return stopWith("stop_no_change", { code: "loop.no_change" }, "loop.no_change");
    if (attempts >= max) return stopWith("stop_iteration_cap", { code: "loop.iteration_cap", params: { max } }, "loop.iteration_cap");
    const cap = this.capFor(task.id, runId, live?.candidate);
    if (cap) return stopWith("stop_spend_cap", { code: "loop.spend_cap", params: { cap: cap.kind } }, "loop.spend_cap");
    const exitCode = res.failure?.code ?? -1;
    this.decide(member.id, task.id, runId, "tests_failed", { code: "loop.tests_failed", params: { command, exitCode } }, attempts + 1, max);
    return testFailureMessage({ command, exitCode: res.failure?.code ?? null, timedOut: res.failure?.timedOut ?? false, tail, attempt: attempts + 1, max });
  }

  /**
   * An implementer finished: whatever it left uncommitted is committed, so the commit the reviewer
   * pins and the verdict names is exactly what was tested.
   */
  private async pinHead(runId: string): Promise<void> {
    const run = this.db.run(runId);
    const wt = run.worktree_id ? this.db.worktree(run.task_id) : null;
    if (!wt || wt.id !== run.worktree_id || this.db.member(run.member_id).writes_code !== 1 || this.db.task(run.task_id).kind !== "code") return;
    try {
      if (await isClean(wt.path, this.opts.gitBin)) return;
      const res = await checkpoint(wt.path, `crewyard: commit what the ${run.role} left uncommitted`, this.opts.gitBin);
      if (res.committed) {
        this.loops.pinTest(runId, res.sha);
        this.audit(run.task_id, runId, "worktree.pinned", { sha: res.sha, skipped: res.skipped.length });
      }
    } catch (err) {
      this.audit(run.task_id, runId, "worktree.pin_failed", { code: errorCode(err) });
    }
  }

  /** The implementer step a reviewer's verdict goes back to: the writer it depends on. */
  private writerFor(member: MemberRow): MemberRow | null {
    const deps = JSON.parse(member.depends_on) as string[];
    return this.db.members(member.crew_id).find((m) => deps.includes(m.step) && m.writes_code === 1 && m.role === "implementer") ?? null;
  }

  /**
   * The review loop: a "changes" verdict goes back to the same implementer, as a native resume of
   * its session with the comments, and the same stage. Test and Review then run again (the
   * scheduler re-runs a step whose dependency finished again). A pass, an invalid result or a stop
   * rule ends the loop with a recorded decision.
   */
  private async reviewLoop(reviewerRunId: string, result: RoleResult): Promise<void> {
    const run = this.db.run(reviewerRunId);
    const task = this.db.task(run.task_id);
    if (task.cancelled_at || task.kind !== "code") return;
    const writer = this.writerFor(this.db.member(run.member_id));
    if (!writer) return;
    const max = this.config(this.db.project(task.project_id)).config.loop.maxIterations;
    const attempts = this.loops.attempts(writer.id);
    if (result.kind === "invalid") {
      this.decide(writer.id, task.id, run.id, "review_invalid", { code: "loop.review_invalid", params: { error: result.error.slice(0, 200) } }, attempts, max);
      return;
    }
    if (result.kind !== "review") return;
    const verdict = this.loops.verdict(run.id);
    const sha = verdict?.headSha?.slice(0, 12) ?? "";
    if (!verdict || verdict.verdict === "pass") {
      this.decide(writer.id, task.id, run.id, "review_passed", { code: "loop.review_passed", params: { sha } }, attempts, max);
      return;
    }
    const stop = (kind: LoopDecisionKind, reason: Reason) => this.decide(writer.id, task.id, run.id, kind, reason, attempts, max);
    if (attempts >= max) return stop("stop_iteration_cap", { code: "loop.iteration_cap", params: { max } });
    const runs = this.db.runs(task.id);
    const last = runs.filter((r) => r.member_id === writer.id).at(-1);
    if (!last || last.end_reason !== "completed" || this.db.successor(last, runs)) return;
    const adapter = this.adapters.get(last.runner);
    // The comments belong to the session that wrote the code; it is never replaced on its own.
    if (!adapter?.capabilities.resume || !last.native_session_id) return stop("stop_no_resume", { code: "loop.no_resume", params: { runner: last.runner } });
    const cap = this.capFor(task.id, null, await this.candidateFor(last));
    if (cap) return stop("stop_spend_cap", { code: "loop.spend_cap", params: { cap: cap.kind } });
    this.decide(writer.id, task.id, run.id, "review_changes", { code: "loop.review_changes", params: { comments: verdict.comments.length, sha } }, attempts + 1, max);
    await this.launch({
      task,
      member: writer,
      target: { profileId: last.profile_id, runner: last.runner, model: last.model },
      cwd: last.cwd,
      prompt: reviewChangesMessage({ verdict, attempt: attempts + 1, max }),
      resumeRef: { runner: last.runner, sessionId: last.native_session_id },
      resumedFrom: last.id,
    });
  }

  /**
   * A completed step runs again when a step it depends on finished again after it started (the
   * review loop, a fix from PR feedback): Test and Review re-read the new head. Returns the run it
   * re-runs, or null.
   */
  private rerunOf(m: MemberRow, members: MemberRow[], runs: RunRow[]): RunRow | null {
    const mine = runs.filter((r) => r.member_id === m.id);
    const latest = mine.at(-1);
    if (!latest || latest.end_reason !== "completed" || this.db.successor(latest, runs)) return null;
    const deps = JSON.parse(m.depends_on) as string[];
    const newer = members
      .filter((d) => deps.includes(d.step))
      .some((d) => runs.some((r) => r.member_id === d.id && r.end_reason === "completed" && r.ended_at !== null && r.ended_at > latest.started_at && !this.db.successor(r, runs)));
    return newer ? latest : null;
  }

  /**
   * Pinned review: a detached checkout of the exact head the reviewer reads, next to the task
   * worktree. The implementer may change the worktree meanwhile; the verdict is stored with this sha.
   */
  private async reviewCheckout(runId: string, task: TaskRow, wt: WorktreeRow): Promise<{ path: string; sha: string }> {
    const sha = await headSha(wt.path, this.opts.gitBin);
    const path = `${wt.path}.review-${sha.slice(0, 8)}`;
    await addDetachedCheckout(wt.repo_path, path, sha, this.opts.gitBin);
    this.loops.addCheckout({ run_id: runId, task_id: task.id, repo_path: wt.repo_path, path, sha });
    this.audit(task.id, runId, "review.checkout", { sha, path });
    return { path, sha };
  }

  /** Removes a run's review checkout once no other unfinished run reads the same folder. */
  private async dropCheckout(runId: string): Promise<void> {
    const c = this.loops.checkout(runId);
    if (!c || c.removed_at) return;
    const shared = this.loops.openCheckouts().some((o) => o.run_id !== runId && sameDir(o.path, c.path) && !this.db.run(o.run_id).ended_at);
    if (shared) {
      this.loops.checkoutRemoved(runId);
      return;
    }
    try {
      await removeDetachedCheckout(c.repo_path, c.path, this.opts.gitBin);
      this.loops.checkoutRemoved(runId);
    } catch (err) {
      // A file held open keeps the folder; the next daemon start tries again.
      this.audit(c.task_id, runId, "review.checkout_kept", { code: errorCode(err) });
    }
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
    // A hibernated run takes the answer as text when it wakes, since its process is gone.
    const asleep = run && !live && !run.ended_at ? this.hibernation.asleep(run.id) : null;
    if ((answer.kind === "approval" || answer.kind === "question") && !live && !boot && !asleep) throw new OrchestratorError("run.not_live");
    // A source that lost its step to a handoff takes no more answers; its requests were cancelled.
    if (run && (answer.kind === "approval" || answer.kind === "question") && this.loops.fenced(run.id, run.member_id)) throw new OrchestratorError("run.fenced");
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
    if (asleep && run && (payload.kind === "question" || payload.kind === "approval") && answer.kind !== "handoff") {
      // Only "allow once" grants the woken session's repeat; "allow always" uses the project allowlist, deny and cancel grant nothing.
      if (payload.kind === "approval" && answer.kind === "approval" && answer.decision === "allow_once" && payload.command) this.hibernation.grant(run.id, { command: payload.command, cwd: payload.cwd, paths: payload.paths, network: payload.network });
      this.turns.queue.add(run.task_id, run.member_id, answerAfterSleep(payload, answer), "note");
      await this.wakeRun(run.id, "answer");
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
    for (const [runId, cause] of [...this.pendingWake]) await this.wakeRun(runId, cause);
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
        // A step runs once, and again only when a step it depends on finished again (the loops).
        const again = runs.some((r) => r.member_id === m.id) ? this.rerunOf(m, members, runs) : null;
        if (runs.some((r) => r.member_id === m.id) && !again) {
          this.blocked.delete(m.id);
          continue;
        }
        const deps = JSON.parse(m.depends_on) as string[];
        const done = (step: string) => {
          const dep = members.find((x) => x.step === step);
          return dep !== undefined && runs.some((r) => r.member_id === dep.id && r.end_reason === "completed");
        };
        if (!deps.every(done)) continue;
        // A Best of N step runs as its variants' tasks until you keep one; then the kept run is its run.
        const group = this.bestOf.group(task.id);
        if (group?.member_id === m.id && !runs.some((r) => r.member_id === m.id)) {
          if (!group.started_at && !group.kept_variant_id) await this.startGroup(task, m, group, project, config.rules.slots, (candidates ??= await this.candidates(project)));
          continue;
        }
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
        // A re-run stays on the profile that last ran the step (a handoff may have moved it off the proposal).
        if (again) await this.launch({ task, member: m, target: { profileId: again.profile_id, runner: again.runner, model: again.model }, resumedFrom: again.id });
        else await this.launch({ task, member: m, target: chosen! });
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
    const usd = estimateFor(candidate, this.tpl(m), task.size, this.now()).usd ?? 0;
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
    const runId = this.insertRun(spec);
    await this.boot(runId, spec);
    return runId;
  }

  /** The run row of a launch, written before any await so admission control counts it at once. */
  private insertRun(spec: LaunchSpec): string {
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
    this.loops.enlist(runId, member.id);
    this.emitTask(task.id, "run_started");
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
      // Pinned review: a read-only reviewer of a code task reads a detached checkout of the exact
      // head, never the live worktree the implementer may still change.
      const pinned = !spec.cwd && PINNED_ROLES.includes(member.role) && task.kind === "code" && wt && existsSync(wt.path) ? await this.reviewCheckout(runId, task, wt) : null;
      if (pinned) cwd = pinned.path;
      const worktreeId = wt && sameDir(wt.path, cwd) ? wt.id : null;
      this.db.exec("update runs set cwd = ?, worktree_id = ? where id = ?", cwd, worktreeId, runId);
      if (member.writes_code && worktreeId) this.db.exec("update worktrees set owner_run_id = ?, last_heartbeat_at = ? where id = ?", runId, this.iso(), worktreeId);

      const candidate = (await this.candidates(project)).find((c) => c.profile.id === target.profileId);
      if (!candidate) throw new OrchestratorError("crew.unknown_profile", { profileId: target.profileId });
      const adapter = this.adapters.get(target.runner);
      if (!adapter) throw new OrchestratorError("adapter.failed", { detail: "no_adapter" });
      // A capped task never starts on a model nobody can price without your click (feature scan F4).
      const unpriced = this.unpricedFor(task, runId, candidate, target.model, estimateFor(candidate, this.tpl(member), task.size, this.now()).usd === null);
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
      if (candidate.profile.credential.kind === "api_key") reserveSpend(this.opts.store.db, { runId, taskId: this.budgetTask(task.id), credentialId: spendCredential(candidate), amountUsd: amount }, this.now());
      // Handoff by fork: the target continues a copy of the source's conversation; on any failure it
      // gets the written package in a new session instead, as before.
      const forked = spec.fork ? await this.forkInto(runId, spec, candidate, cwd) : null;
      const resumeRef = forked?.session ?? spec.resumeRef ?? null;
      if (resumeRef) this.resumed.add(runId);
      // Messages typed for the step while it had no process go with the first prompt.
      let base = forked && spec.fork ? spec.fork.prompt : (spec.prompt ?? rolePrompt(this.tpl(member), task, { plan: this.latestPlan(task.id), branch: worktreeId ? (wt?.branch ?? null) : null }));
      if (pinned && !spec.prompt) base += reviewContext({ sha: pinned.sha, baseSha: wt?.base_sha ?? null, branch: wt?.branch ?? null, test: this.loops.lastTaskTest(task.id), previous: this.loops.previousVerdict(member.id, null) });
      const queued = this.withQueued(member.id, base, Boolean(resumeRef));
      // A new session has not seen the description's attachments; a resumed or forked one has.
      const first = withAttachments(queued.prompt, [...(resumeRef ? [] : this.attachments.forTask(task.id)), ...queued.attachments], adapter.capabilities);
      // Codex reviews with its own review/start against the task's base; the verdict schema still applies.
      const review: ReviewTarget | null = pinned && member.role === "reviewer" && !resumeRef && adapter.capabilities.nativeReview ? { kind: "base_branch", branch: task.base_branch ?? wt!.base_sha } : null;
      if (review) this.nativeReviews.add(runId);
      const policy = this.policyFor(this.tpl(member), config);
      const req: StartRequest = {
        profile: candidate.profile,
        cwd,
        model: target.model,
        prompt: first.text,
        ...(first.attachments ? { attachments: first.attachments } : {}),
        policy,
        env: { ...(await this.directory.envFor(target.profileId)), ...(boot?.status === "ready" ? boot.env : {}) },
        outputSchema: outputSchemaFor(member.role),
        nextTurn: () => this.nextTurn(runId),
        ...(review ? { review: { target: review } } : {}),
        ...(await this.mcpFor(runId, task.id, project.id, policy, adapter)),
      };
      await this.turns.begin(runId);
      const handle = resumeRef ? await adapter.resume(resumeRef, req) : await adapter.start(req);
      for (const id of queued.ids) this.turns.queue.deliver(id, runId);
      this.db.exec("update runs set native_session_id = ?, pid = ? where id = ?", handle.nativeSession?.sessionId ?? null, handle.pid, runId);
      this.attach(runId, adapter, handle, candidate);
      this.audit(task.id, runId, "run.started", { role: member.role, profileId: target.profileId, runner: target.runner, resumed: Boolean(resumeRef), forked: Boolean(forked), pinned: pinned?.sha ?? null, nativeReview: Boolean(review) });
      if (forked) await this.recordForkSpend(runId, forked);
    } catch (err) {
      this.held.delete(runId);
      this.confirming.delete(runId);
      // The runner itself says the session is gone, or still locked after a crash: only then is a
      // session with history replaced, by a fresh run fed the handoff package. A handoff target
      // has its own fallback (the source stays paused), so it is never replaced here.
      const problem = spec.resumeRef && !spec.replacing && !spec.handoffId ? sessionProblemOf(err) : null;
      // The reason stays with the run (redacted), so the UI can say why it never started.
      this.endRun(runId, "failed", problem ? `session.${problem}` : errorDetail(err, await this.secretsFor(target.profileId)));
      if (problem) await this.replaceSession(runId, problem);
    }
  }

  /** Copies the source's session into the target profile for a handoff by fork; null on any failure. */
  private async forkInto(runId: string, spec: LaunchSpec, candidate: Candidate, cwd: string): Promise<ForkResult | null> {
    const source = this.db.run(spec.fork!.sourceRunId);
    const adapter = this.adapters.get(source.runner);
    const sourceCandidate = await this.candidateFor(source);
    if (!adapter?.fork || !sourceCandidate || !source.native_session_id) return null;
    try {
      const res = await adapter.fork({
        source: { profile: sourceCandidate.profile, session: { runner: source.runner, sessionId: source.native_session_id }, env: await this.directory.envFor(source.profile_id) },
        target: { profile: candidate.profile, model: spec.target.model, env: await this.directory.envFor(candidate.profile.id) },
        cwd,
        compact: adapter.capabilities.fork?.compact ?? false,
      });
      if (spec.handoffId) {
        this.db.exec("update handoffs set kind = 'fork' where id = ?", spec.handoffId);
        this.db.exec("update handoff_extras set forked = 1 where handoff_id = ?", spec.handoffId);
      }
      this.audit(spec.task.id, runId, "handoff.forked", { from: source.id, compacted: res.compacted, summaryChars: res.summary?.length ?? 0 });
      return res;
    } catch (err) {
      this.audit(spec.task.id, runId, "handoff.fork_failed", { from: source.id, code: errorCode(err), problem: sessionProblemOf(err) });
      return null;
    }
  }

  /**
   * A fork's compaction spent tokens on the target's key before the run existed; they count on the
   * target run like any usage report. The new session's totals become its baseline, so the
   * runner's later reports add only their growth.
   */
  private async recordForkSpend(runId: string, f: ForkResult): Promise<void> {
    const run = this.db.run(runId);
    if (!run.native_session_id || !f.usage) return;
    const totals = f.totals ?? f.usage;
    const less = (a: number, b: number) => Math.max(0, a - b);
    this.db.setNativeUsage(
      run.runner,
      run.native_session_id,
      {
        tokensIn: less(totals.tokensIn, f.usage.tokensIn),
        tokensOut: less(totals.tokensOut, f.usage.tokensOut),
        cacheRead: less(totals.cacheRead, f.usage.cacheRead),
        costUsd: totals.costUsd !== null && f.usage.costUsd !== null ? less(totals.costUsd, f.usage.costUsd) : null,
        // Compaction searches nothing: the requests a fork copied with the history are all baseline.
        webSearchRequests: totals.webSearchRequests,
        webFetchRequests: totals.webFetchRequests,
      },
      this.iso(),
    );
    await this.onUsage(run, this.db.task(run.task_id), {
      type: "usage.update",
      runId,
      seq: -1,
      at: this.iso(),
      source: { adapter: run.runner, cliVersion: null },
      tokensIn: totals.tokensIn,
      tokensOut: totals.tokensOut,
      cacheRead: totals.cacheRead,
      cacheWrite: 0,
      reasoning: 0,
      contextUsed: null,
      contextSize: null,
      costUsd: totals.costUsd,
      costProvenance: totals.costUsd === null ? "unknown" : "estimated",
      webSearchRequests: totals.webSearchRequests,
      webFetchRequests: totals.webFetchRequests,
    });
  }

  /**
   * The runner said the step's session is gone or locked (a Claude session whose resume is locked
   * after a crash): a fresh run of the same step on the same profile, fed the handoff package,
   * since a fresh session has none of the conversation. Recorded with the reason.
   */
  private async replaceSession(failedRunId: string, problem: SessionProblem): Promise<void> {
    const failed = this.db.run(failedRunId);
    const task = this.db.task(failed.task_id);
    if (task.cancelled_at || this.db.successor(failed)) return;
    const pkg = await this.writePackage(task, failed, `the previous session is ${problem === "locked" ? "locked by another process" : "gone"}`, `session-${failedRunId}`);
    this.audit(task.id, failedRunId, "session.replaced", { problem, packagePath: pkg.path });
    await this.launch({ task, member: this.db.member(failed.member_id), target: { profileId: failed.profile_id, runner: failed.runner, model: failed.model }, cwd: failed.cwd, prompt: pkg.text, resumedFrom: failed.id, replacing: true });
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
    // A new process for a hibernated run is its wake-up, whoever started it (resume, retry, answer).
    const wokeBy = this.pendingWake.get(runId) ?? "resume";
    if (this.hibernation.wake(runId, wokeBy)) this.audit(this.db.run(runId).task_id, runId, "run.woke", { by: wokeBy });
    this.pendingWake.delete(runId);
    const live: Live = { adapter, handle, candidate, done: new Promise<void>((r) => (finish = r)), inTurn: true, turnBegun: false };
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
          const result = applyResult(this.db, runId, ev, (kind, payload) => this.audit(this.db.run(runId).task_id, runId, kind, payload));
          if (result) this.keepVerdict(runId, result);
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
    // A source that lost its step to a handoff may still send events before its process is gone.
    // They are logged and their spend counts, but they change no state and ask nobody anything.
    if (this.loops.fenced(runId, run.member_id) && ev.type !== "usage.update") {
      if (ev.type === "request.question" || ev.type === "request.approval") {
        const live = this.live.get(runId);
        if (live) await this.safe(() => live.adapter.answer(live.handle, ev.requestId, { kind: "cancel" }));
      }
      this.audit(task.id, runId, "event.fenced", { type: ev.type });
      return;
    }
    this.db.exec("update runs set last_activity_at = ? where id = ?", ev.at, runId);
    switch (ev.type) {
      case "run.state":
        this.db.exec("update runs set last_state = ? where id = ?", ev.state, runId);
        break;
      case "turn.started": {
        this.turns.ref(runId, ev.turnRef);
        const live = this.live.get(runId);
        if (live) live.turnBegun = true;
        break;
      }
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
    // Stopped for hibernation: the run stays open and holds its step.
    if (this.hibernating.delete(runId)) {
      this.emitTask(run.task_id, "hibernation");
      void this.tick();
      return;
    }
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
    // The loop stopped this implementer (iteration cap, no change, spend cap): the step failed its tests.
    const loopStop = this.loopFailed.get(runId);
    this.loopFailed.delete(runId);
    if (ended.reason === "completed" && loopStop) {
      this.endRun(runId, "failed", loopStop);
      return;
    }
    // Runners report provider errors as they got them; what we keep and show is redacted and bounded.
    const detail = ended.detail === null ? null : redactDetail(ended.detail, await this.secretsFor(run.profile_id)) || null;
    // Claude reports a gone or locked session only in its stream (adapter-claude: "session.gone: ...").
    const problem = ended.reason === "failed" && this.resumed.has(runId) && !run.handoff_id ? /^session\.(gone|locked):/.exec(detail ?? "")?.[1] : undefined;
    if (ended.reason === "completed") await this.pinHead(runId);
    this.endRun(runId, ended.reason, detail);
    if (problem && !this.confirming.has(runId)) {
      await this.replaceSession(runId, problem as SessionProblem);
      return;
    }
    if (ended.reason === "failed") await this.onFailure(runId, detail);
    const verdict = this.verdicts.get(runId);
    this.verdicts.delete(runId);
    if (ended.reason === "completed" && verdict) await this.reviewLoop(runId, verdict);
  }

  /** A reviewer's checked verdict, stored with the commit its pinned checkout held. */
  private keepVerdict(runId: string, result: RoleResult): void {
    const run = this.db.run(runId);
    if (result.kind === "review") {
      const pinned = this.loops.checkout(runId);
      this.loops.addVerdict({ runId, taskId: run.task_id, memberId: run.member_id, verdict: result.verdict, headSha: pinned?.sha ?? null, native: this.nativeReviews.has(runId) });
    }
    if (run.role === "reviewer") this.verdicts.set(runId, result);
  }

  private endRun(runId: string, reason: EndReason, detail: string | null): void {
    const run = this.db.run(runId);
    if (run.ended_at) return;
    this.db.exec("update runs set ended_at = ?, end_reason = ?, end_detail = ? where id = ? and ended_at is null", this.iso(), reason, detail, runId);
    this.clearTimer(runId);
    this.held.delete(runId);
    this.turns.end(runId);
    this.resumed.delete(runId);
    this.nativeReviews.delete(runId);
    this.draining.delete(runId);
    this.drainRelease.get(runId)?.(null);
    this.drainRelease.delete(runId);
    this.track(this.dropCheckout(runId));
    // The runner may expire its own record; ours stays with the task (feature scan A18).
    if (run.native_session_id) this.track(this.copyTranscript(runId));
    settleReservation(this.opts.store.db, runId, this.now());
    // Its report ticket stops working and its open questions close (docs/adr/0007).
    this.mcp?.runEnded(runId);
    this.hibernation.wake(runId, "ended");
    this.hibernation.dropGrant(runId);
    this.pendingWake.delete(runId);
    // A Best of N variant's diff is what you compare; read it from git once its run is over.
    const variant = this.bestOf.variantByTask(run.task_id);
    if (variant) this.track(this.refreshVariantDiff(variant.id));
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
      await live.adapter.send(live.handle, withAttachments(queued.prompt, queued.attachments, live.adapter.capabilities));
      for (const id of queued.ids) this.turns.queue.deliver(id, runId);
      return;
    }
    const adapter = this.adapters.get(run.runner);
    if (!adapter?.capabilities.resume || !run.native_session_id) throw new OrchestratorError("run.resume_unsupported", { runner: run.runner });
    const task = this.db.task(run.task_id);
    const project = this.db.project(task.project_id);
    const candidate = (await this.candidates(project)).find((c) => c.profile.id === run.profile_id);
    if (!candidate) throw new OrchestratorError("crew.unknown_profile", { profileId: run.profile_id });
    const policy = this.policyFor(this.tpl(run), this.config(project).config);
    const input = withAttachments(queued.prompt, queued.attachments, adapter.capabilities);
    const req: StartRequest = {
      profile: candidate.profile,
      cwd: run.cwd,
      model: run.model,
      prompt: input.text,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      policy,
      env: { ...(await this.directory.envFor(run.profile_id)), ...this.bootstrapEnv(run, project) },
      outputSchema: outputSchemaFor(run.role),
      nextTurn: () => this.nextTurn(runId),
      ...(await this.mcpFor(runId, task.id, project.id, policy, adapter)),
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
    const policy = this.policyFor(this.tpl(run), config);
    const allowlist = [...policy.allowCommands, ...this.db.allowRules(project.id)];
    const risk = classifyRisk({ command: ev.command, cwd: ev.cwd, paths: ev.paths, network: ev.network, worktreeRoot: run.cwd, projectRoot: project.path, allowlist });

    let rule: string | null = null;
    if (policy.writes === "none" && ev.paths.length > 0) rule = "policy.role_read_only";
    else if (policy.writes === "docs" && ev.paths.length > 0 && !onlyDocPaths(ev.paths)) rule = "policy.role_docs_only";
    else if (policy.network === "denied" && ev.network) rule = "policy.role_no_network";

    // You approved this exact call while the run was hibernated; the woken session repeats it once.
    const approvedAsleep = !rule && this.hibernation.takeGrant(run.id, { command: ev.command, cwd: ev.cwd, paths: ev.paths, network: ev.network });
    const decision: "deny" | "allow_once" | null = rule ? "deny" : risk === "low" || approvedAsleep ? "allow_once" : null;
    const payload: RequestPayload = { kind: "approval", toolCallId: ev.toolCallId, command: ev.command, cwd: ev.cwd, paths: ev.paths, network: ev.network, policy: rule ?? (approvedAsleep ? "policy.approved_while_hibernated" : decision ? "policy.allowlisted" : null) };
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
    const seen = this.db.nativeUsage(run.runner, session) ?? { tokensIn: 0, tokensOut: 0, cacheRead: 0, reasoning: 0, costUsd: null, webSearchRequests: 0, webFetchRequests: 0 };
    const restarted = ev.tokensIn < seen.tokensIn || ev.tokensOut < seen.tokensOut;
    const grow = (now: number, before: number) => (restarted ? now : Math.max(0, now - before));
    const dIn = grow(ev.tokensIn, seen.tokensIn);
    const dOut = grow(ev.tokensOut, seen.tokensOut);
    const dCache = grow(ev.cacheRead, seen.cacheRead);
    const dReasoning = grow(ev.reasoning, seen.reasoning);
    // A request total below the last one restarted on its own (a resumed Codex thread whose
    // rollout could not be read), so its requests count in full; a runner that cannot see
    // requests reports none and adds none.
    const growRequests = (now: number | undefined, before: number) => (now === undefined ? 0 : restarted || now < before ? now : now - before);
    const dSearch = growRequests(ev.webSearchRequests, seen.webSearchRequests);
    const dFetch = growRequests(ev.webFetchRequests, seen.webFetchRequests);
    const requests = ev.webSearchRequests !== undefined || ev.webFetchRequests !== undefined ? { webSearchRequests: ev.webSearchRequests ?? seen.webSearchRequests, webFetchRequests: ev.webFetchRequests ?? seen.webFetchRequests } : {};
    this.db.setNativeUsage(run.runner, session, { tokensIn: ev.tokensIn, tokensOut: ev.tokensOut, cacheRead: ev.cacheRead, reasoning: ev.reasoning, costUsd: ev.costUsd, ...requests }, ev.at);

    const live = this.live.get(run.id);
    const model = live?.candidate.model ?? null;
    // Catalog prices, and OpenCode's own estimate (it prices from models.dev too), are the standard
    // rate; DeepSeek bills twice that in its weekday peak hours.
    const peak = peakFactor(live?.candidate.peak, this.now());
    // DeepSeek bills the searches and fetches its server runs per request, at one rate all day and
    // only from its billing start. No runner's own estimate on DeepSeek includes them.
    const requestUsd = live?.candidate.profile.credential.kind === "api_key" ? requestCost(live.candidate.requests, dSearch, dFetch, this.now()) : 0;
    let dCost: number | null;
    let provenance: Provenance;
    if (ev.costUsd !== null) {
      dCost = restarted ? ev.costUsd : Math.max(0, ev.costUsd - (seen.costUsd ?? 0));
      provenance = ev.costProvenance;
      // A billed cost already holds every request.
      if (provenance === "estimated") dCost = dCost * peak + requestUsd;
    } else if (live && live.candidate.profile.credential.kind !== "api_key") {
      [dCost, provenance] = [0, "estimated"];
    } else {
      // The runner could not price these tokens (e.g. Claude Code on DeepSeek): price them from the catalog.
      const usd = model ? estimateCost(model, dIn, dOut, dCache) : null;
      dCost = usd === null ? null : usd * peak + requestUsd;
      provenance = dCost === null ? "unknown" : "estimated";
    }
    if (live && dCost !== null) {
      recordRunSpend(
        this.opts.store.db,
        live.candidate,
        {
          // A Best of N variant spends on its parent's budget and per-task caps.
          taskId: this.budgetTask(task.id),
          runId: run.id,
          profileId: run.profile_id,
          model: run.model ?? model?.id ?? null,
          tokensIn: dIn,
          tokensOut: dOut,
          tokensCache: dCache,
          tokensReasoning: dReasoning,
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
    // A Best of N variant counts against its parent: one budget, one per-task cap for the group.
    const root = this.budgetTask(taskId);
    const caps = reachedCaps(db, spendCredential(candidate), root, this.now(), { addUsd, excludeRunId: runId });
    const task = this.db.task(root);
    if (task.budget_usd !== null) {
      const spent = this.db.spend(this.budgetRuns(root)).usd;
      const held = reservedUsd(db, { taskId: root, excludeRunId: runId });
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
    if (this.db.task(this.budgetTask(task.id)).budget_usd !== null) caps.push("task_budget");
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
    if (await this.switchAccount(this.db.run(runId), task, info)) return;
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
      const info: HandoffInfo = { trigger: "limit", window: null, resetsAt: null, failure: "credit" };
      if (await this.switchAccount(run, task, info)) return;
      await this.offerHandoff(run, task, mode, info, "credit_depleted");
      return;
    }
    if (failure.kind === "transient") {
      // Never wait when the next step is another profile: Auto with a target switches now.
      const switching = mode === "auto" && this.handoffsTaken(run) < MAX_AUTO_HANDOFFS && (await this.autoTargets(run, task, await this.handoffCandidates(run, task, { trigger: "crashed", failure: "transient" }))).length > 0;
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
    // A session with history is never replaced on its own: without a native resume, you decide.
    if (!native && run.native_session_id) {
      this.audit(task.id, run.id, "run.retry_skipped", { reason: "no_resume" });
      await this.offerHandoff(run, task, "manual", { trigger: "crashed", window: null, resetsAt: null, failure: failure.kind }, null);
      this.emitTask(task.id, "retried");
      return;
    }
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
    const next = mode === "auto" ? (await this.autoTargets(run, task, candidates))[0] : undefined;
    if (next && this.handoffsTaken(run) < MAX_AUTO_HANDOFFS) {
      this.track(this.performHandoff(run.id, next, info.trigger === "unpriced" ? "budget" : info.trigger));
      return;
    }
    this.insertRequest(task.id, run.id, null, null, {
      kind: "handoff",
      trigger: detail === "handoff_failed" || detail === "handoff_interrupted" ? "handoff_failed" : info.trigger,
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
      .filter((c): c is Candidate => c !== undefined && eligible(c, this.tpl(member), ctx) && !avoid.models.has(modelKey(c)) && usable(c))
      // Budget left (PLAN.md §8.2 step 2): a key past its daily or task cap is no target.
      .filter((c) => reachedCaps(this.opts.store.db, spendCredential(c), task.id, this.now(), { excludeRunId: run.id }).length === 0)
      .map((c) => scoreCandidate(c, this.tpl(member), ctx, avoid))
      .filter((v) => (v.headroom.pct === null || v.headroom.pct > MIN_HEADROOM) && (task.budget_usd === null || v.estimate.usd === 0 || spent < task.budget_usd));
  }

  private avoidFor(member: MemberRow): { models: Set<string>; providers: Set<string> } {
    // The implementer's model is whatever actually ran, including handoff targets.
    const avoid = { models: this.ranModels(member), providers: new Set<string>() };
    const crewMembers = this.db.members(member.crew_id);
    for (const role of this.tpl(member).independentOf) {
      const other = crewMembers.find((m) => m.role === role);
      if (!other) continue;
      const chosen = other.chosen ? (JSON.parse(other.chosen) as CandidateView) : null;
      if (chosen) {
        avoid.models.add((chosen.model ?? `profile:${chosen.profileId}`).toLowerCase());
        avoid.providers.add(chosen.providerId);
      }
    }
    // The rule cuts both ways: an implementer's handoff target must not take the approved reviewer's model.
    for (const other of crewMembers.filter((m) => this.tpl(m).independentOf.includes(member.role))) {
      const chosen = other.chosen ? (JSON.parse(other.chosen) as CandidateView) : null;
      if (chosen) avoid.models.add((chosen.model ?? `profile:${chosen.profileId}`).toLowerCase());
    }
    return avoid;
  }

  /**
   * Auto mode never moves a step to another account of the same provider on its own: only the
   * account-switch setting does, with its own rules (docs/adr/0009). Another profile on the same
   * key is the same account and stays a target. Manual and Ask still list them all.
   */
  private async autoTargets(run: RunRow, task: TaskRow, candidates: CandidateView[]): Promise<CandidateView[]> {
    const all = await this.candidates(this.db.project(task.project_id));
    const source = all.find((c) => c.profile.id === run.profile_id);
    if (!source) return candidates;
    const others = new Set(sameProviderAccounts(source, all).map((c) => c.profile.id));
    return candidates.filter((v) => !others.has(v.profileId));
  }

  /**
   * Same-provider account switch (docs/adr/0009). With Settings on and the task not held out, a
   * limit, an empty credit or the key's own spend cap moves the step to the next account of the
   * same runner and provider that passes preflight, whatever the task's fallback mode. True when
   * the switch started. Otherwise the task's mode decides, and when there was an account to try,
   * why each was passed over goes to the timeline.
   */
  private async switchAccount(run: RunRow, task: TaskRow, info: HandoffInfo): Promise<boolean> {
    const trigger = switchTrigger(info);
    // A Best of N variant follows the task you see, whose proposal held it in or out.
    if (!trigger || task.cancelled_at || !this.switches.allowed(this.bestOf.parentOf(task.id) ?? task.id)) return false;
    const project = this.db.project(task.project_id);
    const all = await this.candidates(project);
    const source = all.find((c) => c.profile.id === run.profile_id);
    const sourceAccount = source ? accountOf(source) : null;
    if (!source || sourceAccount === null || isClaudeSubscription(source)) return false;
    const accounts = sameProviderAccounts(source, all);
    if (accounts.length === 0) return false;

    const member = this.db.member(run.member_id);
    const ctx = this.scoring(project.id, task.size, task.budget_usd);
    const avoid = this.avoidFor(member);
    const chain = (JSON.parse(member.standby) as CandidateView[]).map((s) => s.profileId);
    const ranked = rankForRole(accounts, this.tpl(member), ctx, avoid).map((v) => v.profileId);
    const left = this.switches.leftAccounts(member.id);
    const spent = this.db.spend(this.db.runs(task.id)).usd ?? 0;
    const sourceInfo = sourceOf(trigger, info, this.db.headroom(run.profile_id, this.now()));
    const from = { profileId: source.profile.id, alias: source.profile.alias };
    const skipped: AccountSwitchSkipped[] = [];
    for (const c of switchOrder(accounts, chain, ranked)) {
      const view = scoreCandidate(c, this.tpl(member), ctx, avoid);
      const reason = refusalOf({
        sameKind: c.profile.credential.kind === source.profile.credential.kind,
        ready: c.ready && this.adapters.has(c.profile.runner),
        claudeSubscription: isClaudeSubscription(c),
        roleOk: eligible(c, this.tpl(member), ctx),
        independent: !avoid.models.has(modelKey(c)),
        leftBefore: left.has(accountOf(c)!),
        overCap: reachedCaps(this.opts.store.db, spendCredential(c), task.id, this.now(), { excludeRunId: run.id }).length > 0,
        overBudget: task.budget_usd !== null && view.estimate.usd !== 0 && spent >= task.budget_usd,
        headroom: view.headroom,
      });
      if (reason) {
        skipped.push({ profileId: c.profile.id, alias: c.profile.alias, reason });
        continue;
      }
      const to = { profileId: c.profile.id, alias: c.profile.alias };
      this.track(
        this.performHandoff(run.id, view, info.trigger === "budget" ? "budget" : "limit", {
          mode: "auto",
          onClaim: (handoffId) => {
            const rec = this.switches.record({ taskId: task.id, memberId: member.id, fromRunId: run.id, handoffId, runner: source.profile.runner, providerId: source.profile.providerId, from: { ...from, account: sourceAccount }, to, trigger, source: sourceInfo, headroom: view.headroom, estimate: view.estimate, skipped });
            this.audit(task.id, run.id, "account.switched", { phase: "switched", switchId: rec.id, handoffId, trigger, providerId: rec.providerId, from, to, source: sourceInfo, headroom: view.headroom, estimate: view.estimate, skipped });
          },
        }),
      );
      return true;
    }
    this.audit(task.id, run.id, "account.switch_refused", { phase: "refused", switchId: null, trigger, providerId: source.profile.providerId, from, to: null, source: sourceInfo, headroom: null, estimate: null, skipped });
    return false;
  }

  /** Models that actually ran for the roles this member must stay independent of. */
  private ranModels(member: MemberRow): Set<string> {
    const out = new Set<string>();
    for (const other of this.db.members(member.crew_id).filter((m) => this.tpl(member).independentOf.includes(m.role))) {
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
    const ranked = rankForRole(await this.candidates(project), this.tpl(member), ctx, this.avoidFor(member));
    return ranked.find((v) => v.profileId === profileId) ?? null;
  }

  /**
   * `mode` overrides what the handoff record says it ran under (an account switch is automatic
   * whatever the task's mode); `onClaim` records what started it once the claim holds.
   */
  private async performHandoff(sourceRunId: string, target: CandidateView, trigger: HandoffTrigger, opts: { mode?: FallbackMode; onClaim?: (handoffId: string) => void } = {}): Promise<void> {
    const source = this.db.run(sourceRunId);
    const task = this.db.task(source.task_id);
    const project = this.db.project(task.project_id);

    // Preflight before claiming anything, so a target that cannot start never touches the source.
    const candidate = (await this.candidates(project)).find((c) => c.profile.id === target.profileId);
    if (!candidate?.ready || !this.adapters.has(target.runner)) {
      await this.offerHandoff(source, task, "manual", { trigger, window: null, resetsAt: null }, "target_unavailable");
      return;
    }
    const handoffId = this.claimHandoff(source, task, target, trigger, opts.mode);
    if (!handoffId) return;
    opts.onClaim?.(handoffId);
    await this.executeHandoff(handoffId, source.id, target, trigger);
  }

  /** The checks runs.handoff makes before it touches the source; each failure is an error code. */
  private async preflightTarget(source: RunRow, task: TaskRow, profileId: string): Promise<CandidateView> {
    const project = this.db.project(task.project_id);
    const member = this.db.member(source.member_id);
    const c = (await this.candidates(project)).find((x) => x.profile.id === profileId);
    if (!c) throw new OrchestratorError("crew.unknown_profile", { profileId });
    if (!c.ready || !this.adapters.has(c.profile.runner)) throw new OrchestratorError("handoff.target_not_ready", { profileId });
    if (readOnlyConflict(c, this.tpl(member))) throw new OrchestratorError("crew.read_only_profile", { profileId, role: member.role });
    const ctx = this.scoring(project.id, task.size, task.budget_usd);
    if (!eligible(c, this.tpl(member), ctx)) throw new OrchestratorError("crew.unknown_profile", { profileId });
    const avoid = this.avoidFor(member);
    if (avoid.models.has(modelKey(c))) throw new OrchestratorError("crew.independence", { role: member.role });
    // Your "continue" past the task budget on this step carries over to the AI you move it to.
    const stepApproved = new Set([...this.approvalsFor(source.id)].filter((k) => k === "task_budget"));
    const cap = this.capFor(task.id, null, c, 0, stepApproved);
    if (cap?.kind === "task_budget") throw new OrchestratorError("handoff.over_budget", { spentUsd: cap.spentUsd, capUsd: cap.capUsd });
    if (cap) throw new OrchestratorError("handoff.over_cap", { profileId, cap: cap.kind });
    return scoreCandidate(c, this.tpl(member), ctx, avoid);
  }

  /**
   * Claim: one open handoff per source run (also a unique index). A second click, or Auto racing
   * a click, gets null instead of starting a second target.
   */
  private claimHandoff(source: RunRow, task: TaskRow, target: CandidateView, trigger: HandoffTrigger, mode?: FallbackMode): string | null {
    const handoffId = this.db.tx(() => {
      if (this.db.openHandoffs().some((h) => h.from_run_id === source.id)) return null;
      const id = randomUUID();
      this.db.exec(
        "insert into handoffs (id, task_id, from_run_id, target_profile_id, mode, trigger_kind, phase, opened_at) values (?, ?, ?, ?, ?, ?, 'stopping_source', ?)",
        id,
        task.id,
        source.id,
        target.profileId,
        mode ?? (trigger === "manual" ? "manual" : task.fallback),
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
      // Stop the source at a turn boundary; never replay a half-finished tool call. "Drain" lets
      // the turn in flight finish first (bounded), "interrupt" ends it now.
      const live = this.live.get(source.id);
      if (live && live.inTurn && this.loops.handoffStop(handoffId) === "drain") {
        const boundary = new Promise<boolean>((resolve) => this.draining.set(source.id, () => resolve(true)));
        let timer: NodeJS.Timeout | undefined;
        const drained = await Promise.race([boundary, live.done.then(() => false), new Promise<false>((r) => (timer = setTimeout(() => r(false), this.opts.drainTimeoutMs ?? DRAIN_TIMEOUT_MS)))]);
        clearTimeout(timer);
        this.draining.delete(source.id);
        this.audit(task.id, source.id, "handoff.drained", { handoffId, drained });
        if (this.db.run(source.id).end_reason === "completed") {
          // The turn was the step's last: there is nothing left to hand over.
          this.closeHandoff(handoffId, "cancelled", "source_completed");
          this.emitTask(task.id, "handoff_failed");
          return;
        }
      }
      if (this.live.get(source.id) === live && live) {
        this.db.exec("update runs set paused_at = coalesce(paused_at, ?) where id = ?", this.iso(), source.id);
        if (this.drainRelease.has(source.id)) {
          // Held at its boundary with no turn running: stop the process, then let the boundary go.
          await this.safe(() => live.adapter.stop(live.handle));
          this.drainRelease.get(source.id)?.(null);
          this.drainRelease.delete(source.id);
          await this.within(live.done, this.opts.stopTimeoutMs ?? 30_000);
        } else {
          await this.safe(() => live.adapter.interrupt(live.handle));
          if (!(await this.within(live.done, this.opts.stopTimeoutMs ?? 30_000))) await this.safe(() => live.adapter.stop(live.handle));
        }
      }
      // A source a cap held before it ever started has nothing to hand over: the target starts the step fresh.
      const neverStarted = !live && source.native_session_id === null && source.tokens_in + source.tokens_out === 0;
      this.held.delete(source.id);
      // The stopped source spends no more; its hold must not block the target on the same key.
      settleReservation(this.opts.store.db, source.id, this.now());

      phase("checkpoint");
      const pkg = await this.writePackage(task, source, trigger, `handoff-${handoffId}`);
      const native = target.runner === source.runner && target.profileId === source.profile_id && source.native_session_id !== null;
      this.db.exec("update handoffs set package_path = ?, checkpoint_sha = ?, kind = ? where id = ?", pkg.path, pkg.sha, native ? "native_resume" : "new_session", handoffId);
      // Fork where the runner can carry the conversation over (feature scan A11): same runner and
      // provider, so the history means the same to the target. Never for a role that must stay
      // independent of another (the reviewer), whose own reading must not start from anyone's history.
      const sourceProvider = (await this.candidateFor(source))?.profile.providerId ?? null;
      const forkable = !native && !neverStarted && source.native_session_id !== null && target.runner === source.runner && sourceProvider !== null && sourceProvider === target.providerId && this.tpl(source).independentOf.length === 0 && Boolean(this.adapters.get(source.runner)?.fork);

      phase("starting_target");
      const targetRunId = await this.launch({
        task,
        member: this.db.member(source.member_id),
        target,
        cwd: source.cwd,
        prompt: native ? "Continue the task." : neverStarted ? undefined : pkg.text,
        resumeRef: native ? { runner: source.runner, sessionId: source.native_session_id! } : null,
        resumedFrom: source.id,
        handoffId,
        fork: forkable ? { sourceRunId: source.id, prompt: forkPrompt({ trigger, packagePath: pkg.path, checkpointSha: pkg.sha }) } : null,
      });
      this.db.exec("update handoffs set to_run_id = ? where id = ?", targetRunId, handoffId);
      phase("confirming");
      const started = this.db.run(targetRunId);
      if (started.ended_at && this.db.handoff(handoffId).closed_at === null) throw new OrchestratorError("adapter.failed", { detail: started.end_detail ?? "target_failed" });
    } catch (err) {
      await this.failHandoff(handoffId, errorCode(err));
    }
  }

  /**
   * PLAN.md §8.2 steps 4 and 5: commits the work in progress, then writes the handoff package under
   * the task folder. Used by every handoff (a fork too, as its fallback) and when a gone or locked
   * session is replaced.
   */
  private async writePackage(task: TaskRow, source: RunRow, trigger: string, name: string): Promise<{ text: string; path: string; sha: string | null }> {
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
      role: this.tpl(source),
      trigger,
      plan: this.latestPlan(task.id, source.id),
      diffStat: stat,
      checkpointSha: sha,
      openQuestions: this.db
        .requests({ taskId: task.id })
        .filter((q) => q.kind === "question")
        .flatMap((q) => (JSON.parse(q.payload) as Extract<RequestPayload, { kind: "question" }>).questions.map((x) => x.prompt)),
      attachments: [...this.attachments.forTask(task.id), ...this.attachments.forMessages(this.turns.queue.pending(source.member_id).map((m) => m.id))],
      transcript: transcript ? `${transcript} (copy of the ${source.runner} session record; the event log of run ${source.id} is in the Crewyard database)` : `Event log of run ${source.id} in the Crewyard database.`,
    });
    const path = join(this.opts.dataDir, "tasks", task.id, `${name}.md`);
    writeFileAtomic(path, text);
    return { text, path, sha };
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
    // The controller swap: the step's epoch moves on, so anything the source still sends is fenced.
    this.loops.bump(target.member_id, targetRunId);
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
      // A hibernated run has no process to lose; it stays open and waits to wake as before.
      if (this.hibernation.asleep(r.id)) {
        tasks.add(r.task_id);
        continue;
      }
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
      this.audit(h.task_id, h.from_run_id, "handoff.reconciled", { handoffId: h.id, phase: h.phase });
      tasks.add(h.task_id);
      // The target never confirmed, so the source still holds the step: ask what to do with it.
      this.track(this.reconcileHandoff(h.from_run_id, h.trigger_kind));
    }
    // Review checkouts of runs the last daemon left behind.
    for (const c of this.loops.openCheckouts()) if (this.db.run(c.run_id).ended_at) this.track(this.dropCheckout(c.run_id));
    tasks.forEach((t) => this.emitTask(t, "recovered"));
  }

  private async reconcileHandoff(sourceRunId: string, trigger: HandoffTrigger): Promise<void> {
    const source = this.db.run(sourceRunId);
    const task = this.db.task(source.task_id);
    if (task.cancelled_at || this.superseded(source) || source.end_reason === "completed") return;
    if (this.db.openRequestsForRun(source.id).some((q) => q.kind === "handoff")) return;
    await this.offerHandoff(source, task, "manual", { trigger, window: null, resetsAt: null }, "handoff_interrupted");
    this.emitTask(task.id, "recovered");
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
    // Newer files are used as far as understood; unusable ones get the defaults with toast approvals off.
    const { config, fromFile } = effectiveProjectConfig(project.path, project.name);
    return { config, fromFile };
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
      now: this.now(),
    };
  }

  private policyFor(tpl: RoleTemplate, config: ProjectConfig): RolePolicy {
    return effectivePolicy(tpl, config);
  }

  /** The role a member or run works as: its snapshot from a role file, else the built-in (role-files.ts). */
  private tpl(m: MemberRow | RunRow): RoleTemplate {
    return this.db.roleTemplate("member_id" in m ? m.member_id : m.id, m.role);
  }


  /** The newest plan any run of the task reported, or one run's plan. */
  private latestPlan(taskId: string, runId?: string): Array<{ title: string; status: "pending" | "in_progress" | "completed" }> | null {
    const runs = this.db.runs(taskId).filter((r) => r.plan && (!runId || r.id === runId));
    const last = runs.at(-1);
    if (last?.plan) return JSON.parse(last.plan);
    // A Best of N variant works from its parent's plan (the planner ran there).
    const parent = runId ? null : this.bestOf.parentOf(taskId);
    return parent ? this.latestPlan(parent) : null;
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
    // A variant's change is its parent's change too: the parent's status and compare view read it.
    const parent = this.bestOf.parentOf(taskId);
    if (parent) this.emit("tasks.changed", { taskId: parent, projectId: task.project_id, status: this.db.status(this.db.task(parent)), cause: "best_of" });
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

