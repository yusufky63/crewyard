import type { McpServerSpec, RolePolicy } from "@crewyard/core";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

// Per-run MCP servers through the Agent SDK's `mcpServers` option (docs/adr/0007). Tools are
// named `mcp__<server>__<tool>` (sdk.d.ts 0.3.312). `strictMcpConfig` keeps the repository's
// `.mcp.json` and the profile's settings out, so a run gets exactly the servers Crewyard recorded.
// - The report server is pre-allowed for every role; it changes nothing in the worktree.
// - Read-only roles run in "dontAsk", so only allowed tools run: the report tools and the read
//   tools Crewyard picked for the role. The PreToolUse hook refuses any other MCP tool again.
// - Writers ask for user server tools through canUseTool, like any other tool.

export const mcpToolName = (server: string, tool: string) => `mcp__${server}__${tool}`;

export function mcpServersOption(specs: readonly McpServerSpec[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  // alwaysLoad keeps the report tools out of tool search: some Anthropic-compatible providers
  // do not support it, and the tools must be there from the first turn.
  for (const s of specs) out[s.name] = { type: "stdio", command: s.command, args: s.args, env: s.env, ...(s.builtin ? { alwaysLoad: true } : {}) };
  return out;
}

/** allowedTools entries: the report server's tools always, and for read-only roles the user tools they may call. */
export function mcpAllowedTools(specs: readonly McpServerSpec[], policy: RolePolicy): string[] {
  const out: string[] = [];
  for (const s of specs) {
    if (s.builtin) out.push(`mcp__${s.name}`);
    else if (policy.writes === "none") out.push(...(s.tools ? s.tools.map((t) => mcpToolName(s.name, t)) : [`mcp__${s.name}`]));
  }
  return out;
}

/** Second layer for read-only roles: an MCP tool that is not one Crewyard gave the role is refused. */
export function mcpToolRefused(name: string, specs: readonly McpServerSpec[], policy: RolePolicy): boolean {
  if (!name.startsWith("mcp__") || policy.writes !== "none") return false;
  const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(name) ?? [];
  const spec = specs.find((s) => s.name === server);
  if (!spec || !tool) return true;
  return spec.tools !== null && !spec.tools.includes(tool);
}

/** A user server's tool call is rated like network access (medium risk, the Inbox decides). */
export const isUserMcpTool = (name: string, specs: readonly McpServerSpec[]) => name.startsWith("mcp__") && !specs.some((s) => s.builtin && name.startsWith(`mcp__${s.name}__`));
