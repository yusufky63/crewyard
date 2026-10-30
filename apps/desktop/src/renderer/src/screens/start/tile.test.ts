import { describe, expect, it } from "vitest";
import type { RepoState, RequestView, TaskSummary } from "@crewyard/core";
import { branchParts, projectActivity } from "./tile.ts";

const repo = (over: Partial<RepoState>): RepoState => ({
  path: "C:\\My Projects\\game",
  remote: { name: "origin", owner: "o", repo: "game", webUrl: "https://github.com/o/game" },
  defaultBranch: "main",
  currentBranch: "main",
  ahead: 0,
  behind: 0,
  dirty: false,
  private: true,
  unpushed: [],
  problem: null,
  ...over,
});
const keys = (r: RepoState | undefined) => branchParts(r).map((p) => (p.params ? `${p.key}:${Object.values(p.params).join(",")}` : p.key));

describe("branchParts", () => {
  it("says nothing until the repo was read", () => {
    expect(keys(undefined)).toEqual([]);
  });

  it("names the branch and says it is up to date when nothing differs", () => {
    expect(keys(repo({}))).toEqual(["branch:main", "upToDate"]);
  });

  it("lists ahead, behind and uncommitted changes", () => {
    expect(keys(repo({ ahead: 2, behind: 1, dirty: true }))).toEqual(["branch:main", "ahead:2", "behind:1", "dirty"]);
  });

  it("separates no upstream, no remote, detached HEAD and not a repo", () => {
    expect(keys(repo({ ahead: null, behind: null }))).toEqual(["branch:main", "noUpstream"]);
    expect(keys(repo({ remote: null, problem: "no_remote", ahead: null, behind: null }))).toEqual(["branch:main", "localOnly"]);
    expect(keys(repo({ currentBranch: null, ahead: null, behind: null }))).toEqual(["detached"]);
    expect(keys(repo({ problem: "not_a_repo" }))).toEqual(["notRepo"]);
  });
});

describe("projectActivity", () => {
  const task = (activeRuns: number) => ({ activeRuns }) as TaskSummary;
  const req = (answered: boolean) => ({ answeredAt: answered ? "2026-10-30T00:00:00Z" : null }) as RequestView;

  it("sums live runs and counts only unanswered requests", () => {
    expect(projectActivity([task(2), task(0), task(1)], [req(false), req(true), req(false)])).toEqual({ running: 3, questions: 2 });
  });

  it("is unknown until both reads answer", () => {
    expect(projectActivity(undefined, [])).toBeNull();
    expect(projectActivity([], undefined)).toBeNull();
  });
});
