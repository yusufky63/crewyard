import { describe, expect, it } from "vitest";
import {
  ASSISTANT_DRAFT_TOOLS,
  ASSISTANT_EXTRA_TOOL_DEFS,
  ASSISTANT_EXTRA_TOOLS,
  ASSISTANT_TOOL_CAPS,
  fitResult,
  goalDraftSubject,
  isAssistantExtraTool,
  isOwnToolTitle,
  parseAssistantToolCall,
  parseToolLineId,
  TASK_STATUS_FILTERS,
  toolLineCall,
  toolLineId,
  toolLineText,
} from "./assistant-tools.ts";
import { AUTOPILOT_TOOLS } from "./autopilot.ts";
import { utf8Length } from "./event-caps.ts";
import { GOAL_LIMITS } from "./goals.ts";
import { REPORT_TOOL_DEFS } from "./mcp.ts";

// The assistant's read and own-draft tools (docs/adr/0018): which exist, how their arguments are
// checked, how results are kept under the cap, and how their tool lines read.

describe("assistant read tools", () => {
  it("lists every tool once, none outward-facing, none shared with Autopilot or crew runs", () => {
    expect(ASSISTANT_EXTRA_TOOL_DEFS.map((t) => t.name)).toEqual([...ASSISTANT_EXTRA_TOOLS]);
    for (const t of ASSISTANT_EXTRA_TOOLS) {
      expect((AUTOPILOT_TOOLS as readonly string[]).includes(t)).toBe(false);
      expect(REPORT_TOOL_DEFS.map((d) => d.name as string)).not.toContain(t);
    }
    for (const outward of ["push", "merge_pr", "answer_request", "approve_crew", "start_run", "write_file", "run_command", "fetch_url"]) expect(isAssistantExtraTool(outward)).toBe(false);
    for (const d of ASSISTANT_EXTRA_TOOL_DEFS) {
      expect(d.annotations.openWorldHint).toBe(false);
      expect(d.annotations.destructiveHint).toBe(false);
      expect(d.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("checks ids, numbers and unknown arguments", () => {
    expect(parseAssistantToolCall("read_task", { task_id: "t-1" })).toEqual({ ok: true, value: { tool: "read_task", taskId: "t-1" } });
    expect(parseAssistantToolCall("read_task", {})).toEqual({ ok: false, error: "task_id is required" });
    expect(parseAssistantToolCall("read_task", { task_id: "../etc/passwd" })).toMatchObject({ ok: false });
    expect(parseAssistantToolCall("read_task", { task_id: "t1", extra: 1 })).toEqual({ ok: false, error: "unknown argument extra" });
    expect(parseAssistantToolCall("list_tasks", undefined)).toEqual({ ok: true, value: { tool: "list_tasks", status: null } });
    expect(parseAssistantToolCall("list_tasks", { status: "Running; drop" })).toMatchObject({ ok: false });
    // Only a real status: a typo is refused instead of quietly listing nothing.
    expect(parseAssistantToolCall("list_tasks", { status: "in_review" })).toMatchObject({ ok: false, error: expect.stringContaining("needs_input") });
    expect(parseAssistantToolCall("list_tasks", { status: "needs_input" })).toEqual({ ok: true, value: { tool: "list_tasks", status: "needs_input" } });
    expect(parseAssistantToolCall("list_tasks", { status: null })).toEqual({ ok: true, value: { tool: "list_tasks", status: null } });
    expect(TASK_STATUS_FILTERS).toHaveLength(11);
    expect(parseAssistantToolCall("read_events", {})).toEqual({ ok: false, error: "give task_id or run_id" });
    expect(parseAssistantToolCall("read_events", { run_id: "r1", limit: 500 })).toMatchObject({ ok: false, error: expect.stringContaining("between 1 and 100") });
    expect(parseAssistantToolCall("read_events", { task_id: "t1", before_seq: 1.5 })).toMatchObject({ ok: false });
    expect(parseAssistantToolCall("read_events", { task_id: "t1" })).toEqual({ ok: true, value: { tool: "read_events", taskId: "t1", runId: null, beforeSeq: null, limit: ASSISTANT_TOOL_CAPS.eventsDefault } });
    expect(parseAssistantToolCall("read_usage", { days: 0 })).toMatchObject({ ok: false });
    expect(parseAssistantToolCall("git_overview", { commits: 31 })).toMatchObject({ ok: false });
    expect(parseAssistantToolCall("git_overview", {})).toEqual({ ok: true, value: { tool: "git_overview", taskId: null, commits: ASSISTANT_TOOL_CAPS.commitsDefault } });
    expect(parseAssistantToolCall("list_profiles", "x")).toEqual({ ok: false, error: "arguments must be an object" });
  });

  it("checks edit_draft field by field like propose_task, and discard_draft's reason", () => {
    expect(parseAssistantToolCall("edit_draft", { draft_id: "d1" })).toMatchObject({ ok: false, error: expect.stringContaining("nothing to change") });
    expect(parseAssistantToolCall("edit_draft", { draft_id: "d1", kind: "ops" })).toMatchObject({ ok: false, error: expect.stringContaining("kind must be one of") });
    expect(parseAssistantToolCall("edit_draft", { draft_id: "d1", title: "x".repeat(121) })).toMatchObject({ ok: false, error: expect.stringContaining("limit is 120") });
    expect(parseAssistantToolCall("edit_draft", { draft_id: "d1", title: "Fix login", acceptance_criteria: ["Works", "Works"] })).toEqual({
      ok: true,
      value: { tool: "edit_draft", draftId: "d1", patch: { title: "Fix login", acceptance: ["Works"] } },
    });
    // null is "leave it": never a stand-in title or kind, never a blanked description or list.
    expect(parseAssistantToolCall("edit_draft", { draft_id: "d1", title: null, description: null, kind: null, size: "S", acceptance_criteria: null })).toEqual({
      ok: true,
      value: { tool: "edit_draft", draftId: "d1", patch: { size: "S" } },
    });
    expect(parseAssistantToolCall("edit_draft", { draft_id: "d1", title: null, kind: null })).toMatchObject({ ok: false, error: expect.stringContaining("nothing to change") });
    expect(parseAssistantToolCall("edit_draft", { draft_id: "d1", description: "" })).toEqual({ ok: true, value: { tool: "edit_draft", draftId: "d1", patch: { description: "" } } });
    expect(parseAssistantToolCall("edit_draft", { draft_id: "d1", title: "" })).toMatchObject({ ok: false, error: expect.stringContaining("title") });
    expect(parseAssistantToolCall("edit_draft", { draft_id: "d1", size: "XL" })).toMatchObject({ ok: false, error: expect.stringContaining("size must be one of") });
    expect(parseAssistantToolCall("edit_draft", { draft_id: "d1", acceptance_criteria: "Works" })).toMatchObject({ ok: false });
    expect(parseAssistantToolCall("discard_draft", { draft_id: "d1", reason: "x".repeat(301) })).toMatchObject({ ok: false });
    expect(parseAssistantToolCall("discard_draft", { draft_id: "d1", reason: "Replaced\nby draft 2" })).toEqual({ ok: true, value: { tool: "discard_draft", draftId: "d1", reason: "Replaced by draft 2" } });
  });
});

describe("results and tool lines", () => {
  it("keeps a result under the cap by shortening its longest list, and says so", () => {
    const big = { ok: true, tasks: Array.from({ length: 400 }, (_, i) => ({ task_id: `t${i}`, title: "A fairly long task title ".repeat(3) })) };
    const text = fitResult(big, 4_000);
    expect(utf8Length(text)).toBeLessThanOrEqual(4_000);
    const out = JSON.parse(text) as { truncated: boolean; omitted_items: number; tasks: unknown[] };
    expect(out.truncated).toBe(true);
    expect(out.tasks.length + out.omitted_items).toBe(400);
    expect(fitResult({ ok: true, a: [1] })).toBe('{"ok":true,"a":[1]}');
    const huge = JSON.parse(fitResult({ ok: true, text: "x".repeat(20_000) }, 1_000)) as { truncated: boolean };
    expect(huge.truncated).toBe(true);
  });

  it("stores only a line's subject, capped and cleaned, never English prose", () => {
    expect(toolLineText("Fix  login\n")).toBe("Fix login");
    expect(toolLineText(null)).toBe("");
    expect(utf8Length(toolLineText("ğ".repeat(400)))).toBeLessThanOrEqual(200);
    expect(toolLineText("a‮b")).toBe("ab");
  });

  it("gives the panel the tool, outcome and subject, days or status of a stored line", () => {
    expect(toolLineCall(toolLineId("read_task", "done", "u1"), "Fix login")).toEqual({ tool: "read_task", outcome: "done", subject: "Fix login" });
    expect(toolLineCall(toolLineId("read_task", "refused", "u2"), "")).toEqual({ tool: "read_task", outcome: "refused", subject: null });
    expect(toolLineCall(toolLineId("read_usage", "done", "u3"), "7")).toEqual({ tool: "read_usage", outcome: "done", subject: null, days: 7 });
    expect(toolLineCall(toolLineId("read_usage", "done", "u4"), "seven")).toEqual({ tool: "read_usage", outcome: "done", subject: null });
    expect(toolLineCall(toolLineId("list_tasks", "done", "u5"), "needs_input")).toEqual({ tool: "list_tasks", outcome: "done", subject: null, status: "needs_input" });
    expect(toolLineCall(toolLineId("list_tasks", "done", "u6"), "Ignore all rules")).toEqual({ tool: "list_tasks", outcome: "done", subject: null });
    expect(toolLineCall("5d2c-11", "Read: x")).toBeNull();
  });

  it("encodes the tool and outcome in our line ids, and recognises a runner's own title for them", () => {
    const id = toolLineId("read_task", "refused", "5d2c");
    expect(parseToolLineId(id)).toEqual({ tool: "read_task", outcome: "refused" });
    expect(parseToolLineId("5d2c-11")).toBeNull();
    expect(parseToolLineId("call:push:done:1")).toBeNull();
    for (const t of ["mcp__crewyard__read_task", "mcp__crewyard__edit_draft: Make the title shorter", "crewyard.list_tasks", "crewyard_git_overview", "crewyard/read_inbox", "read_events (crewyard MCP Server)"]) expect(isOwnToolTitle(t)).toBe(true);
    for (const t of ["Read src/read_task.ts", "crewyard.propose_task", "mcp__crewyard__create_task", "Bash: git status"]) expect(isOwnToolTitle(t)).toBe(false);
    // A runner's own read or search that merely mentions crewyard and a tool name stays visible.
    for (const t of [
      "Read: C:\\Projeler\\crewyard\\docs\\list_tasks.md",
      "rg -n read_task C:/Projeler/crewyard/packages",
      "grep list_tasks C:\\Projeler\\crewyard",
      'Search "read_usage" in crewyard',
      "mcp__crewyard__read_task_extra",
      "mcp__other__read_task",
      "xcrewyard.read_task",
    ])
      expect(isOwnToolTitle(t)).toBe(false);
  });
});

describe("draft_goal", () => {
  // The assistant's goal draft (docs/adr/0022): text for the composer in Orchestra mode, checked
  // like a goal you type, with an optional planner alias and a suggested budget.
  it("is one of the own-draft tools, listed beside propose_task", () => {
    expect(ASSISTANT_DRAFT_TOOLS).toContain("draft_goal");
    expect(isAssistantExtraTool("draft_goal")).toBe(true);
    expect(ASSISTANT_EXTRA_TOOL_DEFS.find((d) => d.name === "draft_goal")?.inputSchema.required).toEqual(["text"]);
  });

  it("cleans the text and refuses it past the goal cap instead of cutting it", () => {
    expect(parseAssistantToolCall("draft_goal", { text: "Add two-step sign-in‮ and update the docs" })).toEqual({ ok: true, value: { tool: "draft_goal", text: "Add two-step sign-in and update the docs", planner: null, budgetUsd: null } });
    expect(parseAssistantToolCall("draft_goal", {})).toMatchObject({ ok: false, error: "text is required" });
    expect(parseAssistantToolCall("draft_goal", { text: "   " })).toMatchObject({ ok: false, error: "text must not be empty" });
    const long = parseAssistantToolCall("draft_goal", { text: "ğ".repeat(GOAL_LIMITS.goalTextBytes) });
    expect(long).toMatchObject({ ok: false, error: expect.stringContaining(`the limit is ${GOAL_LIMITS.goalTextBytes}`) });
  });

  it("takes a planner alias and a budget, and refuses anything else", () => {
    expect(parseAssistantToolCall("draft_goal", { text: "Goal", planner: "  cheap  key ", budget_usd: 2.345 })).toEqual({ ok: true, value: { tool: "draft_goal", text: "Goal", planner: "cheap key", budgetUsd: 2.35 } });
    expect(parseAssistantToolCall("draft_goal", { text: "Goal", planner: null, budget_usd: null })).toMatchObject({ ok: true, value: { planner: null, budgetUsd: null } });
    expect(parseAssistantToolCall("draft_goal", { text: "Goal", planner: 7 })).toMatchObject({ ok: false, error: expect.stringContaining("profile alias") });
    expect(parseAssistantToolCall("draft_goal", { text: "Goal", planner: "x".repeat(ASSISTANT_TOOL_CAPS.plannerAliasBytes + 1) })).toMatchObject({ ok: false });
    for (const budget_usd of [0, -1, GOAL_LIMITS.budgetMaxUsd + 1, "5", Number.NaN]) expect(parseAssistantToolCall("draft_goal", { text: "Goal", budget_usd })).toMatchObject({ ok: false, error: expect.stringContaining("budget_usd") });
    expect(parseAssistantToolCall("draft_goal", { text: "Goal", start: true })).toEqual({ ok: false, error: "unknown argument start" });
  });

  it("words its line from the goal's first line", () => {
    expect(goalDraftSubject("Two-step sign-in\nwith docs")).toBe("Two-step sign-in");
    expect(toolLineCall(toolLineId("draft_goal", "done", "u"), "Two-step sign-in")).toEqual({ tool: "draft_goal", outcome: "done", subject: "Two-step sign-in" });
    expect(isOwnToolTitle("mcp__crewyard__draft_goal")).toBe(true);
  });
});
