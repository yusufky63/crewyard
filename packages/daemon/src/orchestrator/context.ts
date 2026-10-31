import { freemem } from "node:os";
import type {
  AgentAdapter,
  CandidateView,
  HandoffTrigger,
  LimitWindow,
  NativeSessionRef,
  Profile,
  ProjectConfig,
  Reason,
  RolePolicy,
  RunHandle,
  RunnerId,
  SpendCap,
  StartRequest,
  TaskChangeCause,
  TaskSize,
  TasksIpc,
  TasksTopics,
  UnpricedSpend,
  EndReason,
} from "@crewyard/core";
import type { McpHook } from "../mcp/service.ts";
import type { Store } from "../store.ts";
import type { Bootstrapper } from "../worktrees/bootstrap.ts";
import { effectiveProjectConfig } from "../setup/index.ts";
import type { AdmissionLimits } from "./admission.ts";
import { AdapterRegistry } from "./adapters.ts";
import { AccountSwitches } from "./account-switch.ts";
import { AttachmentStore } from "./attachments.ts";
import { BestOfStore } from "./best-of.ts";
import type { ScoringContext } from "./crew.ts";
import { OrchestratorDb, type MemberRow, type ProjectRow, type RunRow, type TaskRow } from "./db.ts";
import { EMPTY_DIRECTORY, type Candidate, type ProfileDirectory } from "./directory.ts";
import type { FailureClass } from "./failures.ts";
import { HibernationStore, type WakeCause } from "./hibernation.ts";
import { LimitMonitor } from "./limits.ts";
import { LoopStore } from "./loops.ts";
import type { RoleResult } from "./results.ts";
import { effectivePolicy, type RoleTemplate } from "./roles.ts";
import type { Scheduler } from "./schedules.ts";
import { StallMonitor } from "./stall.ts";
import { transcriptPath } from "./transcripts.ts";
import { TurnControl } from "./turns.ts";

// What every part of the orchestrator shares: the store and its views, the live process handles,
// the in-memory notes that change every tick, and the small helpers they all use (audit, emit,
// config, candidates). The parts (tasks.ts, dispatch.ts, launch.ts, ...) hold no state of their
// own beyond what only they read; see orchestrator.ts for how they are wired together.

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

export interface Live {
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

export type ProposeParams = TasksIpc["tasks.propose"]["params"];
export type Ended = { reason: EndReason; detail: string | null };
export type HandoffInfo = { trigger: HandoffTrigger | "unpriced"; window: LimitWindow | null; resetsAt: string | null; cap?: SpendCap | null; unpriced?: UnpricedSpend | null; failure?: FailureClass };
export type LaunchSpec = {
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

/** Child environment names that hold a secret (DEEPSEEK_API_KEY, ANTHROPIC_AUTH_TOKEN, ...). */
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|AUTH/i;

export class OrchestratorContext {
  readonly db: OrchestratorDb;
  readonly now: () => Date;
  readonly adapters: AdapterRegistry;
  directory: ProfileDirectory;
  mcp: McpHook | null;
  readonly limits: LimitMonitor;
  /** Worktree setup, cleanup, include list, port and park; built by the orchestrator, which owns its approval requests. */
  bootstrap!: Bootstrapper;
  readonly turns: TurnControl;
  readonly stalls: StallMonitor;
  readonly attachments: AttachmentStore;
  readonly loops: LoopStore;
  readonly bestOf: BestOfStore;
  readonly hibernation: HibernationStore;
  readonly switches: AccountSwitches;
  /** Scheduled tasks; built by the orchestrator, since a due slot proposes and approves a task. */
  schedules!: Scheduler;

  /** Set on daemon exit: timers and passes stop doing anything. */
  closed = false;
  readonly live = new Map<string, Live>();
  /** Why a ready step is still queued; shown as `blockedBy`, not stored (it changes every tick). */
  readonly blocked = new Map<string, Reason>();
  readonly stopping = new Map<string, string>();
  readonly timers = new Map<string, NodeJS.Timeout>();
  /** Target run -> handoff it must confirm before the handoff record flips. */
  readonly confirming = new Map<string, string>();
  readonly background = new Set<Promise<unknown>>();
  /** Runs a spend cap held back before their process started, with what they need to start later. */
  readonly held = new Map<string, LaunchSpec>();
  /** Runs whose process is being stopped for hibernation: the stream's end must not end the run. */
  readonly hibernating = new Set<string>();
  /** Hibernated runs that should wake but wait for an admission slot, with why they wake. */
  readonly pendingWake = new Map<string, WakeCause>();
  /** Implementer runs whose loop stopped (cap, no change): they end failed with this detail, not completed. */
  readonly loopFailed = new Map<string, string>();
  /** Reviewer runs that ended with a verdict; the review loop acts on it once the run has ended. */
  readonly verdicts = new Map<string, RoleResult>();
  /** Runs started with a native resume, so a "session gone/locked" end can fall back to a fresh run. */
  readonly resumed = new Set<string>();
  /** Runs whose reviewer reads through the runner's own review (Codex review/start). */
  readonly nativeReviews = new Set<string>();
  /** Drain handoffs: called at the source's next turn boundary. */
  readonly draining = new Map<string, () => void>();
  /** Drain handoffs: lets the held turn boundary return once the source has been stopped. */
  readonly drainRelease = new Map<string, (v: null) => void>();

  constructor(readonly opts: OrchestratorOptions) {
    this.db = new OrchestratorDb(opts.store.db);
    this.adapters = opts.adapters ?? new AdapterRegistry();
    this.directory = opts.directory ?? EMPTY_DIRECTORY;
    this.mcp = opts.mcp ?? null;
    this.now = opts.now ?? (() => new Date());
    this.limits = new LimitMonitor(this.db, (n) => this.emit("limits.notice", n), this.now);
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
    this.db.handoffStop = (id) => this.loops.handoffStop(id);
  }

  /** Free memory for admission control; tests pass their own. */
  freeMb(): number {
    return (this.opts.freeMemoryMb ?? (() => freemem() / 1024 / 1024))();
  }

  /** The MCP servers for a new process of this run; a fresh report ticket each time (docs/adr/0007). */
  async mcpFor(runId: string, taskId: string, projectId: string, policy: RolePolicy, adapter: AgentAdapter): Promise<Pick<StartRequest, "mcpServers">> {
    const servers = this.mcp ? await this.mcp.serversFor({ runId, taskId, projectId, policy, capabilities: adapter.capabilities }) : undefined;
    return servers ? { mcpServers: servers } : {};
  }

  /** The task whose budget and per-task caps a task spends on: a variant's parent, or itself. */
  budgetTask(taskId: string): string {
    return this.bestOf.parentOf(taskId) ?? taskId;
  }

  /** The runs a task's spend is: its own and, for a Best of N parent, every variant's. */
  budgetRuns(taskId: string): RunRow[] {
    return [...this.db.runs(taskId), ...this.bestOf.variantTasksOf(taskId).flatMap((id) => this.db.runs(id))];
  }

  /** Profile and secrets for talking to a runner about a run's session (undo, transcript). */
  async sessionFor(run: RunRow): Promise<{ profile: Profile; env: Record<string, string> } | null> {
    const candidate = await this.candidateFor(run);
    if (!candidate) return null;
    return { profile: candidate.profile, env: await this.directory.envFor(run.profile_id) };
  }

  /** The candidate a run uses: its live one, or a fresh read from the directory. */
  async candidateFor(run: RunRow): Promise<Candidate | undefined> {
    const live = this.live.get(run.id);
    if (live) return live.candidate;
    const project = this.db.project(this.db.task(run.task_id).project_id);
    return (await this.candidates(project)).find((c) => c.profile.id === run.profile_id);
  }

  superseded(run: RunRow): boolean {
    return this.db.successor(run) !== null;
  }

  /** Models that actually ran for the roles this member must stay independent of. */
  ranModels(member: MemberRow): Set<string> {
    const out = new Set<string>();
    for (const other of this.db.members(member.crew_id).filter((m) => this.tpl(member).independentOf.includes(m.role))) {
      const ran = this.db.db.prepare("select profile_id, model from runs where member_id = ?").all(other.id) as Array<{ profile_id: string; model: string | null }>;
      for (const r of ran) out.add((r.model ?? `profile:${r.profile_id}`).toLowerCase());
    }
    return out;
  }

  /** Port and worktree variables for a run continuing in its task worktree (worktree bootstrap). */
  bootstrapEnv(run: RunRow, project: ProjectRow): Record<string, string> {
    const wt = run.worktree_id ? this.db.worktree(run.task_id) : null;
    if (!wt || wt.id !== run.worktree_id) return {};
    return this.bootstrap.env({ taskId: run.task_id, projectId: project.id, repoPath: wt.repo_path, path: wt.path, branch: wt.branch }, this.config(project).config);
  }

  /** The profile's secret values, only to cut them out of error text; never stored or logged. */
  async secretsFor(profileId: string): Promise<string[]> {
    try {
      const env = await this.directory.envFor(profileId);
      return Object.entries(env)
        .filter(([k, v]) => SECRET_ENV.test(k) && v.length >= 8)
        .map(([, v]) => v);
    } catch {
      return [];
    }
  }

  config(project: ProjectRow): { config: ProjectConfig; fromFile: boolean } {
    // Newer files are used as far as understood; unusable ones get the defaults with toast approvals off.
    const { config, fromFile } = effectiveProjectConfig(project.path, project.name);
    return { config, fromFile };
  }

  async candidates(project: ProjectRow): Promise<Candidate[]> {
    const { config, fromFile } = this.config(project);
    const all = await this.directory.candidates(project.id);
    return all.filter((c) => !fromFile || ((config.profiles.length === 0 || config.profiles.includes(c.profile.id)) && (config.runners.length === 0 || config.runners.includes(c.profile.runner))));
  }

  scoring(projectId: string, size: TaskSize, budgetUsd: number | null, pins?: ProposeParams["pins"], exclude?: string[]): ScoringContext {
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

  policyFor(tpl: RoleTemplate, config: ProjectConfig): RolePolicy {
    return effectivePolicy(tpl, config);
  }

  /** The role a member or run works as: its snapshot from a role file, else the built-in (role-files.ts). */
  tpl(m: MemberRow | RunRow): RoleTemplate {
    return this.db.roleTemplate("member_id" in m ? m.member_id : m.id, m.role);
  }

  /** The newest plan any run of the task reported, or one run's plan. */
  latestPlan(taskId: string, runId?: string): Array<{ title: string; status: "pending" | "in_progress" | "completed" }> | null {
    const runs = this.db.runs(taskId).filter((r) => r.plan && (!runId || r.id === runId));
    const last = runs.at(-1);
    if (last?.plan) return JSON.parse(last.plan);
    // A Best of N variant works from its parent's plan (the planner ran there).
    const parent = runId ? null : this.bestOf.parentOf(taskId);
    return parent ? this.latestPlan(parent) : null;
  }

  audit(taskId: string, runId: string | null, kind: string, payload: unknown): void {
    const projectId = this.db.task(taskId).project_id;
    this.opts.store.appendEvent({ kind, source: "orchestrator", payload, projectId, taskId, runId });
  }

  emit<K extends keyof TasksTopics>(topic: K, payload: TasksTopics[K]): void {
    this.opts.emit(topic, payload);
    if (topic === "tasks.changed") {
      for (const w of this.taskWatchers) {
        try {
          w(payload as TasksTopics["tasks.changed"]);
        } catch {
          // A watcher (Autopilot, docs/adr/0017) must never break the change that told it.
        }
      }
    }
  }

  /** Listeners for task changes inside the daemon, beside the window's feed (Orchestrator.watchTasks). */
  readonly taskWatchers = new Set<(p: TasksTopics["tasks.changed"]) => void>();

  emitTask(taskId: string, cause: TaskChangeCause): void {
    const task = this.db.task(taskId);
    this.emit("tasks.changed", { taskId, projectId: task.project_id, status: this.db.status(task), cause });
    // A variant's change is its parent's change too: the parent's status and compare view read it.
    const parent = this.bestOf.parentOf(taskId);
    if (parent) this.emit("tasks.changed", { taskId: parent, projectId: task.project_id, status: this.db.status(this.db.task(parent)), cause: "best_of" });
  }

  emitRequest(requestId: string): void {
    const q = this.db.request(requestId);
    this.emit("requests.changed", { requestId, taskId: q.task_id, projectId: this.db.task(q.task_id).project_id, open: q.answered_at === null });
  }

  clearTimer(runId: string): void {
    const t = this.timers.get(runId);
    if (t) clearTimeout(t);
    this.timers.delete(runId);
  }

  track<T>(p: Promise<T>): void {
    const tracked = p.catch(() => undefined);
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  async safe(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch {
      // Adapter control calls are best effort; the event stream reports what really happened.
    }
  }

  async within(p: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
    const ok = await Promise.race([p.then(() => true as const), timeout]);
    clearTimeout(timer);
    return ok;
  }

  iso(): string {
    return this.now().toISOString();
  }
}
