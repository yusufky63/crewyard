import { describe, expect, it } from "vitest";
import { ASSISTANT_LIMITS, ASSISTANT_TOOL, ASSISTANT_TOOL_DEFS, assistantAnswer, assistantPolicy, draftDescription, parseTaskDraft } from "./assistant.ts";
import type { AgentEvent } from "./events.ts";
import { REPORT_TOOL_DEFS } from "./mcp.ts";

const env = { runId: "r", seq: 0, at: "2026-10-31T10:00:00Z", source: { adapter: "fake", cliVersion: null } } as const;

describe("parseTaskDraft", () => {
  it("takes the agent's call with snake_case criteria", () => {
    const r = parseTaskDraft({ title: "Find why the Windows build is slow", description: "Compare cold and warm builds.", kind: "research", acceptance_criteria: ["Which step takes longest?", " Is Defender scanning the output? "], size: "S" });
    expect(r).toEqual({
      ok: true,
      value: { title: "Find why the Windows build is slow", description: "Compare cold and warm builds.", kind: "research", acceptance: ["Which step takes longest?", "Is Defender scanning the output?"], size: "S" },
    });
  });

  it("takes an edited card with `acceptance`, drops empty and repeated lines, and leaves size optional", () => {
    const r = parseTaskDraft({ title: "Add a retry", kind: "code", acceptance: ["Retries 3 times", "", "Retries 3 times"] });
    expect(r).toEqual({ ok: true, value: { title: "Add a retry", description: "", kind: "code", acceptance: ["Retries 3 times"], size: null } });
  });

  it("refuses a missing or unknown kind, a bad size and a multi-line title", () => {
    expect(parseTaskDraft({ title: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("kind") });
    expect(parseTaskDraft({ title: "x", kind: "deploy" })).toMatchObject({ ok: false });
    expect(parseTaskDraft({ title: "x", kind: "code", size: "XL" })).toMatchObject({ ok: false, error: expect.stringContaining("size") });
    expect(parseTaskDraft({ title: "a\nb", kind: "code" })).toMatchObject({ ok: false, error: "title must be one line" });
    expect(parseTaskDraft({ title: "   ", kind: "code" })).toMatchObject({ ok: false, error: "title must not be empty" });
    expect(parseTaskDraft("title")).toMatchObject({ ok: false });
    expect(parseTaskDraft({ title: "x", kind: "code", acceptance_criteria: "one" })).toMatchObject({ ok: false });
  });

  it("refuses text over the caps instead of cutting it", () => {
    expect(parseTaskDraft({ title: "t".repeat(ASSISTANT_LIMITS.titleBytes + 1), kind: "code" })).toMatchObject({ ok: false, error: expect.stringContaining("limit is 120") });
    // Bytes, not characters: 61 two-byte letters are 122 bytes.
    expect(parseTaskDraft({ title: "ş".repeat(61), kind: "code" })).toMatchObject({ ok: false });
    expect(parseTaskDraft({ title: "x", kind: "code", description: "d".repeat(ASSISTANT_LIMITS.descriptionBytes + 1) })).toMatchObject({ ok: false });
    expect(parseTaskDraft({ title: "x", kind: "code", acceptance: ["c".repeat(ASSISTANT_LIMITS.criterionBytes + 1)] })).toMatchObject({ ok: false });
    const many = Array.from({ length: ASSISTANT_LIMITS.criteria + 1 }, (_, i) => `criterion ${i}`);
    expect(parseTaskDraft({ title: "x", kind: "code", acceptance: many })).toMatchObject({ ok: false, error: expect.stringContaining("at most 12") });
    expect(parseTaskDraft({ title: "x", kind: "code", acceptance: ["one\ntwo"] })).toMatchObject({ ok: false });
  });

  it("removes control and bidirectional override characters", () => {
    const r = parseTaskDraft({ title: "Fix ‮gpj.exe\u0007", kind: "docs" });
    expect(r).toMatchObject({ ok: true, value: { title: "Fix gpj.exe" } });
  });
});

describe("draftDescription", () => {
  it("puts the criteria under the text as a list", () => {
    expect(draftDescription({ description: "Why is it slow?", acceptance: ["Name the slowest step", "Measure twice"] })).toBe("Why is it slow?\n\nAcceptance criteria:\n- Name the slowest step\n- Measure twice");
    expect(draftDescription({ description: "", acceptance: ["Only this"] })).toBe("Acceptance criteria:\n- Only this");
    expect(draftDescription({ description: "Just text", acceptance: [] })).toBe("Just text");
  });
});

describe("read-only policy", () => {
  it("allows no writes, no commands and no network, as a fresh copy each time", () => {
    const p = assistantPolicy();
    expect(p).toEqual({ writes: "none", allowCommands: [], network: "denied" });
    p.allowCommands.push("rm");
    expect(assistantPolicy().allowCommands).toEqual([]);
  });

  it("denies every approval, whatever the command, and cancels questions", () => {
    for (const command of ["git push", "cat README.md", null]) {
      const a = assistantAnswer({ ...env, type: "request.approval", requestId: "q", toolCallId: null, command, cwd: null, paths: [], network: false, risk: "low" });
      expect(a).toMatchObject({ kind: "approval", decision: "deny" });
    }
    expect(assistantAnswer({ ...env, type: "request.question", requestId: "q", questions: [] })).toEqual({ kind: "cancel" });
    const others: AgentEvent[] = [
      { ...env, type: "message.delta", text: "hi" },
      { ...env, type: "tool.call", toolCallId: "t", title: "Read", kind: "read", input: {} },
    ];
    for (const ev of others) expect(assistantAnswer(ev)).toBeNull();
  });

  it("offers only propose_task, marked read-only, and never the crew report tools", () => {
    expect(ASSISTANT_TOOL_DEFS.map((t) => t.name)).toEqual([ASSISTANT_TOOL]);
    expect(ASSISTANT_TOOL_DEFS[0].annotations.readOnlyHint).toBe(true);
    expect(REPORT_TOOL_DEFS.map((t) => t.name)).not.toContain(ASSISTANT_TOOL);
  });
});
