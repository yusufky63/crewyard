import type { DatabaseSync } from "node:sqlite";
import type { McpRunUsage, McpServerSpec, RolePolicy } from "@crewyard/core";
import type { Launch } from "./launch.ts";
import type { McpServerStore, ServerRecord } from "./servers.ts";

// Which MCP servers one run gets (docs/adr/0007). Crewyard's report server always, for every role.
// Then the user's enabled servers for the project, except where the role forbids them:
// - a read-only role gets only the tools a server marks readOnlyHint (access "marked"), every
//   tool when you vouched for the server ("all"), or nothing ("none");
// - a runner that cannot limit a server's tools (Gemini over ACP) gets a "marked" server for a
//   read-only role not at all, rather than all of its tools.
// What was given and what was left out, with why, is recorded per run for Settings.

export interface PlanInput {
  runId: string;
  taskId: string;
  projectId: string;
  policy: RolePolicy;
  toolFilter: boolean;
  report: McpServerSpec;
}

export interface Plan {
  specs: McpServerSpec[];
  servers: McpRunUsage["servers"];
  skipped: McpRunUsage["skipped"];
  /** Decrypted values, so callers can keep them out of anything they log. */
  secrets: string[];
}

export async function planServers(store: McpServerStore, input: PlanInput, resolve: (command: string, args: string[]) => Promise<Launch>): Promise<Plan> {
  const plan: Plan = { specs: [input.report], servers: [{ name: input.report.name, serverId: null, tools: null }], skipped: [], secrets: [] };
  const readOnly = input.policy.writes === "none";
  for (const rec of store.enabledFor(input.projectId)) {
    const tools = toolsFor(rec, readOnly, input.toolFilter);
    if (tools === "skip_read_only" || tools === "skip_unchecked" || tools === "skip_filter") {
      plan.skipped.push({ name: rec.view.name, reason: tools === "skip_filter" ? "no_tool_filter" : tools === "skip_unchecked" ? "read_only_unchecked" : "read_only" });
      continue;
    }
    const env = await store.envFor(rec.env);
    if (env.missing.length) {
      plan.skipped.push({ name: rec.view.name, reason: "missing_secret" });
      continue;
    }
    const launch = await resolve(rec.view.command, rec.view.args);
    if (!launch.ok) {
      plan.skipped.push({ name: rec.view.name, reason: launch.reason });
      continue;
    }
    plan.secrets.push(...env.secrets);
    plan.specs.push({ name: rec.view.name, command: launch.command, args: launch.args, env: { ...launch.env, ...env.env }, tools, builtin: false });
    plan.servers.push({ name: rec.view.name, serverId: rec.view.id, tools });
  }
  return plan;
}

type Tools = string[] | null | "skip_read_only" | "skip_unchecked" | "skip_filter";

function toolsFor(rec: ServerRecord, readOnly: boolean, toolFilter: boolean): Tools {
  if (!readOnly) return null;
  const access = rec.view.readOnlyAccess;
  if (access === "none") return "skip_read_only";
  if (access === "all") return null;
  if (!rec.view.tools) return "skip_unchecked";
  const marked = rec.view.tools.filter((t) => t.readOnly === true).map((t) => t.name);
  if (marked.length === 0) return "skip_read_only";
  // Every tool is read-only: no filter needed, so any runner can take it.
  if (marked.length === rec.view.tools.length) return null;
  return toolFilter ? marked : "skip_filter";
}

export function recordUsage(db: DatabaseSync, input: Pick<PlanInput, "runId" | "taskId" | "projectId">, plan: Plan, at: string): void {
  db.prepare("insert or replace into mcp_run_servers (run_id, task_id, project_id, servers, skipped, at) values (?, ?, ?, ?, ?, ?)").run(input.runId, input.taskId, input.projectId, JSON.stringify(plan.servers), JSON.stringify(plan.skipped), at);
}

export function runUsage(db: DatabaseSync, filter: { projectId?: string; serverId?: string; limit?: number }): McpRunUsage[] {
  const where = ["1 = 1"];
  const args: Array<string | number> = [];
  if (filter.projectId) {
    where.push("m.project_id = ?");
    args.push(filter.projectId);
  }
  if (filter.serverId) {
    where.push("m.servers like ?");
    args.push(`%"serverId":"${filter.serverId.replace(/[%_"]/g, "")}"%`);
  }
  args.push(Math.min(Math.max(filter.limit ?? 50, 1), 500));
  const rows = db
    .prepare(
      `select m.run_id, m.task_id, m.project_id, m.servers, m.skipped, m.at, r.role, r.runner, r.started_at, t.title
       from mcp_run_servers m left join runs r on r.id = m.run_id left join tasks t on t.id = m.task_id
       where ${where.join(" and ")} order by m.at desc limit ?`,
    )
    .all(...args) as Array<{ run_id: string; task_id: string; project_id: string; servers: string; skipped: string; at: string; role: string | null; runner: string | null; started_at: string | null; title: string | null }>;
  const parse = <T>(s: string): T[] => {
    try {
      const v = JSON.parse(s) as unknown;
      return Array.isArray(v) ? (v as T[]) : [];
    } catch {
      return [];
    }
  };
  return rows.map((r) => ({
    runId: r.run_id,
    taskId: r.task_id,
    projectId: r.project_id,
    taskTitle: r.title ?? "",
    role: r.role ?? "",
    runner: r.runner ?? "",
    startedAt: r.started_at ?? r.at,
    servers: parse(r.servers),
    skipped: parse(r.skipped),
  }));
}
