import type { ProvidersIpc } from "@crewyard/core";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for catalog, profiles, credentials (DPAPI), balances and usage. Owned by the providers work.
export function createProvidersHandlers(_ctx: HandlerContext): HandlerMap<ProvidersIpc> {
  return {};
}
