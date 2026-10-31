import { describe, expect, it } from "vitest";
import { AUTOPILOT_DEFAULT_LIMITS, AUTOPILOT_TOOL_DEFS, AUTOPILOT_TOOLS, basisMatch, budgetFits, failureKey, isAutopilotTool, parseAutopilotCall, parseAutopilotLimits, repeatedFailure } from "./autopilot.ts";

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
    expect(parseAutopilotCall("read_task", { task_id: "t1" })).toEqual({ ok: true, value: { tool: "read_task", taskId: "t1" } });
    expect(parseAutopilotCall("edit_task", { task_id: "t1", reason: "r" })).toMatchObject({ ok: false, error: expect.stringContaining("nothing to change") });
    expect(parseAutopilotCall("edit_task", { task_id: "t1", reason: "r", kind: "ops" })).toMatchObject({ ok: false });
    expect(parseAutopilotCall("edit_task", { task_id: "t1", reason: "r", title: "a\nb" })).toMatchObject({ ok: false, error: "title must be one line" });
    expect(parseAutopilotCall("edit_task", { task_id: "t1", reason: "r", description: "New text", acceptance_criteria: ["It works"] })).toEqual({
      ok: true,
      value: { tool: "edit_task", taskId: "t1", title: null, kind: null, text: { description: "New text", acceptance: ["It works"] }, reason: "r" },
    });
    expect(parseAutopilotCall("queue_message", { task_id: "t1", reason: "r", text: "x".repeat(4001) })).toMatchObject({ ok: false });
    expect(parseAutopilotCall("list_tasks", undefined)).toEqual({ ok: true, value: { tool: "list_tasks" } });
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
