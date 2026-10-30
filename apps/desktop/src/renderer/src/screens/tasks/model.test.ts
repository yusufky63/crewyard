import { describe, expect, it } from "vitest";
import { NO_RUN_CONTROLS, type CandidateView, type CrewMemberView, type LimitNoticePayload, type RequestView, type RunView, type TaskDetail } from "@crewyard/core";
import { canChooseHandoffStop, handoffsOf, currentRun, diffTotals, elapsedMs, filterCounts, formatDuration, limitBanner, loopLook, matchesFilter, resolveTarget, runnersOf, splitTaskText, statusLine, stepState } from "./model.ts";

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
    // The live run's 402 blob has no code: it goes on as text for the row to cut.
    expect(failedWith('API Error: 402 {"error":{"code":402}}')).toEqual({ reasonText: 'API Error: 402 {"error":{"code":402}}' });
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
