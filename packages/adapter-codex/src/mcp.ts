import type { McpServerSpec, RolePolicy } from "@crewyard/core";
import type { JsonValue } from "./protocol/serde_json/JsonValue";

// Per-run MCP servers through the thread's config overrides (`thread/start` and `thread/resume`
// `config`), as `mcp_servers.<name>` tables (Codex config reference, checked 2026-10-30):
// command, args, env_vars, enabled, startup_timeout_sec, enabled_tools, default_tools_approval_mode.
// `type` is never written: Codex warns about it as an unknown field for stdio servers.
// - Values never go into the config, which travels over the app-server's stdio and may be logged:
//   they are set in the app-server's own env and named in `env_vars`, and the thread's
//   shell_environment_policy excludes those names from the agent's commands.
// - The report server's tools run without asking (`approve`).
// - A writer's user server asks for every call (`prompt`), which arrives as
//   mcpServer/elicitation/request and goes to the Inbox like any approval.
// - A read-only role gets only the read tools picked for it (`enabled_tools`), run without asking,
//   since a read-only Codex run declines every approval.

export interface McpPlan {
  /** Dotted config overrides for the thread. */
  config: Record<string, JsonValue>;
  /** Variables for the app-server process, passed on to the servers by name. */
  env: Record<string, string>;
}

export function mcpPlan(specs: readonly McpServerSpec[], policy: RolePolicy): McpPlan {
  const config: Record<string, JsonValue> = {};
  const env: Record<string, string> = {};
  const readOnly = policy.writes === "none";
  for (const s of specs) {
    const names: string[] = [];
    const inline: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.env)) {
      // Two servers that need different values under one name: the later one keeps its value inline.
      if (k in env && env[k] !== v) inline[k] = v;
      else {
        env[k] = v;
        names.push(k);
      }
    }
    const table: Record<string, JsonValue> = { command: s.command, args: [...s.args], env_vars: names, enabled: true, startup_timeout_sec: 30 };
    if (Object.keys(inline).length) table.env = inline;
    if (s.tools) table.enabled_tools = [...s.tools];
    table.default_tools_approval_mode = s.builtin || readOnly ? "approve" : "prompt";
    config[`mcp_servers.${s.name}`] = table;
  }
  return { config, env };
}

/** What an MCP approval elicitation asks for (`_meta.codex_approval_kind: "mcp_tool_call"`), or null for a form. */
export function mcpToolApproval(params: unknown): { server: string; tool: string } | null {
  const p = params as { serverName?: unknown; request?: { _meta?: { codex_approval_kind?: unknown; tool_name?: unknown } } } | null;
  const meta = p?.request?._meta;
  if (meta?.codex_approval_kind !== "mcp_tool_call") return null;
  return { server: typeof p?.serverName === "string" ? p.serverName : "", tool: typeof meta.tool_name === "string" ? meta.tool_name : "" };
}
