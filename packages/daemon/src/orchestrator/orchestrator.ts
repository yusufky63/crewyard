import type { AgentAdapter, HandoffStop, RequestAnswer, RequestView, RunnerId, RunView, SessionSeen, TaskDetail, TaskSummary, TasksIpc } from "@crewyard/core";
import type { McpHook } from "../mcp/service.ts";
import { Bootstrapper } from "../worktrees/bootstrap.ts";
import { AccountSwitcher, type AccountSwitches } from "./account-switch.ts";
import type { AttachmentStore } from "./attachments.ts";
import { BestOfRunner, type BestOfStore } from "./best-of.ts";
import { Budget } from "./budget.ts";
import { OrchestratorContext, type OrchestratorOptions, type ProposeParams } from "./context.ts";
import { CrewManager } from "./crew-manage.ts";
import type { OrchestratorDb } from "./db.ts";
import type { ProfileDirectory } from "./directory.ts";
import { Dispatcher } from "./dispatch.ts";
import { Fallback } from "./fallback.ts";
import { Handoffs } from "./handoffs.ts";
import { Hibernator, type HibernationStore } from "./hibernation.ts";
import { Inbox } from "./inbox.ts";
import { Launcher } from "./launch.ts";
import type { LimitMonitor } from "./limits.ts";
import { LoopRunner, type LoopStore } from "./loops.ts";
import { Messages } from "./messages.ts";
import { Recovery } from "./recovery.ts";
import { RunActions } from "./run-actions.ts";
import { RunLifecycle } from "./run-lifecycle.ts";
import { Scheduler } from "./schedules.ts";
import type { StallMonitor } from "./stall.ts";
import { TaskFlow } from "./tasks.ts";
import type { TurnControl } from "./turns.ts";

export type { OrchestratorOptions } from "./context.ts";

// The deterministic scheduler (PLAN.md D7, D8, §8, §9): it runs the crew you approved as a DAG,
// under admission control, and never lets an agent start another agent. All state lives in the
// store as facts; in memory there are only live process handles, timers and the admission notes
// (context.ts). This class is the public face: it builds the context and the parts that do the
// work, hands each part the other parts' methods it calls, and delegates to them. See the
// "Orchestrator layout" row in AGENTS.md for which part owns what.

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
  /** Loop decisions, test results, pinned verdicts, review checkouts, run epochs (loops.ts). */
  readonly loops: LoopStore;
  /** Crew graph management: proposal edits, follow-ups, skip, Pause all (crew-manage.ts). */
  readonly crew: CrewManager;

  /** Kept on the facade too: github/flow.test.ts reads `opts.store` through a cast. */
  private readonly opts: OrchestratorOptions;
  private readonly ctx: OrchestratorContext;
  private readonly taskFlow: TaskFlow;
  private readonly dispatcher: Dispatcher;
  private readonly launcher: Launcher;
  private readonly lifecycle: RunLifecycle;
  private readonly actions: RunActions;
  private readonly messages: Messages;
  private readonly inbox: Inbox;
  private readonly budget: Budget;
  private readonly fallback: Fallback;
  private readonly handoffs: Handoffs;
  private readonly switcher: AccountSwitcher;
  private readonly loopRunner: LoopRunner;
  private readonly hibernator: Hibernator;
  private readonly bestOfRunner: BestOfRunner;
  private readonly recovery: Recovery;
  private hibernateTimer: NodeJS.Timeout | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
    const ctx = new OrchestratorContext(opts);
    this.ctx = ctx;
    ctx.bootstrap = new Bootstrapper({
      store: opts.store,
      now: ctx.now,
      gitBin: opts.gitBin,
      emit: opts.emit,
      requestApproval: (taskId, runId, payload) => this.inbox.insertRequest(taskId, runId, null, "high", payload),
      audit: (taskId, runId, kind, payload) => ctx.audit(taskId, runId, kind, payload),
      config: (projectId) => ctx.config(ctx.db.project(projectId)).config,
    });
    ctx.schedules = new Scheduler({
      db: opts.store.db,
      now: ctx.now,
      emit: (topic, payload) => ctx.emit(topic, payload),
      propose: (p) => this.taskFlow.propose(p),
      approve: (p) => this.taskFlow.approve(p),
      status: (taskId) => {
        try {
          return ctx.db.status(ctx.db.task(taskId));
        } catch {
          return null;
        }
      },
      projectPath: (projectId) => ctx.db.project(projectId).path,
      audit: (projectId, taskId, kind, payload) => opts.store.appendEvent({ kind, source: "orchestrator", payload, projectId, taskId }),
      track: (p) => ctx.track(p),
    });
    this.db = ctx.db;
    this.limits = ctx.limits;
    this.bootstrap = ctx.bootstrap;
    this.turns = ctx.turns;
    this.stalls = ctx.stalls;
    this.bestOf = ctx.bestOf;
    this.schedules = ctx.schedules;
    this.hibernation = ctx.hibernation;
    this.switches = ctx.switches;
    this.attachments = ctx.attachments;
    this.loops = ctx.loops;

    // Each part gets only the other parts' methods it calls; the arrows resolve when called, so
    // the order below does not matter.
    this.taskFlow = new TaskFlow(ctx, {
      groupView: (task) => this.bestOfRunner.groupView(task),
      groupCandidates: (members, candidates, scoring, n) => this.bestOfRunner.groupCandidates(members, candidates, scoring, n),
      approvedVariants: (task, project, members, views, candidates, group, p) => this.bestOfRunner.approvedVariants(task, project, members, views, candidates, group, p),
      cancelAutoRetry: (runId) => this.fallback.cancelAutoRetry(runId),
      stopRun: (runId, detail, reason) => this.lifecycle.stopRun(runId, detail, reason),
      closeRequest: (q, by) => this.inbox.closeRequest(q, by),
      closeHandoff: (id, outcome, detail) => this.handoffs.closeHandoff(id, outcome, detail),
      tick: () => this.dispatcher.tick(),
    });
    this.dispatcher = new Dispatcher(ctx, {
      wakeRun: (runId, cause) => this.hibernator.wakeRun(runId, cause),
      startGroup: (task, m, group, project, slots, candidates) => this.bestOfRunner.startGroup(task, m, group, project, slots, candidates),
      budgetHold: (task, m, candidate) => this.budget.budgetHold(task, m, candidate),
      launch: (spec) => this.launcher.launch(spec),
    });
    this.launcher = new Launcher(ctx, {
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
    this.lifecycle = new RunLifecycle(ctx, {
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
    this.actions = new RunActions(ctx, {
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
    this.messages = new Messages(ctx, {
      checkSeen: (run, seen) => this.actions.checkSeen(run, seen),
      wakeRun: (runId, cause) => this.hibernator.wakeRun(runId, cause),
      launch: (spec) => this.launcher.launch(spec),
      testGate: (runId) => this.loopRunner.testGate(runId),
      tick: () => this.dispatcher.tick(),
    });
    this.inbox = new Inbox(ctx, {
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
    this.budget = new Budget(ctx, {
      onLimitReached: (runId, info) => this.fallback.onLimitReached(runId, info),
    });
    this.fallback = new Fallback(ctx, {
      switchAccount: (run, task, info) => this.switcher.switchAccount(run, task, info),
      handoffCandidates: (run, task, info) => this.handoffs.handoffCandidates(run, task, info),
      autoTargets: (run, task, candidates) => this.handoffs.autoTargets(run, task, candidates),
      performHandoff: (sourceRunId, target, trigger) => this.handoffs.performHandoff(sourceRunId, target, trigger),
      insertRequest: (taskId, runId, nativeId, risk, payload) => this.inbox.insertRequest(taskId, runId, nativeId, risk, payload),
      launch: (spec) => this.launcher.launch(spec),
      proceed: (runId, text) => this.launcher.proceed(runId, text),
    });
    this.handoffs = new Handoffs(ctx, {
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
    this.switcher = new AccountSwitcher(ctx, {
      avoidFor: (member) => this.handoffs.avoidFor(member),
      performHandoff: (sourceRunId, target, trigger, opts) => this.handoffs.performHandoff(sourceRunId, target, trigger, opts),
    });
    this.loopRunner = new LoopRunner(ctx, {
      capFor: (taskId, runId, candidate) => this.budget.capFor(taskId, runId, candidate),
      launch: (spec) => this.launcher.launch(spec),
    });
    this.hibernator = new Hibernator(ctx, {
      continueRun: (runId, text) => this.launcher.continueRun(runId, text),
      endRun: (runId, reason, detail) => this.lifecycle.endRun(runId, reason, detail),
      onFailure: (runId, detail) => this.fallback.onFailure(runId, detail),
      tick: () => this.dispatcher.tick(),
    });
    this.bestOfRunner = new BestOfRunner(ctx, {
      insertRun: (spec) => this.launcher.insertRun(spec),
      boot: (runId, spec) => this.launcher.boot(runId, spec),
      stopRun: (runId, detail, reason) => this.lifecycle.stopRun(runId, detail, reason),
      cancel: (taskId) => this.taskFlow.cancel(taskId),
      get: (taskId) => this.taskFlow.get(taskId),
      tick: () => this.dispatcher.tick(),
    });
    this.recovery = new Recovery(ctx, {
      closeRequest: (q, by) => this.inbox.closeRequest(q, by),
      closeHandoff: (id, outcome, detail) => this.handoffs.closeHandoff(id, outcome, detail),
      offerHandoff: (run, task, mode, info, detail) => this.fallback.offerHandoff(run, task, mode, info, detail),
      dropCheckout: (runId) => this.loopRunner.dropCheckout(runId),
    });
    this.crew = new CrewManager({
      db: ctx.db,
      dataDir: opts.dataDir,
      candidates: (project) => ctx.candidates(project),
      scoring: (projectId, size, budgetUsd) => ctx.scoring(projectId, size, budgetUsd),
      config: (project) => ctx.config(project),
      template: (m) => ctx.tpl(m),
      bestOfMember: (taskId) => ctx.bestOf.group(taskId)?.member_id ?? null,
      get: (taskId) => this.taskFlow.get(taskId),
      emitTask: (taskId, cause) => ctx.emitTask(taskId, cause),
      audit: (taskId, runId, kind, payload) => ctx.audit(taskId, runId, kind, payload),
      tick: () => this.dispatcher.tick(),
      pause: (runId) => this.actions.pause(runId),
      resume: (runId) => this.actions.resume(runId),
      now: ctx.now,
    });
    this.db.taskExtras = (t) => this.bestOfRunner.taskExtras(t);
    this.db.taskLoop = (t) => this.loopRunner.loopView(t);
  }

  /** Recovers from the last session, then starts scheduling. */
  start(): void {
    this.recovery.recover();
    const opts = this.opts;
    const ms = opts.tickMs ?? 5_000;
    if (ms > 0) this.interval = setInterval(() => void this.tick(), ms).unref();
    const stallMs = opts.stallCheckMs ?? 30_000;
    if (stallMs > 0) this.stallTimer = setInterval(() => this.checkStalls(), stallMs).unref();
    const hibernateMs = opts.hibernateCheckMs ?? 30_000;
    if (hibernateMs > 0) this.hibernateTimer = setInterval(() => void this.checkHibernation(), hibernateMs).unref();
    const scheduleMs = opts.scheduleCheckMs ?? 30_000;
    this.schedules.start(scheduleMs);
    // Slots missed while the app was closed are caught up now (at most MAX_CATCH_UP of them).
    if (scheduleMs > 0) this.ctx.track(this.schedules.check());
    void this.tick();
  }

  /** One pass of the stall rules; a failure (the store closing on exit) waits for the next one. */
  checkStalls(): void {
    if (this.ctx.closed) return;
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
    this.ctx.timers.forEach((t) => clearTimeout(t));
    this.ctx.timers.clear();
    const live = [...this.ctx.live.values()];
    this.ctx.live.clear();
    for (const l of live) this.ctx.track(this.ctx.safe(() => l.adapter.stop(l.handle)));
  }

  /** Called by the providers work once profiles and the catalog are available. */
  setDirectory(directory: ProfileDirectory): void {
    this.ctx.directory = directory;
    void this.tick();
  }

  /** The task assistant (docs/adr/0014) starts its session on the same profiles and adapters as runs. */
  profileDirectory(): ProfileDirectory {
    return this.ctx.directory;
  }

  adapterFor(runner: RunnerId): AgentAdapter | null {
    return this.ctx.adapters.get(runner);
  }

  /** Called by the MCP work (handlers/mcp.ts) once its service exists. */
  setMcp(hook: McpHook): void {
    this.ctx.mcp = hook;
  }

  /** Waits until background work (pumps, handoffs, ticks) has settled; for tests and shutdown. */
  async settle(): Promise<void> {
    while (this.ctx.background.size > 0) await Promise.allSettled([...this.ctx.background]);
  }

  /** One scheduling pass; re-entrant calls fold into one more pass (dispatch.ts). */
  tick(): Promise<void> {
    return this.dispatcher.tick();
  }

  /** One hibernation pass over the live runs (hibernation.ts). */
  checkHibernation(): Promise<void> {
    return this.hibernator.checkHibernation();
  }

  /** Feeds a sample from outside a run (e.g. a provider balance poll) through the same rules. */
  ingestSample(sample: Parameters<LimitMonitor["ingest"]>[0]): void {
    this.limits.ingest(sample, { runId: null, taskId: null });
  }

  // ---------------------------------------------------------------- tasks (tasks.ts, best-of.ts)

  list(projectId?: string): TaskSummary[] {
    return this.taskFlow.list(projectId);
  }

  get(taskId: string): TaskDetail {
    return this.taskFlow.get(taskId);
  }

  propose(p: ProposeParams): Promise<TaskDetail> {
    return this.taskFlow.propose(p);
  }

  approve(p: TasksIpc["tasks.approve"]["params"]): Promise<TaskDetail> {
    return this.taskFlow.approve(p);
  }

  setAccountSwitch(taskId: string, enabled: boolean): TaskDetail {
    return this.taskFlow.setAccountSwitch(taskId, enabled);
  }

  cancel(taskId: string): Promise<TaskDetail> {
    return this.taskFlow.cancel(taskId);
  }

  keepVariant(taskId: string, variantId: string): Promise<TaskDetail> {
    return this.bestOfRunner.keepVariant(taskId, variantId);
  }

  // ---------------------------------------------------------------- runs (run-actions.ts, handoffs.ts)

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

  // ---------------------------------------------------------------- messages, queue and undo (messages.ts)

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

  // ---------------------------------------------------------------- requests (inbox.ts)

  requests(filter: { projectId?: string; taskId?: string; includeAnswered?: boolean }): RequestView[] {
    return this.inbox.requests(filter);
  }

  answer(requestId: string, answer: RequestAnswer, seen?: SessionSeen & { runId: string | null }): Promise<RequestView> {
    return this.inbox.answer(requestId, answer, seen);
  }
}
