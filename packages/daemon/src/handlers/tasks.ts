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
    "runs.pause": ({ runId, sessionId }) => o.pause(runId, { sessionId }),
    "runs.resume": ({ runId }) => o.resume(runId),
    "runs.stop": ({ runId, sessionId }) => o.stop(runId, { sessionId }),
    "runs.message": ({ runId, text, sessionId }) => o.message(runId, text, { sessionId }),
    "runs.handoff": ({ runId, targetProfileId, stop }) => o.handoff(runId, targetProfileId, stop),
    "runs.retry": ({ runId }) => o.retry(runId),
    "requests.list": (params) => o.requests(params),
    "requests.answer": ({ requestId, answer, runId, sessionId }) => o.answer(requestId, answer, { runId, sessionId }),
    "queue.edit": ({ runId, messageId, text }) => o.queueEdit(runId, messageId, text),
    "queue.delete": ({ runId, messageId }) => o.queueDelete(runId, messageId),
    "queue.move": ({ runId, messageId, index }) => o.queueMove(runId, messageId, index),
    "queue.steer": ({ runId, messageId, sessionId }) => o.queueSteer(runId, messageId, { sessionId }),
    "runs.undoPreview": ({ runId }) => o.undoPreview(runId),
    "runs.undo": ({ runId, turnId }) => o.undo(runId, turnId),
    "stalls.list": (params) => o.stalls.list(params),
    "stalls.dismiss": ({ alertId }) => o.stalls.dismiss(alertId),
  };
}
