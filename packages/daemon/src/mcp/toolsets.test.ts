import { describe, expect, it } from "vitest";
import { ASSISTANT_TOOL_DEFS } from "@crewyard/core";
import { McpSession, REPORT_TOOLS } from "./session.ts";

// Crew runs and the task assistant share the report server but not its tools (docs/adr/0014): a
// run's connection cannot propose task drafts, and the assistant cannot file reports or follow-ups.

const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const call = (name: string) => JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: {} } });

async function names(session: McpSession): Promise<string[]> {
  await session.handle(init);
  const out = JSON.parse((await session.handle(list))!) as { result: { tools: Array<{ name: string }> } };
  return out.result.tools.map((t) => t.name);
}

describe("tool sets per connection", () => {
  const ok = async () => ({ text: "ok", isError: false });

  it("lists the report tools for a run and refuses propose_task", async () => {
    const s = new McpSession(ok, "1", REPORT_TOOLS);
    expect(await names(s)).toEqual(["report", "propose_followup"]);
    expect(JSON.parse((await s.handle(call("propose_task")))!)).toMatchObject({ error: { code: -32602 } });
  });

  it("lists only propose_task for the assistant and refuses the report tools", async () => {
    const s = new McpSession(ok, "1", { tools: ASSISTANT_TOOL_DEFS, instructions: "assistant" });
    expect(await names(s)).toEqual(["propose_task"]);
    for (const tool of ["report", "propose_followup"]) expect(JSON.parse((await s.handle(call(tool)))!)).toMatchObject({ error: { code: -32602 } });
    expect(JSON.parse((await s.handle(call("propose_task")))!)).toMatchObject({ result: { isError: false } });
  });
});
