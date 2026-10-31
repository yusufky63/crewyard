import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  capEvent,
  EVENT_LIMITS,
  type AgentAdapter,
  type AgentEvent,
  type Attachment,
  type CandidateView,
  type EndReason,
  type ForkResult,
  type HandoffStop,
  type HandoffTrigger,
  type Reason,
  type ReviewTarget,
  type RequestAnswer,
  type RequestView,
  type RoleId,
  type RunHandle,
  type RunView,
  type SessionProblem,
  type SessionSeen,
  type StartRequest,
  type TaskDetail,
  type TaskSummary,
  type TasksIpc,
  sessionProblemOf,
  type UserInput,
  utf8Length,
  withAttachments,
} from "@crewyard/core";
import type { McpHook } from "../mcp/service.ts";
import { Bootstrapper } from "../worktrees/bootstrap.ts";
import { admit, DEFAULT_LIMITS } from "./admission.ts";
import { OrchestratorContext, type Ended, type LaunchSpec, type Live, type OrchestratorOptions, type ProposeParams } from "./context.ts";
import { Part } from "./part.ts";
import { BestOfRunner } from "./best-of.ts";
import { Hibernator } from "./hibernation.ts";
import { LoopRunner } from "./loops.ts";
import { AccountSwitcher } from "./account-switch.ts";
import { Fallback } from "./fallback.ts";
import { Handoffs } from "./handoffs.ts";
import { Budget } from "./budget.ts";
import { Inbox } from "./inbox.ts";
import { classifyTask } from "./classify.ts";
import { eligible, estimateFor, proposeCrew, readOnlyConflict, sameModel, scoreCandidate, sumEstimates } from "./crew.ts";
import type { MemberRow, ProjectRow, RunRow, TaskRow, WorktreeRow } from "./db.ts";
import type { Candidate, ProfileDirectory } from "./directory.ts";
import { errorCode, errorDetail, OrchestratorError, redactDetail } from "./errors.ts";
import { ensureWorktree, sameDir, taskSlug, writeFileAtomic } from "./git.ts";
import { reviewContext } from "./loops.ts";
import { applyResult, outputSchemaFor, type RoleResult } from "./results.ts";
import type { LimitMonitor } from "./limits.ts";
import { rolePrompt } from "./prompts.ts";
import { projectRoles } from "./role-files.ts";
import { capResetsAt, capWindow, reserveSpend, settleReservation, spendCredential } from "./spend.ts";
import { joinMessages } from "./queue.ts";
import { Scheduler } from "./schedules.ts";
import { snapshotTranscript } from "./transcripts.ts";

export type { OrchestratorOptions } from "./context.ts";

// The deterministic scheduler (PLAN.md D7, D8, §8, §9): it runs the crew you approved as a DAG,
// under admission control, and never lets an agent start another agent. All state lives in the
// store as facts; this class only holds live process handles, timers and the admission notes.

/** Roles that read a pinned, detached checkout of the commit they review instead of the live worktree. */
const PINNED_ROLES: RoleId[] = ["reviewer", "security"];

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

export class Orchestrator extends Part {
  private hibernateTimer: NodeJS.Timeout | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private tickAgain = false;
  private interval: NodeJS.Timeout | null = null;
  private readonly creating = new Map<string, Promise<WorktreeRow>>();
  private readonly inbox: Inbox = new Inbox(this.ctx, {
    checkSeen: (run, seen) => this.checkSeen(run, seen),
    resolveTarget: (run, profileId, payload) => this.handoffs.resolveTarget(run, profileId, payload),
    performHandoff: (sourceRunId, target, trigger) => this.handoffs.performHandoff(sourceRunId, target, trigger),
    scheduleResume: (runId, resetsAt) => this.fallback.scheduleResume(runId, resetsAt),
    stopRun: (runId, detail, reason) => this.stopRun(runId, detail, reason),
    continuePastCap: (runId) => this.fallback.continuePastCap(runId),
    wakeRun: (runId, cause) => this.hibernator.wakeRun(runId, cause),
    proceed: (runId, text) => this.proceed(runId, text),
    endRun: (runId, reason, detail) => this.endRun(runId, reason, detail),
    tick: () => this.tick(),
  });
  private readonly budget: Budget = new Budget(this.ctx, {
    onLimitReached: (runId, info) => this.fallback.onLimitReached(runId, info),
  });
  private readonly handoffs: Handoffs = new Handoffs(this.ctx, {
    cancelAutoRetry: (runId) => this.fallback.cancelAutoRetry(runId),
    closeRequest: (q, by) => this.inbox.closeRequest(q, by),
    offerHandoff: (run, task, mode, info, detail) => this.fallback.offerHandoff(run, task, mode, info, detail),
    launch: (spec) => this.launch(spec),
    stopRun: (runId, detail, reason) => this.stopRun(runId, detail, reason),
    endRun: (runId, reason, detail) => this.endRun(runId, reason, detail),
    copyTranscript: (runId) => this.copyTranscript(runId),
    capFor: (taskId, runId, candidate, addUsd, alsoApproved) => this.budget.capFor(taskId, runId, candidate, addUsd, alsoApproved),
    approvalsFor: (runId) => this.budget.approvalsFor(runId),
  });
  private readonly fallback: Fallback = new Fallback(this.ctx, {
    switchAccount: (run, task, info) => this.switcher.switchAccount(run, task, info),
    handoffCandidates: (run, task, info) => this.handoffs.handoffCandidates(run, task, info),
    autoTargets: (run, task, candidates) => this.handoffs.autoTargets(run, task, candidates),
    performHandoff: (sourceRunId, target, trigger) => this.handoffs.performHandoff(sourceRunId, target, trigger),
    insertRequest: (taskId, runId, nativeId, risk, payload) => this.inbox.insertRequest(taskId, runId, nativeId, risk, payload),
    launch: (spec) => this.launch(spec),
    proceed: (runId, text) => this.proceed(runId, text),
  });
  private readonly switcher: AccountSwitcher = new AccountSwitcher(this.ctx, {
    avoidFor: (member) => this.handoffs.avoidFor(member),
    performHandoff: (sourceRunId, target, trigger, opts) => this.handoffs.performHandoff(sourceRunId, target, trigger, opts),
  });
  private readonly loopRunner: LoopRunner = new LoopRunner(this.ctx, {
    capFor: (taskId, runId, candidate) => this.budget.capFor(taskId, runId, candidate),
    launch: (spec) => this.launch(spec),
  });
  private readonly hibernator: Hibernator = new Hibernator(this.ctx, {
    continueRun: (runId, text) => this.continueRun(runId, text),
    endRun: (runId, reason, detail) => this.endRun(runId, reason, detail),
    onFailure: (runId, detail) => this.fallback.onFailure(runId, detail),
    tick: () => this.tick(),
  });
  private readonly bestOfRunner: BestOfRunner = new BestOfRunner(this.ctx, {
    insertRun: (spec) => this.insertRun(spec),
    boot: (runId, spec) => this.boot(runId, spec),
    stopRun: (runId, detail, reason) => this.stopRun(runId, detail, reason),
    cancel: (taskId) => this.cancel(taskId),
    get: (taskId) => this.get(taskId),
    tick: () => this.tick(),
  });

  override get db() {
    return this.ctx.db;
  }
  override get limits() {
    return this.ctx.limits;
  }
  /** Worktree setup, cleanup, include list, port and park (packages/daemon/src/worktrees). */
  override get bootstrap() {
    return this.ctx.bootstrap;
  }
  /** Turn checkpoints, the follow-up queue, Steer now and Undo (turns.ts, queue.ts). */
  override get turns() {
    return this.ctx.turns;
  }
  override get stalls() {
    return this.ctx.stalls;
  }
  /** Best of N groups and their variant tasks (best-of.ts). */
  override get bestOf() {
    return this.ctx.bestOf;
  }
  /** Scheduled tasks and their daemon-side timer (schedules.ts). */
  override get schedules() {
    return this.ctx.schedules;
  }
  /** Idle runs whose process was stopped and that wake by session id (hibernation.ts). */
  override get hibernation() {
    return this.ctx.hibernation;
  }
  /** Same-provider account switches and the tasks held out of them (account-switch.ts, docs/adr/0009). */
  override get switches() {
    return this.ctx.switches;
  }
  /** Images and files on task descriptions and queued messages (attachments.ts). */
  override get attachments() {
    return this.ctx.attachments;
  }
  /** Loop decisions, test results, pinned verdicts, review checkouts, run epochs (loops.ts). */
  override get loops() {
    return this.ctx.loops;
  }

  constructor(opts: OrchestratorOptions) {
    super(new OrchestratorContext(opts));
    this.ctx.bootstrap = new Bootstrapper({
      store: opts.store,
      now: this.ctx.now,
      gitBin: opts.gitBin,
      emit: opts.emit,
      requestApproval: (taskId, runId, payload) => this.inbox.insertRequest(taskId, runId, null, "high", payload),
      audit: (taskId, runId, kind, payload) => this.audit(taskId, runId, kind, payload),
      config: (projectId) => this.config(this.db.project(projectId)).config,
    });
    this.ctx.schedules = new Scheduler({
      db: opts.store.db,
      now: this.ctx.now,
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
    this.db.taskExtras = (t) => this.bestOfRunner.taskExtras(t);
    this.db.taskLoop = (t) => this.loopRunner.loopView(t);
  }

  /** Recovers from the last session, then starts scheduling. */
  start(): void {
    this.recover();
    const ms = this.opts.tickMs ?? 5_000;
    if (ms > 0) this.interval = setInterval(() => void this.tick(), ms).unref();
    const stallMs = this.opts.stallCheckMs ?? 30_000;
    if (stallMs > 0) this.stallTimer = setInterval(() => this.checkStalls(), stallMs).unref();
    const hibernateMs = this.opts.hibernateCheckMs ?? 30_000;
    if (hibernateMs > 0) this.hibernateTimer = setInterval(() => void this.hibernator.checkHibernation(), hibernateMs).unref();
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
    this.ctx.closed = true;
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
    this.ctx.directory = directory;
    void this.tick();
  }

  /** Called by the MCP work (handlers/mcp.ts) once its service exists. */
  setMcp(hook: McpHook): void {
    this.ctx.mcp = hook;
  }

  /** Waits until background work (pumps, handoffs, ticks) has settled; for tests and shutdown. */
  async settle(): Promise<void> {
    while (this.ctx.background.size > 0) await Promise.allSettled([...this.ctx.background]);
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
    return { ...this.db.detail(task, this.blocked), bestOfGroup: this.bestOfRunner.groupView(task), accountSwitch: this.switches.taskEnabled(task.id), ...(attachments.length > 0 ? { attachments } : {}) };
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
    const group = p.bestOf === undefined ? null : this.bestOfRunner.groupCandidates(crew.members, candidates, ctx, p.bestOf);
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
    const groupCands = group ? this.bestOfRunner.approvedVariants(task, project, members, views, candidates, group, p) : null;

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
      for (const r of this.db.runs(task.id).filter((r) => r.ended_at && r.resume_at)) this.fallback.cancelAutoRetry(r.id);
      for (const r of this.db.runs(task.id).filter((r) => !r.ended_at)) await this.stopRun(r.id, "task_cancelled");
      for (const q of this.db.requests({ taskId: task.id })) this.inbox.closeRequest(q, "system");
      for (const h of this.db.handoffs(task.id).filter((h) => !h.closed_at)) this.handoffs.closeHandoff(h.id, "cancelled", null);
      // The variants of a Best of N group go with their task; their worktrees stay, like the task's.
      for (const id of this.bestOf.variantTasksOf(task.id)) await this.cancel(id);
      this.audit(task.id, null, "task.cancelled", {});
      this.emitTask(task.id, "cancelled");
    }
    return this.get(task.id);
  }

  // ---------------------------------------------------------------- hibernation

  checkHibernation(): Promise<void> {
    return this.hibernator.checkHibernation();
  }

  // ---------------------------------------------------------------- Best of N (feature scan A8)

  keepVariant(taskId: string, variantId: string): Promise<TaskDetail> {
    return this.bestOfRunner.keepVariant(taskId, variantId);
  }

  // ---------------------------------------------------------------- runs

  handoff(runId: string, targetProfileId: string, stop: HandoffStop = "interrupt"): Promise<RunView> {
    return this.handoffs.handoff(runId, targetProfileId, stop);
  }

  async pause(runId: string, seen?: SessionSeen): Promise<RunView> {
    const run = this.db.run(runId);
    this.checkSeen(run, seen);
    if (run.ended_at) throw new OrchestratorError("run.ended");
    if (!run.paused_at) {
      this.db.exec("update runs set paused_at = ? where id = ?", this.iso(), runId);
      const live = this.live.get(runId);
      if (live) await this.safe(() => live.adapter.interrupt(live.handle));
      // Interrupting the turn cancels its pending prompts; the agent asks again after resume.
      for (const q of this.db.openRequestsForRun(runId).filter((q) => q.kind !== "handoff")) this.inbox.closeRequest(q, "system");
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
      if (run.limit_reached && this.budget.unpricedOpen(runId)) throw new OrchestratorError("run.price_unknown");
      const cap = run.limit_reached ? this.budget.capFor(task.id, runId, await this.candidateFor(run)) : null;
      if (cap) throw new OrchestratorError("run.still_limited", { window: capWindow(cap), resetsAt: capResetsAt(cap, this.now()) ?? "" });
      // The pause interrupted the turn; let that stream end as a pause first, or its end would
      // read as a stop once paused_at is cleared.
      const pausing = this.live.get(runId);
      if (pausing) await this.within(pausing.done, this.opts.stopTimeoutMs ?? 30_000);
      this.clearTimer(runId);
      this.db.exec("update runs set paused_at = null, resume_at = null, limit_reached = 0 where id = ?", runId);
      for (const q of this.db.openRequestsForRun(runId).filter((q) => q.kind === "handoff")) this.inbox.closeRequest(q, "system");
      await this.proceed(runId, "Continue the task where you stopped.");
      this.emitTask(run.task_id, "run_resumed");
      return this.db.runView(this.db.run(runId));
    }
    if (this.superseded(run) || !["interrupted", "stopped", "failed"].includes(run.end_reason ?? "")) throw new OrchestratorError("run.not_resumable");
    const adapter = this.adapters.get(run.runner);
    if (!adapter?.capabilities.resume || !run.native_session_id) throw new OrchestratorError("run.resume_unsupported", { runner: run.runner });
    this.fallback.cancelAutoRetry(run.id);
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
    if (run.ended_at && run.resume_at) this.fallback.cancelAutoRetry(runId);
    if (!run.ended_at) await this.stopRun(runId, "user_stop");
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
      this.fallback.cancelAutoRetry(run.id);
      // The crash or limit question about the old run is answered by retrying it.
      for (const q of this.db.openRequestsForRun(run.id).filter((q) => q.kind === "handoff")) this.inbox.closeRequest(q, "system");
      const id = await this.launch({ task, member: this.db.member(run.member_id), target: { profileId: run.profile_id, runner: run.runner, model: run.model }, resumedFrom: run.id });
      this.audit(task.id, id, "run.retried", { from: run.id });
      this.emitTask(task.id, "retried");
      return this.db.runView(this.db.run(id));
    }
    if (run.limit_reached || run.resume_at) {
      if (this.budget.unpricedOpen(run.id)) throw new OrchestratorError("run.price_unknown");
      const cap = this.budget.capFor(task.id, run.id, await this.candidateFor(run));
      if (cap) throw new OrchestratorError("run.still_limited", { window: capWindow(cap), resetsAt: capResetsAt(cap, this.now()) ?? "" });
      const reached = this.db.reachedWindow(run.profile_id, this.now());
      if (reached) throw new OrchestratorError("run.still_limited", { window: reached.window, resetsAt: reached.resetsAt });
      this.clearTimer(run.id);
      this.db.exec("update runs set limit_reached = 0, paused_at = null, resume_at = null where id = ?", run.id);
      for (const q of this.db.openRequestsForRun(run.id).filter((q) => q.kind === "handoff")) this.inbox.closeRequest(q, "system");
      this.audit(task.id, run.id, "run.retried", { after: "limit" });
      try {
        await this.proceed(run.id, "Your limit has cleared. Continue the task where you stopped.");
        this.emitTask(task.id, "run_resumed");
      } catch (err) {
        this.db.exec("update runs set paused_at = ? where id = ?", this.iso(), run.id);
        await this.fallback.offerHandoff(this.db.run(run.id), task, "manual", { trigger: "limit", window: null, resetsAt: null }, errorCode(err));
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
    if (!live && !run.paused_at && this.hibernation.asleep(runId)) await this.hibernator.wakeRun(runId, "message");
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
      const fix = !stop && live ? await this.loopRunner.testGate(runId) : null;
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
    return this.inbox.requests(filter);
  }

  answer(requestId: string, answer: RequestAnswer, seen?: SessionSeen & { runId: string | null }): Promise<RequestView> {
    return this.inbox.answer(requestId, answer, seen);
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
    for (const [runId, cause] of [...this.pendingWake]) await this.hibernator.wakeRun(runId, cause);
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
          if (!group.started_at && !group.kept_variant_id) await this.bestOfRunner.startGroup(task, m, group, project, config.rules.slots, (candidates ??= await this.candidates(project)));
          continue;
        }
        const chosen = m.chosen ? (JSON.parse(m.chosen) as CandidateView) : null;
        const reason = !chosen
          ? ({ code: "admission.no_profile" } as Reason)
          : !this.adapters.has(chosen.runner)
            ? ({ code: "admission.no_adapter", params: { runner: chosen.runner } } as Reason)
            : this.ranModels(m).has((chosen.model ?? `profile:${chosen.profileId}`).toLowerCase())
              ? ({ code: "no_independent_candidate" } as Reason)
              : (this.admission(task, m, chosen.profileId, config.rules.slots) ?? this.budget.budgetHold(task, m, (candidates ??= await this.candidates(project)).find((c) => c.profile.id === chosen.profileId)));
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

  private admission(task: TaskRow, m: MemberRow, profileId: string, projectSlots: number): Reason | null {
    const counts = this.db.activeCounts();
    const wt = this.db.worktree(task.id);
    const owner = wt?.owner_run_id ? this.db.run(wt.owner_run_id) : null;
    return admit(
      {
        projectActive: counts.byProject.get(task.project_id) ?? 0,
        profileActive: counts.byProfile.get(profileId) ?? 0,
        globalActive: counts.total,
        freeMb: this.freeMb(),
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
      const pinned = !spec.cwd && PINNED_ROLES.includes(member.role) && task.kind === "code" && wt && existsSync(wt.path) ? await this.loopRunner.reviewCheckout(runId, task, wt) : null;
      if (pinned) cwd = pinned.path;
      const worktreeId = wt && sameDir(wt.path, cwd) ? wt.id : null;
      this.db.exec("update runs set cwd = ?, worktree_id = ? where id = ?", cwd, worktreeId, runId);
      if (member.writes_code && worktreeId) this.db.exec("update worktrees set owner_run_id = ?, last_heartbeat_at = ? where id = ?", runId, this.iso(), worktreeId);

      const candidate = (await this.candidates(project)).find((c) => c.profile.id === target.profileId);
      if (!candidate) throw new OrchestratorError("crew.unknown_profile", { profileId: target.profileId });
      const adapter = this.adapters.get(target.runner);
      if (!adapter) throw new OrchestratorError("adapter.failed", { detail: "no_adapter" });
      // A capped task never starts on a model nobody can price without your click (feature scan F4).
      const unpriced = this.budget.unpricedFor(task, runId, candidate, target.model, estimateFor(candidate, this.tpl(member), task.size, this.now()).usd === null);
      if (unpriced) {
        this.held.set(runId, spec);
        await this.fallback.onLimitReached(runId, { trigger: "unpriced", window: null, resetsAt: null, unpriced });
        return;
      }
      // Check and hold in one synchronous step, so a parallel step cannot slip in between (F3).
      const amount = candidate.profile.credential.kind === "api_key" ? this.budget.reservationFor(task, member, candidate) : 0;
      const cap = this.budget.capFor(task.id, runId, candidate, amount);
      if (cap) {
        this.held.set(runId, spec);
        await this.budget.pauseForCap(runId, cap, this.iso());
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
    await this.budget.onUsage(run, this.db.task(run.task_id), {
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
    const pkg = await this.handoffs.writePackage(task, failed, `the previous session is ${problem === "locked" ? "locked by another process" : "gone"}`, `session-${failedRunId}`);
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
        if (this.confirming.has(runId)) await this.handoffs.confirmHandoff(runId);
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
        await this.budget.onUsage(run, task, ev);
        break;
      case "limit.update":
        this.limits.ingest({ profileId: run.profile_id, window: ev.window, usedPct: ev.usedPct, resetsAt: ev.resetsAt, provenance: ev.provenance, observedAt: ev.at }, { runId, taskId: task.id, reached: ev.reached });
        if (ev.reached) await this.fallback.onLimitReached(runId, { trigger: "limit", window: ev.window, resetsAt: ev.resetsAt });
        break;
      case "request.question":
        this.inbox.insertRequest(task.id, runId, ev.requestId, null, { kind: "question", questions: ev.questions });
        break;
      case "request.approval":
        await this.inbox.routeApproval(run, task, ev);
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
      await this.fallback.onLimitReached(runId, { trigger: "limit", window: null, resetsAt: null });
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
    if (ended.reason === "completed") await this.loopRunner.pinHead(runId);
    this.endRun(runId, ended.reason, detail);
    if (problem && !this.confirming.has(runId)) {
      await this.replaceSession(runId, problem as SessionProblem);
      return;
    }
    if (ended.reason === "failed") await this.fallback.onFailure(runId, detail);
    const verdict = this.verdicts.get(runId);
    this.verdicts.delete(runId);
    if (ended.reason === "completed" && verdict) await this.loopRunner.reviewLoop(runId, verdict);
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
    this.track(this.loopRunner.dropCheckout(runId));
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
    if (variant) this.track(this.bestOfRunner.refreshVariantDiff(variant.id));
    // A handoff target that ends before it confirmed leaves the source paused and asks you.
    const pendingHandoff = this.confirming.get(runId);
    if (pendingHandoff) {
      this.confirming.delete(runId);
      this.track(this.handoffs.failHandoff(pendingHandoff, detail ?? "target_ended"));
    }
    // Nobody is left to receive these answers; they close instead of lingering as "needs input".
    // A run that finished its work needs no hand off either (e.g. a cap tripped on its last report).
    for (const q of this.db.openRequestsForRun(runId).filter((q) => q.kind !== "handoff" || reason === "completed")) this.inbox.closeRequest(q, "system");
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

  // ---------------------------------------------------------------- approvals

  // ---------------------------------------------------------------- usage and limits

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

  /** Feeds a sample from outside a run (e.g. a provider balance poll) through the same rules. */
  ingestSample(sample: Parameters<LimitMonitor["ingest"]>[0]): void {
    this.limits.ingest(sample, { runId: null, taskId: null });
  }

  // ---------------------------------------------------------------- handoff (PLAN.md §8)

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
      for (const q of this.db.openRequestsForRun(r.id)) this.inbox.closeRequest(q, "system");
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
      this.handoffs.closeHandoff(h.id, "interrupted", h.phase);
      this.audit(h.task_id, h.from_run_id, "handoff.reconciled", { handoffId: h.id, phase: h.phase });
      tasks.add(h.task_id);
      // The target never confirmed, so the source still holds the step: ask what to do with it.
      this.track(this.reconcileHandoff(h.from_run_id, h.trigger_kind));
    }
    // Review checkouts of runs the last daemon left behind.
    for (const c of this.loops.openCheckouts()) if (this.db.run(c.run_id).ended_at) this.track(this.loopRunner.dropCheckout(c.run_id));
    tasks.forEach((t) => this.emitTask(t, "recovered"));
  }

  private async reconcileHandoff(sourceRunId: string, trigger: HandoffTrigger): Promise<void> {
    const source = this.db.run(sourceRunId);
    const task = this.db.task(source.task_id);
    if (task.cancelled_at || this.superseded(source) || source.end_reason === "completed") return;
    if (this.db.openRequestsForRun(source.id).some((q) => q.kind === "handoff")) return;
    await this.fallback.offerHandoff(source, task, "manual", { trigger, window: null, resetsAt: null }, "handoff_interrupted");
    this.emitTask(task.id, "recovered");
  }

  // ---------------------------------------------------------------- helpers

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

}

