import type { McpServerSpec } from "@crewyard/core";
import type * as acp from "@agentclientprotocol/sdk";

// Per-run MCP servers through ACP's `session/new` and `session/load` `mcpServers` (stdio entries:
// name, absolute command, args, env as name/value pairs; agentclientprotocol.com session-setup,
// checked 2026-10-30). ACP has no way to limit a server to some of its tools, so the daemon gives
// a read-only role only servers whose every tool it may use (capabilities.mcp.toolFilter false).
// Gemini CLI marks an MCP tool's permission request with `_meta["gemini-cli"].mcp.server_name`;
// the report server's are allowed here, a user server's are rated like network access.

export function acpMcpServers(specs: readonly McpServerSpec[]): acp.McpServer[] {
  return specs.map((s) => ({ name: s.name, command: s.command, args: [...s.args], env: Object.entries(s.env).map(([name, value]) => ({ name, value })) }));
}

/** The MCP server a permission request is for, when the agent says (Gemini CLI); null otherwise. */
export function mcpServerOf(toolCall: { _meta?: Record<string, unknown> | null }): string | null {
  const g = toolCall._meta?.["gemini-cli"] as { mcp?: { server_name?: unknown } } | undefined;
  return typeof g?.mcp?.server_name === "string" ? g.mcp.server_name : null;
}
