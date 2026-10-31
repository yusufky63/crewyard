import { describe, expect, it } from "vitest";
import {
  ASSISTANT_EXTRA_TOOL_DEFS,
  ASSISTANT_EXTRA_TOOLS,
  ASSISTANT_TOOL_CAPS,
  fitResult,
  isAssistantExtraTool,
  isOwnToolTitle,
  parseAssistantToolCall,
  parseToolLineId,
  toolLineId,
  toolLineTitle,
} from "./assistant-tools.ts";
import { AUTOPILOT_TOOLS } from "./autopilot.ts";
import { utf8Length } from "./event-caps.ts";
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

  it("reads as a tool line with its subject, capped and cleaned", () => {
    expect(toolLineTitle("read_task", "Fix  login\n")).toBe("Read task: Fix login");
    expect(toolLineTitle("list_tasks", null)).toBe("Listed tasks");
    expect(toolLineTitle("read_crew", "x", true)).toBe("Read crew: x (refused)");
    expect(utf8Length(toolLineTitle("read_task", "ğ".repeat(400)))).toBeLessThanOrEqual(200);
    expect(toolLineTitle("read_task", "a‮b")).toBe("Read task: ab");
  });

  it("encodes the tool and outcome in our line ids, and recognises a runner's own title for them", () => {
    const id = toolLineId("read_task", "refused", "5d2c");
    expect(parseToolLineId(id)).toEqual({ tool: "read_task", outcome: "refused" });
    expect(parseToolLineId("5d2c-11")).toBeNull();
    expect(parseToolLineId("call:push:done:1")).toBeNull();
    for (const t of ["mcp__crewyard__read_task", "crewyard.list_tasks", "crewyard_git_overview", "read_events (crewyard MCP Server)"]) expect(isOwnToolTitle(t)).toBe(true);
    for (const t of ["Read src/read_task.ts", "crewyard.propose_task", "mcp__crewyard__create_task", "Bash: git status"]) expect(isOwnToolTitle(t)).toBe(false);
  });
});
