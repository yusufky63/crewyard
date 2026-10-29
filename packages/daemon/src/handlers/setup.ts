import type { SetupIpc } from "@crewyard/core";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for the New project wizard and .mission/project.json. Owned by the project setup work.
export function createSetupHandlers(_ctx: HandlerContext): HandlerMap<SetupIpc> {
  return {};
}
