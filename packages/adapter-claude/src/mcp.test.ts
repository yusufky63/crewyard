import type { AgentEvent, McpServerSpec, Profile, RolePolicy, StartRequest } from "@crewyard/core";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { fakeQuery, type Step } from "./fake-query.ts";
import { SESSION, init, result } from "./fixtures.ts";
import { createAdapter } from "./index.ts";

const profile: Profile = {
  id: "p1",
  alias: "Claude · work",
  runner: "claude-code",
  providerId: "anthropic",
  credential: { kind: "api_key", secretRef: "claude-work" },
  defaultModel: "claude-sonnet-5",
  configDir: "C:\\Users\\Test User\\AppData\\Roaming\\Crewyard\\profiles\\claude-code\\work",
  baseUrl: null,
};
const writer: RolePolicy = { writes: "worktree", allowCommands: [], network: "ask" };
const reviewer: RolePolicy = { writes: "none", allowCommands: [], network: "ask" };

const report: McpServerSpec = { name: "crewyard", command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: ["-NoProfile", "-EncodedCommand", "AAAA"], env: { CREWYARD_REPORT_PIPE: "\\\\.\\pipe\\x", CREWYARD_RUN_TICKET: "t".repeat(43) }, tools: null, builtin: true };
const files: McpServerSpec = { name: "files", command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\srv\\files.js"], env: { ROOT: "C:\\Work Trees" }, tools: ["read_file"], builtin: false };
const docs: McpServerSpec = { name: "docs", command: "C:\\bin\\docs.exe", args: [], env: {}, tools: null, builtin: false };

const req = (over: Partial<StartRequest> = {}): StartRequest => ({ profile, cwd: "C:\\Work Trees\\demo repo", model: null, prompt: "Go", policy: writer, env: { ANTHROPIC_API_KEY: "sk-ant-api03-test" }, mcpServers: [report, files, docs], ...over });

function setup(turns: Step[][]) {
  const fq = fakeQuery(turns);
  const adapter = createAdapter({ query: fq.query, which: async () => "C:\\bin\\claude.exe", run: async () => ({ code: 0, stdout: "2.1.312 (Claude Code)\n", stderr: "" }), killTree: vi.fn(async () => {}), env: { Path: "C:\\Windows" } });
  return { adapter, rec: fq.rec };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("Claude adapter: MCP servers", () => {
  it("passes the run's servers through mcpServers with strictMcpConfig and pre-allows the report tools", async () => {
    const { adapter, rec } = setup([[init(), result()]]);
    await collect(adapter.events(await adapter.start(req())));
    const o = rec.options!;
    expect(o.strictMcpConfig).toBe(true);
    expect(o.mcpServers).toEqual({
      crewyard: { type: "stdio", command: report.command, args: report.args, env: report.env, alwaysLoad: true },
      files: { type: "stdio", command: files.command, args: files.args, env: files.env },
      docs: { type: "stdio", command: docs.command, args: [], env: {} },
    });
    expect(o.allowedTools).toContain("mcp__crewyard");
    // A writer's user server tools are not pre-allowed: they come to canUseTool.
    expect(o.allowedTools?.some((t) => t.startsWith("mcp__files") || t.startsWith("mcp__docs"))).toBe(false);
  });

  it("asks for a writer's user MCP tool as network-rated, so the daemon never approves it by policy", async () => {
    const { adapter } = setup([[init(), { ask: { tool: "mcp__files__write_file", input: { path: "x" }, id: "m1" } }, result()]]);
    const run = await adapter.start(req());
    const events: AgentEvent[] = [];
    for await (const e of adapter.events(run)) {
      events.push(e);
      if (e.type === "request.approval") await adapter.answer(run, e.requestId, { kind: "approval", decision: "deny" });
    }
    expect(events.find((e) => e.type === "request.approval")).toMatchObject({ network: true, command: null });
  });

  it("allows a read-only role only the read tools it was given, and refuses others in the hook", async () => {
    const { adapter, rec } = setup([[init(), result()]]);
    await collect(adapter.events(await adapter.start(req({ policy: reviewer }))));
    const o = rec.options!;
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.allowedTools).toEqual(expect.arrayContaining(["mcp__crewyard", "mcp__files__read_file", "mcp__docs"]));
    expect(o.allowedTools).not.toContain("mcp__files");
    const hook = o.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const base = { session_id: SESSION, transcript_path: "t", cwd: "c", hook_event_name: "PreToolUse" as const, tool_use_id: "x" };
    const signal = new AbortController().signal;
    const decide = (tool_name: string) => hook({ ...base, tool_name, tool_input: {} }, "x", { signal });
    await expect(decide("mcp__files__write_file")).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await expect(decide("mcp__other__anything")).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await expect(decide("mcp__files__read_file")).resolves.toEqual({});
    await expect(decide("mcp__docs__search")).resolves.toEqual({});
    await expect(decide("mcp__crewyard__report")).resolves.toEqual({});
  });

  it("gives no servers when the run has none, still in strict mode", async () => {
    const { adapter, rec } = setup([[init(), result()]]);
    await collect(adapter.events(await adapter.start(req({ mcpServers: undefined }))));
    expect(rec.options?.mcpServers).toEqual({});
    expect(rec.options?.strictMcpConfig).toBe(true);
  });
});
