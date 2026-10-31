import type { AssistantIpc } from "@crewyard/core";
import { projectFacts } from "../assistant/facts.ts";
import { AssistantService, type AssistantServiceOptions } from "../assistant/service.ts";
import { orchestratorFor } from "../orchestrator/index.ts";
import { HIBERNATION_KEY, readHibernation } from "../settings/values.ts";
import { mcpServiceFor } from "./mcp.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for the task assistant (docs/adr/0014). Owned by the assistant work. Thin: the rules
// live in ../assistant. The service reaches the orchestrator only through its public reads and
// propose(), and the MCP service for its report server ticket.

const services = new WeakMap<object, AssistantService>();

/** The one assistant service per store, so app.shutdown and tests reach the same instance. */
export function assistantFor(ctx: HandlerContext, overrides: Partial<Omit<AssistantServiceOptions, "store" | "host" | "emit">> = {}): AssistantService {
  const existing = services.get(ctx.store);
  if (existing) return existing;
  const o = orchestratorFor(ctx);
  const mcp = mcpServiceFor(ctx);
  const db = ctx.store.db;
  const service = new AssistantService({
    store: ctx.store,
    emit: ctx.emit,
    ...overrides,
    host: {
      project: (id) => {
        const row = db.prepare("select id, name, path from projects where id = ?").get(id) as { id: string; name: string; path: string } | undefined;
        if (!row) throw new Error("project.not_found");
        return row;
      },
      candidates: async (projectId) => await o.profileDirectory().candidates(projectId),
      envFor: async (profileId) => await o.profileDirectory().envFor(profileId),
      adapter: (runner) => o.adapterFor(runner),
      reportServer: (conversationId) => mcp.assistantServer(conversationId),
      serverEnded: (conversationId) => mcp.assistantEnded(conversationId),
      propose: (p) => o.propose(p),
      activeRuns: () => {
        const counts = o.db.activeCounts();
        return { total: counts.total, byProfile: counts.byProfile };
      },
      task: (taskId) => {
        try {
          const t = o.get(taskId);
          return { projectId: t.projectId, status: t.status, kind: t.kind };
        } catch {
          return null;
        }
      },
      followupAccepted: (reportId, taskId) => mcp.reports.linkAccepted(reportId, taskId),
      facts: async (projectId) => {
        const row = db.prepare("select name, path from projects where id = ?").get(projectId) as { name: string; path: string } | undefined;
        if (!row) throw new Error("project.not_found");
        return projectFacts(row.path, row.name);
      },
      idleMinutes: () => readHibernation((db.prepare("select value from settings where key = ?").get(HIBERNATION_KEY) as { value: string } | undefined)?.value).idleMinutes,
    },
  });
  mcp.setAssistant((conversationId, tool, args) => service.toolCall(conversationId, tool, args));
  services.set(ctx.store, service);
  return service;
}

export function createAssistantHandlers(ctx: HandlerContext): HandlerMap<AssistantIpc> {
  const a = assistantFor(ctx);
  return {
    "assistant.profiles": ({ projectId }) => a.profiles(projectId),
    "assistant.get": ({ projectId }) => a.get(projectId),
    "assistant.send": ({ projectId, profileId, text }) => a.send(projectId, profileId, text),
    "assistant.stop": ({ projectId }) => a.stop(projectId),
    "assistant.clear": ({ projectId }) => a.clear(projectId),
    "assistant.addDraft": ({ draftId, edit }) => a.addDraft(draftId, edit),
    "assistant.discardDraft": ({ draftId }) => a.discardDraft(draftId),
    "assistant.report": ({ taskId }) => a.report(taskId),
    "assistant.presets": ({ projectId }) => a.presets(projectId),
    "assistant.preset": ({ projectId, presetId }) => a.preset(projectId, presetId),
  };
}
