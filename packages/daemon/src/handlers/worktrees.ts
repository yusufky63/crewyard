import type { WorktreesIpc } from "@crewyard/core";
import { orchestratorFor } from "../orchestrator/index.ts";
import { assertFolder } from "../projects.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for worktree bootstrap: include preview for the wizard, the disk meter, park and unpark.
// Owned by the worktree bootstrap work; the rules live in ../worktrees.
export function createWorktreesHandlers(ctx: HandlerContext): HandlerMap<WorktreesIpc> {
  // Resolved per call: the tasks handlers create the orchestrator (with their options) first.
  const boot = () => orchestratorFor(ctx).bootstrap;
  return {
    "worktrees.includePreview": ({ path, include, maxMb }) => boot().includePreview(assertFolder(path), include, maxMb),
    "worktrees.disk": ({ projectId }) => boot().disk(projectId),
    "worktrees.park": ({ taskId }) => boot().park(taskId),
    "worktrees.unpark": ({ taskId }) => boot().unpark(taskId),
  };
}
