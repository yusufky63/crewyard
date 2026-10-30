import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerSpec, RolePolicy } from "@crewyard/core";
import { afterEach, describe, expect, it } from "vitest";
import { isUserMcpPermission, mcpConfig, mcpPermissionRules, withMcpConfig } from "./mcp.ts";
import { envGuardFile, providerConfigEnv, writeEnvGuard } from "./server.ts";

const writer: RolePolicy = { writes: "worktree", allowCommands: [], network: "ask" };
const reader: RolePolicy = { writes: "none", allowCommands: [], network: "ask" };
const report: McpServerSpec = { name: "crewyard", command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: ["-EncodedCommand", "AAAA"], env: { CREWYARD_RUN_TICKET: "t" }, tools: null, builtin: true };
const files: McpServerSpec = { name: "files", command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\srv\\files.js"], env: { ROOT: "C:\\Work Trees" }, tools: ["read_file"], builtin: false };
const docs: McpServerSpec = { name: "docs", command: "C:\\bin\\docs.exe", args: [], env: {}, tools: null, builtin: false };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("mcpConfig", () => {
  it("writes 1.x local servers with the command as one array and their environment", () => {
    expect(mcpConfig([report, files])).toEqual({
      mcp: {
        crewyard: { type: "local", command: [report.command, ...report.args], environment: report.env, enabled: true, timeout: 30_000 },
        files: { type: "local", command: [files.command, "C:\\srv\\files.js"], environment: files.env, enabled: true, timeout: 30_000 },
      },
    });
    expect(mcpConfig([])).toEqual({});
  });

  it("turns Code Mode off in the 2.x shape, so permission rules keep matching tool names", () => {
    expect(mcpConfig([files], 2)).toEqual({ mcp: { servers: { files: { type: "local", command: [files.command, "C:\\srv\\files.js"], environment: files.env, codemode: false, timeout: { startup: 30_000 } } } } });
  });

  it("merges into the provider block of the inline config instead of replacing it", () => {
    const provider = providerConfigEnv("ollama", "http://127.0.0.1:11434/v1", ["llama"]);
    const merged = JSON.parse(withMcpConfig(provider, mcpConfig([report])).OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>;
    expect(Object.keys(merged).sort()).toEqual(["mcp", "provider"]);
    expect(withMcpConfig({}, {})).toEqual({});
  });
});

describe("mcpPermissionRules", () => {
  it("allows the report tools, and asks for a writer's user server tools", () => {
    expect(mcpPermissionRules([report, docs], writer)).toEqual([
      { permission: "crewyard_*", pattern: "*", action: "allow" },
      { permission: "docs_*", pattern: "*", action: "ask" },
    ]);
  });

  it("denies a read-only role's server as a whole, then allows its picked tools, later rules winning", () => {
    expect(mcpPermissionRules([report, files, docs], reader)).toEqual([
      { permission: "crewyard_*", pattern: "*", action: "allow" },
      { permission: "files_*", pattern: "*", action: "deny" },
      { permission: "files_read_file", pattern: "*", action: "allow" },
      { permission: "docs_*", pattern: "*", action: "allow" },
    ]);
  });

  it("tells user server permissions from the report server's", () => {
    expect(isUserMcpPermission("files_write_file", [report, files])).toBe(true);
    expect(isUserMcpPermission("crewyard_report", [report, files])).toBe(false);
    expect(isUserMcpPermission("bash", [report, files])).toBe(false);
  });
});

describe("env guard", () => {
  it("blanks the inline config in the agent's commands when it carries MCP env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewyard oc mcp "));
    dirs.push(dir);
    await writeEnvGuard(dir, { DEEPSEEK_API_KEY: "k" }, ["OPENCODE_CONFIG_CONTENT"]);
    const src = readFileSync(envGuardFile(dir), "utf8");
    expect(src).toContain('"OPENCODE_CONFIG_CONTENT"');
    expect(src).toContain('"DEEPSEEK_API_KEY"');
  });
});
