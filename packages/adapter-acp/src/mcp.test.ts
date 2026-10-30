import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, McpServerSpec, RolePolicy, StartRequest } from "@crewyard/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapter } from "./index.ts";
import { acpMcpServers, mcpServerOf } from "./mcp.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const WORKTREE: RolePolicy = { writes: "worktree", allowCommands: [], network: "ask" };
const report: McpServerSpec = { name: "crewyard", command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: ["-EncodedCommand", "AAAA"], env: { CREWYARD_RUN_TICKET: "t".repeat(43) }, tools: null, builtin: true };
const github: McpServerSpec = { name: "github", command: "C:\\bin\\github-mcp.exe", args: ["stdio"], env: { GH_TOKEN: "ghs_x" }, tools: null, builtin: false };

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "crewyard acp mcp "));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("acpMcpServers", () => {
  it("turns specs into ACP stdio entries with env as name/value pairs", () => {
    expect(acpMcpServers([report, github])).toEqual([
      { name: "crewyard", command: report.command, args: report.args, env: [{ name: "CREWYARD_RUN_TICKET", value: "t".repeat(43) }] },
      { name: "github", command: github.command, args: ["stdio"], env: [{ name: "GH_TOKEN", value: "ghs_x" }] },
    ]);
  });

  it("reads the MCP server of a Gemini CLI permission request", () => {
    expect(mcpServerOf({ _meta: { "gemini-cli": { mcp: { server_name: "github", tool_name: "x" } } } })).toBe("github");
    expect(mcpServerOf({})).toBeNull();
  });
});

describe("ACP adapter with MCP servers", () => {
  it("sends the run's servers in session/new, allows report tools and asks for a user server's as network", async () => {
    const dir = join(root, "mcp");
    const cwd = join(dir, "work tree");
    await mkdir(cwd, { recursive: true });
    const logFile = join(dir, "fake log.jsonl");
    const req: StartRequest = {
      profile: { id: "g1", alias: "gemini work", runner: "gemini-cli", providerId: "google", credential: { kind: "plan_signin", secretRef: null }, defaultModel: null, configDir: join(dir, "profile dir"), baseUrl: null },
      cwd,
      model: "gemini-2.5-pro",
      prompt: "mcptools",
      policy: WORKTREE,
      env: { FAKE_ACP_LOG: logFile },
      mcpServers: [report, github],
    };
    const adapter = createAdapter({ executable: process.execPath, prefixArgs: [FAKE], cancelGraceMs: 2_000 });
    const run = await adapter.start(req);
    const events: AgentEvent[] = [];
    for await (const ev of adapter.events(run)) {
      events.push(ev);
      if (ev.type === "request.approval") await adapter.answer(run, ev.requestId, { kind: "approval", decision: "deny" });
    }
    const log = (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.find((l) => l.kind === "session.new")).toMatchObject({ params: { cwd, mcpServers: acpMcpServers([report, github]) } });
    const outcomes = log.filter((l) => l.kind === "permission.outcome").map((l) => [l.tool, (l.outcome as { optionId?: string }).optionId]);
    expect(outcomes).toEqual([
      ["report", "proceed_once"],
      ["create_issue", "cancel"],
    ]);
    expect(events.filter((e) => e.type === "request.approval")).toEqual([expect.objectContaining({ network: true })]);
  });
});
