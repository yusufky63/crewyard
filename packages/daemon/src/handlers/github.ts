import type { GithubIpc } from "@crewyard/core";
import { GithubClient } from "../github/client.ts";
import { PrFlow, type TaskSource } from "../github/flow.ts";
import { ReviewDesk } from "../github/review.ts";
import { GithubService, type OpenQuestionsSource } from "../github/service.ts";
import { createTokenSource } from "../github/token.ts";
import { orchestratorFor } from "../orchestrator/index.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for PRs, checks, merge gates, push queue, Actions minutes and workflow checks. Owned by the GitHub work.

let service: GithubService | null = null;
let pendingSource: OpenQuestionsSource | undefined;

/**
 * Overrides where the merge gate reads open agent questions. By default they come from the
 * orchestrator's requests for the task that owns the branch.
 */
export function setOpenQuestionsSource(source: OpenQuestionsSource): void {
  if (service) service.openQuestions = source;
  pendingSource = source;
}

export function createGithubHandlers(
  ctx: HandlerContext,
  deps: { client?: GithubClient; tokenState?: () => "ok" | "no_gh" | "signed_out"; tasks?: () => TaskSource } = {},
): HandlerMap<GithubIpc> {
  const token = createTokenSource();
  const client = deps.client ?? new GithubClient(() => token.get());
  const projectPath = (projectId: string) => {
    const p = ctx.store.listProjects().find((x) => x.id === projectId);
    if (!p) throw new Error(`Unknown project: ${projectId}`);
    return p.path;
  };
  // Resolved per call: the tasks handlers create the orchestrator (with their options) first.
  const tasks = deps.tasks ?? (() => orchestratorFor(ctx));
  let flow: PrFlow | null = null;
  const svc = new GithubService({
    projectPath,
    emit: ctx.emit,
    client,
    tokenState: deps.tokenState ?? (() => token.state()),
    resetToken: () => token.reset(),
    openQuestions: pendingSource ?? ((projectId, branch) => flow!.openQuestions(projectId, branch)),
    watched: () => flow!.watched(),
    afterRefresh: (projectId) => flow!.sync(projectId),
  });
  flow = new PrFlow({ store: ctx.store, service: svc, client, tasks, projectPath, emit: ctx.emit });
  const prs = flow;
  const review = new ReviewDesk({ store: ctx.store, service: svc, client, tasks, emit: ctx.emit });
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
    "github.merge": async ({ projectId, number, headSha }) => {
      const res = await svc.merge(projectId, number, headSha);
      prs.afterMerge(projectId, number, headSha, res);
      return res;
    },
    "github.taskPull": ({ taskId }) => prs.view(taskId),
    "github.taskPulls": ({ projectId }) => prs.views(projectId),
    "github.createPull": ({ taskId, title, body, headSha }) => prs.create(taskId, title, body, headSha),
    "github.removeWorktree": ({ projectId, path }) => prs.remove(projectId, path),
    "github.routing": ({ projectId }) => ({ enabled: prs.routing(projectId) }),
    "github.setRouting": ({ projectId, enabled }) => ({ enabled: prs.setRouting(projectId, enabled) }),
    "github.sendFeedback": async ({ taskId }) => ({ sent: await prs.sendHeld(taskId) }),
    "github.issues": ({ projectId }) => review.issues(projectId),
    "github.issue": ({ projectId, number }) => review.issue(projectId, number),
    "github.linkIssue": ({ taskId, number, url, title }) => review.link(taskId, number, url, title),
    "github.taskIssue": ({ taskId }) => review.taskIssue(taskId),
    "github.taskDiff": ({ taskId, scope, runId }) => review.diff(taskId, scope, runId),
    "github.reviewDrafts": ({ taskId }) => review.drafts(taskId),
    "github.addReviewComment": ({ taskId, ...input }) => review.add(taskId, input),
    "github.removeReviewComment": ({ taskId, id }) => review.remove(taskId, id),
    "github.sendReview": ({ taskId }) => review.send(taskId),
  };
}
