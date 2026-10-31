import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type AgentAdapter, type Attachment, type ForkResult, type ReviewTarget, type RoleId, type RunHandle, type SessionProblem, type StartRequest, sessionProblemOf, type UserInput, withAttachments, type AgentEvent, type EndReason, type SpendCap, type UnpricedSpend } from "@crewyard/core";
import type { OrchestratorContext, LaunchSpec, Live, HandoffInfo } from "./context.ts";
import { Part } from "./part.ts";
import { reviewContext } from "./loops.ts";
import { estimateFor } from "./crew.ts";
import type { MemberRow, ProjectRow, RunRow, TaskRow, WorktreeRow } from "./db.ts";
import type { Candidate } from "./directory.ts";
import { errorCode, errorDetail, OrchestratorError } from "./errors.ts";
import { ensureWorktree, sameDir, taskSlug } from "./git.ts";
import { outputSchemaFor } from "./results.ts";
import { rolePrompt } from "./prompts.ts";
import { reserveSpend, spendCredential } from "./spend.ts";
import { joinMessages } from "./queue.ts";

// Starting a run's process: the run row first (so admission counts it at once), then the task
// worktree or a pinned review checkout, the spend checks that may hold it, worktree bootstrap,
// a fork or native resume, and the prompt with what is queued for the step. Also the native
// resume that continues a run after a pause, a limit or hibernation.

export interface LauncherDeps {
  reviewCheckout(runId: string, task: TaskRow, wt: WorktreeRow): Promise<{ path: string; sha: string }>;
  unpricedFor(task: TaskRow, runId: string, candidate: Candidate | undefined, model: string | null, unknownPrice: boolean): UnpricedSpend | null;
  reservationFor(task: TaskRow, m: MemberRow, candidate: Candidate): number;
  capFor(taskId: string, runId: string | null, candidate: Candidate | undefined, addUsd?: number): SpendCap | null;
  pauseForCap(runId: string, cap: SpendCap, at: string): Promise<void>;
  onUsage(run: RunRow, task: TaskRow, ev: Extract<AgentEvent, { type: "usage.update" }>): Promise<void>;
  onLimitReached(runId: string, info: HandoffInfo): Promise<void>;
  nextTurn(runId: string): Promise<string | UserInput | null>;
  endRun(runId: string, reason: EndReason, detail: string | null): void;
  writePackage(task: TaskRow, source: RunRow, trigger: string, name: string): Promise<{ text: string; path: string; sha: string | null }>;
  pump(runId: string, live: Live): Promise<void>;
}

export class Launcher extends Part {
  private readonly creating = new Map<string, Promise<WorktreeRow>>();

  constructor(ctx: OrchestratorContext, private readonly deps: LauncherDeps) {
    super(ctx);
  }

  /**
   * Starts one run of a crew step. The run row goes in before any await, so admission control
   * counts it at once; a failure to start ends it as failed with a code.
   */
  async launch(spec: LaunchSpec): Promise<string> {
    const runId = this.insertRun(spec);
    await this.boot(runId, spec);
    return runId;
  }

  /** The run row of a launch, written before any await so admission control counts it at once. */
  insertRun(spec: LaunchSpec): string {
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
  async boot(runId: string, spec: LaunchSpec): Promise<void> {
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
      const pinned = !spec.cwd && PINNED_ROLES.includes(member.role) && task.kind === "code" && wt && existsSync(wt.path) ? await this.deps.reviewCheckout(runId, task, wt) : null;
      if (pinned) cwd = pinned.path;
      const worktreeId = wt && sameDir(wt.path, cwd) ? wt.id : null;
      this.db.exec("update runs set cwd = ?, worktree_id = ? where id = ?", cwd, worktreeId, runId);
      if (member.writes_code && worktreeId) this.db.exec("update worktrees set owner_run_id = ?, last_heartbeat_at = ? where id = ?", runId, this.iso(), worktreeId);

      const candidate = (await this.candidates(project)).find((c) => c.profile.id === target.profileId);
      if (!candidate) throw new OrchestratorError("crew.unknown_profile", { profileId: target.profileId });
      const adapter = this.adapters.get(target.runner);
      if (!adapter) throw new OrchestratorError("adapter.failed", { detail: "no_adapter" });
      // A capped task never starts on a model nobody can price without your click (feature scan F4).
      const unpriced = this.deps.unpricedFor(task, runId, candidate, target.model, estimateFor(candidate, this.tpl(member), task.size, this.now()).usd === null);
      if (unpriced) {
        this.held.set(runId, spec);
        await this.deps.onLimitReached(runId, { trigger: "unpriced", window: null, resetsAt: null, unpriced });
        return;
      }
      // Check and hold in one synchronous step, so a parallel step cannot slip in between (F3).
      const amount = candidate.profile.credential.kind === "api_key" ? this.deps.reservationFor(task, member, candidate) : 0;
      const cap = this.deps.capFor(task.id, runId, candidate, amount);
      if (cap) {
        this.held.set(runId, spec);
        await this.deps.pauseForCap(runId, cap, this.iso());
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
        nextTurn: () => this.deps.nextTurn(runId),
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
      this.deps.endRun(runId, "failed", problem ? `session.${problem}` : errorDetail(err, await this.secretsFor(target.profileId)));
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
    await this.deps.onUsage(run, this.db.task(run.task_id), {
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
  async replaceSession(failedRunId: string, problem: SessionProblem): Promise<void> {
    const failed = this.db.run(failedRunId);
    const task = this.db.task(failed.task_id);
    if (task.cancelled_at || this.db.successor(failed)) return;
    const pkg = await this.deps.writePackage(task, failed, `the previous session is ${problem === "locked" ? "locked by another process" : "gone"}`, `session-${failedRunId}`);
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
    this.track(this.deps.pump(runId, live).finally(finish));
  }

  /** Native resume on the same run; used after a pause and at a limit reset. */
  async continueRun(runId: string, text: string): Promise<void> {
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
      nextTurn: () => this.deps.nextTurn(runId),
      ...(await this.mcpFor(runId, task.id, project.id, policy, adapter)),
    };
    await this.turns.begin(runId);
    const handle = await adapter.resume({ runner: run.runner, sessionId: run.native_session_id }, req);
    for (const id of queued.ids) this.turns.queue.deliver(id, runId);
    this.db.exec("update runs set native_session_id = ?, pid = ? where id = ?", handle.nativeSession?.sessionId ?? run.native_session_id, handle.pid, runId);
    this.attach(runId, adapter, handle, candidate);
  }

  /** Continues a run however it can: a live turn, a native resume, or a first start if a cap held it. */
  async proceed(runId: string, text: string): Promise<void> {
    const spec = this.held.get(runId);
    if (spec && !this.live.has(runId)) {
      this.held.delete(runId);
      await this.boot(runId, { ...spec, task: this.db.task(spec.task.id) });
      return;
    }
    await this.continueRun(runId, text);
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
}

/** Roles that read a pinned, detached checkout of the commit they review instead of the live worktree. */
const PINNED_ROLES: RoleId[] = ["reviewer", "security"];
