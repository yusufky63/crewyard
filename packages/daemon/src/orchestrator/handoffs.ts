import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  CandidateView,
  EndReason,
  FallbackMode,
  HandoffStop,
  HandoffPhase,
  HandoffTrigger,
  RequestPayload,
  RunView,
  SpendCap,
} from "@crewyard/core";
import type { HandoffInfo, LaunchSpec, OrchestratorContext } from "./context.ts";
import { Part } from "./part.ts";
import { sameProviderAccounts } from "./account-switch.ts";
import { eligible, MIN_HEADROOM, modelKey, rankForRole, readOnlyConflict, scoreCandidate } from "./crew.ts";
import type { MemberRow, RequestRow, RunRow, TaskRow } from "./db.ts";
import type { Candidate } from "./directory.ts";
import { errorCode, OrchestratorError } from "./errors.ts";
import { checkpoint, diffStat, headSha, sameDir, writeFileAtomic } from "./git.ts";
import { forkPrompt, handoffPackage } from "./prompts.ts";
import { reachedCaps, settleReservation, spendCredential } from "./spend.ts";

// Handoff (PLAN.md §8): a step moves from one profile to another. Preflight picks the targets,
// a claim makes it one handoff per source, the source stops at a turn boundary (drained or
// interrupted), the work is committed and written up as a package, and the target starts by
// native resume, fork or a new session. The record flips only once the target is talking and git
// matches; a failure leaves the source paused and asks you.

export interface HandoffsDeps {
  cancelAutoRetry(runId: string): void;
  closeRequest(q: RequestRow, by: "system" | "policy"): void;
  offerHandoff(run: RunRow, task: TaskRow, mode: FallbackMode, info: HandoffInfo, detail: string | null): Promise<void>;
  launch(spec: LaunchSpec): Promise<string>;
  stopRun(runId: string, detail: string, reason?: EndReason): Promise<void>;
  endRun(runId: string, reason: EndReason, detail: string | null): void;
  copyTranscript(runId: string): Promise<string | null>;
  capFor(taskId: string, runId: string | null, candidate: Candidate | undefined, addUsd?: number, alsoApproved?: Set<string>): SpendCap | null;
  approvalsFor(runId: string): Set<string>;
}

export class Handoffs extends Part {
  constructor(ctx: OrchestratorContext, private readonly deps: HandoffsDeps) {
    super(ctx);
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
    this.deps.cancelAutoRetry(source.id);
    // Your choice answers any limit or crash question still open for this run.
    for (const q of this.db.openRequestsForRun(source.id).filter((q) => q.kind === "handoff")) this.deps.closeRequest(q, "system");
    this.track(this.executeHandoff(handoffId, source.id, target, "manual"));
    return this.db.runView(this.db.run(runId));
  }

  /**
   * Preflight (PLAN.md §8.2 step 2): standby candidates that are ready, have an adapter, keep the
   * role's permissions and the independence rule, have more than 20% headroom (Unknown passes and
   * says so) and fit the remaining budget. After a crash, a profile on the model that just failed
   * and a profile whose last run could not even start are skipped (both failed again in the live
   * run); after a credit stop, so is every profile on the key that ran out.
   */
  async handoffCandidates(run: RunRow, task: TaskRow, info?: Pick<HandoffInfo, "trigger" | "failure">): Promise<CandidateView[]> {
    const project = this.db.project(task.project_id);
    const member = this.db.member(run.member_id);
    const all = await this.candidates(project);
    // A Best of N variant spends on its parent: the parent's budget and per-task caps count every variant.
    const root = this.budgetTask(task.id);
    const budget = this.db.task(root).budget_usd;
    const ctx = this.scoring(project.id, task.size, budget);
    const avoid = this.avoidFor(member);
    const chain = (JSON.parse(member.standby) as CandidateView[]).map((s) => s.profileId);
    const original = member.chosen ? (JSON.parse(member.chosen) as CandidateView).profileId : null;
    const order = [...chain, ...(original ? [original] : [])].filter((id, i, a) => a.indexOf(id) === i && id !== run.profile_id);
    const spent = this.db.spend(this.budgetRuns(root)).usd ?? 0;
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
      .filter((c) => reachedCaps(this.opts.store.db, spendCredential(c), root, this.now(), { excludeRunId: run.id }).length === 0)
      .map((c) => scoreCandidate(c, this.tpl(member), ctx, avoid))
      .filter((v) => (v.headroom.pct === null || v.headroom.pct > MIN_HEADROOM) && (budget === null || v.estimate.usd === 0 || spent < budget));
  }

  avoidFor(member: MemberRow): { models: Set<string>; providers: Set<string> } {
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
  async autoTargets(run: RunRow, task: TaskRow, candidates: CandidateView[]): Promise<CandidateView[]> {
    const all = await this.candidates(this.db.project(task.project_id));
    const source = all.find((c) => c.profile.id === run.profile_id);
    if (!source) return candidates;
    const others = new Set(sameProviderAccounts(source, all).map((c) => c.profile.id));
    return candidates.filter((v) => !others.has(v.profileId));
  }

  async resolveTarget(run: RunRow, profileId: string | null, payload: Extract<RequestPayload, { kind: "handoff" }>): Promise<CandidateView | null> {
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
  async performHandoff(sourceRunId: string, target: CandidateView, trigger: HandoffTrigger, opts: { mode?: FallbackMode; onClaim?: (handoffId: string) => void } = {}): Promise<void> {
    const source = this.db.run(sourceRunId);
    const task = this.db.task(source.task_id);
    const project = this.db.project(task.project_id);

    // Preflight before claiming anything, so a target that cannot start never touches the source.
    const candidate = (await this.candidates(project)).find((c) => c.profile.id === target.profileId);
    if (!candidate?.ready || !this.adapters.has(target.runner)) {
      await this.deps.offerHandoff(source, task, "manual", { trigger, window: null, resetsAt: null }, "target_unavailable");
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
    const stepApproved = new Set([...this.deps.approvalsFor(source.id)].filter((k) => k === "task_budget"));
    const cap = this.deps.capFor(task.id, null, c, 0, stepApproved);
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
      const targetRunId = await this.deps.launch({
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
  async writePackage(task: TaskRow, source: RunRow, trigger: string, name: string): Promise<{ text: string; path: string; sha: string | null }> {
    const wt = this.db.worktree(task.id);
    let sha: string | null = null;
    let stat: string | null = null;
    if (wt && sameDir(wt.path, source.cwd)) {
      sha = (await checkpoint(wt.path, `wip: handoff from ${source.id}`, this.opts.gitBin)).sha;
      stat = await diffStat(wt.path, wt.base_sha, this.opts.gitBin);
    }
    // The package cites our copy: the runner's own may expire before anyone reads it.
    const transcript = await this.deps.copyTranscript(source.id);
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
  async confirmHandoff(targetRunId: string): Promise<void> {
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
        this.track(this.deps.stopRun(targetRunId, "handoff_failed"));
        return;
      }
    }
    this.closeHandoff(handoffId, "completed", null);
    // The controller swap: the step's epoch moves on, so anything the source still sends is fenced.
    this.loops.bump(target.member_id, targetRunId);
    this.db.exec("update runs set handoff_id = ? where id = ?", handoffId, h.from_run_id);
    if (target.worktree_id) this.db.exec("update worktrees set owner_run_id = ? where id = ?", targetRunId, target.worktree_id);
    // A hand off you asked for is not a limit; the source simply stopped in favour of the target.
    this.deps.endRun(h.from_run_id, h.trigger_kind === "manual" ? "stopped" : "limit", "handed_off");
    this.audit(h.task_id, targetRunId, "handoff.completed", { handoffId, from: h.from_run_id, mode: h.mode });
    this.emitTask(h.task_id, "handoff_completed");
  }

  async failHandoff(handoffId: string, detail: string): Promise<void> {
    const h = this.db.handoff(handoffId);
    if (h.closed_at) return;
    this.closeHandoff(handoffId, "failed", detail);
    const source = this.db.run(h.from_run_id);
    // The source stays paused and you decide (PLAN.md §8.2 step 7).
    if (!source.ended_at) this.db.exec("update runs set paused_at = coalesce(paused_at, ?) where id = ?", this.iso(), source.id);
    const task = this.db.task(h.task_id);
    this.audit(task.id, source.id, "handoff.failed", { handoffId, detail });
    await this.deps.offerHandoff(source, task, "manual", { trigger: h.trigger_kind, window: null, resetsAt: null }, "handoff_failed");
    this.emitTask(task.id, "handoff_failed");
  }

  closeHandoff(id: string, outcome: "completed" | "failed" | "cancelled" | "interrupted", detail: string | null): void {
    this.db.exec("update handoffs set closed_at = ?, outcome = ?, detail = ?, phase = 'closed' where id = ? and closed_at is null", this.iso(), outcome, detail, id);
  }
}

/** Longest a "drain" handoff waits for the turn in flight to end before it interrupts it. */
const DRAIN_TIMEOUT_MS = 10 * 60_000;
