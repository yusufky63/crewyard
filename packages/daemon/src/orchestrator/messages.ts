import { type RunView, type SessionSeen, type UserInput, withAttachments } from "@crewyard/core";
import type { OrchestratorContext, LaunchSpec } from "./context.ts";
import { Part } from "./part.ts";
import type { WakeCause } from "./hibernation.ts";
import type { RunRow } from "./db.ts";
import { OrchestratorError } from "./errors.ts";
import { rolePrompt } from "./prompts.ts";
import { joinMessages } from "./queue.ts";

// What you say to a step (feature scan A10, A13): every message joins the step's queue first, and
// a turn boundary, a resume or a new run takes it from there. Also Steer now, Undo last turn, and
// feedback after a step finished (follow-up).

export interface MessagesDeps {
  checkSeen(run: RunRow, seen: SessionSeen | undefined): void;
  wakeRun(runId: string, cause: WakeCause): Promise<void>;
  launch(spec: LaunchSpec): Promise<string>;
  testGate(runId: string): Promise<string | null>;
  tick(): Promise<void>;
}

export class Messages extends Part {
  constructor(ctx: OrchestratorContext, private readonly deps: MessagesDeps) {
    super(ctx);
  }

  async message(runId: string, text: string, seen?: SessionSeen, attachmentIds: string[] = []): Promise<RunView> {
    const run = this.db.run(runId);
    this.deps.checkSeen(run, seen);
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
    if (!live && !run.paused_at && this.hibernation.asleep(runId)) await this.deps.wakeRun(runId, "message");
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
    this.deps.checkSeen(run, seen);
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
      void this.deps.tick();
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
    const id = await this.deps.launch({
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
  async nextTurn(runId: string): Promise<string | UserInput | null> {
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
      const fix = !stop && live ? await this.deps.testGate(runId) : null;
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
}
