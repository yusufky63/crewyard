import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HandoffStop, LoopDecisionKind, LoopDecisionView, Reason, ReviewVerdict, ReviewVerdictView, TaskLoopView, TestResultView, VerdictComment } from "@crewyard/core";

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
