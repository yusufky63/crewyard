import type { AgentCapabilities, McpServerSpec, McpTopics, McpServerView, RolePolicy } from "@crewyard/core";
import type { Store } from "../store.ts";
import { checkServer } from "./check.ts";
import { planServers, recordUsage } from "./inject.ts";
import { resolveLaunch, type Launch } from "./launch.ts";
import { ReportPipe } from "./pipe.ts";
import { reportServerSpec } from "./relay.ts";
import { ReportService, type ReportHost } from "./reports.ts";
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

  constructor(private readonly opts: McpServiceOptions) {
    this.now = opts.now ?? (() => new Date());
    this.reports = new ReportService({ store: opts.store, host: opts.host, emit: opts.emit, now: this.now });
    this.pipe = new ReportPipe({ tickets: this.tickets, call: (runId, tool, args) => this.reports.call(runId, tool, args), version: "1" }, opts.pipePath);
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
