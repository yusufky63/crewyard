import type { RolePolicy } from "@crewyard/core";
import type { PermissionRuleset } from "@opencode-ai/sdk/v2";

// Role policies become an OpenCode permission ruleset on the session, so the server itself refuses
// writes for read-only roles. OpenCode evaluates rules with findLast, so later rules win; the
// session ruleset is appended after the agent's own ("build" allows "*").

/** Edit patterns are paths relative to the worktree; OpenCode's "*" also matches across "/". */
export const DOC_PATTERNS = ["*.md", "*.mdx", "*.txt", "docs/*"];

const NETWORK_TOOLS = ["webfetch", "websearch"];

/**
 * Inspection commands a read-only role may run without asking, so a reviewer can read the diff.
 * OpenCode has no read-only command classifier of its own, so this list is short on purpose.
 */
export const READ_ONLY_COMMANDS = ["git diff", "git log", "git show", "git status", "git blame"];

/** Command shapes that write even when the command itself only reads: redirection and `--output`. */
const WRITING_SHAPES = ["*>*", "*--output*"];

/**
 * Shapes that chain a second command or expand into one (the characters of core's SHELL_SYNTAX).
 * An allow rule is a prefix glob ("pnpm test *"), so without these "pnpm test && curl ..." would
 * ride on it. OpenCode evaluates rules with findLast, so they go after the allow rules.
 */
export const CHAIN_SHAPES = [";", "&", "|", "<", ">", "`", "$", "(", ")", "{", "}", "%", "\n", "\r"].map((c) => `*${c}*`);

export function permissionRules(policy: RolePolicy): PermissionRuleset {
  const rules: PermissionRuleset = [];
  // The task tool starts OpenCode's own subagents, whose work would bypass the crew's DAG; never.
  rules.push({ permission: "task", pattern: "*", action: "deny" });
  if (policy.writes !== "worktree") rules.push({ permission: "edit", pattern: "*", action: "deny" });
  if (policy.writes === "docs") for (const pattern of DOC_PATTERNS) rules.push({ permission: "edit", pattern, action: "allow" });
  const allow = (cmd: string) => rules.push({ permission: "bash", pattern: cmd, action: "allow" }, { permission: "bash", pattern: `${cmd} *`, action: "allow" });
  if (policy.writes === "none") {
    // Read-only roles: the server refuses every command except the role's allowlist (its test and
    // build commands) and plain inspection; nothing reaches the Inbox.
    rules.push({ permission: "bash", pattern: "*", action: "deny" });
    for (const cmd of [...policy.allowCommands, ...READ_ONLY_COMMANDS]) allow(cmd);
    for (const pattern of [...WRITING_SHAPES, ...CHAIN_SHAPES]) rules.push({ permission: "bash", pattern, action: "deny" });
  } else {
    // Every command goes through our approval layer (risk classes, Inbox) unless the role allowlists it.
    rules.push({ permission: "bash", pattern: "*", action: "ask" });
    for (const cmd of policy.allowCommands) allow(cmd);
    // A chained command is never allowlisted: it goes to the approval layer, which rates it medium or high.
    for (const pattern of CHAIN_SHAPES) rules.push({ permission: "bash", pattern, action: "ask" });
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
  if (permission === "task") return true;
  // The ruleset settles every command of a read-only role; a question about one means it was bypassed.
  if (permission === "bash" && policy.writes === "none") return true;
  if (permission === "edit") {
    if (policy.writes === "none") return true;
    if (policy.writes === "docs") return patterns.length === 0 || !patterns.every(isDocsPath);
  }
  if (NETWORK_TOOLS.includes(permission) && policy.network === "denied") return true;
  return false;
}
