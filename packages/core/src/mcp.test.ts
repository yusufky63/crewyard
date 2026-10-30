import { describe, expect, it } from "vitest";
import { cleanText, commandWarnings, mcpInputProblem, packageSpecs, parseFollowup, parseReport, REPORT_LIMITS, type McpServerInput } from "./mcp.ts";

describe("parseReport", () => {
  it("takes a well-formed report and drops duplicate artifact paths", () => {
    expect(parseReport({ kind: "checkpoint", text: " tests pass ", artifacts: ["out/a.txt", "out/a.txt"] })).toEqual({ ok: true, value: { kind: "checkpoint", text: "tests pass", artifacts: ["out/a.txt"] } });
  });

  it("refuses unknown kinds, empty text and non-objects", () => {
    expect(parseReport({ kind: "spawn", text: "x" }).ok).toBe(false);
    expect(parseReport({ kind: "done", text: "   " }).ok).toBe(false);
    expect(parseReport("done").ok).toBe(false);
    expect(parseReport(null).ok).toBe(false);
  });

  it("refuses text past the byte cap instead of cutting it, counting UTF-8 bytes", () => {
    const ok = parseReport({ kind: "stuck", text: "a".repeat(REPORT_LIMITS.textBytes) });
    expect(ok.ok).toBe(true);
    // 700 three-byte characters are 2,100 bytes, past the 2,000-byte cap though only 700 long.
    const wide = parseReport({ kind: "stuck", text: "ş€".repeat(350) + "€".repeat(350) });
    expect(wide).toEqual({ ok: false, error: expect.stringContaining("the limit is 2000") });
  });

  it("caps the number and size of artifact paths and refuses multi-line paths", () => {
    expect(parseReport({ kind: "done", text: "x", artifacts: Array.from({ length: 11 }, (_, i) => `f${i}`) }).ok).toBe(false);
    expect(parseReport({ kind: "done", text: "x", artifacts: ["a".repeat(261)] }).ok).toBe(false);
    expect(parseReport({ kind: "done", text: "x", artifacts: ["a\tb"] }).ok).toBe(false);
    expect(parseReport({ kind: "done", text: "x", artifacts: "a.txt" }).ok).toBe(false);
  });

  it("removes control and bidirectional override characters", () => {
    expect(cleanText("ok\u0007 \u202Etxt.exe\u202C\r\nnext")).toBe("ok txt.exe\nnext");
    const r = parseReport({ kind: "checkpoint", text: "a\u0000b" });
    expect(r.ok && r.value.text).toBe("ab");
  });
});

describe("parseFollowup", () => {
  it("needs a one-line title and caps both fields", () => {
    expect(parseFollowup({ title: "Add a cache", description: "Later." })).toEqual({ ok: true, value: { title: "Add a cache", description: "Later." } });
    expect(parseFollowup({ title: "two\nlines" }).ok).toBe(false);
    expect(parseFollowup({ title: "t".repeat(121) }).ok).toBe(false);
    expect(parseFollowup({ title: "t", description: "d".repeat(4001) }).ok).toBe(false);
    expect(parseFollowup({ description: "no title" }).ok).toBe(false);
  });
});

describe("commandWarnings", () => {
  it("flags npx @latest as floating and a bare package as unpinned", () => {
    expect(commandWarnings("npx", ["-y", "@modelcontextprotocol/server-filesystem@latest", "C:\\Work Folder"])).toEqual([{ code: "floating", spec: "@modelcontextprotocol/server-filesystem@latest" }]);
    expect(commandWarnings("C:\\Program Files\\nodejs\\npx.cmd", ["-y", "mcp-server-git"])).toEqual([{ code: "unpinned", spec: "mcp-server-git" }]);
    expect(commandWarnings("npx", ["-y", "some-server@^1.2.0"])).toEqual([{ code: "unpinned", spec: "some-server@^1.2.0" }]);
  });

  it("accepts exact versions, scoped or not, and Python pins", () => {
    expect(commandWarnings("npx", ["-y", "@scope/server@1.4.2"])).toEqual([]);
    expect(commandWarnings("uvx", ["mcp-server-time==2025.9.1"])).toEqual([]);
    expect(commandWarnings("uvx", ["--from", "mcp-server-git==1.0.0", "mcp-server-git"])).toEqual([]);
    expect(commandWarnings("uvx", ["mcp-server-time"])).toEqual([{ code: "unpinned", spec: "mcp-server-time" }]);
  });

  it("reads pnpm dlx, npm exec and --package values, and ignores plain programs and local paths", () => {
    expect(packageSpecs("pnpm", ["dlx", "srv@next"])).toEqual(["srv@next"]);
    expect(packageSpecs("npm", ["exec", "--package=tool@2.0.0", "--", "tool"])).toEqual(["tool@2.0.0"]);
    expect(packageSpecs("pnpm", ["test"])).toEqual([]);
    expect(packageSpecs("node", ["server.js"])).toEqual([]);
    expect(packageSpecs("npx", ["./local-server"])).toEqual([]);
  });
});

describe("mcpInputProblem", () => {
  const base: McpServerInput = { scope: "global", name: "files", command: "node", args: ["server.js"], env: [], enabled: true, readOnlyAccess: "none" };

  it("accepts a plain server", () => {
    expect(mcpInputProblem(base)).toBeNull();
  });

  it("keeps the report server's name and plain tool names", () => {
    expect(mcpInputProblem({ ...base, name: "crewyard" })).toBe("mcp.name_reserved");
    expect(mcpInputProblem({ ...base, name: "My Server" })).toBe("mcp.name_invalid");
  });

  it("refuses a secret-looking variable stored as plain text, and reserved names", () => {
    expect(mcpInputProblem({ ...base, env: [{ name: "GITHUB_TOKEN", secret: false, value: "x" }] })).toBe("mcp.env_must_be_secret");
    expect(mcpInputProblem({ ...base, env: [{ name: "GITHUB_TOKEN", secret: true, value: "x" }] })).toBeNull();
    expect(mcpInputProblem({ ...base, env: [{ name: "CREWYARD_RUN_TICKET", secret: false, value: "x" }] })).toBe("mcp.env_name_invalid");
    expect(mcpInputProblem({ ...base, env: [{ name: "A", secret: false }, { name: "a", secret: false }] })).toBe("mcp.env_duplicate");
  });

  it("needs a project for project scope and refuses multi-line commands", () => {
    expect(mcpInputProblem({ ...base, scope: "project" })).toBe("mcp.project_required");
    expect(mcpInputProblem({ ...base, command: "node\nevil" })).toBe("mcp.command_invalid");
    expect(mcpInputProblem({ ...base, args: ["a\nb"] })).toBe("mcp.args_invalid");
  });
});
