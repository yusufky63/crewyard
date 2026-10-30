import type { McpServerSpec, RolePolicy } from "@crewyard/core";
import type { PermissionRuleset } from "@opencode-ai/sdk/v2";
import { mcpPermissionRules } from "../mcp.ts";
import { mustReject, permissionRules } from "../policy.ts";
import type { PermissionRule } from "./api.ts";

// 2.x takes the same role policy as an ordered `permissions` list of { action, resource, effect }
// in which the last matching rule wins, like 1.x's findLast (opencode.ai/v2/docs/permissions,
// opened 2026-10-31). The rules are therefore built once, by the 1.x code, and only renamed here:
// `bash` became `shell` and `task` became `subagent` (opencode.ai/v2/docs/migrate-v1).

const RENAMED: Record<string, string> = { bash: "shell", task: "subagent" };
const BACK = Object.fromEntries(Object.entries(RENAMED).map(([v1, v2]) => [v2, v1]));

export function toV2Rules(rules: PermissionRuleset): PermissionRule[] {
  return rules.map((r) => ({ action: RENAMED[r.permission] ?? r.permission, resource: r.pattern, effect: r.action }));
}

export function permissionRulesV2(policy: RolePolicy, mcp: readonly McpServerSpec[] = []): PermissionRule[] {
  return [
    // 2.x allows paths outside the worktree by default; 1.x asked, and the approval layer expects to.
    { action: "external_directory", resource: "*", effect: "ask" },
    // `execute` runs code that calls MCP tools (Code Mode). Crewyard turns Code Mode off per server;
    // should it run anyway, a writer is asked and a read-only role refused, like a command.
    { action: "execute", resource: "*", effect: policy.writes === "none" ? "deny" : "ask" },
    ...toV2Rules([...permissionRules(policy), ...mcpPermissionRules(mcp, policy)]),
  ];
}

/** The adapter's second line of defence, on 2.x action names. */
export function mustRejectV2(policy: RolePolicy, action: string, resources: string[]): boolean {
  if (action === "execute" && policy.writes === "none") return true;
  return mustReject(policy, BACK[action] ?? action, resources);
}
