import type { RepoState, RequestView, TaskSummary } from "@crewyard/core";

// The state line on a recent-project tile (PLAN.md §11.1): branch state, running agents and open
// questions. Pure, so what each tile claims is tested without React.

/** One piece of the branch line: an i18n key under `start:tile.` with its params. */
export interface Part {
  key: string;
  params?: Record<string, string | number>;
}

export function branchParts(repo: RepoState | undefined): Part[] {
  if (!repo) return [];
  if (repo.problem === "not_a_repo") return [{ key: "notRepo" }];
  const parts: Part[] = [repo.currentBranch ? { key: "branch", params: { branch: repo.currentBranch } } : { key: "detached" }];
  if (repo.problem === "no_remote") parts.push({ key: "localOnly" });
  else if (repo.ahead === null || repo.behind === null) {
    if (repo.currentBranch) parts.push({ key: "noUpstream" });
  } else {
    if (repo.ahead > 0) parts.push({ key: "ahead", params: { count: repo.ahead } });
    if (repo.behind > 0) parts.push({ key: "behind", params: { count: repo.behind } });
  }
  if (repo.dirty) parts.push({ key: "dirty" });
  if (parts.length === 1 && repo.currentBranch && repo.ahead === 0 && repo.behind === 0) parts.push({ key: "upToDate" });
  return parts;
}

export interface Activity {
  running: number;
  questions: number;
}

/** Live runs across the project's tasks and its unanswered requests (questions and approvals). */
export function projectActivity(tasks: TaskSummary[] | undefined, requests: RequestView[] | undefined): Activity | null {
  if (!tasks || !requests) return null;
  return {
    running: tasks.reduce((n, t) => n + t.activeRuns, 0),
    questions: requests.filter((r) => r.answeredAt === null).length,
  };
}
