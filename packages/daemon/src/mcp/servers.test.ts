import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerInput, McpServerSpec, RolePolicy } from "@crewyard/core";
import { Store } from "../store.ts";
import { cleanTemps, tempDir } from "../orchestrator/testing.ts";
import { SecretStore } from "../providers/secrets.ts";
import { planServers, recordUsage, runUsage } from "./inject.ts";
import { resolveLaunch } from "./launch.ts";
import { McpServerStore } from "./servers.ts";

// A protector that marks blobs, so a test can tell a DPAPI file from plain text.
const marked = { protect: async (b: Buffer) => Buffer.concat([Buffer.from("DPAPI:"), b]), unprotect: async (b: Buffer) => b.subarray(6) };

const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  cleanTemps();
});

function setup() {
  const root = tempDir("crewyard mcp servers-");
  const store = new Store(join(root, "t.db"));
  stores.push(store);
  const project = store.addProject(join(root, "repo"), "repo");
  const servers = new McpServerStore(store.db, new SecretStore(join(root, "data"), marked));
  return { root, store, project, servers };
}

const input = (over: Partial<McpServerInput> = {}): McpServerInput => ({ scope: "global", name: "files", command: "node", args: ["server.js"], env: [], enabled: true, readOnlyAccess: "marked", ...over });

const writer: RolePolicy = { writes: "worktree", allowCommands: [], network: "ask" };
const reader: RolePolicy = { writes: "none", allowCommands: [], network: "ask" };
const report: McpServerSpec = { name: "crewyard", command: "powershell.exe", args: [], env: {}, tools: null, builtin: true };
const ok = async (command: string, args: string[]) => ({ ok: true as const, command: `C:\\bin\\${command}.exe`, args, env: {} });

describe("McpServerStore", () => {
  it("keeps secret env values in DPAPI blobs and never in the database or the view", async () => {
    const s = setup();
    const view = await s.servers.save(input({ env: [{ name: "GITHUB_TOKEN", secret: true, value: "ghp_supersecretvalue" }, { name: "LOG_LEVEL", secret: false, value: "info" }] }));
    expect(view.env).toEqual([
      { name: "GITHUB_TOKEN", secret: true, value: null, stored: true },
      { name: "LOG_LEVEL", secret: false, value: "info", stored: false },
    ]);
    const dump = JSON.stringify(s.store.db.prepare("select * from mcp_server_env").all()) + JSON.stringify(s.store.db.prepare("select * from mcp_servers").all());
    expect(dump).not.toContain("ghp_supersecretvalue");
    const blobs = readdirSync(join(s.root, "data", "secrets"));
    expect(blobs).toHaveLength(1);
    expect(readFileSync(join(s.root, "data", "secrets", blobs[0]!)).subarray(0, 6).toString()).toBe("DPAPI:");
    // Saving again without a value keeps the stored secret.
    await s.servers.save({ ...input({ env: [{ name: "GITHUB_TOKEN", secret: true }] }), id: view.id });
    const env = await s.servers.envFor(s.servers.envRows(view.id));
    expect(env.env).toEqual({ GITHUB_TOKEN: "ghp_supersecretvalue" });
  });

  it("deletes a server's secret blobs with it and when a variable is removed", async () => {
    const s = setup();
    const view = await s.servers.save(input({ env: [{ name: "API_KEY", secret: true, value: "k1" }] }));
    await s.servers.save({ ...input({ env: [] }), id: view.id });
    expect(readdirSync(join(s.root, "data", "secrets"))).toHaveLength(0);
    const again = await s.servers.save(input({ name: "other", env: [{ name: "API_KEY", secret: true, value: "k2" }] }));
    expect(s.servers.remove(again.id)).toBe(true);
    expect(readdirSync(join(s.root, "data", "secrets"))).toHaveLength(0);
  });

  it("refuses secret-looking names as plain text and duplicate names in one scope", async () => {
    const s = setup();
    await expect(s.servers.save(input({ env: [{ name: "OPENAI_API_KEY", secret: false, value: "x" }] }))).rejects.toThrow("mcp.env_must_be_secret");
    await s.servers.save(input());
    await expect(s.servers.save(input())).rejects.toThrow("mcp.name_taken");
    await s.servers.save(input({ scope: "project", projectId: s.project.id }));
  });

  it("lets a project server replace a global one of the same name for that project", async () => {
    const s = setup();
    await s.servers.save(input({ args: ["global.js"] }));
    await s.servers.save(input({ scope: "project", projectId: s.project.id, args: ["project.js"] }));
    expect(s.servers.enabledFor(s.project.id).map((r) => r.view.args)).toEqual([["project.js"]]);
    expect(s.servers.list().map((v) => v.args)).toEqual([["global.js"]]);
    expect(s.servers.list(s.project.id)).toHaveLength(2);
  });

  it("forgets the checked tools when the command changes", async () => {
    const s = setup();
    const v = await s.servers.save(input());
    s.servers.setCheck(v.id, [{ name: "read_file", readOnly: true }], null);
    await s.servers.save({ ...input({ readOnlyAccess: "all" }), id: v.id });
    expect(s.servers.get(v.id).tools).toEqual([{ name: "read_file", readOnly: true }]);
    await s.servers.save({ ...input({ args: ["other.js"] }), id: v.id });
    expect(s.servers.get(v.id).tools).toBeNull();
  });

  it("warns about npx @latest and unpinned packages", async () => {
    const s = setup();
    const v = await s.servers.save(input({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@latest"] }));
    expect(v.warnings).toEqual([{ code: "floating", spec: "@modelcontextprotocol/server-filesystem@latest" }]);
  });
});

describe("planServers", () => {
  async function three(s: ReturnType<typeof setup>) {
    const files = await s.servers.save(input({ name: "files" }));
    s.servers.setCheck(files.id, [{ name: "read_file", readOnly: true }, { name: "write_file", readOnly: false }], null);
    const db = await s.servers.save(input({ name: "db", readOnlyAccess: "none" }));
    const docs = await s.servers.save(input({ name: "docs", readOnlyAccess: "all" }));
    return { files, db, docs };
  }
  const plan = (s: ReturnType<typeof setup>, policy: RolePolicy, toolFilter = true) => planServers(s.servers, { runId: "r1", taskId: "t1", projectId: s.project.id, policy, toolFilter, report }, ok);

  it("gives writers every enabled server with all tools, after the report server", async () => {
    const s = setup();
    await three(s);
    const p = await plan(s, writer);
    expect(p.specs.map((x) => [x.name, x.tools])).toEqual([
      ["crewyard", null],
      ["db", null],
      ["docs", null],
      ["files", null],
    ]);
    expect(p.specs[1]!.command).toBe("C:\\bin\\node.exe");
  });

  it("gives read-only roles only marked read tools, vouched servers whole, and nothing else", async () => {
    const s = setup();
    await three(s);
    const p = await plan(s, reader);
    expect(p.specs.map((x) => [x.name, x.tools])).toEqual([
      ["crewyard", null],
      ["docs", null],
      ["files", ["read_file"]],
    ]);
    expect(p.skipped).toEqual([{ name: "db", reason: "read_only" }]);
  });

  it("leaves a partly read-only server out for a read-only role on a runner without a tool filter", async () => {
    const s = setup();
    await three(s);
    const p = await plan(s, reader, false);
    expect(p.specs.map((x) => x.name)).toEqual(["crewyard", "docs"]);
    expect(p.skipped).toContainEqual({ name: "files", reason: "no_tool_filter" });
  });

  it("skips a server whose secret is missing or whose command is not found, and records the run", async () => {
    const s = setup();
    const v = await s.servers.save(input({ name: "gh", env: [{ name: "GH_TOKEN", secret: true }] }));
    await s.servers.save(input({ name: "gone", command: "missing-tool" }));
    const p = await planServers(s.servers, { runId: "r1", taskId: "t1", projectId: s.project.id, policy: writer, toolFilter: true, report }, async (c, a) => (c === "missing-tool" ? { ok: false, reason: "not_found" } : ok(c, a)));
    expect(p.skipped).toEqual([
      { name: "gh", reason: "missing_secret" },
      { name: "gone", reason: "not_found" },
    ]);
    recordUsage(s.store.db, { runId: "r1", taskId: "t1", projectId: s.project.id }, p, "2026-10-30T10:00:00.000Z");
    expect(runUsage(s.store.db, { projectId: s.project.id })).toMatchObject([{ runId: "r1", servers: [{ name: "crewyard" }], skipped: p.skipped }]);
    expect(v.env[0]!.stored).toBe(false);
  });

  it("passes decrypted secrets in the server's env only", async () => {
    const s = setup();
    await s.servers.save(input({ name: "gh", env: [{ name: "GH_TOKEN", secret: true, value: "ghs_value" }] }));
    const p = await plan(s, writer);
    expect(p.specs.find((x) => x.name === "gh")!.env).toEqual({ GH_TOKEN: "ghs_value" });
    expect(p.secrets).toEqual(["ghs_value"]);
  });
});

describe.runIf(process.platform === "win32")("resolveLaunch", () => {
  it("runs a .cmd shim through cmd.exe and refuses arguments cmd.exe would re-parse", async () => {
    const shim = async () => "C:\\Program Files\\nodejs\\npx.cmd";
    const l = await resolveLaunch("npx", ["-y", "pkg@1.0.0", "C:\\Work Folder"], shim);
    expect(l).toEqual({ ok: true, command: expect.stringMatching(/cmd\.exe$/i), args: ["/d", "/c", "npx.cmd", "-y", "pkg@1.0.0", "C:\\Work Folder"], env: { NoDefaultCurrentDirectoryInExePath: "1" } });
    expect(await resolveLaunch("npx", ["a&b"], shim)).toEqual({ ok: false, reason: "shell_syntax" });
    expect(await resolveLaunch("npx", ["%PATH%"], shim)).toEqual({ ok: false, reason: "shell_syntax" });
  });

  it("keeps an .exe as it is and reports a missing command", async () => {
    expect(await resolveLaunch("node", ["s.js"], async () => "C:\\bin\\node.exe")).toEqual({ ok: true, command: "C:\\bin\\node.exe", args: ["s.js"], env: {} });
    expect(await resolveLaunch("nope", [], async () => null)).toEqual({ ok: false, reason: "not_found" });
    expect(existsSync(process.execPath)).toBe(true);
    expect((await resolveLaunch(process.execPath, []))).toMatchObject({ ok: true, command: process.execPath });
  });
});

describe("checkServer", () => {
  // A stdio MCP server in a few lines: it answers initialize and pages its tools/list in two.
  const SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + String.fromCharCode(10));
console.error("starting with " + process.env.SECRET_VALUE);
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } } });
  if (m.method === "tools/list" && !m.params.cursor) out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "read_file", annotations: { readOnlyHint: true } }], nextCursor: "2" } });
  if (m.method === "tools/list" && m.params.cursor) out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "write_file", annotations: { readOnlyHint: false } }, { name: "search" }] } });
});`;

  it("lists tools across pages with their readOnlyHint and stops the server", async () => {
    const { checkServer } = await import("./check.ts");
    // A file, not -e: Windows argument quoting would rewrite the script's escapes.
    const file = join(tempDir("crewyard mcp check-"), "server.cjs");
    writeFileSync(file, SERVER);
    const res = await checkServer({ command: process.execPath, args: [file] }, { SECRET_VALUE: "hush" }, ["hush"], { timeoutMs: 15_000 });
    expect(res).toEqual({ ok: true, tools: [{ name: "read_file", readOnly: true }, { name: "write_file", readOnly: false }, { name: "search", readOnly: null }] });
  });

  it("reports a server that exits with its last stderr line, secrets masked", async () => {
    const { checkServer } = await import("./check.ts");
    const res = await checkServer({ command: process.execPath, args: ["-e", "console.error('bad key hush-hush'); process.exit(3)"] }, {}, ["hush-hush"], { timeoutMs: 15_000 });
    expect(res).toEqual({ ok: false, error: "bad key ***" });
  });
});
