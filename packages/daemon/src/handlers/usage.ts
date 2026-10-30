import type { UsageIpc } from "@crewyard/core";
import { taskTimeline, usageReport } from "../usage/index.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for the usage view and the task timeline. Owned by the usage work; the reads live in ../usage.
export function createUsageHandlers(ctx: HandlerContext): HandlerMap<UsageIpc> {
  const db = ctx.store.db;
  return {
    "usage.report": ({ days }) => usageReport(db, days),
    "usage.timeline": ({ taskId }) => taskTimeline(db, taskId),
  };
}
