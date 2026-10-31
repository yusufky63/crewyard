import { randomUUID } from "node:crypto";
import {
  classifyRisk,
  type AgentEvent,
  type Answer,
  type CandidateView,
  type EndReason,
  type HandoffTrigger,
  type RequestAnswer,
  type RequestPayload,
  type RequestView,
  type SessionSeen,
} from "@crewyard/core";
import type { OrchestratorContext } from "./context.ts";
import { Part } from "./part.ts";
import type { RequestRow, RunRow, TaskRow } from "./db.ts";
import { OrchestratorError } from "./errors.ts";
import { onlyDocPaths } from "./roles.ts";
import { answerAfterSleep, type WakeCause } from "./hibernation.ts";

// The Inbox: requests a run is waiting on (questions, approvals, handoff choices), how a runner's
// approval is routed by role policy and risk, and what your answer sets in motion.

export interface InboxDeps {
  checkSeen(run: RunRow, seen: SessionSeen | undefined): void;
  resolveTarget(run: RunRow, profileId: string | null, payload: Extract<RequestPayload, { kind: "handoff" }>): Promise<CandidateView | null>;
  performHandoff(sourceRunId: string, target: CandidateView, trigger: HandoffTrigger): Promise<void>;
  scheduleResume(runId: string, resetsAt: string): void;
  stopRun(runId: string, detail: string, reason?: EndReason): Promise<void>;
  continuePastCap(runId: string): Promise<void>;
  wakeRun(runId: string, cause: WakeCause): Promise<void>;
  proceed(runId: string, text: string): Promise<void>;
  endRun(runId: string, reason: EndReason, detail: string | null): void;
  tick(): Promise<void>;
}

export class Inbox extends Part {
  constructor(ctx: OrchestratorContext, private readonly deps: InboxDeps) {
    super(ctx);
  }

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
    if (run) this.deps.checkSeen(run, seen);
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
        target = await this.deps.resolveTarget(run!, answer.targetProfileId ?? payload.proposedTarget?.profileId ?? null, payload);
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
      for (const id of next.ready) if (this.held.has(id) && !this.live.has(id)) this.track(this.deps.proceed(id, ""));
      if (next.denied && !this.db.run(next.denied).ended_at) this.deps.endRun(next.denied, "failed", "bootstrap.denied");
    }
    if (asleep && run && (payload.kind === "question" || payload.kind === "approval") && answer.kind !== "handoff") {
      // Only "allow once" grants the woken session's repeat; "allow always" uses the project allowlist, deny and cancel grant nothing.
      if (payload.kind === "approval" && answer.kind === "approval" && answer.decision === "allow_once" && payload.command) this.hibernation.grant(run.id, { command: payload.command, cwd: payload.cwd, paths: payload.paths, network: payload.network });
      this.turns.queue.add(run.task_id, run.member_id, answerAfterSleep(payload, answer), "note");
      await this.deps.wakeRun(run.id, "answer");
    }
    if (answer.kind === "handoff" && run && payload.kind === "handoff") {
      if (answer.decision === "hand_off" && target) this.track(this.deps.performHandoff(run.id, target, payload.trigger === "handoff_failed" ? "limit" : payload.trigger === "unpriced" ? "budget" : payload.trigger));
      else if (answer.decision === "wait_for_reset" && payload.resetsAt) this.deps.scheduleResume(run.id, payload.resetsAt);
      else if (answer.decision === "stop" && !run.ended_at) await this.deps.stopRun(run.id, "user_stop", "limit");
      else if (answer.decision === "continue" && !run.ended_at) await this.deps.continuePastCap(run.id);
    }
    this.emitTask(q.task_id, "request");
    void this.deps.tick();
    return this.db.requestView(this.db.request(q.id));
  }

  /**
   * Role permissions first (a read-only role never writes, whatever it asks), then risk. Only low
   * risk is approved by policy; medium and high always wait for you and never time out.
   */
  async routeApproval(run: RunRow, task: TaskRow, ev: Extract<AgentEvent, { type: "request.approval" }>): Promise<void> {
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

  insertRequest(taskId: string, runId: string | null, nativeId: string | null, risk: RequestRow["risk"], payload: RequestPayload, answeredByPolicy: RequestAnswer | null = null): string {
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

  closeRequest(q: RequestRow, by: "system" | "policy"): void {
    const closed = this.db.db.prepare("update requests set answered_at = ?, answer = ?, answered_by = ? where id = ? and answered_at is null").run(this.iso(), JSON.stringify({ kind: "cancel" }), by, q.id);
    if (Number(closed.changes) > 0) this.audit(q.task_id, q.run_id, "request.answered", { requestId: q.id, nativeId: q.native_id, by, kind: "cancel" });
    this.emitRequest(q.id);
  }
}

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
