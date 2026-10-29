import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vitest";
import { OpenCodeMapper, toolKind } from "./mapper.ts";

const user: UserMessage = { id: "m_u", sessionID: "s", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } };
const tokens = (input: number, output: number) => ({ input, output, reasoning: 0, cache: { read: 0, write: 0 } });
const assistant = (id: string, created: number, cost: number, t = tokens(0, 0), sessionID = "s"): AssistantMessage => ({
  id,
  sessionID,
  role: "assistant",
  time: { created },
  parentID: "m_u",
  modelID: "m",
  providerID: "p",
  mode: "build",
  agent: "build",
  path: { cwd: ".", root: "." },
  cost,
  tokens: t,
});
const textPart = (id: string, messageID: string, text: string, sessionID = "s"): Part => ({ id, sessionID, messageID, type: "text", text });

describe("OpenCodeMapper", () => {
  it("emits each text character once across deltas, full updates and replays", () => {
    const m = new OpenCodeMapper("s", ".");
    m.message(assistant("m_a", 2, 0));
    expect(m.part(textPart("t", "m_a", ""))).toEqual([]);
    expect(m.delta({ sessionID: "s", messageID: "m_a", partID: "t", field: "text", delta: "Hel" })).toEqual([{ type: "message.delta", text: "Hel" }]);
    expect(m.part(textPart("t", "m_a", "Hello"))).toEqual([{ type: "message.delta", text: "lo" }]);
    expect(m.part(textPart("t", "m_a", "Hello"))).toEqual([]);
  });

  it("skips user parts and sessions it does not own, and follows child sessions", () => {
    const m = new OpenCodeMapper("s", ".");
    m.message(user);
    expect(m.part(textPart("u", "m_u", "my prompt"))).toEqual([]);
    expect(m.part(textPart("x", "m_x", "other", "elsewhere"))).toEqual([]);
    m.sessionSeen({ id: "child", parentID: "s" });
    expect(m.part(textPart("c", "m_c", "from subagent", "child"))).toEqual([{ type: "message.delta", text: "from subagent" }]);
  });

  it("maps tool states once per status change", () => {
    const m = new OpenCodeMapper("s", ".");
    const base = { id: "p1", sessionID: "s", messageID: "m_a", type: "tool" as const, callID: "c1", tool: "edit" };
    expect(m.part({ ...base, state: { status: "pending", input: { filePath: "a.ts" }, raw: "" } })).toEqual([{ type: "tool.call", toolCallId: "c1", title: "edit", kind: "edit", input: { filePath: "a.ts" } }]);
    const running = { ...base, state: { status: "running" as const, input: {}, title: "a.ts", time: { start: 1 } } };
    expect(m.part(running)).toEqual([{ type: "tool.update", toolCallId: "c1", status: "in_progress" }]);
    expect(m.part(running)).toEqual([]);
    expect(m.part({ ...base, state: { status: "error", input: {}, error: "boom", time: { start: 1, end: 2 } } })).toEqual([{ type: "tool.update", toolCallId: "c1", status: "failed", output: "boom" }]);
  });

  it("sums usage across messages and labels cost as estimated", () => {
    const m = new OpenCodeMapper("s", ".");
    expect(m.message(assistant("a1", 1, 0))).toEqual([]);
    m.message(assistant("a1", 1, 0.25, tokens(10, 5)));
    const [ev] = m.message(assistant("a2", 2, 0.5, tokens(30, 10)));
    expect(ev).toMatchObject({ type: "usage.update", tokensIn: 40, tokensOut: 15, contextUsed: 40, costUsd: 0.75, contextSize: null, costProvenance: "estimated" });
  });

  it("dedupes requests across replays and lets settled ones go", () => {
    const m = new OpenCodeMapper("s", "C:\\work tree");
    const req = { id: "per_1", sessionID: "s", permission: "edit", patterns: ["src/a.ts"], metadata: { filepath: "C:\\work tree\\src\\a.ts" }, always: [] };
    expect(m.permission(req)).toEqual([{ type: "request.approval", requestId: "per_1", toolCallId: null, command: null, cwd: "C:\\work tree", paths: ["C:\\work tree\\src\\a.ts"], network: false }]);
    expect(m.permission(req)).toEqual([]);
    expect(m.pending.get("per_1")).toBe("permission");
    m.settle("per_1");
    expect(m.pending.size).toBe(0);
    expect(m.permission({ ...req, id: "per_2", permission: "webfetch", patterns: ["https://example.com"], metadata: {} })).toMatchObject([{ network: true, paths: [], command: "webfetch https://example.com" }]);
  });

  it("drops cancelled todos and unchanged plans", () => {
    const m = new OpenCodeMapper("s", ".");
    const todos = [
      { content: "a", status: "completed", priority: "high" },
      { content: "b", status: "cancelled", priority: "low" },
    ];
    expect(m.todos("s", todos)).toEqual([{ type: "plan.update", steps: [{ title: "a", status: "completed" }] }]);
    expect(m.todos("s", todos)).toEqual([]);
    expect(m.todos("child", todos)).toEqual([]);
  });

  it("classifies tools", () => {
    expect(["read", "bash", "grep", "webfetch", "write", "task"].map(toolKind)).toEqual(["read", "execute", "search", "fetch", "edit", "other"]);
  });
});
