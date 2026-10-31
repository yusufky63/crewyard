import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "@crewyard/proc";
import { GithubClient, type FetchLike } from "./client.ts";
import { focusDue, GithubService } from "./service.ts";

let root = "";
let repo = "";
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "crewyard gh service "));
  repo = join(root, "my repo");
  mkdirSync(repo);
  for (const args of [["init", "--initial-branch=main"], ["remote", "add", "origin", "git@github.com:octo/app.git"]]) await run("git", args, { cwd: repo });
});
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

const recent = new Date(Date.now() - 3_600_000).toISOString();
const old = new Date(Date.now() - 30 * 86_400_000).toISOString();

/** Answers by URL; every answer carries an ETag, and a matching If-None-Match gets a 304. */
function routes(table: Record<string, unknown>) {
  const seen: string[] = [];
  const fn: FetchLike = async (url, init) => {
    const path = url.replace("https://api.github.com", "");
    seen.push(`${init.method} ${path}${init.headers["If-None-Match"] ? " (etag)" : ""}`);
    if (init.method === "POST" && path === "/graphql") return Response.json({ data: { repository: { viewerDefaultMergeMethod: "SQUASH" } } });
    const key = Object.keys(table).find((k) => path === k || path.startsWith(k.includes("?") ? k : `${k}?`));
    if (!key) return Response.json({ message: "Not Found" }, { status: 404 });
    const etag = `"${key}"`;
    if (init.headers["If-None-Match"] === etag) return new Response(null, { status: 304, headers: { etag } });
    return Response.json(table[key], { headers: { etag, "x-ratelimit-remaining": "4000", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "9999999999" } });
  };
  return { fn, seen };
}

const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  html_url: `https://github.com/octo/app/pull/${number}`,
  user: { login: "octo" },
  head: { ref: `agent/${number}`, sha: `sha${number}` },
  base: { ref: "main" },
  ...extra,
});

// Each case runs git in a temp repo; under the full parallel suite on Windows that can pass 5 s.
describe("GitHub service", { timeout: 30_000 }, () => {
  it("lists open and recently merged PRs with checks and gates, and revalidates with ETags", async () => {
    const { fn, seen } = routes({
      "/repos/octo/app": { private: true, default_branch: "main", owner: { type: "User" }, allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true },
      "/repos/octo/app/pulls": [pull(2), pull(3, { draft: true })],
      "/repos/octo/app/commits/sha2/check-runs": { check_runs: [{ name: "check", status: "completed", conclusion: "success" }] },
      "/repos/octo/app/commits/sha2/statuses": [],
      "/repos/octo/app/commits/sha3/check-runs": { check_runs: [{ name: "check", status: "completed", conclusion: "failure" }] },
      "/repos/octo/app/commits/sha3/statuses": [],
      "/repos/octo/app/compare/main...sha2": { ahead_by: 2, behind_by: 0 },
      "/repos/octo/app/compare/main...sha3": { ahead_by: 1, behind_by: 4 },
      "/repos/octo/app/pulls/2": { mergeable_state: "clean" },
      "/repos/octo/app/pulls/3": { mergeable_state: "draft" },
    });
    const svc = new GithubService({
      projectPath: () => repo,
      emit: () => undefined,
      client: new GithubClient(async () => "t", fn),
      tokenState: () => "ok",
      resetToken: () => undefined,
      openQuestions: (_p, branch) => (branch === "agent/2" ? 0 : null),
    });
    const res = await svc.pulls("p");
    expect(res.problem).toBeNull();
    expect(res.mergeMethod).toBe("squash");
    // The closed list is the same URL prefix in this table, so both lists return the open ones; merged needs merged_at.
    const [two, three] = res.pulls;
    expect(two).toMatchObject({ number: 2, state: "open", behindBy: 0, mergeState: "clean", checks: { state: "passed" } });
    expect(two?.gate).toMatchObject({ readyForApproval: true, mergeable: false });
    expect(three).toMatchObject({ number: 3, state: "draft", checks: { state: "failing", failingNames: ["check"] } });
    expect(three?.gate?.items.map((i) => i.status)).toEqual(["fail", "fail", "wait", "unknown", "wait"]);

    seen.length = 0;
    await svc.refresh("p");
    expect(seen.filter((s) => s.startsWith("GET")).every((s) => s.endsWith("(etag)"))).toBe(true);
    expect((await svc.repo("p")).private).toBe(true);
  });

  it("keeps merged PRs from the last two weeks and gives them no gate", async () => {
    const { fn } = routes({
      "/repos/octo/app": { private: false, default_branch: "main", owner: { type: "Organization" } },
      "/repos/octo/app/pulls?state=open": [],
      "/repos/octo/app/pulls?state=closed": [pull(9, { merged_at: recent }), pull(8, { merged_at: null }), pull(7, { merged_at: old })],
      "/repos/octo/app/commits/sha9/check-runs": { check_runs: [] },
      "/repos/octo/app/commits/sha9/statuses": [{ context: "ci", state: "success" }],
    });
    const svc = new GithubService({ projectPath: () => repo, emit: () => undefined, client: new GithubClient(async () => "t", fn), tokenState: () => "ok", resetToken: () => undefined });
    const res = await svc.pulls("p");
    expect(res.pulls.map((p) => [p.number, p.state, p.gate])).toEqual([[9, "merged", null]]);
    expect(res.mergeMethod).toBe("squash");
  });

  it("refuses to merge while a gate item is unknown, without calling the merge endpoint", async () => {
    const { fn, seen } = routes({
      "/repos/octo/app": { private: true, default_branch: "main", owner: { type: "User" } },
      "/repos/octo/app/pulls": [pull(2)],
      "/repos/octo/app/commits/sha2/check-runs": { check_runs: [{ name: "check", status: "completed", conclusion: "success" }] },
      "/repos/octo/app/commits/sha2/statuses": [],
      "/repos/octo/app/compare/main...sha2": { ahead_by: 2, behind_by: 0 },
    });
    const svc = new GithubService({ projectPath: () => repo, emit: () => undefined, client: new GithubClient(async () => "t", fn), tokenState: () => "ok", resetToken: () => undefined });
    await expect(svc.merge("p", 2, "sha2")).rejects.toThrow(/questions/);
    await expect(svc.merge("p", 2, "other")).rejects.toThrow(/new commits/);
    expect(seen.some((s) => s.startsWith("PUT"))).toBe(false);
  });

  it("refuses a merge GitHub reports as conflicting or behind, with that reason", async () => {
    for (const state of ["dirty", "behind"]) {
      const { fn, seen } = routes({
        "/repos/octo/app": { private: true, default_branch: "main", owner: { type: "User" } },
        "/repos/octo/app/pulls?state=open": [pull(2)],
        "/repos/octo/app/pulls?state=closed": [],
        "/repos/octo/app/pulls/2": { mergeable_state: state },
        "/repos/octo/app/commits/sha2/check-runs": { check_runs: [{ name: "check", status: "completed", conclusion: "success" }] },
        "/repos/octo/app/commits/sha2/statuses": [],
        "/repos/octo/app/compare/main...sha2": { ahead_by: 2, behind_by: 0 },
      });
      const svc = new GithubService({ projectPath: () => repo, emit: () => undefined, client: new GithubClient(async () => "t", fn), tokenState: () => "ok", resetToken: () => undefined, openQuestions: () => 0 });
      await expect(svc.merge("p", 2, "sha2")).rejects.toThrow(`merge.${state}`);
      expect(seen.some((s) => s.startsWith("PUT"))).toBe(false);
    }
  });

  it("merges with the repo's method once every gate passes", async () => {
    const { fn, seen } = routes({
      "/repos/octo/app": { private: true, default_branch: "main", owner: { type: "User" }, allow_merge_commit: true, allow_squash_merge: true },
      "/repos/octo/app/pulls?state=open": [pull(2)],
      "/repos/octo/app/pulls?state=closed": [],
      "/repos/octo/app/commits/sha2/check-runs": { check_runs: [{ name: "check", status: "completed", conclusion: "success" }] },
      "/repos/octo/app/commits/sha2/statuses": [],
      "/repos/octo/app/compare/main...sha2": { ahead_by: 2, behind_by: 0 },
      "/repos/octo/app/pulls/2/merge": { merged: true, sha: "m1" },
      "/repos/octo/app/pulls/2": { mergeable_state: "unstable" },
    });
    const svc = new GithubService({ projectPath: () => repo, emit: () => undefined, client: new GithubClient(async () => "t", fn), tokenState: () => "ok", resetToken: () => undefined, openQuestions: () => 0 });
    expect(await svc.merge("p", 2, "sha2")).toEqual({ merged: true, sha: "m1", method: "squash" });
    expect(seen.filter((s) => s.startsWith("PUT"))).toEqual(["PUT /repos/octo/app/pulls/2/merge"]);
  });
});

describe("background refresh", { timeout: 30_000 }, () => {
  it("refreshes only the projects with a task in review, and runs the after-refresh hook before github.changed", async () => {
    const { fn, seen } = routes({
      "/repos/octo/app": { private: true, default_branch: "main", owner: { type: "User" } },
      "/repos/octo/app/pulls": [],
    });
    const order: string[] = [];
    let watched: string[] = [];
    const svc = new GithubService({
      projectPath: () => repo,
      emit: (topic) => order.push(topic),
      client: new GithubClient(async () => "t", fn),
      tokenState: () => "ok",
      resetToken: () => undefined,
      watched: () => watched,
      afterRefresh: async (p) => void order.push(`after:${p}`),
    });
    await svc.backgroundTick();
    expect(seen).toEqual([]);
    watched = ["p"];
    await svc.backgroundTick();
    expect(seen.some((s) => s.startsWith("GET /repos/octo/app/pulls"))).toBe(true);
    expect(order).toEqual(["after:p", "github.changed"]);
  });
});

describe("focus refresh", { timeout: 30_000 }, () => {
  it("is due at first, then not again within 30 s", () => {
    expect(focusDue(null, 1_000)).toBe(true);
    expect(focusDue(1_000, 30_999)).toBe(false);
    expect(focusDue(1_000, 31_000)).toBe(true);
    // A clock that went back (sleep, time zone fix) never blocks focus refreshes for good.
    expect(focusDue(50_000, 10_000)).toBe(true);
  });

  it("reads the watched projects once per focus, at most every 30 s", async () => {
    const { fn, seen } = routes({
      "/repos/octo/app": { private: true, default_branch: "main", owner: { type: "User" } },
      "/repos/octo/app/pulls": [],
    });
    let now = 100_000;
    const svc = new GithubService({
      projectPath: () => repo,
      emit: () => undefined,
      client: new GithubClient(async () => "t", fn),
      tokenState: () => "ok",
      resetToken: () => undefined,
      watched: () => ["p"],
      now: () => now,
    });
    expect(await svc.focused(null)).toEqual(["p"]);
    const reads = seen.length;
    expect(reads).toBeGreaterThan(0);
    now += 10_000;
    expect(await svc.focused(null)).toEqual([]);
    expect(seen).toHaveLength(reads);
    now += 20_000;
    expect(await svc.focused(null)).toEqual(["p"]);
  });

  it("skips a project on screen without open PRs and reads nothing when no task is in review", async () => {
    const { fn, seen } = routes({ "/repos/octo/app/pulls": [] });
    const svc = new GithubService({ projectPath: () => repo, emit: () => undefined, client: new GithubClient(async () => "t", fn), tokenState: () => "ok", resetToken: () => undefined, watched: () => [] });
    expect(await svc.focused("p")).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("background refresh", () => {
  it("swallows a tick that throws, so a closing store never becomes an unhandled rejection", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const svc = new GithubService({
        projectPath: () => repo,
        emit: () => undefined,
        client: new GithubClient(async () => "t", async () => Response.json({})),
        tokenState: () => "ok",
        resetToken: () => undefined,
        watched: () => {
          calls++;
          throw new Error("database is not open");
        },
      });
      svc.startBackground();
      await vi.advanceTimersByTimeAsync(130_000);
      svc.stop();
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
