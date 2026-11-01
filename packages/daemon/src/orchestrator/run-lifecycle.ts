import { join } from "node:path";
import { capEvent, EVENT_LIMITS, type AgentEvent, type EndReason, type SessionProblem, utf8Length, type RequestPayload } from "@crewyard/core";
import type { OrchestratorContext, Ended, Live, HandoffInfo } from "./context.ts";
import { Part } from "./part.ts";
import type { RunRow, TaskRow, RequestRow } from "./db.ts";
import { errorCode, redactDetail } from "./errors.ts";
import { writeFileAtomic } from "./git.ts";
import { applyResult, type RoleResult } from "./results.ts";
import { GOAL_PLANNER } from "./roles.ts";
import { settleReservation } from "./spend.ts";
import { snapshotTranscript } from "./transcripts.ts";

// A run's life once its process is attached: the adapter's event stream (logged, capped, routed
// to usage, limits, requests and approvals), how the stream's end becomes the run's end, and
// everything that ending a run releases (timers, holds, checkouts, tickets, open requests).

export interface RunLifecycleDeps {
  confirmHandoff(targetRunId: string): Promise<void>;
  failHandoff(handoffId: string, detail: string): Promise<void>;
  onUsage(run: RunRow, task: TaskRow, ev: Extract<AgentEvent, { type: "usage.update" }>): Promise<void>;
  onLimitReached(runId: string, info: HandoffInfo): Promise<void>;
  onFailure(runId: string, detail: string | null): Promise<void>;
  insertRequest(taskId: string, runId: string | null, nativeId: string | null, risk: RequestRow["risk"], payload: RequestPayload): string;
  routeApproval(run: RunRow, task: TaskRow, ev: Extract<AgentEvent, { type: "request.approval" }>): Promise<void>;
  closeRequest(q: RequestRow, by: "system" | "policy"): void;
  replaceSession(failedRunId: string, problem: SessionProblem): Promise<void>;
  pinHead(runId: string): Promise<void>;
  reviewLoop(reviewerRunId: string, result: RoleResult): Promise<void>;
  dropCheckout(runId: string): Promise<void>;
  refreshVariantDiff(variantId: string): Promise<void>;
  /**
   * Every end of an Orchestra planning run, however it ended (docs/adr/0019), with its result
   * when it completed (null when the runner sent none). GoalPlanner checks and stores the plan.
   */
  planningEnded(runId: string, reason: EndReason, result: RoleResult | null): Promise<void>;
  tick(): Promise<void>;
}

export class RunLifecycle extends Part {
  /** A planning run's result, kept from its run.ended event until endRun hands it to the planner. */
  private readonly planResults = new Map<string, RoleResult>();

  constructor(ctx: OrchestratorContext, private readonly deps: RunLifecycleDeps) {
    super(ctx);
  }

  async pump(runId: string, live: Live): Promise<void> {
    let ended: Ended | null = null;
    try {
      for await (const ev of live.adapter.events(live.handle)) {
        if (this.live.get(runId) !== live) return;
        if (this.confirming.has(runId)) await this.deps.confirmHandoff(runId);
        if (ev.type === "run.ended") {
          this.record(runId, ev);
          const result = applyResult(this.db, runId, ev, (kind, payload) => this.audit(this.db.run(runId).task_id, runId, kind, payload));
          if (result) this.keepVerdict(runId, result);
          if (result && this.db.run(runId).role === GOAL_PLANNER.id) this.planResults.set(runId, result);
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
        await this.deps.onUsage(run, task, ev);
        break;
      case "limit.update":
        this.limits.ingest({ profileId: run.profile_id, window: ev.window, usedPct: ev.usedPct, resetsAt: ev.resetsAt, provenance: ev.provenance, observedAt: ev.at }, { runId, taskId: task.id, reached: ev.reached });
        if (ev.reached) await this.deps.onLimitReached(runId, { trigger: "limit", window: ev.window, resetsAt: ev.resetsAt });
        break;
      case "request.question":
        this.deps.insertRequest(task.id, runId, ev.requestId, null, { kind: "question", questions: ev.questions });
        break;
      case "request.approval":
        await this.deps.routeApproval(run, task, ev);
        break;
      default:
        break;
    }
  }

  private async onStreamEnd(runId: string, ended: Ended): Promise<void> {
    const run = this.db.run(runId);
    // Read before endRun, which forgets both: the loop's stop rule and a reviewer's verdict.
    const loopStop = this.loopFailed.get(runId);
    const verdict = this.verdicts.get(runId);
    if (run.ended_at) {
      // Already ended some other way (a stop racing the last event): nobody acts on them now.
      this.loopFailed.delete(runId);
      this.verdicts.delete(runId);
      return;
    }
    // Stopped for hibernation: the run stays open and holds its step.
    if (this.hibernating.delete(runId)) {
      this.emitTask(run.task_id, "hibernation");
      void this.deps.tick();
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
      void this.deps.tick();
      return;
    }
    if (ended.reason === "limit") {
      await this.deps.onLimitReached(runId, { trigger: "limit", window: null, resetsAt: null });
      return;
    }
    // The loop stopped this implementer (iteration cap, no change, spend cap): the step failed its tests.
    if (ended.reason === "completed" && loopStop) {
      this.endRun(runId, "failed", loopStop);
      return;
    }
    // Runners report provider errors as they got them; what we keep and show is redacted and bounded.
    const detail = ended.detail === null ? null : redactDetail(ended.detail, await this.secretsFor(run.profile_id)) || null;
    // Claude reports a gone or locked session only in its stream (adapter-claude: "session.gone: ...").
    const problem = ended.reason === "failed" && this.resumed.has(runId) && !run.handoff_id ? /^session\.(gone|locked):/.exec(detail ?? "")?.[1] : undefined;
    if (ended.reason === "completed") await this.deps.pinHead(runId);
    this.endRun(runId, ended.reason, detail);
    // A failed planning run is never relaunched by itself, not even in a fresh session when its
    // resumed one (the corrective turn) is gone: the goal shows Retry planning, since relaunching a
    // planner on its own loops against a metered API (design §4.4, §5.3). Nor retried or handed off.
    const planning = run.role === GOAL_PLANNER.id;
    if (problem && !this.confirming.has(runId) && !planning) {
      await this.deps.replaceSession(runId, problem as SessionProblem);
      return;
    }
    if (ended.reason === "failed" && !planning) await this.deps.onFailure(runId, detail);
    if (ended.reason === "completed" && verdict) await this.deps.reviewLoop(runId, verdict);
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

  endRun(runId: string, reason: EndReason, detail: string | null): void {
    const run = this.db.run(runId);
    const planResult = this.planResults.get(runId) ?? null;
    this.planResults.delete(runId);
    if (run.ended_at) return;
    this.db.exec("update runs set ended_at = ?, end_reason = ?, end_detail = ? where id = ? and ended_at is null", this.iso(), reason, detail, runId);
    this.clearTimer(runId);
    this.held.delete(runId);
    this.turns.end(runId);
    this.resumed.delete(runId);
    this.nativeReviews.delete(runId);
    // A paused, limited or hibernated run keeps these until it ends; however it ends, they go now.
    this.loopFailed.delete(runId);
    this.verdicts.delete(runId);
    this.draining.delete(runId);
    this.drainRelease.get(runId)?.(null);
    this.drainRelease.delete(runId);
    this.track(this.deps.dropCheckout(runId));
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
    if (variant) this.track(this.deps.refreshVariantDiff(variant.id));
    // A handoff target that ends before it confirmed leaves the source paused and asks you.
    const pendingHandoff = this.confirming.get(runId);
    if (pendingHandoff) {
      this.confirming.delete(runId);
      this.track(this.deps.failHandoff(pendingHandoff, detail ?? "target_ended"));
    }
    // Nobody is left to receive these answers; they close instead of lingering as "needs input".
    // A run that finished its work needs no hand off either (e.g. a cap tripped on its last report).
    for (const q of this.db.openRequestsForRun(runId).filter((q) => q.kind !== "handoff" || reason === "completed")) this.deps.closeRequest(q, "system");
    this.audit(run.task_id, runId, "run.finished", { reason, detail });
    this.emitTask(run.task_id, "run_ended");
    // Here rather than in the stream's end, so a stop, a cancel or a failed start reach the goal too.
    if (run.role === GOAL_PLANNER.id) this.track(this.deps.planningEnded(runId, reason, reason === "completed" ? planResult : null));
    void this.deps.tick();
  }

  async stopRun(runId: string, detail: string, reason: EndReason = "stopped"): Promise<void> {
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

  /** Copies the runner's own transcript into the task folder (feature scan A18); returns our copy's path. */
  async copyTranscript(runId: string): Promise<string | null> {
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
}

/** Largest tool output kept whole on disk when its event is cut; bigger ones keep only the head. */
const KEEP_FULL_MAX = 8 * 1024 * 1024;
