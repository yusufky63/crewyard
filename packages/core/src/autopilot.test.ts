import { describe, expect, it } from "vitest";
import { AUTOPILOT_CAPS, AUTOPILOT_DEFAULT_LIMITS, AUTOPILOT_TOOL_DEFS, AUTOPILOT_TOOLS, basisMatch, budgetFits, failureKey, goalPlanFits, isAutopilotTool, parseAutopilotCall, parseAutopilotLimits, planningFits, repeatedFailure } from "./autopilot.ts";
import { GOAL_LIMITS } from "./goals.ts";

// Autopilot's pure rules (docs/adr/0017): which tools exist, how their arguments are checked, and
// the budget, basis and stop rules the daemon applies per call.

describe("autopilot tools", () => {
  it("lists the allowed task-flow tools and nothing outward-facing", () => {
    expect(AUTOPILOT_TOOL_DEFS.map((t) => t.name)).toEqual([...AUTOPILOT_TOOLS]);
    for (const outward of ["push", "create_pr", "merge", "merge_pr", "delete_worktree", "delete_branch", "answer_request", "approve_request", "continue_past_cap", "set_limits", "sign_in"]) {
      expect(isAutopilotTool(outward)).toBe(false);
      expect(parseAutopilotCall(outward, {})).toEqual({ ok: false, error: "unknown tool" });
    }
  });

  it("checks create_task: a draft, a basis of at least 8 characters, sources and a reason", () => {
    const ok = parseAutopilotCall("create_task", {
      title: "Find why the build is slow",
      kind: "research",
      acceptance_criteria: ["Which step is slowest?"],
      basis: "the build got slow",
      sources: [{ kind: "issue", ref: "#12 Slow build" }],
      reason: "You asked\nfor this.",
    });
    expect(ok).toMatchObject({ ok: true, value: { tool: "create_task", draft: { title: "Find why the build is slow", kind: "research", acceptance: ["Which step is slowest?"] }, basis: "the build got slow", sources: [{ kind: "issue", ref: "#12 Slow build" }], reason: "You asked for this." } });
    expect(parseAutopilotCall("create_task", { title: "x", kind: "code", basis: "short", reason: "r" })).toMatchObject({ ok: false, error: expect.stringContaining("at least 8") });
    expect(parseAutopilotCall("create_task", { title: "x", kind: "code", reason: "r" })).toMatchObject({ ok: false, error: "basis is required" });
    expect(parseAutopilotCall("create_task", { title: "x", kind: "code", basis: "please do it", reason: "" })).toMatchObject({ ok: false, error: "reason must not be empty" });
    expect(parseAutopilotCall("create_task", { title: "x", kind: "code", basis: "please do it", reason: "r", sources: [{ kind: "web", ref: "x" }] })).toMatchObject({ ok: false });
    expect(parseAutopilotCall("create_task", { title: "x", kind: "code", basis: "please do it", reason: "r", sources: Array.from({ length: 6 }, () => ({ kind: "file", ref: "a" })) })).toMatchObject({ ok: false, error: "at most 5 sources" });
    expect(parseAutopilotCall("create_task", { title: "x", kind: "code", basis: "please do it", reason: "x".repeat(501) })).toMatchObject({ ok: false, error: expect.stringContaining("limit is 500") });
  });

  it("checks task ids, edit fields and message size", () => {
    expect(parseAutopilotCall("approve_crew", { task_id: "../../x", reason: "r" })).toMatchObject({ ok: false });
    expect(parseAutopilotCall("approve_crew", { task_id: "6f1c-ab", reason: "fits" })).toEqual({ ok: true, value: { tool: "approve_crew", taskId: "6f1c-ab", reason: "fits" } });
    // The reads are the assistant's own tools now (docs/adr/0018), never gated on Autopilot.
    expect(parseAutopilotCall("read_task", { task_id: "t1" })).toEqual({ ok: false, error: "unknown tool" });
    expect(parseAutopilotCall("edit_task", { task_id: "t1", reason: "r" })).toMatchObject({ ok: false, error: expect.stringContaining("nothing to change") });
    expect(parseAutopilotCall("edit_task", { task_id: "t1", reason: "r", kind: "ops" })).toMatchObject({ ok: false });
    expect(parseAutopilotCall("edit_task", { task_id: "t1", reason: "r", title: "a\nb" })).toMatchObject({ ok: false, error: "title must be one line" });
    expect(parseAutopilotCall("edit_task", { task_id: "t1", reason: "r", description: "New text", acceptance_criteria: ["It works"] })).toEqual({
      ok: true,
      value: { tool: "edit_task", taskId: "t1", title: null, kind: null, text: { description: "New text", acceptance: ["It works"] }, reason: "r" },
    });
    expect(parseAutopilotCall("queue_message", { task_id: "t1", reason: "r", text: "x".repeat(4001) })).toMatchObject({ ok: false });
    expect(isAutopilotTool("list_tasks")).toBe(false);
  });
});

describe("autopilot limits", () => {
  it("keeps the base for missing fields, rounds, and refuses values out of bounds", () => {
    expect(parseAutopilotLimits({})).toEqual({ ok: true, value: AUTOPILOT_DEFAULT_LIMITS });
    expect(parseAutopilotLimits({ perTaskUsd: 0.505, tasksPerHour: 2.4 })).toEqual({ ok: true, value: { ...AUTOPILOT_DEFAULT_LIMITS, perTaskUsd: 0.51, tasksPerHour: 2 } });
    expect(parseAutopilotLimits({ perTaskUsd: 0 })).toMatchObject({ ok: false });
    expect(parseAutopilotLimits({ concurrent: 9 })).toMatchObject({ ok: false });
    expect(parseAutopilotLimits({ perTaskUsd: Number.NaN })).toMatchObject({ ok: false });
    expect(parseAutopilotLimits({ perTaskUsd: 6, perDayUsd: 5 })).toMatchObject({ ok: false, error: "perDayUsd must not be under perTaskUsd" });
    expect(parseAutopilotLimits("x")).toMatchObject({ ok: false });
  });
});

describe("autopilot budget", () => {
  const limits = { perTaskUsd: 1, perDayUsd: 5 };
  it("fits only a known estimate under both limits", () => {
    expect(budgetFits({ usd: 0.4, provenance: "estimated" }, limits, 0)).toBeNull();
    expect(budgetFits({ usd: 1, provenance: "estimated" }, limits, 4)).toBeNull();
    expect(budgetFits({ usd: null, provenance: "unknown" }, limits, 0)).toBe("estimate_unknown");
    expect(budgetFits({ usd: 0.1, provenance: "unknown" }, limits, 0)).toBe("estimate_unknown");
    expect(budgetFits({ usd: 1.01, provenance: "estimated" }, limits, 0)).toBe("over_task_limit");
    expect(budgetFits({ usd: 0.5, provenance: "estimated" }, limits, 4.6)).toBe("over_day_limit");
  });
});

describe("autopilot basis", () => {
  const messages = ["The Windows build got slow.\nPlease  find out why and fix it.", "Also look at CI."];
  it("matches a verbatim quote of your message, whitespace and case normalised", () => {
    expect(basisMatch("please find out why", messages)).toBe(0);
    expect(basisMatch("look at CI", messages)).toBe(1);
    expect(basisMatch("delete the repository", messages)).toBe(-1);
    expect(basisMatch("why", messages)).toBe(-1);
  });
});

describe("autopilot stop rule", () => {
  const now = new Date("2026-10-31T12:00:00Z");
  it("halts on the same failure twice inside 24 hours, ids and numbers aside", () => {
    expect(failureKey("Run 3f2a1b4c-0000-4000-8000-000000000001 failed after 12 s at C:\\work\\x.ts")).toBe(failureKey("Run 9e2a1b4c-1111-4000-8000-000000000002 failed after 30 s at C:\\other\\y.ts"));
    expect(repeatedFailure([{ detail: "adapter_error: exit 1", at: "2026-10-31T10:00:00Z" }, { detail: "adapter_error: exit 2", at: "2026-10-31T11:00:00Z" }], now)).toBe(true);
    expect(repeatedFailure([{ detail: "adapter_error", at: "2026-10-31T10:00:00Z" }, { detail: "process_gone", at: "2026-10-31T11:00:00Z" }], now)).toBe(false);
    expect(repeatedFailure([{ detail: "adapter_error", at: "2026-10-29T10:00:00Z" }, { detail: "adapter_error", at: "2026-10-31T11:00:00Z" }], now)).toBe(false);
  });
});

// Autopilot's goal tools (docs/adr/0022): Plan goal and Approve and start for goals it creates,
// under the same limits as its tasks.
describe("autopilot goal tools", () => {
  it("keeps its goal caps equal to the goal limits", () => {
    expect(AUTOPILOT_CAPS.goalTextBytes).toBe(GOAL_LIMITS.goalTextBytes);
    expect([AUTOPILOT_CAPS.maxParallelMin, AUTOPILOT_CAPS.maxParallelMax]).toEqual([GOAL_LIMITS.maxParallelMin, GOAL_LIMITS.maxParallelMax]);
    expect(AUTOPILOT_TOOLS).toEqual(expect.arrayContaining(["create_goal", "approve_goal_plan"]));
    for (const outward of ["replan_goal", "merge_goal", "push_goal", "stop_goal", "set_goal_limits", "answer_decision"]) expect(isAutopilotTool(outward)).toBe(false);
  });

  it("checks create_goal: the goal text, your words as basis, an optional planner and a reason", () => {
    expect(parseAutopilotCall("create_goal", { text: "Two-step sign-in‮ with docs", planner: " cheap ", basis: "add two-step sign-in", reason: "You asked\nfor it." })).toEqual({
      ok: true,
      value: { tool: "create_goal", text: "Two-step sign-in with docs", planner: "cheap", basis: "add two-step sign-in", sources: [], reason: "You asked for it." },
    });
    expect(parseAutopilotCall("create_goal", { basis: "add two-step sign-in", reason: "r" })).toMatchObject({ ok: false, error: "text is required" });
    expect(parseAutopilotCall("create_goal", { text: "x".repeat(AUTOPILOT_CAPS.goalTextBytes + 1), basis: "add two-step sign-in", reason: "r" })).toMatchObject({ ok: false, error: expect.stringContaining("the limit is") });
    expect(parseAutopilotCall("create_goal", { text: "Goal", basis: "short", reason: "r" })).toMatchObject({ ok: false, error: expect.stringContaining("at least 8") });
    expect(parseAutopilotCall("create_goal", { text: "Goal", basis: "add two-step sign-in" })).toMatchObject({ ok: false, error: "reason is required" });
  });

  it("checks approve_goal_plan: a goal id, an optional revision and max_parallel within the goal bounds", () => {
    expect(parseAutopilotCall("approve_goal_plan", { goal_id: "g-1", reason: "It fits." })).toEqual({ ok: true, value: { tool: "approve_goal_plan", goalId: "g-1", revision: null, maxParallel: null, reason: "It fits." } });
    expect(parseAutopilotCall("approve_goal_plan", { goal_id: "g-1", revision: 2, max_parallel: 1, reason: "r" })).toMatchObject({ ok: true, value: { revision: 2, maxParallel: 1 } });
    expect(parseAutopilotCall("approve_goal_plan", { goal_id: "../g", reason: "r" })).toMatchObject({ ok: false, error: expect.stringContaining("goal_id") });
    expect(parseAutopilotCall("approve_goal_plan", { goal_id: "g", revision: 0, reason: "r" })).toMatchObject({ ok: false });
    expect(parseAutopilotCall("approve_goal_plan", { goal_id: "g", max_parallel: 5, reason: "r" })).toMatchObject({ ok: false, error: expect.stringContaining("max_parallel") });
  });

  const est = (usd: number | null) => (usd === null ? { usd: null, provenance: "unknown" as const } : { usd, provenance: "estimated" as const });
  const limits = { ...AUTOPILOT_DEFAULT_LIMITS };
  const idle = { committedTodayUsd: 0, startedLastHour: 0, active: 0 };

  it("fits a planning run only with a known estimate whose ceiling fits what is left of the day", () => {
    expect(planningFits({ estimate: est(0.1), ceilingUsd: 0.3 }, limits, 0)).toBeNull();
    expect(planningFits({ estimate: est(null), ceilingUsd: 0.25 }, limits, 0)).toBe("estimate_unknown");
    expect(planningFits({ estimate: est(0.1), ceilingUsd: null }, limits, 0)).toBe("estimate_unknown");
    expect(planningFits({ estimate: est(0.1), ceilingUsd: 0.3 }, limits, 4.8)).toBe("over_day_limit");
    expect(planningFits({ estimate: est(0.1), ceilingUsd: 0.3 }, limits, 4.7)).toBeNull();
  });

  it("approves a plan with the known total as its budget and the smaller of 2 and the concurrency limit at once", () => {
    const fit = goalPlanFits({ tasks: [{ key: "api", estimate: est(0.4) }, { key: "ui", estimate: est(0.3) }], review: est(0.123) }, limits, idle, null);
    expect(fit).toEqual({ ok: true, budgetUsd: 0.83, maxParallel: 2 });
    expect(goalPlanFits({ tasks: [{ key: "a", estimate: est(0.2) }], review: null }, { ...limits, concurrent: 1 }, idle, null)).toEqual({ ok: true, budgetUsd: 0.2, maxParallel: 1 });
  });

  it("refuses a plan with an Unknown estimate, a task over the per-task limit, or a total over the day", () => {
    expect(goalPlanFits({ tasks: [], review: null }, limits, idle, null)).toEqual({ ok: false, code: "plan_not_ready", key: null });
    expect(goalPlanFits({ tasks: [{ key: "a", estimate: est(0.2) }, { key: "b", estimate: est(null) }], review: null }, limits, idle, null)).toEqual({ ok: false, code: "estimate_unknown", key: "b" });
    expect(goalPlanFits({ tasks: [{ key: "a", estimate: est(0.2) }], review: est(null) }, limits, idle, null)).toEqual({ ok: false, code: "estimate_unknown", key: "review" });
    expect(goalPlanFits({ tasks: [{ key: "a", estimate: est(1.2) }], review: null }, limits, idle, null)).toEqual({ ok: false, code: "over_task_limit", key: "a" });
    expect(goalPlanFits({ tasks: [{ key: "a", estimate: est(0.9) }, { key: "b", estimate: est(0.9) }], review: null }, limits, { ...idle, committedTodayUsd: 3.5 }, null)).toEqual({ ok: false, code: "over_day_limit", key: null });
    // Rounding the budget up to the cent must not push a share at the limit past it.
    expect(goalPlanFits({ tasks: [{ key: "a", estimate: est(0.999) }, { key: "b", estimate: est(0.0001) }], review: null }, { ...limits, perTaskUsd: 0.999 }, idle, null)).toMatchObject({ ok: false, code: "over_task_limit" });
  });

  it("counts a goal as one start per task, and keeps At once within the concurrency limit", () => {
    const four = { tasks: ["a", "b", "c", "d"].map((key) => ({ key, estimate: est(0.1) })), review: null };
    expect(goalPlanFits(four, limits, idle, null)).toMatchObject({ ok: true });
    expect(goalPlanFits(four, limits, { ...idle, startedLastHour: 1 }, null)).toEqual({ ok: false, code: "rate_started", key: null });
    expect(goalPlanFits(four, limits, idle, 3)).toEqual({ ok: false, code: "concurrent", key: null });
    expect(goalPlanFits(four, limits, { ...idle, active: 1 }, null)).toEqual({ ok: false, code: "concurrent", key: null });
    expect(goalPlanFits(four, limits, { ...idle, active: 1 }, 1)).toEqual({ ok: true, budgetUsd: 0.4, maxParallel: 1 });
  });
});
