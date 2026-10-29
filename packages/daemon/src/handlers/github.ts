import type { GithubIpc } from "@crewyard/core";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for PRs, checks, merge gates, push queue, Actions minutes and workflow checks. Owned by the GitHub work.
export function createGithubHandlers(_ctx: HandlerContext): HandlerMap<GithubIpc> {
  return {};
}
