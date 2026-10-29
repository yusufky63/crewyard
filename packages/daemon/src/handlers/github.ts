import type { GithubIpc } from "@crewyard/core";
import { GithubClient } from "../github/client.ts";
import { GithubService, type OpenQuestionsSource } from "../github/service.ts";
import { createTokenSource } from "../github/token.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for PRs, checks, merge gates, push queue, Actions minutes and workflow checks. Owned by the GitHub work.

let service: GithubService | null = null;
let pendingSource: OpenQuestionsSource | undefined;

/**
 * The orchestrator calls this once it tracks agent questions per branch. Until then the count is
 * unknown and the merge gate stays closed, because unknown never counts as "no open questions".
 */
export function setOpenQuestionsSource(source: OpenQuestionsSource): void {
  if (service) service.openQuestions = source;
  pendingSource = source;
}

export function createGithubHandlers(ctx: HandlerContext, deps: { client?: GithubClient; tokenState?: () => "ok" | "no_gh" | "signed_out" } = {}): HandlerMap<GithubIpc> {
  const token = createTokenSource();
  const client = deps.client ?? new GithubClient(() => token.get());
  const projectPath = (projectId: string) => {
    const p = ctx.store.listProjects().find((x) => x.id === projectId);
    if (!p) throw new Error(`Unknown project: ${projectId}`);
    return p.path;
  };
  const svc = new GithubService({
    projectPath,
    emit: ctx.emit,
    client,
    tokenState: deps.tokenState ?? (() => token.state()),
    resetToken: () => token.reset(),
    openQuestions: pendingSource,
  });
  service?.stop();
  service = svc;
  if (!deps.client) svc.startBackground();

  return {
    "github.auth": () => svc.auth(),
    "github.repo": ({ projectId }) => svc.repo(projectId),
    "github.pulls": ({ projectId }) => svc.pulls(projectId),
    "github.pushQueue": ({ projectId }) => svc.pushQueue(projectId),
    "github.worktrees": ({ projectId }) => svc.worktrees(projectId),
    "github.minutes": ({ projectId }) => svc.minutes(projectId),
    "github.workflows": ({ projectId }) => svc.workflows(projectId),
    "github.sync": ({ projectId }) => svc.sync(projectId),
    "github.refresh": async ({ projectId }) => {
      await svc.refresh(projectId);
      return svc.sync(projectId);
    },
    "github.push": ({ projectId, branch, headSha }) => svc.push(projectId, branch, headSha),
    "github.merge": ({ projectId, number, headSha }) => svc.merge(projectId, number, headSha),
  };
}
