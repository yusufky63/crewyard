import { randomUUID } from "node:crypto";
import { type CandidateView, type FallbackMode, type HandoffTrigger, type RequestPayload } from "@crewyard/core";
import type { OrchestratorContext, HandoffInfo, LaunchSpec } from "./context.ts";
import { Part } from "./part.ts";
import type { RunRow, TaskRow, RequestRow } from "./db.ts";
import { errorCode } from "./errors.ts";
import { classifyFailure, RETRY, retryDelayMs, type Failure } from "./failures.ts";

// What happens when a run hits a limit, a spend cap or an error (PLAN.md §8, feature scan F8):
// wait for the window to reset, switch to another account of the same provider, retry the same
// profile after a transient error, hand off on Auto, or ask you in the Inbox.

export interface FallbackDeps {
  switchAccount(run: RunRow, task: TaskRow, info: HandoffInfo): Promise<boolean>;
  handoffCandidates(run: RunRow, task: TaskRow, info?: Pick<HandoffInfo, "trigger" | "failure">): Promise<CandidateView[]>;
  autoTargets(run: RunRow, task: TaskRow, candidates: CandidateView[]): Promise<CandidateView[]>;
  performHandoff(sourceRunId: string, target: CandidateView, trigger: HandoffTrigger): Promise<void>;
  insertRequest(taskId: string, runId: string | null, nativeId: string | null, risk: RequestRow["risk"], payload: RequestPayload): string;
  launch(spec: LaunchSpec): Promise<string>;
  proceed(runId: string, text: string): Promise<void>;
}

export class Fallback extends Part {
  constructor(ctx: OrchestratorContext, private readonly deps: FallbackDeps) {
    super(ctx);
  }

  async onLimitReached(runId: string, info: HandoffInfo): Promise<void> {
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
    if (await this.deps.switchAccount(this.db.run(runId), task, info)) return;
    await this.offerHandoff(this.db.run(runId), task, mode, info, null);
  }

  /**
   * A run that failed after it started (feature scan F8). A request every provider would refuse
   * stays failed: no handoff, no fallback, no retry. A transient error moves to the next profile at
   * once when Auto has one, and otherwise retries the same profile after a jittered backoff, a few
   * times. Anything else, and a transient error out of retries, is handed off like a limit, per
   * the task's mode.
   */
  async onFailure(runId: string, detail: string | null): Promise<void> {
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
      if (await this.deps.switchAccount(run, task, info)) return;
      await this.offerHandoff(run, task, mode, info, "credit_depleted");
      return;
    }
    if (failure.kind === "transient") {
      // Never wait when the next step is another profile: Auto with a target switches now.
      const switching = mode === "auto" && this.handoffsTaken(run) < MAX_AUTO_HANDOFFS && (await this.deps.autoTargets(run, task, await this.deps.handoffCandidates(run, task, { trigger: "crashed", failure: "transient" }))).length > 0;
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
    await this.deps.launch({ runId: id, task, member: this.db.member(run.member_id), target: { profileId: run.profile_id, runner: run.runner, model: run.model }, ...resume, resumedFrom: run.id });
    this.audit(task.id, id, "run.auto_retry", { from: run.id, attempt, delayMs, native });
    this.emitTask(task.id, "retried");
  }

  /** Drops a pending same-profile retry; whatever you chose instead takes over the step. */
  cancelAutoRetry(runId: string): void {
    this.clearTimer(runId);
    this.db.exec("update runs set resume_at = null where id = ? and ended_at is not null", runId);
  }

  async offerHandoff(run: RunRow, task: TaskRow, mode: FallbackMode, info: HandoffInfo, detail: string | null): Promise<void> {
    const candidates = await this.deps.handoffCandidates(run, task, info);
    const next = mode === "auto" ? (await this.deps.autoTargets(run, task, candidates))[0] : undefined;
    if (next && this.handoffsTaken(run) < MAX_AUTO_HANDOFFS) {
      this.track(this.deps.performHandoff(run.id, next, info.trigger === "unpriced" ? "budget" : info.trigger));
      return;
    }
    this.deps.insertRequest(task.id, run.id, null, null, {
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

  /** Wait-for-reset: the same session continues when its window resets. */
  scheduleResume(runId: string, resetsAt: string): void {
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
      await this.deps.proceed(runId, "Your usage window has reset. Continue the task where you stopped.");
      this.audit(run.task_id, runId, "run.resumed", { after: "reset" });
      this.emitTask(run.task_id, "run_resumed");
    } catch (err) {
      this.db.exec("update runs set paused_at = ? where id = ?", this.iso(), runId);
      await this.offerHandoff(this.db.run(runId), this.db.task(run.task_id), "manual", { trigger: "limit", window: null, resetsAt: null }, errorCode(err));
    }
  }

  /** "Continue" on a budget request: the approval is stored on the request, so later checks skip that cap for this run. */
  async continuePastCap(runId: string): Promise<void> {
    const run = this.db.run(runId);
    this.clearTimer(runId);
    this.db.exec("update runs set limit_reached = 0, paused_at = null, resume_at = null where id = ?", runId);
    this.audit(run.task_id, runId, "run.cap_approved", {});
    try {
      await this.deps.proceed(runId, "Spending past the cap was approved. Continue the task where you stopped.");
      this.emitTask(run.task_id, "run_resumed");
    } catch (err) {
      this.db.exec("update runs set paused_at = ? where id = ?", this.iso(), runId);
      await this.offerHandoff(this.db.run(runId), this.db.task(run.task_id), "manual", { trigger: "budget", window: null, resetsAt: null }, errorCode(err));
    }
  }
}

/** How many handoffs one crew step may take on its own before it asks you (the standby chain is 2 long). */
const MAX_AUTO_HANDOFFS = 2;
