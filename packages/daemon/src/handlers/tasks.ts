import type { TasksIpc } from "@crewyard/core";
import { orchestratorFor, type OrchestratorOptions } from "../orchestrator/index.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for tasks, crews, runs, requests (Inbox), limits and handoffs. Owned by the orchestrator backend.
// Thin by design: every rule lives in ../orchestrator so it can be tested without IPC.
export function createTasksHandlers(ctx: HandlerContext, overrides?: Partial<OrchestratorOptions>): HandlerMap<TasksIpc> {
  const o = orchestratorFor(ctx, overrides);
  return {
    "tasks.list": ({ projectId }) => o.list(projectId),
    "tasks.get": ({ taskId }) => o.get(taskId),
    "tasks.propose": (params) => o.propose(params),
    "tasks.approve": (params) => o.approve(params),
    "tasks.cancel": ({ taskId }) => o.cancel(taskId),
    "runs.pause": ({ runId }) => o.pause(runId),
    "runs.resume": ({ runId }) => o.resume(runId),
    "runs.stop": ({ runId }) => o.stop(runId),
    "runs.message": ({ runId, text }) => o.message(runId, text),
    "requests.list": (params) => o.requests(params),
    "requests.answer": ({ requestId, answer }) => o.answer(requestId, answer),
  };
}
