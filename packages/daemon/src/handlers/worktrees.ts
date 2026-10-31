import type { WorktreesIpc } from "@crewyard/core";
import { orchestratorFor } from "../orchestrator/index.ts";
import { assertFolder } from "../projects.ts";
import { FilesError, listFolder, readPreview } from "../worktrees/files.ts";
import { taskMentions } from "../worktrees/mentions.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for worktree bootstrap: include preview for the wizard, the disk meter, park and unpark.
// Owned by the worktree bootstrap work; the rules live in ../worktrees. The Files tab reads go
// straight to the store and the disk: they never need the orchestrator and never write.
export function createWorktreesHandlers(ctx: HandlerContext): HandlerMap<WorktreesIpc> {
  // Resolved per call: the tasks handlers create the orchestrator (with their options) first.
  const boot = () => orchestratorFor(ctx).bootstrap;
  /** The task's own worktree folder; the renderer never chooses the root. */
  const rootOf = (taskId: string): string => {
    const row = ctx.store.db.prepare("select path from worktrees where task_id = ?").get(taskId) as { path: string } | undefined;
    if (!row) throw new FilesError("files.no_worktree");
    return row.path;
  };
  return {
    "worktrees.includePreview": ({ path, include, maxMb }) => boot().includePreview(assertFolder(path), include, maxMb),
    "worktrees.disk": ({ projectId }) => boot().disk(projectId),
    "worktrees.park": ({ taskId }) => boot().park(taskId),
    "worktrees.unpark": ({ taskId }) => boot().unpark(taskId),
    "worktrees.listDir": ({ taskId, path }) => listFolder(rootOf(taskId), path),
    "worktrees.readFile": ({ taskId, path }) => readPreview(rootOf(taskId), path),
    "worktrees.mentions": ({ taskId }) => taskMentions(ctx.store.db, taskId, rootOf(taskId)),
  };
}
