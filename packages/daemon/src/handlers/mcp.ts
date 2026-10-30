import type { McpIpc } from "@crewyard/core";
import { runUsage } from "../mcp/inject.ts";
import type { Launch } from "../mcp/launch.ts";
import { McpServerStore } from "../mcp/servers.ts";
import { McpService } from "../mcp/service.ts";
import { orchestratorFor } from "../orchestrator/index.ts";
import { defaultProtector, type Protector } from "../providers/dpapi.ts";
import { SecretStore } from "../providers/secrets.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for MCP: crew reports, follow-up proposals and the user's stdio servers (docs/adr/0007).
// Owned by the MCP work. The service hooks into the one orchestrator of this store.

export interface McpHandlerOptions {
  protector?: Protector;
  resolve?: (command: string, args: string[]) => Promise<Launch>;
  pipePath?: string;
}

const orNull = <T>(fn: () => T): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

const services = new WeakMap<object, McpService>();

/** The one MCP service per store, so tests and other areas reach the same instance. */
export function mcpServiceFor(ctx: HandlerContext, opts: McpHandlerOptions = {}): McpService {
  const existing = services.get(ctx.store);
  if (existing) return existing;
  const o = orchestratorFor(ctx);
  const servers = new McpServerStore(ctx.store.db, new SecretStore(ctx.info.dataDir, opts.protector ?? defaultProtector()));
  const service = new McpService({
    store: ctx.store,
    servers,
    emit: ctx.emit,
    resolve: opts.resolve,
    pipePath: opts.pipePath,
    host: {
      run: (id) => orNull(() => o.db.run(id)),
      task: (id) => orNull(() => o.db.task(id)),
      propose: (p) => o.propose(p),
      message: (runId, text, seen) => o.message(runId, text, seen),
    },
  });
  services.set(ctx.store, service);
  o.setMcp(service);
  return service;
}

export function createMcpHandlers(ctx: HandlerContext, opts: McpHandlerOptions = {}): HandlerMap<McpIpc> {
  const svc = mcpServiceFor(ctx, opts);
  const changed = (serverId: string | null) => ctx.emit("mcp.servers.changed", { serverId });
  return {
    "mcp.servers.list": ({ projectId }) => svc.servers.list(projectId),
    "mcp.servers.save": async (input) => {
      const view = await svc.servers.save(input);
      changed(view.id);
      return view;
    },
    "mcp.servers.remove": ({ id }) => {
      const removed = svc.servers.remove(id);
      if (removed) changed(id);
      return { removed };
    },
    "mcp.servers.check": ({ id }) => svc.check(id),
    "mcp.servers.usage": (filter) => runUsage(ctx.store.db, filter),
    "mcp.reports.list": (filter) => svc.reports.list(filter),
    "mcp.reports.dismiss": ({ reportId }) => svc.reports.dismiss(reportId),
    "mcp.reports.reply": ({ reportId, text, sessionId }) => svc.reports.reply(reportId, text, { sessionId }),
    "mcp.followups.accept": ({ reportId }) => svc.reports.accept(reportId),
  };
}
