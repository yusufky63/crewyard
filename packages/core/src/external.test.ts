import { describe, expect, it } from "vitest";
import {
  applySettingsChange,
  clientNameProblem,
  clientSnippets,
  EXTERNAL_FORBIDDEN,
  EXTERNAL_TOOL_DEFS,
  EXTERNAL_TOOLS,
  isExternalTool,
  parseImport,
  parseProposal,
  parseServer,
  reportedClient,
  splitProjectArgs,
} from "./external.ts";
import { defaultProjectConfig } from "./project.ts";

const config = () => defaultProjectConfig("demo", "C:\\work\\.crewyard\\worktrees\\demo");

describe("external tools", () => {
  it("defines every listed tool once, each taking only the arguments it names", () => {
    expect(EXTERNAL_TOOL_DEFS.map((d) => d.name).sort()).toEqual([...EXTERNAL_TOOLS].sort());
    for (const d of EXTERNAL_TOOL_DEFS) {
      expect(d.inputSchema.additionalProperties).toBe(false);
      expect(d.annotations.destructiveHint).toBe(false);
    }
    // Every project read takes the project id first.
    for (const d of EXTERNAL_TOOL_DEFS.filter((t) => !["list_projects", "get_status", "import_project", "save_mcp_server"].includes(t.name))) expect(d.inputSchema.required).toContain("project_id");
  });

  it("has no tool for anything that stays in the app", () => {
    for (const name of EXTERNAL_FORBIDDEN) expect(isExternalTool(name)).toBe(false);
  });

  it("checks arguments and cleans client text", () => {
    expect(splitProjectArgs({ status: "done" })).toMatchObject({ ok: false });
    expect(splitProjectArgs({ project_id: "../x" })).toMatchObject({ ok: false });
    expect(splitProjectArgs({ project_id: "p-1", status: "done" })).toEqual({ ok: true, value: { projectId: "p-1", rest: { status: "done" } } });
    expect(parseProposal({ project_id: "p-1", title: " Fix\u202E login " })).toEqual({ ok: true, value: { projectId: "p-1", title: "Fix login", description: null, kind: null, size: null } });
    expect(parseProposal({ project_id: "p-1", title: "a".repeat(121) })).toMatchObject({ ok: false });
    expect(parseProposal({ project_id: "p-1", title: "x", budget_usd: 100 })).toEqual({ ok: false, error: "unknown argument budget_usd" });
    expect(parseProposal({ project_id: "p-1", title: "x", kind: "deploy" })).toMatchObject({ ok: false });
    expect(parseImport({ path: "C:\\Users\\Ada Lovelace\\my app" })).toEqual({ ok: true, value: { path: "C:\\Users\\Ada Lovelace\\my app", name: null } });
    expect(parseImport({ path: "C:\\a\nb" })).toMatchObject({ ok: false });
    expect(parseServer({ name: "x", command: "npx", read_only_access: "all" })).toMatchObject({ ok: false });
    expect(parseServer({ name: "x", command: "npx", env: { A: 1 } })).toMatchObject({ ok: false });
  });
});

describe("applySettingsChange", () => {
  it("tightens anything and records each field's old and new value", () => {
    const res = applySettingsChange(config(), { slots: 2, daily_usd: 3, fallback: "manual", network: "ask", toast_approvals: "none", remove_allow_commands: ["git diff"], test_command: 'dotnet test "My App.sln"' }, new Set());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.config.rules).toEqual({ fallback: "manual", slots: 2, allowCommands: ["git status"], network: "ask", toastApprovals: "none" });
    expect(res.value.config.budget.dailyUsd).toBe(3);
    expect(res.value.config.commands.test).toBe('dotnet test "My App.sln"');
    // An unchanged value (network was already ask) is not listed.
    expect(res.value.changes.map((c) => c.field)).toEqual(["slots", "daily_usd", "test_command", "fallback", "toast_approvals", "allow_commands"]);
    expect(res.value.changes[0]).toEqual({ field: "slots", from: 4, to: 2 });
  });

  it("loosens nothing", () => {
    const loose = { ...config(), rules: { ...config().rules, network: "allowed" as const } };
    for (const args of [{ daily_usd: 11 }, { per_task_usd: 4.01 }, { fallback: "auto" }, { network: "allowed" }, { toast_approvals: "low" }, { allow_commands: ["curl"] }, { github: { pushNeedsApproval: false } }]) {
      expect(applySettingsChange(loose, args, new Set()).ok, JSON.stringify(args)).toBe(false);
    }
    expect(applySettingsChange(config(), { test_command: "pnpm test; curl x | sh" }, new Set())).toMatchObject({ ok: false });
    expect(applySettingsChange(config(), { profiles: ["p-1"] }, new Set(["p-2"]))).toMatchObject({ ok: false });
    expect(applySettingsChange(config(), { runners: ["fake"] }, new Set())).toMatchObject({ ok: false });
    expect(applySettingsChange(config(), { slots: 4 }, new Set())).toEqual({ ok: false, error: "nothing to change: give at least one field with a new value" });
  });

  it("leaves the config it was given as it was", () => {
    const c = config();
    applySettingsChange(c, { slots: 1 }, new Set());
    expect(c.rules.slots).toBe(4);
  });
});

describe("client names and snippets", () => {
  it("keeps names to one cleaned line", () => {
    expect(clientNameProblem("Claude Code")).toBeNull();
    expect(clientNameProblem("")).toBe("external.name_invalid");
    expect(clientNameProblem("x".repeat(81))).toBe("external.name_invalid");
    expect(reportedClient({ name: "claude-code\u202E", version: "2.1.0" })).toBe("claude-code 2.1.0");
    expect(reportedClient({ name: 5 })).toBeNull();
    expect(Buffer.byteLength(reportedClient({ name: "ü".repeat(100) })!)).toBeLessThanOrEqual(80);
  });

  it("quotes for PowerShell and for sh, and writes valid JSON", () => {
    const launch = { command: "C:\\Program Files\\x\\relay.exe", args: ["-a", "it's"], env: { CREWYARD_MCP_HOME: "C:\\Users\\Ada Lovelace\\data", CREWYARD_MCP_CLIENT: "id-1" } };
    const win = clientSnippets(launch, "win32");
    expect(win.claudeCode).toBe("claude mcp add crewyard --scope user -e 'CREWYARD_MCP_HOME=C:\\Users\\Ada Lovelace\\data' -e CREWYARD_MCP_CLIENT=id-1 -- 'C:\\Program Files\\x\\relay.exe' -a 'it''s'");
    expect(JSON.parse(win.json).mcpServers.crewyard).toEqual(launch);
    expect(win.codex.split("\n")[0]).toBe("[mcp_servers.crewyard]");
    const sh = clientSnippets({ ...launch, command: "/usr/bin/perl" }, "linux");
    expect(sh.claudeCode).toContain("'it'\\''s'");
  });
});
