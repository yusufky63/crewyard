import type { RolePolicy } from "@crewyard/core";
import type { PermissionRuleset } from "@opencode-ai/sdk/v2";

// Role policies become an OpenCode permission ruleset on the session, so the server itself refuses
// writes for read-only roles. OpenCode evaluates rules with findLast, so later rules win; the
// session ruleset is appended after the agent's own ("build" allows "*").

/** Edit patterns are paths relative to the worktree; OpenCode's "*" also matches across "/". */
export const DOC_PATTERNS = ["*.md", "*.mdx", "*.txt", "docs/*"];

const NETWORK_TOOLS = ["webfetch", "websearch"];

export function permissionRules(policy: RolePolicy): PermissionRuleset {
  const rules: PermissionRuleset = [];
  if (policy.writes !== "worktree") rules.push({ permission: "edit", pattern: "*", action: "deny" });
  if (policy.writes === "docs") for (const pattern of DOC_PATTERNS) rules.push({ permission: "edit", pattern, action: "allow" });
  // Every command goes through our approval layer (risk classes, Inbox) unless the role allowlists it.
  rules.push({ permission: "bash", pattern: "*", action: "ask" });
  for (const cmd of policy.allowCommands) {
    rules.push({ permission: "bash", pattern: cmd, action: "allow" });
    rules.push({ permission: "bash", pattern: `${cmd} *`, action: "allow" });
  }
  const network = policy.network === "allowed" ? "allow" : policy.network === "denied" ? "deny" : "ask";
  for (const permission of NETWORK_TOOLS) rules.push({ permission, pattern: "*", action: network });
  return rules;
}

export function isDocsPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return /\.(md|mdx|txt)$/i.test(p) || p.startsWith("docs/");
}

/**
 * Second line of defence: a permission request that the role must never grant is rejected by the
 * adapter without reaching the user, even if the server asked despite the ruleset.
 */
export function mustReject(policy: RolePolicy, permission: string, patterns: string[]): boolean {
  if (permission === "edit") {
    if (policy.writes === "none") return true;
    if (policy.writes === "docs") return patterns.length === 0 || !patterns.every(isDocsPath);
  }
  if (NETWORK_TOOLS.includes(permission) && policy.network === "denied") return true;
  return false;
}
