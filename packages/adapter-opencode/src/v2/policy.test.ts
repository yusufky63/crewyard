import type { McpServerSpec, RolePolicy } from "@crewyard/core";
import { describe, expect, it } from "vitest";
import { permissionRules } from "../policy.ts";
import { mustRejectV2, permissionRulesV2, toV2Rules } from "./policy.ts";

const WORKTREE: RolePolicy = { writes: "worktree", allowCommands: ["pnpm test"], network: "ask" };
const READ_ONLY: RolePolicy = { writes: "none", allowCommands: [], network: "denied" };

describe("2.x permission rules", () => {
  it("are 1.x's rules in the same order with 2.x action names", () => {
    const v1 = permissionRules(WORKTREE);
    const v2 = toV2Rules(v1);
    expect(v2).toHaveLength(v1.length);
    expect(v2[0]).toEqual({ action: "subagent", resource: "*", effect: "deny" });
    expect(v2.filter((r) => r.action === "shell").map((r) => r.resource)).toEqual(v1.filter((r) => r.permission === "bash").map((r) => r.pattern));
    expect(v2.some((r) => r.action === "bash" || r.action === "task")).toBe(false);
  });

  it("ask before leaving the worktree and keep code execution away from read-only roles", () => {
    expect(permissionRulesV2(WORKTREE).slice(0, 2)).toEqual([
      { action: "external_directory", resource: "*", effect: "ask" },
      { action: "execute", resource: "*", effect: "ask" },
    ]);
    const ro = permissionRulesV2(READ_ONLY);
    expect(ro[1]).toEqual({ action: "execute", resource: "*", effect: "deny" });
    // Later rules win, so the read-only edit deny must come after nothing that allows edits.
    expect(ro.filter((r) => r.action === "edit")).toEqual([{ action: "edit", resource: "*", effect: "deny" }]);
    expect(ro.filter((r) => r.action === "webfetch")).toEqual([{ action: "webfetch", resource: "*", effect: "deny" }]);
  });

  it("carry the MCP rules: report tools allowed, a read-only role's server limited to its read tools", () => {
    const specs: McpServerSpec[] = [
      { name: "crewyard", command: "node", args: [], env: {}, tools: null, builtin: true },
      { name: "docs", command: "node", args: [], env: {}, tools: ["search"], builtin: false },
    ];
    const rules = permissionRulesV2(READ_ONLY, specs).slice(-3);
    expect(rules).toEqual([
      { action: "crewyard_*", resource: "*", effect: "allow" },
      { action: "docs_*", resource: "*", effect: "deny" },
      { action: "docs_search", resource: "*", effect: "allow" },
    ]);
  });

  it("are backed by the adapter's own refusal on 2.x action names", () => {
    expect(mustRejectV2(WORKTREE, "subagent", [])).toBe(true);
    expect(mustRejectV2(READ_ONLY, "shell", ["ls"])).toBe(true);
    expect(mustRejectV2(WORKTREE, "shell", ["ls"])).toBe(false);
    expect(mustRejectV2(READ_ONLY, "execute", [])).toBe(true);
    expect(mustRejectV2({ ...WORKTREE, writes: "docs" }, "edit", ["src/a.ts"])).toBe(true);
    expect(mustRejectV2({ ...WORKTREE, writes: "docs" }, "edit", ["docs/a.md"])).toBe(false);
  });
});
