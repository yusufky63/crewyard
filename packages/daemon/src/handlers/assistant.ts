import type { AssistantIpc, RolesListing } from "@crewyard/core";
import { projectFacts } from "../assistant/facts.ts";
import { Autopilot } from "../assistant/autopilot.ts";
import { AssistantService, type AssistantServiceOptions } from "../assistant/service.ts";
import { AssistantTools } from "../assistant/tools.ts";
import { orchestratorFor } from "../orchestrator/index.ts";
import { HIBERNATION_KEY, readHibernation } from "../settings/values.ts";
import { effectiveProjectConfig } from "../setup/index.ts";
import { agentFilesServiceFor } from "./agentfiles.ts";
import { mcpServiceFor } from "./mcp.ts";
import { problemSources } from "./problems.ts";
import { createRolesHandlers } from "./roles.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for the task assistant (docs/adr/0014) and its Autopilot (docs/adr/0017). Owned by the
// assistant work. Thin: the rules live in ../assistant. Both reach the orchestrator only through
// its public methods, and the MCP service for the report server ticket.

const services = new WeakMap<object, AssistantService>();
const autopilots = new WeakMap<object, Autopilot>();
const externalTools = new WeakMap<object, AssistantTools>();

/** The one Autopilot per store, built with the assistant service. */
export function autopilotFor(ctx: HandlerContext): Autopilot {
  assistantFor(ctx);
  return autopilots.get(ctx.store)!;
}

/** The one assistant service per store, so app.shutdown and tests reach the same instance. */
export function assistantFor(ctx: HandlerContext, overrides: Partial<Omit<AssistantServiceOptions, "store" | "host" | "emit">> = {}): AssistantService {
  const existing = services.get(ctx.store);
  if (existing) return existing;
  const o = orchestratorFor(ctx);
  const mcp = mcpServiceFor(ctx);
  const db = ctx.store.db;
  const autopilot: Autopilot = new Autopilot({
    store: ctx.store,
    emit: ctx.emit,
    ...(overrides.now ? { now: overrides.now } : {}),
    host: {
      propose: (p) => o.propose(p),
      get: (taskId) => o.get(taskId),
      list: (projectId) => o.list(projectId),
      edit: (taskId, patch) => o.edit(taskId, patch),
      approve: (taskId) => o.approve({ taskId }),
      cancel: (taskId) => o.cancel(taskId),
      enqueue: (runId, text) => void o.enqueue(runId, text),
      retry: (runId) => o.retry(runId),
      // read_task is a read the agent may make at any time: it never creates the suggested drafts.
      report: (taskId) => service.peekReport(taskId),
      candidates: async (projectId) => await o.profileDirectory().candidates(projectId),
      projectName: (projectId) => (db.prepare("select name from projects where id = ?").get(projectId) as { name: string } | undefined)?.name ?? null,
      userMessages: (conversationId) => db.prepare("select id, text from assistant_messages where conversation_id = ? and role = 'user' order by at, rowid").all(conversationId) as Array<{ id: string; text: string }>,
      notify: (projectId, code, text) => service.notify(projectId, code, text),
    },
  });
  const project = (id: string) => {
    const row = db.prepare("select id, name, path from projects where id = ?").get(id) as { id: string; name: string; path: string } | undefined;
    if (!row) throw new Error("project.not_found");
    return row;
  };
  // The read tools (docs/adr/0018) reach every part through its own public read; nothing here can
  // start, change or stop a task or a run.
  // `record: false` builds the same tools for external clients (docs/adr/0021): their reads of an
  // Autopilot task's report never count as Autopilot reading it.
  const readTools = (record: boolean) => new AssistantTools({
    store: ctx.store,
    ...(overrides.now ? { now: () => overrides.now!().getTime() } : {}),
    host: {
      project,
      task: (taskId) => {
        try {
          return o.get(taskId);
        } catch {
          return null;
        }
      },
      taskList: (projectId, status) => autopilot.taskList(projectId, status),
      taskRead: (projectId, taskId) => autopilot.taskRead(projectId, taskId, record),
      reportRead: (projectId, taskId) => (record ? autopilot.reportRead(projectId, taskId) : undefined),
      requests: (projectId) => o.requests({ projectId }),
      agentReports: (projectId) => mcp.reports.list({ projectId }),
      stalls: (projectId) => o.stalls.list({ projectId }),
      candidates: async (projectId) => await o.profileDirectory().candidates(projectId),
      problems: (projectId) => problemSources(db, projectId),
      roles: (projectId) => createRolesHandlers(ctx)["roles.list"]({ projectId }) as RolesListing,
      agentFiles: (projectId) => {
        const files = agentFilesServiceFor(ctx);
        return { scan: files.scan(projectId), shares: files.shares(), bridge: files.bridge(projectId) };
      },
      config: (path, name) => effectiveProjectConfig(path, name),
    },
  });
  const tools = readTools(true);
  externalTools.set(ctx.store, readTools(false));
  const service = new AssistantService({
    store: ctx.store,
    emit: ctx.emit,
    ...overrides,
    tools,
    autopilot: {
      call: (projectId, conversationId, tool, args) => autopilot.call(projectId, conversationId, tool, args),
      busy: (projectId) => autopilot.busy(projectId),
      promptNote: (projectId) => autopilot.promptNote(projectId),
      completed: (taskId) => autopilot.completed(taskId),
    },
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
  o.watchTasks((p) => autopilot.onTaskChanged(p));
  services.set(ctx.store, service);
  autopilots.set(ctx.store, autopilot);
  return service;
}

/** The assistant's read tools for external clients (docs/adr/0021), sharing the assistant's services. */
export function externalReadToolsFor(ctx: HandlerContext): AssistantTools {
  assistantFor(ctx);
  return externalTools.get(ctx.store)!;
}

export function createAssistantHandlers(ctx: HandlerContext): HandlerMap<AssistantIpc> {
  const a = assistantFor(ctx);
  const ap = autopilotFor(ctx);
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
    "autopilot.get": ({ projectId }) => ap.view(projectId),
    "autopilot.set": ({ projectId, enabled, consent, limits }) => ap.set(projectId, { ...(enabled !== undefined ? { enabled } : {}), ...(consent !== undefined ? { consent } : {}), ...(limits ? { limits } : {}) }),
    "autopilot.global": () => ap.global(),
    "autopilot.kill": ({ killed }) => ap.kill(killed),
  };
}
