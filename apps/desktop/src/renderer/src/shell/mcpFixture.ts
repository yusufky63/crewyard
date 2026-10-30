import { commandWarnings, type CrewReportView, type McpRunUsage, type McpServerView, type TaskDetail, type TimelineEvent } from "@crewyard/core";

// Screenshot data for crew reports and MCP servers (docs/adr/0007). Used only in screenshot mode
// (`fixture` in the page URL), through the fixture router in screens/tasks/fixture.ts.

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

export function fixtureReports(projectId: string): CrewReportView[] {
  const base = { projectId, closedAt: null, closedBy: null, taskCreated: null, artifacts: [] as string[] };
  return [
    { ...base, id: "rp-1", taskId: "t-running", runId: "r-m6", memberId: "m6", type: "needs_input", title: null, text: "Should a locked account get 429 with Retry-After, or 423? The spec allows both and the existing handlers use neither.", createdAt: ago(3) },
    { ...base, id: "rp-2", taskId: "t-running", runId: "r-m6", memberId: "m6", type: "followup", title: "Move the session cache to Redis", text: "The limiter keeps counters in memory, so two app instances would each allow five attempts.", createdAt: ago(9) },
  ];
}

const server = (over: Partial<McpServerView> & Pick<McpServerView, "id" | "name" | "command" | "args">): McpServerView => ({
  scope: "global",
  projectId: null,
  env: [],
  enabled: true,
  readOnlyAccess: "marked",
  tools: null,
  checkedAt: null,
  checkError: null,
  warnings: commandWarnings(over.command, over.args),
  updatedAt: ago(60),
  ...over,
});

export function fixtureServers(projectId: string | undefined): McpServerView[] {
  return [
    server({
      id: "mcp-1",
      name: "github",
      command: "C:\\Tools\\github-mcp-server.exe",
      args: ["stdio", "--read-only=false"],
      env: [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", secret: true, value: null, stored: true }],
      tools: [
        { name: "get_issue", readOnly: true },
        { name: "list_pull_requests", readOnly: true },
        { name: "search_code", readOnly: true },
        { name: "create_issue", readOnly: false },
        { name: "create_pull_request", readOnly: false },
      ],
      checkedAt: ago(42),
    }),
    server({ id: "mcp-2", name: "docs", command: "npx", args: ["-y", "@acme/docs-mcp@latest"], readOnlyAccess: "none", tools: [{ name: "search_docs", readOnly: null }, { name: "fetch_page", readOnly: null }], checkedAt: ago(130) }),
    ...(projectId ? [server({ id: "mcp-3", name: "postgres", scope: "project", projectId, command: "uvx", args: ["postgres-mcp==0.3.0", "--access-mode=restricted"], env: [{ name: "DATABASE_URI", secret: true, value: null, stored: false }, { name: "LOG_LEVEL", secret: false, value: "info", stored: false }], enabled: false })] : []),
  ];
}

export function fixtureUsage(projectId: string | undefined): McpRunUsage[] {
  const p = projectId ?? "p";
  return [
    { runId: "r-m6", taskId: "t-running", projectId: p, taskTitle: "Add rate limiting to the login endpoint", role: "implementer", runner: "claude-code", startedAt: ago(10), servers: [{ name: "crewyard", serverId: null, tools: null }, { name: "github", serverId: "mcp-1", tools: null }, { name: "docs", serverId: "mcp-2", tools: null }], skipped: [] },
    { runId: "r-m7", taskId: "t-running", projectId: p, taskTitle: "Add rate limiting to the login endpoint", role: "reviewer", runner: "opencode", startedAt: ago(4), servers: [{ name: "crewyard", serverId: null, tools: null }, { name: "github", serverId: "mcp-1", tools: ["get_issue", "list_pull_requests", "search_code"] }], skipped: [{ name: "docs", reason: "read_only" }] },
  ];
}

/** Report events for the timeline fixture: what the running implementer sent. */
export function fixtureReportEvents(detail: TaskDetail, push: (at: number, runId: string | null, e: Extract<TimelineEvent, { kind: "report" }> extends infer E ? Omit<E, "seq" | "at" | "runId"> : never) => void): void {
  const r = detail.runs.find((x) => x.endedAt === null) ?? detail.runs[0];
  if (!r) return;
  const start = Date.parse(r.startedAt);
  const end = r.endedAt ? Date.parse(r.endedAt) : Date.now();
  const at = (f: number) => start + (end - start) * f;
  push(at(0.3), r.id, { kind: "report", reportId: "rp-0", report: "checkpoint", text: "The token bucket and its tests are in; the handler change is next.", title: null });
  if (!r.endedAt) push(at(0.8), r.id, { kind: "report", reportId: "rp-1", report: "needs_input", text: "Should a locked account get 429 with Retry-After, or 423?", title: null });
}
