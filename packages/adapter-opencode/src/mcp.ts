import type { McpServerSpec, RolePolicy } from "@crewyard/core";
import type { PermissionRuleset } from "@opencode-ai/sdk/v2";

// Per-run MCP servers through OpenCode's config (docs/adr/0007), given inline in
// OPENCODE_CONFIG_CONTENT like the provider block, so nothing is written into the profile's or the
// repository's config. Tools are named `<server>_<tool>` (opencode.ai/docs/mcp-servers).
// - 1.x (the version we drive): `mcp.<name> = { type: "local", command: [cmd, ...args],
//   environment, enabled, timeout }`.
// - 2.x moves servers to `mcp.servers.<name>` and turns on Code Mode for every server, which calls
//   MCP tools through one `execute` tool, so `<server>_*` permission rules would no longer match the
//   call. Crewyard writes `codemode: false` there; 2.x stays refused until its conformance run.
// Permissions ride on the session ruleset, where later rules win: a read-only role's server is
// denied as a whole and then allowed tool by tool.

/** Startup timeout; npx and uvx servers may download on first use. */
const TIMEOUT_MS = 30_000;

export function mcpConfig(specs: readonly McpServerSpec[], major = 1): Record<string, unknown> {
  if (specs.length === 0) return {};
  const servers: Record<string, unknown> = {};
  for (const s of specs) {
    servers[s.name] =
      major >= 2
        ? { type: "local", command: [s.command, ...s.args], environment: { ...s.env }, codemode: false, timeout: { startup: TIMEOUT_MS } }
        : { type: "local", command: [s.command, ...s.args], environment: { ...s.env }, enabled: true, timeout: TIMEOUT_MS };
  }
  return { mcp: major >= 2 ? { servers } : servers };
}

/** Session rules appended after the role's own: report tools allowed, user tools asked (writers) or limited (read-only). */
export function mcpPermissionRules(specs: readonly McpServerSpec[], policy: RolePolicy): PermissionRuleset {
  const rules: PermissionRuleset = [];
  for (const s of specs) {
    if (s.builtin) {
      rules.push({ permission: `${s.name}_*`, pattern: "*", action: "allow" });
      continue;
    }
    if (policy.writes !== "none") {
      rules.push({ permission: `${s.name}_*`, pattern: "*", action: "ask" });
      continue;
    }
    if (!s.tools) {
      rules.push({ permission: `${s.name}_*`, pattern: "*", action: "allow" });
      continue;
    }
    rules.push({ permission: `${s.name}_*`, pattern: "*", action: "deny" });
    for (const t of s.tools) rules.push({ permission: `${s.name}_${t}`, pattern: "*", action: "allow" });
  }
  return rules;
}

/**
 * The project bridge for OpenCode (docs/adr/0015): its `instructions` config takes extra instruction
 * files, relative to the project (opencode.ai/docs/rules), in 1.x and in 2.x. Relative names keep a
 * project path with spaces or brackets out of OpenCode's glob matching. Merged into the inline config.
 */
export function withInstructions(extra: Record<string, string>, files: readonly string[] | undefined): Record<string, string> {
  if (!files || files.length === 0) return extra;
  const base = extra.OPENCODE_CONFIG_CONTENT ? (JSON.parse(extra.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>) : {};
  return { ...extra, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...base, instructions: files.map((f) => f.split("\\").join("/")) }) };
}

/** Merges the MCP block into the launch's inline config (OPENCODE_CONFIG_CONTENT), keeping the provider block. */
export function withMcpConfig(extra: Record<string, string>, block: Record<string, unknown>): Record<string, string> {
  if (Object.keys(block).length === 0) return extra;
  let base: Record<string, unknown> = {};
  if (extra.OPENCODE_CONFIG_CONTENT) base = JSON.parse(extra.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>;
  return { ...extra, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...base, ...block }) };
}

/** The permission a request names for a user server's tool, so the adapter can rate it like network access. */
export function isUserMcpPermission(permission: string, specs: readonly McpServerSpec[]): boolean {
  return specs.some((s) => !s.builtin && permission.startsWith(`${s.name}_`));
}
