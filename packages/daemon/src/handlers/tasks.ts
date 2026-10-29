import type { TasksIpc } from "@crewyard/core";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for tasks, crews, runs, requests (Inbox), limits and handoffs. Owned by the orchestrator backend.
export function createTasksHandlers(_ctx: HandlerContext): HandlerMap<TasksIpc> {
  return {};
}
