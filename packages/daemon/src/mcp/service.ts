import { ASSISTANT_EXTRA_TOOL_DEFS, ASSISTANT_TOOL_DEFS, AUTOPILOT_TOOL_DEFS, type AgentCapabilities, type McpServerSpec, type McpTopics, type McpServerView, type RolePolicy } from "@crewyard/core";
import type { Store } from "../store.ts";
import { checkServer } from "./check.ts";
import { planServers, recordUsage } from "./inject.ts";
import { resolveLaunch, type Launch } from "./launch.ts";
import { ReportPipe } from "./pipe.ts";
import { reportServerSpec } from "./relay.ts";
import { ReportService, type ReportHost } from "./reports.ts";
import { REPORT_TOOLS, type ToolOutcome, type ToolSet } from "./session.ts";
import type { McpServerStore } from "./servers.ts";
import { RunTickets } from "./tickets.ts";

// Everything MCP in the daemon (docs/adr/0007), behind the one hook the orchestrator calls when it
// starts a run process and when a run ends. The pipe listens only once a run needs it.

export interface McpRunInput {
  runId: string;
  taskId: string;
  projectId: string;
  policy: RolePolicy;
  capabilities: AgentCapabilities;
}

/** What the orchestrator calls; implemented by McpService, absent in tests that do not need MCP. */
export interface McpHook {
  /** The servers for a new run process, or undefined when the runner takes none. Never throws. */
  serversFor(input: McpRunInput): Promise<McpServerSpec[] | undefined>;
  runEnded(runId: string): void;
}

/**
 * Tickets of the task assistant (docs/adr/0014) carry this prefix on their key. Run ids are UUIDs,
 * so a crew run's ticket can never reach the assistant's tool, nor the other way round.
 */
export const ASSISTANT_KEY = "assistant:";

/**
 * What an assistant connection lists: propose_task, the read and own-draft tools (docs/adr/0018),
 * which work with Autopilot off, and the Autopilot tools (docs/adr/0017), listed on every assistant
 * connection because a client reads the list once per session; the daemon refuses each Autopilot
 * call while it is off or stopped. Crew runs list none of these.
 */
export const ASSISTANT_TOOLS: ToolSet = {
  tools: [...ASSISTANT_TOOL_DEFS, ...ASSISTANT_EXTRA_TOOL_DEFS, ...AUTOPILOT_TOOL_DEFS],
  instructions:
    "Use propose_task once for each task you suggest. It only shows the person a draft; nothing starts unless they add it and approve its crew. The read tools (list_tasks, read_task, read_report, read_crew, list_drafts, read_inbox, read_events, read_usage, list_profiles, read_project, git_overview, list_problems, list_agent_files) and edit_draft and discard_draft for your own open drafts always work. create_task, edit_task, approve_crew, queue_message, retry_step, cancel_task and complete_task work only while the person has Autopilot on for this project; a refusal says why.",
};

export type AssistantToolCall = (conversationId: string, tool: string, args: unknown) => Promise<ToolOutcome>;

export interface McpServiceOptions {
  store: Store;
  servers: McpServerStore;
  host: ReportHost;
  emit<K extends keyof McpTopics>(topic: K, payload: McpTopics[K]): void;
  now?: () => Date;
  resolve?: (command: string, args: string[]) => Promise<Launch>;
  pipePath?: string;
}

export class McpService implements McpHook {
  readonly tickets = new RunTickets();
  readonly reports: ReportService;
  readonly pipe: ReportPipe;
  private readonly now: () => Date;
  private assistantCall: AssistantToolCall | null = null;

  constructor(private readonly opts: McpServiceOptions) {
    this.now = opts.now ?? (() => new Date());
    this.reports = new ReportService({ store: opts.store, host: opts.host, emit: opts.emit, now: this.now });
    this.pipe = new ReportPipe(
      {
        tickets: this.tickets,
        call: (key, tool, args) => {
          if (!key.startsWith(ASSISTANT_KEY)) return this.reports.call(key, tool, args);
          const call = this.assistantCall;
          return call ? call(key.slice(ASSISTANT_KEY.length), tool, args) : Promise.resolve({ text: "Refused: the task assistant is not running.", isError: true });
        },
        toolsFor: (key) => (key.startsWith(ASSISTANT_KEY) ? ASSISTANT_TOOLS : REPORT_TOOLS),
        version: "1",
      },
      opts.pipePath,
    );
  }

  /** The task assistant takes its tool calls here (handlers/assistant.ts). */
  setAssistant(call: AssistantToolCall): void {
    this.assistantCall = call;
  }

  /**
   * The report server for one assistant process: the same relay and pipe as runs, a fresh ticket
   * that lists only propose_task. Undefined when the pipe cannot listen or no relay can run.
   */
  async assistantServer(conversationId: string): Promise<McpServerSpec | undefined> {
    try {
      return reportServerSpec(await this.pipe.listen(), this.tickets.issue(ASSISTANT_KEY + conversationId));
    } catch {
      return undefined;
    }
  }

  assistantEnded(conversationId: string): void {
    this.tickets.revoke(ASSISTANT_KEY + conversationId);
  }

  get servers(): McpServerStore {
    return this.opts.servers;
  }

  async serversFor(input: McpRunInput): Promise<McpServerSpec[] | undefined> {
    if (!input.capabilities.mcp) return undefined;
    try {
      const path = await this.pipe.listen();
      const report = reportServerSpec(path, this.tickets.issue(input.runId));
      const plan = await planServers(this.opts.servers, { ...input, toolFilter: input.capabilities.mcp.toolFilter, report }, this.opts.resolve ?? ((c, a) => resolveLaunch(c, a)));
      recordUsage(this.opts.store.db, input, plan, this.now().toISOString());
      return plan.specs;
    } catch {
      // Reporting is a convenience; a pipe that cannot listen must not keep the run from starting.
      return undefined;
    }
  }

  runEnded(runId: string): void {
    this.tickets.revoke(runId);
    this.reports.runEnded(runId);
  }

  /** Settings "Check tools": runs the server once with its stored env, records what it lists. */
  async check(id: string): Promise<McpServerView> {
    const view = this.opts.servers.get(id);
    const env = await this.opts.servers.envFor(this.opts.servers.envRows(id));
    if (env.missing.length) {
      this.opts.servers.setCheck(id, null, "missing_secret");
      return this.opts.servers.get(id);
    }
    const launch = await (this.opts.resolve ?? ((c, a) => resolveLaunch(c, a)))(view.command, view.args);
    if (!launch.ok) {
      this.opts.servers.setCheck(id, null, launch.reason);
      return this.opts.servers.get(id);
    }
    const res = await checkServer(launch, { ...launch.env, ...env.env }, env.secrets);
    this.opts.servers.setCheck(id, res.ok ? res.tools : null, res.ok ? null : res.error || "failed");
    this.opts.emit("mcp.servers.changed", { serverId: id });
    return this.opts.servers.get(id);
  }

  async close(): Promise<void> {
    await this.pipe.close();
  }
}
