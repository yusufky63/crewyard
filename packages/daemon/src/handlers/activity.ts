import { dirname, join } from "node:path";
import type { ActivityIpc } from "@crewyard/core";
import { activityEvent, activityFacets, listActivity } from "../activity/events.ts";
import { readLogs } from "../activity/logs.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for the Activity drawer. Read-only: the event log and Crewyard's own log files.
export function createActivityHandlers(ctx: HandlerContext): HandlerMap<ActivityIpc> {
  const db = ctx.store.db;
  // The host passes where it writes; otherwise the logs sit next to the data folder in the profile.
  const logDir = process.env.CREWYARD_LOG_DIR || join(dirname(ctx.info.dataDir), "logs");
  return {
    "activity.events": (params) => listActivity(db, params),
    "activity.event": ({ projectId, seq }) => activityEvent(db, projectId, seq),
    "activity.facets": ({ projectId }) => activityFacets(db, projectId),
    "activity.logs": ({ sources, limit }) => readLogs(logDir, sources, limit),
  };
}
