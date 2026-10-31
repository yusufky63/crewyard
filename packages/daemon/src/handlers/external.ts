import { basename, isAbsolute } from "node:path";
import { INBOX_REPORT_TYPES, type ExternalIpc, type ProjectSummary } from "@crewyard/core";
import { KILL_KEY } from "../assistant/autopilot.ts";
import { ExternalService, type ExternalServiceOptions } from "../external/service.ts";
import { ExternalTools } from "../external/tools.ts";
import { orchestratorFor } from "../orchestrator/index.ts";
import { defaultProtector } from "../providers/dpapi.ts";
import { assertFolder } from "../projects.ts";
import { caseTwins, effectiveProjectConfig, writeProjectConfig } from "../setup/index.ts";
import { externalReadToolsFor } from "./assistant.ts";
import { mcpServiceFor } from "./mcp.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for Settings → External access and the external tools' host (docs/adr/0021). The tools
// reach each part through its own public read or write: the orchestrator's propose and reads, the
// MCP server store, the assistant's read tools, project.json through the wizard's writer. None of
// them can approve, start, answer, push, merge or delete.

const services = new WeakMap<object, ExternalService>();

export type ExternalHandlerOptions = Partial<Pick<ExternalServiceOptions, "protector" | "platform" | "pipePath" | "powershell" | "now">>;

/** The one external-access service per store, so tests and the handlers reach the same instance. */
export function externalServiceFor(ctx: HandlerContext, opts: ExternalHandlerOptions = {}): ExternalService {
  const existing = services.get(ctx.store);
  if (existing) return existing;
  const { store } = ctx;
  const svc = new ExternalService({ store, dataDir: ctx.info.dataDir, protector: opts.protector ?? defaultProtector(), emit: ctx.emit, ...opts });
  const row = (id: string) => store.listProjects().find((p) => p.id === id) ?? null;
  const tools = new ExternalTools({
    ...(opts.now ? { now: () => opts.now!().getTime() } : {}),
    host: {
      projects: () => store.listProjects(),
      project: row,
      addProject: (path, name) => {
        if (!isAbsolute(path)) throw new Error("external.relative_path");
        const abs = assertFolder(path);
        // Projects are compared without case on every platform (PLAN.md §12.1).
        const known = store.listProjects().find((p) => p.path.toLowerCase() === abs.toLowerCase());
        if (known) return { project: known, added: false };
        if (caseTwins(abs).length) throw new Error("setup.case_twins");
        return { project: store.addProject(abs, name ?? basename(abs)), added: true };
      },
      read: (c, tool, args) => externalReadToolsFor(ctx).call(c, tool, args),
      status: () => {
        const o = orchestratorFor(ctx);
        const tasks = o.list();
        const by = (s: string) => tasks.filter((t) => t.status === s).length;
        const reports = mcpServiceFor(ctx).reports.list({}).filter((r) => INBOX_REPORT_TYPES.includes(r.type)).length;
        const kill = (store.db.prepare("select value from settings where key = ?").get(KILL_KEY) as { value: string } | undefined)?.value;
        const killed = kill ? (JSON.parse(kill) as { killed?: unknown }).killed === true : false;
        return {
          running: true,
          started_at: ctx.info.startedAt,
          projects: store.listProjects().length,
          tasks: { total: tasks.length, proposed: by("proposed"), queued: by("queued"), running: by("running"), needs_input: by("needs_input"), limited: by("limited"), review: by("review") },
          active_runs: o.db.activeCounts().total,
          inbox: { requests: o.requests({}).length, agent_reports: reports, stalls: o.stalls.list({}).length },
          autopilot_stopped: killed,
        };
      },
      profileIds: async (projectId) => new Set((await orchestratorFor(ctx).profileDirectory().candidates(projectId)).map((c) => c.profile.id)),
      config: (p: ProjectSummary) => {
        const { config, status } = effectiveProjectConfig(p.path, p.name);
        return { config, status };
      },
      writeConfig: async (p, config) => {
        await writeProjectConfig(p.path, config);
      },
      propose: (p) => orchestratorFor(ctx).propose(p),
      servers: (projectId) => mcpServiceFor(ctx).servers.list(projectId ?? undefined),
      saveServer: (input) => mcpServiceFor(ctx).servers.save(input),
      event: (e) => void store.appendEvent(e),
      emit: ctx.emit,
    },
  });
  svc.bind((clientId, client, tool, args) => tools.call(clientId, client, tool, args));
  services.set(store, svc);
  return svc;
}

export function createExternalHandlers(ctx: HandlerContext, opts: ExternalHandlerOptions = {}): HandlerMap<ExternalIpc> {
  const svc = externalServiceFor(ctx, opts);
  void svc.start();
  return {
    "external.get": () => svc.view(),
    "external.setEnabled": ({ enabled }) => svc.setEnabled(enabled === true),
    "external.addClient": ({ name }) => svc.addClient(typeof name === "string" ? name : ""),
    "external.clientConfig": ({ clientId }) => svc.clientConfig(clientId),
    "external.revoke": ({ clientId }) => svc.revoke(clientId),
  };
}
