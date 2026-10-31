import type { RunView, SessionSeen, EndReason, FallbackMode, SpendCap } from "@crewyard/core";
import type { OrchestratorContext, HandoffInfo, LaunchSpec } from "./context.ts";
import { Part } from "./part.ts";
import type { RunRow, TaskRow, RequestRow } from "./db.ts";
import type { Candidate } from "./directory.ts";
import { errorCode, OrchestratorError } from "./errors.ts";
import { capResetsAt, capWindow } from "./spend.ts";

// Pause, Resume, Stop and "Check again" on a run, and the check that each acts only on the run
// and session you saw (feature scan F11). Nothing restarts without one of these calls.

export interface RunActionsDeps {
  closeRequest(q: RequestRow, by: "system" | "policy"): void;
  unpricedOpen(runId: string): boolean;
  capFor(taskId: string, runId: string | null, candidate: Candidate | undefined): SpendCap | null;
  proceed(runId: string, text: string): Promise<void>;
  launch(spec: LaunchSpec): Promise<string>;
  stopRun(runId: string, detail: string, reason?: EndReason): Promise<void>;
  cancelAutoRetry(runId: string): void;
  offerHandoff(run: RunRow, task: TaskRow, mode: FallbackMode, info: HandoffInfo, detail: string | null): Promise<void>;
  tick(): Promise<void>;
}

export class RunActions extends Part {
  constructor(ctx: OrchestratorContext, private readonly deps: RunActionsDeps) {
    super(ctx);
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
      for (const q of this.db.openRequestsForRun(runId).filter((q) => q.kind !== "handoff")) this.deps.closeRequest(q, "system");
      this.emitTask(run.task_id, "run_paused");
      void this.deps.tick();
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
      if (run.limit_reached && this.deps.unpricedOpen(runId)) throw new OrchestratorError("run.price_unknown");
      const cap = run.limit_reached ? this.deps.capFor(task.id, runId, await this.candidateFor(run)) : null;
      if (cap) throw new OrchestratorError("run.still_limited", { window: capWindow(cap), resetsAt: capResetsAt(cap, this.now()) ?? "" });
      // The pause interrupted the turn; let that stream end as a pause first, or its end would
      // read as a stop once paused_at is cleared.
      const pausing = this.live.get(runId);
      if (pausing) await this.within(pausing.done, this.opts.stopTimeoutMs ?? 30_000);
      this.clearTimer(runId);
      this.db.exec("update runs set paused_at = null, resume_at = null, limit_reached = 0 where id = ?", runId);
      for (const q of this.db.openRequestsForRun(runId).filter((q) => q.kind === "handoff")) this.deps.closeRequest(q, "system");
      await this.deps.proceed(runId, "Continue the task where you stopped.");
      this.emitTask(run.task_id, "run_resumed");
      return this.db.runView(this.db.run(runId));
    }
    if (this.superseded(run) || !["interrupted", "stopped", "failed"].includes(run.end_reason ?? "")) throw new OrchestratorError("run.not_resumable");
    const adapter = this.adapters.get(run.runner);
    if (!adapter?.capabilities.resume || !run.native_session_id) throw new OrchestratorError("run.resume_unsupported", { runner: run.runner });
    this.deps.cancelAutoRetry(run.id);
    const newId = await this.deps.launch({
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
    if (run.ended_at && run.resume_at) this.deps.cancelAutoRetry(runId);
    if (!run.ended_at) await this.deps.stopRun(runId, "user_stop");
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
      this.deps.cancelAutoRetry(run.id);
      // The crash or limit question about the old run is answered by retrying it.
      for (const q of this.db.openRequestsForRun(run.id).filter((q) => q.kind === "handoff")) this.deps.closeRequest(q, "system");
      const id = await this.deps.launch({ task, member: this.db.member(run.member_id), target: { profileId: run.profile_id, runner: run.runner, model: run.model }, resumedFrom: run.id });
      this.audit(task.id, id, "run.retried", { from: run.id });
      this.emitTask(task.id, "retried");
      return this.db.runView(this.db.run(id));
    }
    if (run.limit_reached || run.resume_at) {
      if (this.deps.unpricedOpen(run.id)) throw new OrchestratorError("run.price_unknown");
      const cap = this.deps.capFor(task.id, run.id, await this.candidateFor(run));
      if (cap) throw new OrchestratorError("run.still_limited", { window: capWindow(cap), resetsAt: capResetsAt(cap, this.now()) ?? "" });
      const reached = this.db.reachedWindow(run.profile_id, this.now());
      if (reached) throw new OrchestratorError("run.still_limited", { window: reached.window, resetsAt: reached.resetsAt });
      this.clearTimer(run.id);
      this.db.exec("update runs set limit_reached = 0, paused_at = null, resume_at = null where id = ?", run.id);
      for (const q of this.db.openRequestsForRun(run.id).filter((q) => q.kind === "handoff")) this.deps.closeRequest(q, "system");
      this.audit(task.id, run.id, "run.retried", { after: "limit" });
      try {
        await this.deps.proceed(run.id, "Your limit has cleared. Continue the task where you stopped.");
        this.emitTask(task.id, "run_resumed");
      } catch (err) {
        this.db.exec("update runs set paused_at = ? where id = ?", this.iso(), run.id);
        await this.deps.offerHandoff(this.db.run(run.id), task, "manual", { trigger: "limit", window: null, resetsAt: null }, errorCode(err));
        this.emitTask(task.id, "limit");
      }
      return this.db.runView(this.db.run(run.id));
    }
    await this.deps.tick();
    return this.db.runView(this.db.run(run.id));
  }

  /**
   * Feature scan F11: a stop, pause, message or answer acts only on the run and session you saw. If
   * a handoff, resume or retry took over the step, or the native session changed, it is refused
   * and the UI re-reads. Internal callers pass nothing and are not checked.
   */
  checkSeen(run: RunRow, seen: SessionSeen | undefined): void {
    if (!seen) return;
    // A handoff target that failed never took the step over, so the source's own questions stay answerable.
    const next = this.db.successor(run);
    if (next) throw new OrchestratorError("run.session_changed", { runId: next.id });
    if (seen.sessionId !== null && run.native_session_id !== seen.sessionId) throw new OrchestratorError("run.session_changed", { runId: run.id });
  }
}
