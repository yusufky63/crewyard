import { randomUUID } from "node:crypto";
import type {
  CandidateView,
  HandoffStop,
  HandoffTrigger,
  RequestAnswer,
  RequestView,
  RunView,
  SessionSeen,
  TaskDetail,
  TaskSummary,
  TasksIpc,
} from "@crewyard/core";
import type { McpHook } from "../mcp/service.ts";
import { Bootstrapper } from "../worktrees/bootstrap.ts";
import { OrchestratorContext, type OrchestratorOptions, type ProposeParams } from "./context.ts";
import { Part } from "./part.ts";
import { Dispatcher } from "./dispatch.ts";
import { RunActions } from "./run-actions.ts";
import { Messages } from "./messages.ts";
import { Launcher } from "./launch.ts";
import { RunLifecycle } from "./run-lifecycle.ts";
import { BestOfRunner } from "./best-of.ts";
import { Hibernator } from "./hibernation.ts";
import { LoopRunner } from "./loops.ts";
import { AccountSwitcher } from "./account-switch.ts";
import { Fallback } from "./fallback.ts";
import { Handoffs } from "./handoffs.ts";
import { Budget } from "./budget.ts";
import { Inbox } from "./inbox.ts";
import { classifyTask } from "./classify.ts";
import { eligible, proposeCrew, readOnlyConflict, sameModel, scoreCandidate, sumEstimates } from "./crew.ts";
import type { ProfileDirectory } from "./directory.ts";
import { OrchestratorError } from "./errors.ts";
import type { LimitMonitor } from "./limits.ts";
import { projectRoles } from "./role-files.ts";
import { settleReservation } from "./spend.ts";
import { Scheduler } from "./schedules.ts";

export type { OrchestratorOptions } from "./context.ts";

// The deterministic scheduler (PLAN.md D7, D8, §8, §9): it runs the crew you approved as a DAG,
// under admission control, and never lets an agent start another agent. All state lives in the
// store as facts; this class only holds live process handles, timers and the admission notes.

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
  private interval: NodeJS.Timeout | null = null;
  private readonly inbox: Inbox = new Inbox(this.ctx, {
    checkSeen: (run, seen) => this.actions.checkSeen(run, seen),
    resolveTarget: (run, profileId, payload) => this.handoffs.resolveTarget(run, profileId, payload),
    performHandoff: (sourceRunId, target, trigger) => this.handoffs.performHandoff(sourceRunId, target, trigger),
    scheduleResume: (runId, resetsAt) => this.fallback.scheduleResume(runId, resetsAt),
    stopRun: (runId, detail, reason) => this.lifecycle.stopRun(runId, detail, reason),
    continuePastCap: (runId) => this.fallback.continuePastCap(runId),
    wakeRun: (runId, cause) => this.hibernator.wakeRun(runId, cause),
    proceed: (runId, text) => this.launcher.proceed(runId, text),
    endRun: (runId, reason, detail) => this.lifecycle.endRun(runId, reason, detail),
    tick: () => this.dispatcher.tick(),
  });
  private readonly budget: Budget = new Budget(this.ctx, {
    onLimitReached: (runId, info) => this.fallback.onLimitReached(runId, info),
  });
  private readonly handoffs: Handoffs = new Handoffs(this.ctx, {
    cancelAutoRetry: (runId) => this.fallback.cancelAutoRetry(runId),
    closeRequest: (q, by) => this.inbox.closeRequest(q, by),
    offerHandoff: (run, task, mode, info, detail) => this.fallback.offerHandoff(run, task, mode, info, detail),
    launch: (spec) => this.launcher.launch(spec),
    stopRun: (runId, detail, reason) => this.lifecycle.stopRun(runId, detail, reason),
    endRun: (runId, reason, detail) => this.lifecycle.endRun(runId, reason, detail),
    copyTranscript: (runId) => this.lifecycle.copyTranscript(runId),
    capFor: (taskId, runId, candidate, addUsd, alsoApproved) => this.budget.capFor(taskId, runId, candidate, addUsd, alsoApproved),
    approvalsFor: (runId) => this.budget.approvalsFor(runId),
  });
  private readonly fallback: Fallback = new Fallback(this.ctx, {
    switchAccount: (run, task, info) => this.switcher.switchAccount(run, task, info),
    handoffCandidates: (run, task, info) => this.handoffs.handoffCandidates(run, task, info),
    autoTargets: (run, task, candidates) => this.handoffs.autoTargets(run, task, candidates),
    performHandoff: (sourceRunId, target, trigger) => this.handoffs.performHandoff(sourceRunId, target, trigger),
    insertRequest: (taskId, runId, nativeId, risk, payload) => this.inbox.insertRequest(taskId, runId, nativeId, risk, payload),
    launch: (spec) => this.launcher.launch(spec),
    proceed: (runId, text) => this.launcher.proceed(runId, text),
  });
  private readonly switcher: AccountSwitcher = new AccountSwitcher(this.ctx, {
    avoidFor: (member) => this.handoffs.avoidFor(member),
    performHandoff: (sourceRunId, target, trigger, opts) => this.handoffs.performHandoff(sourceRunId, target, trigger, opts),
  });
  private readonly loopRunner: LoopRunner = new LoopRunner(this.ctx, {
    capFor: (taskId, runId, candidate) => this.budget.capFor(taskId, runId, candidate),
    launch: (spec) => this.launcher.launch(spec),
  });
  private readonly hibernator: Hibernator = new Hibernator(this.ctx, {
    continueRun: (runId, text) => this.launcher.continueRun(runId, text),
    endRun: (runId, reason, detail) => this.lifecycle.endRun(runId, reason, detail),
    onFailure: (runId, detail) => this.fallback.onFailure(runId, detail),
    tick: () => this.dispatcher.tick(),
  });
  private readonly bestOfRunner: BestOfRunner = new BestOfRunner(this.ctx, {
    insertRun: (spec) => this.launcher.insertRun(spec),
    boot: (runId, spec) => this.launcher.boot(runId, spec),
    stopRun: (runId, detail, reason) => this.lifecycle.stopRun(runId, detail, reason),
    cancel: (taskId) => this.cancel(taskId),
    get: (taskId) => this.get(taskId),
    tick: () => this.dispatcher.tick(),
  });
  private readonly lifecycle: RunLifecycle = new RunLifecycle(this.ctx, {
    confirmHandoff: (targetRunId) => this.handoffs.confirmHandoff(targetRunId),
    failHandoff: (handoffId, detail) => this.handoffs.failHandoff(handoffId, detail),
    onUsage: (run, task, ev) => this.budget.onUsage(run, task, ev),
    onLimitReached: (runId, info) => this.fallback.onLimitReached(runId, info),
    onFailure: (runId, detail) => this.fallback.onFailure(runId, detail),
    insertRequest: (taskId, runId, nativeId, risk, payload) => this.inbox.insertRequest(taskId, runId, nativeId, risk, payload),
    routeApproval: (run, task, ev) => this.inbox.routeApproval(run, task, ev),
    closeRequest: (q, by) => this.inbox.closeRequest(q, by),
    replaceSession: (failedRunId, problem) => this.launcher.replaceSession(failedRunId, problem),
    pinHead: (runId) => this.loopRunner.pinHead(runId),
    reviewLoop: (reviewerRunId, result) => this.loopRunner.reviewLoop(reviewerRunId, result),
    dropCheckout: (runId) => this.loopRunner.dropCheckout(runId),
    refreshVariantDiff: (variantId) => this.bestOfRunner.refreshVariantDiff(variantId),
    tick: () => this.dispatcher.tick(),
  });
  private readonly launcher: Launcher = new Launcher(this.ctx, {
    reviewCheckout: (runId, task, wt) => this.loopRunner.reviewCheckout(runId, task, wt),
    unpricedFor: (task, runId, candidate, model, unknownPrice) => this.budget.unpricedFor(task, runId, candidate, model, unknownPrice),
    reservationFor: (task, m, candidate) => this.budget.reservationFor(task, m, candidate),
    capFor: (taskId, runId, candidate, addUsd) => this.budget.capFor(taskId, runId, candidate, addUsd),
    pauseForCap: (runId, cap, at) => this.budget.pauseForCap(runId, cap, at),
    onUsage: (run, task, ev) => this.budget.onUsage(run, task, ev),
    onLimitReached: (runId, info) => this.fallback.onLimitReached(runId, info),
    nextTurn: (runId) => this.messages.nextTurn(runId),
    endRun: (runId, reason, detail) => this.lifecycle.endRun(runId, reason, detail),
    writePackage: (task, source, trigger, name) => this.handoffs.writePackage(task, source, trigger, name),
    pump: (runId, live) => this.lifecycle.pump(runId, live),
  });
  private readonly messages: Messages = new Messages(this.ctx, {
    checkSeen: (run, seen) => this.actions.checkSeen(run, seen),
    wakeRun: (runId, cause) => this.hibernator.wakeRun(runId, cause),
    launch: (spec) => this.launcher.launch(spec),
    testGate: (runId) => this.loopRunner.testGate(runId),
    tick: () => this.dispatcher.tick(),
  });
  private readonly actions: RunActions = new RunActions(this.ctx, {
    closeRequest: (q, by) => this.inbox.closeRequest(q, by),
    unpricedOpen: (runId) => this.budget.unpricedOpen(runId),
    capFor: (taskId, runId, candidate) => this.budget.capFor(taskId, runId, candidate),
    proceed: (runId, text) => this.launcher.proceed(runId, text),
    launch: (spec) => this.launcher.launch(spec),
    stopRun: (runId, detail, reason) => this.lifecycle.stopRun(runId, detail, reason),
    cancelAutoRetry: (runId) => this.fallback.cancelAutoRetry(runId),
    offerHandoff: (run, task, mode, info, detail) => this.fallback.offerHandoff(run, task, mode, info, detail),
    tick: () => this.dispatcher.tick(),
  });
  private readonly dispatcher: Dispatcher = new Dispatcher(this.ctx, {
    wakeRun: (runId, cause) => this.hibernator.wakeRun(runId, cause),
    startGroup: (task, m, group, project, slots, candidates) => this.bestOfRunner.startGroup(task, m, group, project, slots, candidates),
    budgetHold: (task, m, candidate) => this.budget.budgetHold(task, m, candidate),
    launch: (spec) => this.launcher.launch(spec),
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
    if (ms > 0) this.interval = setInterval(() => void this.dispatcher.tick(), ms).unref();
    const stallMs = this.opts.stallCheckMs ?? 30_000;
    if (stallMs > 0) this.stallTimer = setInterval(() => this.checkStalls(), stallMs).unref();
    const hibernateMs = this.opts.hibernateCheckMs ?? 30_000;
    if (hibernateMs > 0) this.hibernateTimer = setInterval(() => void this.hibernator.checkHibernation(), hibernateMs).unref();
    const scheduleMs = this.opts.scheduleCheckMs ?? 30_000;
    this.schedules.start(scheduleMs);
    // Slots missed while the app was closed are caught up now (at most MAX_CATCH_UP of them).
    if (scheduleMs > 0) this.track(this.schedules.check());
    void this.dispatcher.tick();
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
    void this.dispatcher.tick();
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
    await this.dispatcher.tick();
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
      for (const r of this.db.runs(task.id).filter((r) => !r.ended_at)) await this.lifecycle.stopRun(r.id, "task_cancelled");
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

  pause(runId: string, seen?: SessionSeen): Promise<RunView> {
    return this.actions.pause(runId, seen);
  }

  resume(runId: string): Promise<RunView> {
    return this.actions.resume(runId);
  }

  stop(runId: string, seen?: SessionSeen): Promise<RunView> {
    return this.actions.stop(runId, seen);
  }

  retry(runId: string): Promise<RunView> {
    return this.actions.retry(runId);
  }

  handoff(runId: string, targetProfileId: string, stop: HandoffStop = "interrupt"): Promise<RunView> {
    return this.handoffs.handoff(runId, targetProfileId, stop);
  }

  // ---------------------------------------------------------------- follow-up queue and undo

  message(runId: string, text: string, seen?: SessionSeen, attachmentIds: string[] = []): Promise<RunView> {
    return this.messages.message(runId, text, seen, attachmentIds);
  }

  enqueue(runId: string, text: string): { run: RunView; messageId: string } {
    return this.messages.enqueue(runId, text);
  }

  queueEdit(runId: string, messageId: string, text: string): RunView {
    return this.messages.queueEdit(runId, messageId, text);
  }

  queueDelete(runId: string, messageId: string): RunView {
    return this.messages.queueDelete(runId, messageId);
  }

  queueMove(runId: string, messageId: string, index: number): RunView {
    return this.messages.queueMove(runId, messageId, index);
  }

  queueSteer(runId: string, messageId: string, seen?: SessionSeen): Promise<RunView> {
    return this.messages.queueSteer(runId, messageId, seen);
  }

  undoPreview(runId: string) {
    return this.messages.undoPreview(runId);
  }

  undo(runId: string, turnId: string): Promise<RunView> {
    return this.messages.undo(runId, turnId);
  }

  followUp(runId: string, text: string): Promise<RunView> {
    return this.messages.followUp(runId, text);
  }

  // ---------------------------------------------------------------- crew loops (feature scan A9)

  // ---------------------------------------------------------------- requests

  requests(filter: { projectId?: string; taskId?: string; includeAnswered?: boolean }): RequestView[] {
    return this.inbox.requests(filter);
  }

  answer(requestId: string, answer: RequestAnswer, seen?: SessionSeen & { runId: string | null }): Promise<RequestView> {
    return this.inbox.answer(requestId, answer, seen);
  }

  // ---------------------------------------------------------------- scheduler

  tick(): Promise<void> {
    return this.dispatcher.tick();
  }

  // ---------------------------------------------------------------- approvals

  // ---------------------------------------------------------------- usage and limits

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

}

