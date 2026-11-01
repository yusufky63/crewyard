import { describe, expect, it } from "vitest";
import { NO_RUN_CONTROLS, type CandidateView, type CrewMemberView, type GoalSummary, type LimitNoticePayload, type RequestView, type RunView, type TaskDetail, type TaskGoalRef } from "@crewyard/core";
import { approvalRequest, cost, decision, goalDetail, goalTask, revision } from "./goalTestData.ts";
import {
  awaitingApproval,
  canChooseHandoffStop,
  handoffsOf,
  currentRun,
  diffTotals,
  elapsedMs,
  filterCounts,
  FILTERS,
  formatDuration,
  GOAL_FEED_PAGE,
  goalBucket,
  goalFolded,
  goalMatchesFilter,
  goalNeeds,
  goalNumber,
  goalRowStatus,
  goalSpendPct,
  goalStatusLine,
  goalTaskLine,
  holdTone,
  listOrder,
  haltKey,
  limitBanner,
  loopLook,
  matchesFilter,
  offersCrewProposal,
  planCost,
  reportsToAccept,
  resolveTarget,
  runnersOf,
  splitTaskText,
  statusLine,
  utf8Bytes,
  stepState,
  taskBucket,
  taskMatchesFilter,
} from "./model.ts";

const cand = (profileId: string, runner: CandidateView["runner"] = "codex"): CandidateView => ({
  profileId,
  alias: `${profileId}-alias`,
  runner,
  providerId: "openai",
  model: `${profileId}-model`,
  score: 1,
  headroom: { pct: null, window: null, provenance: "unknown" },
  estimate: { usd: 0, provenance: "estimated" },
  reasons: [],
});
const member = (id: string, role: CrewMemberView["role"], chosen: CandidateView, standby: CandidateView[] = []): CrewMemberView => ({ id, step: role, role, dependsOn: [], required: true, writesCode: role === "implementer", chosen, standby, reasons: [], edited: false, blockedBy: null });
const run = (id: string, memberId: string, over: Partial<RunView> = {}): RunView => ({
  id,
  taskId: "t",
  memberId,
  role: "implementer",
  profileId: "a",
  runner: "codex",
  model: null,
  state: "running",
  cwd: "C:\\x y",
  worktreeId: null,
  startedAt: "2026-10-30T10:00:00.000Z",
  endedAt: null,
  endReason: null,
  endDetail: null,
  lastActivityAt: null,
  pausedAt: null,
  resumeAt: null,
  limitReached: false,
  pendingRequestId: null,
  handoffId: null,
  resumedFrom: null,
  nativeSessionId: null,
  queuedMessages: 0,
  queue: [],
  controls: NO_RUN_CONTROLS,
  transcriptPath: null,
  tokensIn: 0,
  tokensOut: 0,
  cost: { usd: 0, provenance: "estimated" },
  plan: null,
  diff: null,
  ...over,
});
const task = (over: Partial<TaskDetail>): TaskDetail => ({
  id: "t",
  projectId: "p",
  title: "T",
  kind: "code",
  size: "M",
  status: "running",
  fallback: "ask",
  budgetUsd: null,
  spend: { usd: 0, provenance: "estimated" },
  createdAt: "2026-10-30T09:00:00.000Z",
  cancelledAt: null,
  openRequests: 0,
  activeRuns: 0,
  resumableRunIds: [],
  description: "",
  baseBranch: null,
  waitResetMinutes: 20,
  classification: [],
  crew: { id: "c", proposedAt: "", approvedAt: "", estimate: { usd: 0, provenance: "estimated" }, members: [member("m1", "planner", cand("a", "claude-code")), member("m2", "implementer", cand("a"), [cand("b", "opencode"), cand("c")])] },
  runs: [],
  worktree: null,
  handoffs: [],
  loop: { maxIterations: 3, decisions: [], tests: [], verdicts: [] },
  ...over,
});
const notice = (over: Partial<LimitNoticePayload>): LimitNoticePayload => ({ kind: "warn", profileId: "a", window: "5h", usedPct: 82, resetsAt: "2026-10-30T15:00:00.000Z", provenance: "reported", minutesUntilFull: null, runId: "r2", taskId: "t", observedAt: "2026-10-30T10:05:00.000Z", ...over });

describe("composer text", () => {
  it("uses the first line as the title and the rest as the description", () => {
    expect(splitTaskText("  Fix the login typo\nIt says 'pasword'.\n")).toEqual({ title: "Fix the login typo", description: "It says 'pasword'." });
    expect(splitTaskText("   ")).toEqual({ title: "", description: "" });
  });

  it("cuts one long paragraph at its first sentence and keeps all of it as the description", () => {
    const text = "Optimize unit pathfinding for 2,000 units. Keep the frame time under 16 ms on the benchmark map and add a regression test for the flow field.";
    const { title, description } = splitTaskText(text);
    expect(title).toBe("Optimize unit pathfinding for 2,000 units.");
    expect(description).toBe(text);
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    expect(splitTaskText(words).title.length).toBeLessThanOrEqual(120);
    expect(splitTaskText(words).title.endsWith(" ")).toBe(false);
  });
});

describe("filters", () => {
  it("keeps Ready for review, Merged and Done apart", () => {
    expect(matchesFilter("review", "done")).toBe(false);
    expect(matchesFilter("merged", "done")).toBe(false);
    expect(matchesFilter("limited", "needs_you")).toBe(true);
    expect(filterCounts([{ status: "running" }, { status: "queued" }, { status: "review" }, { status: "needs_input" }])).toEqual({ all: 4, running: 2, needs_you: 1, review: 1, merged: 0, done: 0 });
  });
});

describe("rows", () => {
  const runs = [
    run("r1", "m1", { state: "ended", endedAt: "2026-10-30T10:03:00.000Z", endReason: "completed", runner: "claude-code", diff: [{ path: "a.ts", added: 9, removed: 9 }] }),
    run("r2", "m2", { startedAt: "2026-10-30T10:03:00.000Z", diff: [{ path: "a.ts", added: 5, removed: 1 }, { path: "b.ts", added: 2, removed: 0 }] }),
  ];

  it("talks about the newest open run and measures from the first start", () => {
    const d = task({ runs });
    expect(currentRun(d)?.id).toBe("r2");
    expect(elapsedMs(d, Date.parse("2026-10-30T10:14:02.000Z"))).toBe(14 * 60_000 + 2_000);
    expect(elapsedMs(task({ runs: [runs[0]!] }), Date.parse("2026-10-30T12:00:00.000Z"))).toBe(3 * 60_000);
    expect(elapsedMs(task({}), 0)).toBeNull();
    expect([formatDuration(45_000), formatDuration(842_000), formatDuration(7_500_000)]).toEqual(["45s", "14m 02s", "2h 05m"]);
  });

  it("sums the latest diff per file and lists runners in order", () => {
    expect(diffTotals(task({ runs }))).toEqual({ files: 2, added: 7, removed: 1 });
    expect(diffTotals(task({}))).toBeNull();
    expect(runnersOf(task({ runs }))).toEqual(["claude-code", "codex"]);
    expect(runnersOf(task({}))).toEqual(["claude-code", "codex"]);
  });

  it("derives the status line from facts, with the detail that makes it useful", () => {
    expect(statusLine(task({ runs }), [])).toMatchObject({ key: "runningStep", tone: "run", icon: "spinner", params: { role: "implementer" } });
    const approval = { taskId: "t", runId: "r2", kind: "approval", answeredAt: null, payload: { kind: "approval" } } as unknown as RequestView;
    expect(statusLine(task({ status: "needs_input", runs }), [approval])).toMatchObject({ key: "needsApproval", tone: "wait", icon: "terminal" });
    const limited = [runs[0]!, run("r2", "m2", { limitReached: true, state: "rate_limited", resumeAt: "2026-10-30T16:40:00.000Z" })];
    expect(statusLine(task({ status: "limited", runs: limited }), [])).toMatchObject({ key: "limitedResets", tone: "bad", params: { time: "2026-10-30T16:40:00.000Z" } });
    const handoff = { id: "h", fromRunId: "r2", toRunId: null, targetProfileId: "b", mode: "ask", kind: null, stop: "interrupt", trigger: "limit", phase: "checkpoint", packagePath: null, checkpointSha: null, openedAt: "", closedAt: null, outcome: null, detail: null } as const;
    expect(statusLine(task({ status: "handing_off", runs, handoffs: [handoff] }), [])).toMatchObject({ key: "handingOffTo", params: { target: "b-alias" } });
    expect(statusLine(task({ status: "review" }), []).key).toBe("review");
    expect(statusLine(task({ status: "failed", runs: [run("r9", "m2", { endedAt: "x", endReason: "failed", endDetail: "stream_closed" })] }), [])).toMatchObject({ key: "failedBecause", params: { reason: "stream_closed" } });
  });

  it("translates the code of a failure and passes a runner's own text on as text", () => {
    const failedWith = (endDetail: string) => statusLine(task({ status: "failed", runs: [run("r9", "m2", { endedAt: "x", endReason: "failed", endDetail })] }), []).params;
    // A start failure keeps its code for the row; the redacted reason after it is for the inspector.
    expect(failedWith("adapter.failed: spawn opencode ENOENT")).toEqual({ reason: "adapter.failed" });
    // The live run's 402 blob has no code: the row gets its status and message, the tooltip the raw text.
    const raw = 'API Error: 402 {"error":{"code":402,"message":"Your prepayment credits are depleted.","status":"FAILED_PRECONDITION"}}';
    expect(failedWith(raw)).toEqual({ reasonText: "402 · Your prepayment credits are depleted.", reasonRaw: raw });
    // Text with no body we can read goes on as written.
    expect(failedWith("socket hang up")).toEqual({ reasonText: "socket hang up", reasonRaw: "socket hang up" });
  });

  it("names each step's state", () => {
    const m = member("m2", "implementer", cand("a"));
    expect(stepState(m, null)).toBe("waiting");
    expect(stepState({ ...m, blockedBy: { code: "admission.project_slots" } }, null)).toBe("blocked");
    expect(stepState(m, run("r", "m2", { state: "waiting_approval" }))).toBe("needs_you");
    expect(stepState(m, run("r", "m2", { state: "rate_limited" }))).toBe("limited");
    expect(stepState(m, run("r", "m2", { endedAt: "x", endReason: "stopped" }))).toBe("stopped");
  });

  it("resolves what the inspector shows", () => {
    const d = task({ runs });
    expect(resolveTarget(d, { taskId: "t" })).toMatchObject({ run: { id: "r2" }, memberId: "m2" });
    expect(resolveTarget(d, { taskId: "t", memberId: "m1" })).toMatchObject({ run: { id: "r1" }, memberId: "m1" });
    expect(resolveTarget(d, { taskId: "t", runId: "r1" })).toMatchObject({ run: { id: "r1" }, memberId: "m1" });
    expect(resolveTarget(task({}), { taskId: "t" })).toEqual({ run: null, memberId: "m1" });
  });
});

describe("handoff stop", () => {
  it("offers finishing the turn only while a turn is under way", () => {
    for (const state of ["running", "waiting_input", "waiting_approval"] as const) expect(canChooseHandoffStop({ state })).toBe(true);
    for (const state of ["starting", "paused", "rate_limited", "handing_off", "ended"] as const) expect(canChooseHandoffStop({ state })).toBe(false);
  });
  it("lists a run's handoffs both ways, newest first", () => {
    const h = (id: string, fromRunId: string, toRunId: string | null, openedAt: string) =>
      ({ id, fromRunId, toRunId, targetProfileId: "b", mode: "ask", kind: "fork", stop: "drain", trigger: "manual", phase: "closed", packagePath: null, checkpointSha: null, openedAt, closedAt: null, outcome: null, detail: null }) as const;
    const all = [h("a", "r1", "r2", "2026-10-30T10:00:00.000Z"), h("b", "r2", "r3", "2026-10-30T11:00:00.000Z"), h("c", "r9", null, "2026-10-30T12:00:00.000Z")];
    expect(handoffsOf(all, "r2").map((x) => x.id)).toEqual(["b", "a"]);
    expect(handoffsOf(all, "r5")).toEqual([]);
  });
});

describe("loop decisions", () => {
  it("never shows a try sent back or a stop as passed", () => {
    expect(loopLook("tests_passed")).toEqual({ icon: "check", tone: "ok" });
    expect(loopLook("review_passed").tone).toBe("ok");
    expect(loopLook("tests_skipped").tone).toBe("muted");
    for (const k of ["tests_failed", "review_changes", "review_invalid", "stop_iteration_cap", "stop_no_change", "stop_spend_cap", "stop_no_resume"] as const) expect(loopLook(k).tone).toBe("bad");
    expect(loopLook("stop_spend_cap").icon).toBe("gauge");
  });
});

describe("limit banner", () => {
  const live = [run("r2", "m2")];

  it("shows a reached limit first, with the first standby that is not the run's own account", () => {
    const d = task({ runs: [run("r2", "m2", { limitReached: true, resumeAt: "2026-10-30T16:40:00.000Z" })] });
    expect(limitBanner(d, [])).toMatchObject({ kind: "reached", runId: "r2", resetsAt: "2026-10-30T16:40:00.000Z", target: { profileId: "b" } });
  });

  it("picks the strongest live notice for an open run and ignores ended runs and context hand offs", () => {
    expect(limitBanner(task({ runs: live }), [notice({}), notice({ kind: "critical", usedPct: 96 }), notice({ kind: "ahead_of_pace", minutesUntilFull: 25 })])).toMatchObject({ kind: "critical", usedPct: 96 });
    expect(limitBanner(task({ runs: [run("r2", "m2", { endedAt: "x", endReason: "completed" })] }), [notice({})])).toBeNull();
    expect(limitBanner(task({ runs: live }), [notice({ window: "context" })])).toMatchObject({ kind: "warn", target: null });
    // An account-wide notice (no run) still applies to the open run on that account.
    expect(limitBanner(task({ runs: live }), [notice({ runId: null })])).toMatchObject({ runId: "r2" });
    expect(limitBanner(task({ runs: live }), [])).toBeNull();
  });
});

// ---------------------------------------------------------------- Orchestra goals (docs/adr/0019)

const ref = (over: Partial<TaskGoalRef> = {}): TaskGoalRef => ({ goalId: "g1", key: "k3", number: 3, waiting: false, hold: null, joined: false, hidden: false, role: "task", ...over });
const goalSummary = (status: GoalSummary["status"], over: Partial<GoalSummary> = {}): Pick<GoalSummary, "status" | "outcome" | "reason" | "done" | "total"> => ({ status, outcome: null, reason: null, done: 1, total: 4, ...over });

describe("goal filters", () => {
  it("never counts a waiting goal task under Needs you, and counts the goal once in its own filter", () => {
    // A plan of eight accepted, unreleased tasks derives as `proposed`, which alone reads Needs you.
    const waiting = Array.from({ length: 8 }, (_, i) => ({ status: "proposed" as const, goal: ref({ number: i + 1, waiting: true, hold: { code: "goal.waits_finish" as const, params: { task: "01" } } }) }));
    const counts = filterCounts(waiting, [goalSummary("running")]);
    expect(counts.needs_you).toBe(0);
    expect(counts.running).toBe(1);
    expect(counts.all).toBe(9);
  });

  it("never counts goal tasks on their own under Ready for review, Merged or Done; the goal counts there", () => {
    const tasks = [
      { status: "review" as const, goal: ref({ joined: true }) },
      { status: "done" as const, goal: ref({ number: 1 }) },
      { status: "failed" as const, goal: ref({ number: 2 }) },
    ];
    expect(filterCounts(tasks, [goalSummary("ready_for_review")])).toEqual({ all: 4, running: 0, needs_you: 0, review: 1, merged: 0, done: 0 });
    expect(filterCounts([], [goalSummary("finished", { outcome: "merged" }), goalSummary("finished", { outcome: "done" })])).toMatchObject({ merged: 1, done: 1 });
  });

  it("still counts a goal task with an Inbox request under Needs you, next to its goal", () => {
    const tasks = [{ status: "needs_input" as const, goal: ref() }, { status: "limited" as const, goal: ref({ number: 4 }) }];
    expect(filterCounts(tasks, [goalSummary("needs_you", { reason: "request" })]).needs_you).toBe(3);
    expect(taskMatchesFilter(tasks[0]!, "needs_you")).toBe(true);
  });

  it("hides planning, last review, discarded and unapproved goal tasks from every filter", () => {
    const hidden = { status: "running" as const, goal: ref({ hidden: true, role: "planning" }) };
    expect(taskBucket(hidden)).toBeNull();
    for (const f of FILTERS) expect(taskMatchesFilter(hidden, f)).toBe(false);
    expect(filterCounts([hidden]).all).toBe(0);
  });

  it("puts each goal status in its filter; paused, stopped and collapsed show only under All", () => {
    expect(goalBucket({ status: "planning", outcome: null })).toBe("running");
    expect(goalBucket({ status: "needs_you", outcome: null })).toBe("needs_you");
    expect(goalBucket({ status: "ready_for_review", outcome: null })).toBe("review");
    expect(goalBucket({ status: "paused", outcome: null })).toBe("other");
    expect(goalBucket({ status: "stopped", outcome: null })).toBe("other");
    expect(goalBucket({ status: "finished", outcome: "collapsed" })).toBe("other");
    expect(goalMatchesFilter({ status: "paused", outcome: null }, "all")).toBe(true);
    expect(goalMatchesFilter({ status: "paused", outcome: null }, "running")).toBe(false);
  });

  it("leaves tasks without a goal as they were", () => {
    expect(taskBucket({ status: "proposed" })).toBe("needs_you");
    expect(taskBucket({ status: "cancelled", goal: null })).toBe("other");
  });

  it("never offers a goal task for crew approval", () => {
    const base = { projectId: "p", title: "x", kind: "code" as const, size: "M" as const, status: "proposed" as const, fallback: "ask" as const, budgetUsd: null, spend: { usd: 0, provenance: "estimated" as const }, createdAt: "", cancelledAt: null, openRequests: 0, activeRuns: 0, resumableRunIds: [] };
    expect(awaitingApproval([{ ...base, id: "a" }, { ...base, id: "b", goal: ref({ waiting: true }) }]).map((x) => x.id)).toEqual(["a"]);
  });
});

describe("list order", () => {
  it("puts what needs you first, then what runs, then review, then the rest, newest first inside each, goals and tasks together", () => {
    const g = (id: string, status: GoalSummary["status"], createdAt: string, outcome: GoalSummary["outcome"] = null) => ({ id, status, outcome, createdAt });
    const t = (id: string, status: TaskSummary["status"], createdAt: string) => ({ id, status, goal: null, createdAt });
    const rows = listOrder(
      [g("g-done", "finished", "2026-10-31T12:00:00Z", "merged"), g("g-run", "running", "2026-10-31T09:00:00Z"), g("g-plan", "needs_you", "2026-10-31T08:00:00Z"), g("g-planning", "planning", "2026-10-31T11:00:00Z"), g("g-stopped", "stopped", "2026-10-31T13:00:00Z")],
      [t("t-failed", "failed", "2026-10-31T10:00:00Z"), t("t-proposed", "proposed", "2026-10-31T07:00:00Z"), t("t-run", "running", "2026-10-31T10:30:00Z"), t("t-review", "review", "2026-10-31T06:00:00Z"), t("t-done", "done", "2026-10-31T14:00:00Z")],
    );
    expect(rows.map((r) => (r.kind === "goal" ? r.goal.id : r.task.id))).toEqual(["t-failed", "g-plan", "t-proposed", "g-planning", "t-run", "g-run", "t-review", "t-done", "g-stopped", "g-done"]);
  });
});

describe("goal status labels", () => {
  it("has seven states with their icon and color, and never shows Ready for review as merged", () => {
    expect(goalStatusLine(goalSummary("planning"))).toMatchObject({ key: "planning", tone: "run", icon: "spinner" });
    expect(goalStatusLine(goalSummary("needs_you", { reason: "stuck" }))).toMatchObject({ key: "needsYou", tone: "wait", icon: "question", reason: "stuck" });
    expect(goalStatusLine(goalSummary("running", { done: 2, total: 4 }))).toMatchObject({ key: "running", tone: "run", done: 2, total: 4 });
    expect(goalStatusLine(goalSummary("paused"))).toMatchObject({ key: "paused", tone: "muted", icon: "pause" });
    expect(goalStatusLine(goalSummary("ready_for_review"))).toMatchObject({ key: "ready", tone: "ok", icon: "check" });
    expect(goalStatusLine(goalSummary("finished", { outcome: "merged" }))).toMatchObject({ key: "merged", tone: "ink", icon: "pr" });
    expect(goalStatusLine(goalSummary("finished", { outcome: "done" }))).toMatchObject({ key: "done", tone: "ok", icon: "check" });
    expect(goalStatusLine(goalSummary("stopped"))).toMatchObject({ key: "stopped", tone: "muted", icon: "square" });
    expect(goalStatusLine(goalSummary("ready_for_review")).key).not.toBe("merged");
  });

  it("folds finished and stopped goals only", () => {
    expect(goalFolded({ status: "finished" })).toBe(true);
    expect(goalFolded({ status: "stopped" })).toBe(true);
    expect(goalFolded({ status: "running" })).toBe(false);
  });

  it("measures spend against the budget and says Unknown without a number", () => {
    expect(goalSpendPct({ spend: cost(1.5, "reported"), budgetUsd: 3 })).toBe(50);
    expect(goalSpendPct({ spend: cost(9, "reported"), budgetUsd: 3 })).toBe(100);
    expect(goalSpendPct({ spend: cost(null, "unknown"), budgetUsd: 3 })).toBeNull();
    expect(goalSpendPct({ spend: cost(1), budgetUsd: null })).toBeNull();
  });

  it("numbers goal tasks with two digits", () => {
    expect(goalNumber(2)).toBe("02");
    expect(goalNumber(12)).toBe("12");
  });
});

describe("goal task lines", () => {
  it("says why an unreleased task waits, and never Waiting for approval", () => {
    const hold = { code: "goal.waits_report" as const, params: { task: "01", taskId: "t1" } };
    expect(goalTaskLine(goalTask(3, { released: false, status: "proposed", hold }))).toMatchObject({ key: "hold", tone: "wait", hold });
    expect(goalTaskLine(goalTask(3, { released: false, status: "proposed" }))).toMatchObject({ key: "waiting", tone: "ink" });
    expect(goalTaskLine(goalTask(3, { released: false, status: "proposed" }), { paused: true })).toMatchObject({ key: "goalPaused", icon: "pause" });
  });

  it("keeps the warning color for holds only you can lift, and plain ink for orderings that clear by themselves", () => {
    const line = (code: string) => goalTaskLine(goalTask(3, { released: false, status: "proposed", hold: { code, params: { task: "02", taskId: "t2" } } as never })).tone;
    for (const code of ["goal.waits_report", "goal.prereq_failed", "goal.prereq_cancelled", "goal.conflict", "goal.halted", "goal.error"]) expect(line(code)).toBe("wait");
    for (const code of ["goal.waits_finish", "goal.waits_overlap", "goal.waits_join", "goal.parallel_cap"]) expect(line(code)).toBe("ink");
    expect(line("goal.paused")).toBe("muted");
    expect(holdTone({ code: "goal.paused_all" })).toBe("muted");
    expect(goalTaskLine(goalTask(2, { status: "queued" as never, released: true })).tone).toBe("ink");
  });

  it("reads In goal branch once merged, and a finished writer waits to be merged instead of Ready for review", () => {
    expect(goalTaskLine(goalTask(2, { status: "review", joined: { sha: "abc", at: "x" } }))).toMatchObject({ key: "inGoalBranch", tone: "ok" });
    expect(goalTaskLine(goalTask(2, { status: "review" }))).toMatchObject({ key: "awaitingJoin", tone: "ink" });
  });

  it("marks a finished report that writing tasks wait on until you accept it", () => {
    const research = goalTask(1, { writes: false, status: "done" });
    expect(goalTaskLine(research, { feedsWriter: true })).toMatchObject({ key: "reportWaits" });
    expect(goalTaskLine(research)).toMatchObject({ key: "done" });
    expect(goalTaskLine({ ...research, reportAcceptedAt: "x" }, { feedsWriter: true })).toMatchObject({ key: "reportAccepted" });
  });

  it("shows skipped, unapproved, failed, cancelled and request states", () => {
    expect(goalTaskLine(goalTask(4, { accepted: false }))).toMatchObject({ key: "skipped", tone: "muted" });
    expect(goalTaskLine(goalTask(4, { accepted: null, released: false }))).toMatchObject({ key: "notApproved" });
    expect(goalTaskLine(goalTask(2, { status: "failed" }))).toMatchObject({ key: "failed", tone: "bad" });
    expect(goalTaskLine(goalTask(2, { status: "cancelled" }))).toMatchObject({ key: "cancelled" });
    expect(goalTaskLine(goalTask(2, { status: "needs_input" }), { pending: "approval" })).toMatchObject({ key: "needsApproval", icon: "terminal" });
    expect(goalTaskLine(goalTask(2, { status: "needs_input" }))).toMatchObject({ key: "needsAnswer" });
    expect(goalTaskLine(goalTask(2, { status: "limited" }))).toMatchObject({ key: "limited", tone: "bad" });
  });

  it("gives a goal task's own row its hold or goal-branch line, and nothing else", () => {
    expect(goalRowStatus(ref({ waiting: true, hold: { code: "goal.waits_finish", params: { task: "02" } } }), "proposed")).toMatchObject({ key: "hold" });
    expect(goalRowStatus(ref({ joined: true }), "review")).toMatchObject({ key: "inGoalBranch" });
    expect(goalRowStatus(ref(), "running")).toBeNull();
    expect(goalRowStatus(null, "proposed")).toBeNull();
    expect(goalRowStatus(ref({ hidden: true, waiting: true }), "proposed")).toBeNull();
  });
});

describe("goal needs you", () => {
  it("lists a plan to review, open decisions, requests, reports, failed tasks, halt, stuck and empty, in that order", () => {
    const g = goalDetail({
      status: "needs_you",
      reason: "stuck",
      revisions: [revision(), revision({ id: "r2", revision: 2, cause: "replan", state: "ready", approvedAt: null })],
      decisions: [decision({ id: "d1", kind: "conflict", taskId: "t2", actions: ["send_to_implementer", "merge_myself", "check_again", "leave_out"] }), decision({ id: "d0", answeredAt: "x", answer: "resume" })],
      tasks: [goalTask(1, { writes: false, status: "done" }), goalTask(2, { status: "failed" }), goalTask(3, { status: "failed", dependsOn: [{ taskId: "t1", key: "k1", source: "plan" }] })],
      halted: { reason: "failed_tasks", at: "x" },
    });
    const needs = goalNeeds(g, [approvalRequest("t3"), approvalRequest("other-task"), approvalRequest("t2", { id: "answered", answeredAt: "x" })]);
    expect(needs.map((n) => n.kind)).toEqual(["plan", "decision", "request", "report", "failed", "halted", "stuck"]);
    // 02's failure is already a decision; only 03's shows on its own.
    expect(needs.find((n) => n.kind === "failed")).toEqual({ kind: "failed", taskId: "t3" });
  });

  it("does not repeat what an open decision says, and a stopped goal needs nothing", () => {
    const g = goalDetail({ status: "needs_you", reason: "stuck", halted: { reason: "same_failure", at: "x" }, decisions: [decision(), decision({ id: "d2", kind: "stuck", actions: ["retry", "replan", "run_without", "stop"] })] });
    expect(goalNeeds(g, []).map((n) => n.kind)).toEqual(["decision", "decision"]);
    expect(goalNeeds({ ...g, status: "stopped" }, [approvalRequest("t2")])).toEqual([]);
  });

  it("still says a halt once its stop-rule decision is answered, as long as the goal stays halted", () => {
    const g = goalDetail({ status: "needs_you", reason: "halted", halted: { reason: "same_failure", at: "x" }, decisions: [decision({ answeredAt: "x", answer: "replan" })] });
    expect(goalNeeds(g, [])).toEqual([{ kind: "halted", reason: "same_failure" }]);
  });

  it("asks for a report only when a writing task waits for it, until you accept it", () => {
    const tasks = [goalTask(1, { writes: false, status: "done" }), goalTask(2, { released: false, status: "proposed", dependsOn: [{ taskId: "t1", key: "k1", source: "plan" }] }), goalTask(4, { writes: false, status: "done" })];
    expect(reportsToAccept(tasks)).toEqual(["t1"]);
    expect(reportsToAccept([{ ...tasks[0]!, reportAcceptedAt: "x" }, tasks[1]!])).toEqual([]);
    expect(reportsToAccept([tasks[0]!, { ...tasks[1]!, accepted: false }])).toEqual([]);
  });
});

describe("goal tasks in the Tasks screen", () => {
  it("never opens a crew proposal with Approve for a waiting goal task", () => {
    const waiting: TaskGoalRef = { goalId: "g1", key: "k3", number: 3, waiting: true, hold: null, joined: false, hidden: false };
    expect(offersCrewProposal({ status: "proposed", goal: null })).toBe(true);
    expect(offersCrewProposal({ status: "proposed", goal: waiting })).toBe(false);
    expect(offersCrewProposal({ status: "running", goal: null })).toBe(false);
    expect(offersCrewProposal(undefined)).toBe(false);
  });
});

describe("goal costs, caps and words", () => {
  it("states a planning run's estimate with its ceiling, no API cost for $0, and Unknown never as a number", () => {
    expect(planCost(cost(0.31), 0.93)).toEqual({ key: "estimateUpTo", usd: 0.31, ceiling: 0.93 });
    expect(planCost(cost(0.31), null)).toEqual({ key: "estimate", usd: 0.31, ceiling: null });
    expect(planCost(cost(0), 0.25)).toEqual({ key: "noApiCost", usd: 0, ceiling: null });
    expect(planCost(cost(null, "unknown"), 0.75)).toEqual({ key: "unknownUpTo", usd: null, ceiling: 0.75 });
    expect(planCost(cost(null, "unknown"), 0)).toEqual({ key: "unknown", usd: null, ceiling: null });
  });

  it("counts goal text caps in UTF-8 bytes, as the daemon does", () => {
    expect(utf8Bytes("abc")).toBe(3);
    // Sixty Turkish letters fit a 120-character field but are 120 bytes; one more is over.
    expect(utf8Bytes("ş".repeat(60))).toBe(120);
    expect(utf8Bytes("ş".repeat(61))).toBeGreaterThan(120);
  });

  it("reads a halt's stored rule code as words, with a line for codes it does not know", () => {
    expect(haltKey("same_failure")).toBe("same_failure");
    expect(haltKey("failed_tasks")).toBe("failed_tasks");
    expect(haltKey("budget")).toBe("other");
  });

  it("pages the goal feed by 40", () => {
    expect(GOAL_FEED_PAGE).toBe(40);
  });
});
