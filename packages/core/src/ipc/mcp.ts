import type { CrewReportType, McpRunUsage, McpServerInput, McpServerView } from "../mcp.ts";
import type { SessionSeen } from "./tasks.ts";

// IPC methods for MCP: crew reports and follow-up proposals from agents (feature scan A14), and the
// user's own stdio MCP servers managed in Settings (docs/adr/0007). Implemented in
// packages/daemon/src/handlers/mcp.ts.

export interface CrewReportView {
  id: string;
  projectId: string;
  taskId: string;
  runId: string;
  memberId: string;
  type: CrewReportType;
  /** The agent's text, cleaned and capped (core/mcp.ts); render it as text, never as markup. */
  text: string;
  /** Follow-ups only. */
  title: string | null;
  /** Paths inside the run's working folder, relative to it. */
  artifacts: string[];
  createdAt: string;
  /** You dismissed it, or (needs input) answered it. */
  closedAt: string | null;
  closedBy: "dismissed" | "replied" | "accepted" | "run_ended" | null;
  /** A follow-up you turned into a draft task. The task still waits for its crew approval. */
  taskCreated: string | null;
}

export interface McpIpc {
  /** Global servers plus, with a project, that project's. */
  "mcp.servers.list": { params: { projectId?: string }; result: McpServerView[] };
  /**
   * Adds or updates a server. Secret env values go to DPAPI and are never returned; nothing is
   * written into the project folder. Fails with an `mcp.*` code (core/mcp.ts mcpInputProblem).
   */
  "mcp.servers.save": { params: McpServerInput; result: McpServerView };
  "mcp.servers.remove": { params: { id: string }; result: { removed: boolean } };
  /**
   * Starts the server once (initialize, tools/list) to learn its tools and their readOnlyHint,
   * then stops its process tree. Runs only when you click; it runs the command you entered.
   */
  "mcp.servers.check": { params: { id: string }; result: McpServerView };
  /** Which runs got which servers, newest first. */
  "mcp.servers.usage": { params: { projectId?: string; serverId?: string; limit?: number }; result: McpRunUsage[] };
  /** Reports and proposals; open Inbox items only unless `includeClosed`. */
  "mcp.reports.list": { params: { projectId?: string; taskId?: string; runId?: string; includeClosed?: boolean }; result: CrewReportView[] };
  "mcp.reports.dismiss": { params: { reportId: string }; result: CrewReportView };
  /**
   * Answers a needs-input or stuck report: the text goes to the run like a typed message (queued
   * while a turn runs, or to whichever run continues the step), and the item closes.
   */
  "mcp.reports.reply": { params: { reportId: string; text: string } & SessionSeen; result: CrewReportView };
  /**
   * Turns a follow-up proposal into a draft task (tasks.propose: classified, crew proposed, nothing
   * started). Its crew still needs your approval on the Tasks screen.
   */
  "mcp.followups.accept": { params: { reportId: string }; result: { report: CrewReportView; taskId: string } };
}

export interface McpTopics {
  "mcp.reports.changed": { reportId: string; taskId: string; projectId: string; open: boolean };
  "mcp.servers.changed": { serverId: string | null };
}
