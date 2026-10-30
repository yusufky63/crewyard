import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, McpServerSpec, RolePolicy } from "@crewyard/core";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "./adapter.ts";
import { mcpPlan, mcpToolApproval } from "./mcp.ts";

const launcher = { command: process.execPath, args: [fileURLToPath(new URL("./__fixtures__/fake-app-server.mjs", import.meta.url))] };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const writer: RolePolicy = { writes: "worktree", allowCommands: [], network: "ask" };
const reader: RolePolicy = { writes: "none", allowCommands: [], network: "ask" };
const report: McpServerSpec = {
  name: "crewyard",
  command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  args: ["-EncodedCommand", "AAAA"],
  env: { CREWYARD_REPORT_PIPE: "\\\\.\\pipe\\x", CREWYARD_RUN_TICKET: "ticket-value-0000000000000000000000000000" },
  tools: null,
  builtin: true,
};
const github: McpServerSpec = { name: "github", command: "C:\\bin\\github-mcp.exe", args: ["stdio"], env: { GH_TOKEN: "ghs_secretvalue" }, tools: null, builtin: false };
const files: McpServerSpec = { name: "files", command: "C:\\bin\\files.exe", args: [], env: {}, tools: ["read_file"], builtin: false };

describe("mcpPlan", () => {
  it("writes mcp_servers tables with env_vars names only, approve for the report server and prompt for a writer's servers", () => {
    const plan = mcpPlan([report, github, files], writer);
    expect(plan.config).toEqual({
      "mcp_servers.crewyard": { command: report.command, args: report.args, env_vars: ["CREWYARD_REPORT_PIPE", "CREWYARD_RUN_TICKET"], enabled: true, startup_timeout_sec: 30, default_tools_approval_mode: "approve" },
      "mcp_servers.github": { command: github.command, args: ["stdio"], env_vars: ["GH_TOKEN"], enabled: true, startup_timeout_sec: 30, default_tools_approval_mode: "prompt" },
      "mcp_servers.files": { command: files.command, args: [], env_vars: [], enabled: true, startup_timeout_sec: 30, enabled_tools: ["read_file"], default_tools_approval_mode: "prompt" },
    });
    expect(JSON.stringify(plan.config)).not.toContain("ghs_secretvalue");
    expect(JSON.stringify(plan.config)).not.toContain("ticket-value");
    expect(plan.env).toEqual({ ...report.env, GH_TOKEN: "ghs_secretvalue" });
  });

  it("lets a read-only role's picked read tools run without asking", () => {
    expect(mcpPlan([files], reader).config["mcp_servers.files"]).toMatchObject({ enabled_tools: ["read_file"], default_tools_approval_mode: "approve" });
  });

  it("keeps a clashing value inline instead of overwriting another server's", () => {
    const a: McpServerSpec = { ...files, name: "a", env: { ROOT: "C:\\one" } };
    const b: McpServerSpec = { ...files, name: "b", env: { ROOT: "C:\\two" } };
    const plan = mcpPlan([a, b], writer);
    expect(plan.env).toEqual({ ROOT: "C:\\one" });
    expect(plan.config["mcp_servers.b"]).toMatchObject({ env_vars: [], env: { ROOT: "C:\\two" } });
  });

  it("reads an MCP tool approval and ignores forms", () => {
    expect(mcpToolApproval({ serverName: "github", request: { _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "create_issue" } } })).toEqual({ server: "github", tool: "create_issue" });
    expect(mcpToolApproval({ serverName: "github", request: { message: "Pick" } })).toBeNull();
  });
});

describe("CodexAdapter with MCP servers", () => {
  function home(config: object): string {
    const dir = mkdtempSync(join(tmpdir(), "crewyard codex mcp "));
    dirs.push(dir);
    writeFileSync(join(dir, "fake.json"), JSON.stringify(config));
    return dir;
  }
  const log = (dir: string) =>
    readFileSync(join(dir, "fake-log.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const req = (dir: string, policy: RolePolicy) => ({
    profile: { id: "p", alias: "w", runner: "codex" as const, providerId: "openai", credential: { kind: "plan_signin" as const, secretRef: null }, defaultModel: "gpt-5.5", configDir: dir, baseUrl: null },
    cwd: dir,
    model: null,
    prompt: "Go",
    policy,
    env: {},
    mcpServers: [report, github],
  });

  it("sets server env on the app-server, keeps it out of shells, and asks for a writer's MCP tool in the Inbox", async () => {
    const dir = home({ scenario: "mcp" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.start(req(dir, writer));
    const events: AgentEvent[] = [];
    for await (const e of adapter.events(run)) {
      events.push(e);
      if (e.type === "request.approval") await adapter.answer(run, e.requestId, { kind: "approval", decision: "allow_once" });
    }
    const entries = log(dir);
    expect(entries[0]).toMatchObject({ env: { CREWYARD_RUN_TICKET: report.env.CREWYARD_RUN_TICKET, GH_TOKEN: "ghs_secretvalue" } });
    const start = entries.find((e) => (e.in as { method?: string } | undefined)?.method === "thread/start")!.in as { params: { config: Record<string, unknown> } };
    expect(start.params.config["shell_environment_policy.exclude"]).toEqual(expect.arrayContaining(["CREWYARD_RUN_TICKET", "CREWYARD_REPORT_PIPE", "GH_TOKEN"]));
    expect(JSON.stringify(start.params)).not.toContain("ghs_secretvalue");
    expect(events.filter((e) => e.type === "request.approval")).toEqual([expect.objectContaining({ network: true, command: null, cwd: dir })]);
    expect(entries.filter((e) => e.answered).map((e) => [e.answered, (e.response as { action: string }).action])).toEqual([
      ["mcp", "accept"],
      ["form", "decline"],
    ]);
  });

  it("declines MCP tool approvals for a read-only role without asking", async () => {
    const dir = home({ scenario: "mcp" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.start(req(dir, reader));
    const events: AgentEvent[] = [];
    for await (const e of adapter.events(run)) events.push(e);
    expect(events.some((e) => e.type === "request.approval")).toBe(false);
    expect(log(dir).filter((e) => e.answered).map((e) => (e.response as { action: string }).action)).toEqual(["decline", "decline"]);
  });
});
