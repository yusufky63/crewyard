import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HandoffStop, LoopDecisionKind, LoopDecisionView, Reason, ReviewVerdict, ReviewVerdictView, TaskLoopView, TestResultView, VerdictComment, SpendCap } from "@crewyard/core";
import type { OrchestratorContext, LaunchSpec, Live } from "./context.ts";
import { Part } from "./part.ts";
import type { MemberRow, ProjectRow, RunRow, TaskRow, WorktreeRow } from "./db.ts";
import type { Candidate } from "./directory.ts";
import { errorCode, redactDetail } from "./errors.ts";
import { addDetachedCheckout, checkpoint, headSha, isClean, removeDetachedCheckout, sameDir } from "./git.ts";
import { snapshot } from "./checkpoints.ts";
import { runSteps } from "../worktrees/steps.ts";
import type { RoleResult } from "./results.ts";

// Crew-level loops (feature scan A9) and the records the handoff hardening keeps. After Implement
// the daemon runs the project's test command at the implementer's turn boundary; a failure goes
// back to the same session as its next turn. A reviewer's "changes" verdict goes back to the same
// implementer as a resumed run, after which Test and Review run again. Every decision is a row
// with its reason, so the timeline and the crew graph show why the loop went on or stopped.
// This module keeps the rows and the agent-facing text; the orchestrator decides when to act.

/** Kinds that count as one fix attempt against the step's iteration cap. */
const ATTEMPTS: LoopDecisionKind[] = ["tests_failed", "review_changes"];

interface DecisionRow {
  id: string;
  task_id: string;
  member_id: string;
  run_id: string | null;
  iteration: number;
  max_iterations: number;
  kind: LoopDecisionKind;
  reason: string;
  at: string;
}

export interface TestRow {
  id: string;
  task_id: string;
  member_id: string;
  run_id: string;
  command: string;
  exit_code: number | null;
  passed: number;
  tail: string;
  tree_sha: string | null;
  head_sha: string | null;
  duration_ms: number;
  at: string;
}

interface VerdictRow {
  run_id: string;
  task_id: string;
  member_id: string;
  verdict: "pass" | "changes";
  summary: string;
  comments: string;
  head_sha: string | null;
  native: number;
  at: string;
}

export interface CheckoutRow {
  run_id: string;
  task_id: string;
  repo_path: string;
  path: string;
  sha: string;
  created_at: string;
  removed_at: string | null;
}

export class LoopStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date,
  ) {}

  private one<T>(sql: string, ...args: Array<string | number | null>): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }

  private all<T>(sql: string, ...args: Array<string | number | null>): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }

  private exec(sql: string, ...args: Array<string | number | null>): void {
    this.db.prepare(sql).run(...args);
  }

  // ---- decisions

  decide(d: { taskId: string; memberId: string; runId: string | null; iteration: number; max: number; kind: LoopDecisionKind; reason: Reason }): LoopDecisionView {
    const row: DecisionRow = { id: randomUUID(), task_id: d.taskId, member_id: d.memberId, run_id: d.runId, iteration: d.iteration, max_iterations: d.max, kind: d.kind, reason: JSON.stringify(d.reason), at: this.now().toISOString() };
    this.exec(
      "insert into loop_decisions (id, task_id, member_id, run_id, iteration, max_iterations, kind, reason, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.id,
      row.task_id,
      row.member_id,
      row.run_id,
      row.iteration,
      row.max_iterations,
      row.kind,
      row.reason,
      row.at,
    );
    return decisionView(row);
  }

  /** Fix attempts the step has had: test failures and "changes" verdicts sent back to it. */
  attempts(memberId: string): number {
    const marks = ATTEMPTS.map(() => "?").join(", ");
    return Number(this.one<{ n: number }>(`select count(*) as n from loop_decisions where member_id = ? and kind in (${marks})`, memberId, ...ATTEMPTS)?.n ?? 0);
  }

  decided(runId: string, kind: LoopDecisionKind): boolean {
    return this.one("select 1 as x from loop_decisions where run_id = ? and kind = ?", runId, kind) !== undefined;
  }

  // ---- test results

  addTest(t: Omit<TestRow, "id" | "at">): TestRow {
    const row: TestRow = { ...t, id: randomUUID(), at: this.now().toISOString() };
    this.exec(
      "insert into test_results (id, task_id, member_id, run_id, command, exit_code, passed, tail, tree_sha, head_sha, duration_ms, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.id,
      row.task_id,
      row.member_id,
      row.run_id,
      row.command,
      row.exit_code,
      row.passed,
      row.tail,
      row.tree_sha,
      row.head_sha,
      row.duration_ms,
      row.at,
    );
    return row;
  }

  lastTest(memberId: string): TestRow | null {
    return this.one<TestRow>("select * from test_results where member_id = ? order by at desc, rowid desc limit 1", memberId) ?? null;
  }

  /** The newest test result of a task's writer steps, for the reviewer's context. */
  lastTaskTest(taskId: string): TestRow | null {
    return this.one<TestRow>("select * from test_results where task_id = ? order by at desc, rowid desc limit 1", taskId) ?? null;
  }

  /** The commit a run's last test result belongs to, once the daemon committed what was left. */
  pinTest(runId: string, headSha: string): void {
    this.exec("update test_results set head_sha = ? where id = (select id from test_results where run_id = ? order by at desc, rowid desc limit 1)", headSha, runId);
  }

  // ---- verdicts

  addVerdict(v: { runId: string; taskId: string; memberId: string; verdict: ReviewVerdict; headSha: string | null; native: boolean }): void {
    this.exec(
      "insert or replace into review_verdicts (run_id, task_id, member_id, verdict, summary, comments, head_sha, native, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      v.runId,
      v.taskId,
      v.memberId,
      v.verdict.verdict,
      v.verdict.summary,
      JSON.stringify(v.verdict.comments),
      v.headSha,
      v.native ? 1 : 0,
      this.now().toISOString(),
    );
  }

  verdict(runId: string): ReviewVerdictView | null {
    const row = this.one<VerdictRow>("select * from review_verdicts where run_id = ?", runId);
    return row ? verdictView(row, false) : null;
  }

  /** The member's verdict before this run, for a re-review's context. */
  previousVerdict(memberId: string, beforeRunId: string | null): ReviewVerdictView | null {
    const rows = this.all<VerdictRow>("select * from review_verdicts where member_id = ? order by at desc, rowid desc", memberId).filter((r) => r.run_id !== beforeRunId);
    return rows[0] ? verdictView(rows[0], false) : null;
  }

  /**
   * The newest verdict of the task's reviewer for exactly this commit. The merge and PR gates ask
   * this; a verdict for any other commit never counts, however recent.
   */
  verdictFor(taskId: string, headSha: string): ReviewVerdictView | null {
    const row = this.one<VerdictRow>("select * from review_verdicts where task_id = ? and head_sha = ? order by at desc, rowid desc limit 1", taskId, headSha);
    return row ? verdictView(row, false) : null;
  }

  latestVerdict(taskId: string): ReviewVerdictView | null {
    const row = this.one<VerdictRow>("select * from review_verdicts where task_id = ? order by at desc, rowid desc limit 1", taskId);
    return row ? verdictView(row, false) : null;
  }

  // ---- the task view

  view(taskId: string, maxIterations: number, writerStartedAfter: (at: string) => boolean): TaskLoopView {
    return {
      maxIterations,
      decisions: this.all<DecisionRow>("select * from loop_decisions where task_id = ? order by at, rowid", taskId).map(decisionView),
      tests: this.all<TestRow>("select * from test_results where task_id = ? order by at, rowid", taskId).map(testView),
      verdicts: this.all<VerdictRow>("select * from review_verdicts where task_id = ? order by at, rowid", taskId).map((r) => verdictView(r, writerStartedAfter(r.at))),
    };
  }

  // ---- run epochs (handoff fencing)

  /** A new run of a step joins the step's current epoch. */
  enlist(runId: string, memberId: string): void {
    this.exec("insert or ignore into run_epochs (run_id, member_id, epoch) values (?, ?, ?)", runId, memberId, this.stepEpoch(memberId));
  }

  stepEpoch(memberId: string): number {
    return this.one<{ epoch: number }>("select epoch from step_epochs where member_id = ?", memberId)?.epoch ?? 0;
  }

  /**
   * A handoff swapped the step's controller: the step moves to the next epoch and only the target
   * holds it. Whatever the source still sends after this is stale.
   */
  bump(memberId: string, controllerRunId: string): number {
    const next = this.stepEpoch(memberId) + 1;
    this.exec("insert into step_epochs (member_id, epoch) values (?, ?) on conflict(member_id) do update set epoch = excluded.epoch", memberId, next);
    this.exec("insert into run_epochs (run_id, member_id, epoch) values (?, ?, ?) on conflict(run_id) do update set epoch = excluded.epoch", controllerRunId, memberId, next);
    return next;
  }

  /** Runs from before this table existed have no row and are never fenced. */
  fenced(runId: string, memberId: string): boolean {
    const own = this.one<{ epoch: number }>("select epoch from run_epochs where run_id = ?", runId);
    return own !== undefined && own.epoch < this.stepEpoch(memberId);
  }

  // ---- review checkouts

  addCheckout(c: Omit<CheckoutRow, "created_at" | "removed_at">): void {
    this.exec(
      "insert or replace into review_checkouts (run_id, task_id, repo_path, path, sha, created_at, removed_at) values (?, ?, ?, ?, ?, ?, null)",
      c.run_id,
      c.task_id,
      c.repo_path,
      c.path,
      c.sha,
      this.now().toISOString(),
    );
  }

  checkout(runId: string): CheckoutRow | null {
    return this.one<CheckoutRow>("select * from review_checkouts where run_id = ?", runId) ?? null;
  }

  /** Checkouts not removed yet; another live run may still share the same folder. */
  openCheckouts(): CheckoutRow[] {
    return this.all<CheckoutRow>("select * from review_checkouts where removed_at is null");
  }

  checkoutRemoved(runId: string): void {
    this.exec("update review_checkouts set removed_at = ? where run_id = ?", this.now().toISOString(), runId);
  }

  // ---- handoff extras

  setHandoff(handoffId: string, stop: HandoffStop): void {
    this.exec("insert or ignore into handoff_extras (handoff_id, stop, forked) values (?, ?, 0)", handoffId, stop);
  }

  handoffStop(handoffId: string): HandoffStop {
    return this.one<{ stop: HandoffStop }>("select stop from handoff_extras where handoff_id = ?", handoffId)?.stop ?? "interrupt";
  }
}

const decisionView = (r: DecisionRow): LoopDecisionView => ({
  id: r.id,
  memberId: r.member_id,
  runId: r.run_id,
  iteration: r.iteration,
  maxIterations: r.max_iterations,
  kind: r.kind,
  reason: JSON.parse(r.reason) as Reason,
  at: r.at,
});

const testView = (r: TestRow): TestResultView => ({
  id: r.id,
  runId: r.run_id,
  command: r.command,
  exitCode: r.exit_code,
  passed: r.passed === 1,
  tail: r.tail,
  durationMs: r.duration_ms,
  headSha: r.head_sha,
  at: r.at,
});

const verdictView = (r: VerdictRow, stale: boolean): ReviewVerdictView => ({
  runId: r.run_id,
  memberId: r.member_id,
  verdict: r.verdict,
  summary: r.summary,
  comments: JSON.parse(r.comments) as VerdictComment[],
  headSha: r.head_sha,
  native: r.native === 1,
  stale,
  at: r.at,
});

// ---- agent-facing text (read by models, not UI copy, so English and not translated)

/** Longest test output the implementer gets back; the tail is where failures are reported. */
const FAILURE_TAIL_CHARS = 6_000;

export function testFailureMessage(p: { command: string; exitCode: number | null; timedOut: boolean; tail: string; attempt: number; max: number }): string {
  const tail = p.tail.length > FAILURE_TAIL_CHARS ? p.tail.slice(-FAILURE_TAIL_CHARS) : p.tail;
  return [
    `The project's test command failed after your last turn (fix attempt ${p.attempt} of ${p.max}).`,
    `Command: ${p.command}`,
    p.timedOut ? "It timed out." : `Exit code: ${p.exitCode ?? "none"}`,
    "Last lines of its output:",
    "<<<",
    tail || "(no output)",
    ">>>",
    "Fix the cause, commit your change, and end your turn. Do not skip, weaken or delete tests to make them pass.",
  ].join("\n");
}

export function reviewChangesMessage(p: { verdict: ReviewVerdictView; attempt: number; max: number }): string {
  const v = p.verdict;
  return [
    `The reviewer asked for changes to commit ${v.headSha ?? "(unknown)"} (fix attempt ${p.attempt} of ${p.max}).`,
    "Summary:",
    "<<<",
    v.summary,
    ">>>",
    ...(v.comments.length
      ? ["Comments:", ...v.comments.map((c, i) => `${i + 1}. [${c.severity}] ${c.file}${c.line !== null ? `:${c.line}` : ""}: ${c.body}`)]
      : ["(no line comments)"]),
    "",
    "Address every blocker and major comment, commit your change, and end your turn. The tests and the review run again after you.",
  ].join("\n");
}

/** Context a pinned reviewer gets on top of its role prompt. */
export function reviewContext(p: { sha: string; baseSha: string | null; branch: string | null; test: TestRow | null; previous: ReviewVerdictView | null }): string {
  const lines = [
    "",
    `You review commit ${p.sha}${p.branch ? ` of branch ${p.branch}` : ""}, checked out read-only in your working folder (a detached checkout; nothing you do here reaches the branch).`,
    p.baseSha ? `The changes to review are \`git diff ${p.baseSha} ${p.sha}\`.` : "Review the changes on this commit.",
  ];
  if (p.test) lines.push(p.test.passed ? `The project's test command \`${p.test.command}\` passed on this commit; you need not run it again.` : `The project's test command \`${p.test.command}\` did not pass on this commit.`);
  if (p.previous && p.previous.verdict === "changes") {
    lines.push(
      `The previous review (of ${p.previous.headSha ?? "an earlier commit"}) asked for changes; check each one was addressed:`,
      "<<<",
      p.previous.summary,
      ...p.previous.comments.map((c) => `- [${c.severity}] ${c.file}${c.line !== null ? `:${c.line}` : ""}: ${c.body}`),
      ">>>",
    );
  }
  return lines.join("\n");
}

// The loops as an orchestrator part: the Test step at an implementer's turn boundary, the pinned
// commit and checkout a reviewer reads, and a "changes" verdict going back to the implementer.

export interface LoopRunnerDeps {
  capFor(taskId: string, runId: string | null, candidate: Candidate | undefined): SpendCap | null;
  launch(spec: LaunchSpec): Promise<string>;
  /** Whether an Orchestra goal manages the task (TaskFlow.goalManaged): its docs work is merged by commit. */
  goalManaged(taskId: string): boolean;
}

export class LoopRunner extends Part {
  constructor(ctx: OrchestratorContext, private readonly deps: LoopRunnerDeps) {
    super(ctx);
  }

  /** A verdict may be stale once any writer of the task started after it: the head can have moved. */
  loopView(task: TaskRow) {
    const writers = this.db.runs(task.id).filter((r) => r.worktree_id !== null && this.db.member(r.member_id).writes_code === 1);
    const max = this.config(this.db.project(task.project_id)).config.loop.maxIterations;
    return this.loops.view(task.id, max, (at) => writers.some((r) => r.started_at > at));
  }

  private decide(memberId: string, taskId: string, runId: string | null, kind: LoopDecisionKind, reason: Reason, iteration: number, max: number): void {
    const d = this.loops.decide({ taskId, memberId, runId, iteration, max, kind, reason });
    this.audit(taskId, runId, "loop.decision", { decisionId: d.id, memberId, kind, reason, iteration, max });
    this.emitTask(taskId, "loop");
  }

  /**
   * The Test step at an implementer's turn boundary. Returns the failure as the next turn's text,
   * or null to let the run finish: the tests passed, the project has none, or a stop rule ended
   * the loop (then the run ends failed with the rule as its detail, never as completed).
   */
  async testGate(runId: string): Promise<string | null> {
    const run = this.db.run(runId);
    const task = this.db.task(run.task_id);
    const member = this.db.member(run.member_id);
    if (task.kind !== "code" || member.role !== "implementer" || !run.worktree_id) return null;
    const project = this.db.project(task.project_id);
    const { config } = this.config(project);
    const max = config.loop.maxIterations;
    const attempts = this.loops.attempts(member.id);
    const command = config.commands.test?.trim() || null;
    if (!command) {
      if (!this.loops.decided(runId, "tests_skipped")) this.decide(member.id, task.id, runId, "tests_skipped", { code: "loop.tests_skipped" }, attempts, max);
      return null;
    }
    const live = this.live.get(runId);
    // The agent is idle while its tests run: the stall rules must not read that as a hung turn,
    // and the turn boundary stays held, so a queued message waits for it instead of racing the tests.
    if (live) live.testing = true;
    try {
      return await this.runTests(runId, run, task, member, project, command, attempts, max, live);
    } finally {
      if (live) live.testing = false;
    }
  }

  private async runTests(runId: string, run: RunRow, task: TaskRow, member: MemberRow, project: ProjectRow, command: string, attempts: number, max: number, live: Live | undefined): Promise<string | null> {
    const tree = await snapshot(run.cwd, null, this.opts.gitBin).then((s) => s.tree).catch(() => null);
    const started = this.now().getTime();
    const res = await runSteps([{ command, timeoutSec: TEST_TIMEOUT_SEC }], run.cwd, { ...process.env, ...this.bootstrapEnv(run, project) });
    const tail = res.failure ? redactDetail(res.failure.tail, await this.secretsFor(run.profile_id)) : "";
    const previous = this.loops.lastTest(member.id);
    this.loops.addTest({ task_id: task.id, member_id: member.id, run_id: runId, command, exit_code: res.ok ? 0 : (res.failure?.code ?? null), passed: res.ok ? 1 : 0, tail, tree_sha: tree, head_sha: null, duration_ms: this.now().getTime() - started });
    if (res.ok) {
      this.decide(member.id, task.id, runId, "tests_passed", { code: "loop.tests_passed", params: { command } }, attempts, max);
      return null;
    }
    const now = this.db.run(runId);
    if (now.ended_at || now.paused_at || this.stopping.has(runId) || this.db.task(task.id).cancelled_at) return null;
    const stopWith = (kind: LoopDecisionKind, reason: Reason, detail: string): null => {
      this.decide(member.id, task.id, runId, kind, reason, attempts, max);
      this.loopFailed.set(runId, detail);
      return null;
    };
    // The same tree as the last failing try: the agent changed nothing, another try would not either.
    if (previous && previous.passed === 0 && tree !== null && previous.tree_sha === tree) return stopWith("stop_no_change", { code: "loop.no_change" }, "loop.no_change");
    if (attempts >= max) return stopWith("stop_iteration_cap", { code: "loop.iteration_cap", params: { max } }, "loop.iteration_cap");
    const cap = this.deps.capFor(task.id, runId, live?.candidate);
    if (cap) return stopWith("stop_spend_cap", { code: "loop.spend_cap", params: { cap: cap.kind } }, "loop.spend_cap");
    const exitCode = res.failure?.code ?? -1;
    this.decide(member.id, task.id, runId, "tests_failed", { code: "loop.tests_failed", params: { command, exitCode } }, attempts + 1, max);
    return testFailureMessage({ command, exitCode: res.failure?.code ?? null, timedOut: res.failure?.timedOut ?? false, tail, attempt: attempts + 1, max });
  }

  /**
   * An implementer finished: whatever it left uncommitted is committed, so the commit the reviewer
   * pins and the verdict names is exactly what was tested. A goal's docs step is committed the same
   * way: only commits reach the goal branch (docs/adr/0019), and its reviewer then reads exactly the
   * commit that gets merged. Docs tasks outside a goal keep their work in the worktree, as before.
   */
  async pinHead(runId: string): Promise<void> {
    const run = this.db.run(runId);
    const wt = run.worktree_id ? this.db.worktree(run.task_id) : null;
    if (!wt || wt.id !== run.worktree_id || this.db.member(run.member_id).writes_code !== 1) return;
    const kind = this.db.task(run.task_id).kind;
    if (kind !== "code" && !(kind === "docs" && this.deps.goalManaged(run.task_id))) return;
    try {
      if (await isClean(wt.path, this.opts.gitBin)) return;
      const res = await checkpoint(wt.path, `crewyard: commit what the ${run.role} left uncommitted`, this.opts.gitBin);
      if (res.committed) {
        this.loops.pinTest(runId, res.sha);
        this.audit(run.task_id, runId, "worktree.pinned", { sha: res.sha, skipped: res.skipped.length });
      }
    } catch (err) {
      this.audit(run.task_id, runId, "worktree.pin_failed", { code: errorCode(err) });
    }
  }

  /** The implementer step a reviewer's verdict goes back to: the writer it depends on. */
  private writerFor(member: MemberRow): MemberRow | null {
    const deps = JSON.parse(member.depends_on) as string[];
    return this.db.members(member.crew_id).find((m) => deps.includes(m.step) && m.writes_code === 1 && m.role === "implementer") ?? null;
  }

  /**
   * The review loop: a "changes" verdict goes back to the same implementer, as a native resume of
   * its session with the comments, and the same stage. Test and Review then run again (the
   * scheduler re-runs a step whose dependency finished again). A pass, an invalid result or a stop
   * rule ends the loop with a recorded decision.
   */
  async reviewLoop(reviewerRunId: string, result: RoleResult): Promise<void> {
    const run = this.db.run(reviewerRunId);
    const task = this.db.task(run.task_id);
    if (task.cancelled_at || task.kind !== "code") return;
    const writer = this.writerFor(this.db.member(run.member_id));
    if (!writer) return;
    const max = this.config(this.db.project(task.project_id)).config.loop.maxIterations;
    const attempts = this.loops.attempts(writer.id);
    if (result.kind === "invalid") {
      this.decide(writer.id, task.id, run.id, "review_invalid", { code: "loop.review_invalid", params: { error: result.error.slice(0, 200) } }, attempts, max);
      return;
    }
    if (result.kind !== "review") return;
    const verdict = this.loops.verdict(run.id);
    const sha = verdict?.headSha?.slice(0, 12) ?? "";
    if (!verdict || verdict.verdict === "pass") {
      this.decide(writer.id, task.id, run.id, "review_passed", { code: "loop.review_passed", params: { sha } }, attempts, max);
      return;
    }
    const stop = (kind: LoopDecisionKind, reason: Reason) => this.decide(writer.id, task.id, run.id, kind, reason, attempts, max);
    if (attempts >= max) return stop("stop_iteration_cap", { code: "loop.iteration_cap", params: { max } });
    const runs = this.db.runs(task.id);
    const last = runs.filter((r) => r.member_id === writer.id).at(-1);
    if (!last || last.end_reason !== "completed" || this.db.successor(last, runs)) return;
    const adapter = this.adapters.get(last.runner);
    // The comments belong to the session that wrote the code; it is never replaced on its own.
    if (!adapter?.capabilities.resume || !last.native_session_id) return stop("stop_no_resume", { code: "loop.no_resume", params: { runner: last.runner } });
    const cap = this.deps.capFor(task.id, null, await this.candidateFor(last));
    if (cap) return stop("stop_spend_cap", { code: "loop.spend_cap", params: { cap: cap.kind } });
    this.decide(writer.id, task.id, run.id, "review_changes", { code: "loop.review_changes", params: { comments: verdict.comments.length, sha } }, attempts + 1, max);
    await this.deps.launch({
      task,
      member: writer,
      target: { profileId: last.profile_id, runner: last.runner, model: last.model },
      cwd: last.cwd,
      prompt: reviewChangesMessage({ verdict, attempt: attempts + 1, max }),
      resumeRef: { runner: last.runner, sessionId: last.native_session_id },
      resumedFrom: last.id,
    });
  }

  /**
   * Pinned review: a detached checkout of the exact head the reviewer reads, next to the task
   * worktree. The implementer may change the worktree meanwhile; the verdict is stored with this sha.
   */
  async reviewCheckout(runId: string, task: TaskRow, wt: WorktreeRow): Promise<{ path: string; sha: string }> {
    const sha = await headSha(wt.path, this.opts.gitBin);
    const path = `${wt.path}.review-${sha.slice(0, 8)}`;
    await addDetachedCheckout(wt.repo_path, path, sha, this.opts.gitBin);
    this.loops.addCheckout({ run_id: runId, task_id: task.id, repo_path: wt.repo_path, path, sha });
    this.audit(task.id, runId, "review.checkout", { sha, path });
    return { path, sha };
  }

  /** Removes a run's review checkout once no other unfinished run reads the same folder. */
  async dropCheckout(runId: string): Promise<void> {
    const c = this.loops.checkout(runId);
    if (!c || c.removed_at) return;
    const shared = this.loops.openCheckouts().some((o) => o.run_id !== runId && sameDir(o.path, c.path) && !this.db.run(o.run_id).ended_at);
    if (shared) {
      this.loops.checkoutRemoved(runId);
      return;
    }
    try {
      await removeDetachedCheckout(c.repo_path, c.path, this.opts.gitBin);
      this.loops.checkoutRemoved(runId);
    } catch (err) {
      // A file held open keeps the folder; the next daemon start tries again.
      this.audit(c.task_id, runId, "review.checkout_kept", { code: errorCode(err) });
    }
  }
}

/** Longest the Test step may run the project's test command. */
const TEST_TIMEOUT_SEC = 900;
