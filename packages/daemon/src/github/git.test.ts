import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "@crewyard/proc";
import { GithubClient } from "./client.ts";
import { parseRemote, parseWorktrees } from "./git.ts";
import { GithubService } from "./service.ts";

const temps: string[] = [];
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 })));

describe("remote parsing", () => {
  it("reads owner and repo from every GitHub URL form and drops credentials", () => {
    const want = { name: "origin", owner: "yusufky63", repo: "crewyard", webUrl: "https://github.com/yusufky63/crewyard" };
    expect(parseRemote("origin", "https://github.com/yusufky63/crewyard.git")).toEqual(want);
    expect(parseRemote("origin", "https://user:secret@github.com/yusufky63/crewyard")).toEqual(want);
    expect(parseRemote("origin", "git@github.com:yusufky63/crewyard.git")).toEqual(want);
    expect(parseRemote("origin", "ssh://git@github.com/yusufky63/crewyard.git")).toEqual(want);
    expect(parseRemote("origin", "https://gitlab.com/a/b.git")).toBeNull();
  });

  it("parses worktree porcelain output", () => {
    const text = "worktree C:/Projeler/my repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree C:/Projeler/.mc/worktrees/my repo/t1\nHEAD bbb\nbranch refs/heads/agent/x\n\nworktree C:/w/detached\nHEAD ccc\ndetached\n";
    expect(parseWorktrees(text)).toEqual([
      { path: "C:/Projeler/my repo", head: "aaa", branch: "main", primary: true },
      { path: "C:/Projeler/.mc/worktrees/my repo/t1", head: "bbb", branch: "agent/x", primary: false },
      { path: "C:/w/detached", head: "ccc", branch: null, primary: false },
    ]);
  });
});

const g = async (cwd: string, ...args: string[]) => {
  const res = await run("git", args, { cwd, timeoutMs: 30_000 });
  if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
};

describe("repo state, push queue and push against a local bare remote", () => {
  it("finds unpushed branches, the workflows they trigger, and pushes once", async () => {
    const root = mkdtempSync(join(tmpdir(), "crewyard gh test "));
    temps.push(root);
    const bare = join(root, "remote repo.git");
    const repo = join(root, "my project");
    mkdirSync(repo);
    await g(root, "init", "--bare", "--initial-branch=main", bare);
    await g(repo, "init", "--initial-branch=main");
    for (const [k, v] of [["user.name", "Test"], ["user.email", "test@example.com"], ["commit.gpgsign", "false"]]) await g(repo, "config", k!, v!);
    // The remote looks like GitHub, but pushes are rewritten to the local bare repo.
    await g(repo, "remote", "add", "origin", "https://github.com/test-owner/test-repo.git");
    await g(repo, "config", `url.${bare.replace(/\\/g, "/")}.pushInsteadOf`, "https://github.com/test-owner/test-repo.git");

    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: ci\non: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n");
    await g(repo, "add", ".");
    await g(repo, "commit", "-m", "first");
    await g(repo, "push", "origin", "main");
    await g(repo, "fetch", bare, "main:refs/remotes/origin/main");
    await g(repo, "checkout", "-b", "agent/seams");
    writeFileSync(join(repo, "a.txt"), "x");
    await g(repo, "add", ".");
    await g(repo, "commit", "-m", "second");
    writeFileSync(join(repo, "b.txt"), "y");
    await g(repo, "add", ".");
    await g(repo, "commit", "-m", "third");
    const tip = await g(repo, "rev-parse", "HEAD");

    const client = new GithubClient(async () => null);
    const svc = new GithubService({ projectPath: () => repo, emit: () => undefined, client, tokenState: () => "signed_out", resetToken: () => undefined });

    const state = await svc.repo("p");
    expect(state.problem).toBeNull();
    expect(state.remote?.owner).toBe("test-owner");
    expect(state.currentBranch).toBe("agent/seams");
    expect(state.unpushed).toEqual([{ branch: "agent/seams", headSha: tip, commits: 2, upstream: null }]);

    const queue = await svc.pushQueue("p");
    expect(queue.branches[0]?.workflows.map((w) => [w.name, w.events])).toEqual([["ci", ["push"]]]);

    const findings = await svc.workflows("p");
    expect(findings.findings.map((f) => f.rule)).toEqual(["push_all_branches", "no_concurrency", "no_timeout"]);

    await expect(svc.push("p", "agent/seams", "0".repeat(40))).rejects.toThrow(/moved/);
    const res = await svc.push("p", "agent/seams", tip);
    expect(res.pushed).toBe(true);
    expect(await g(bare, "rev-parse", "refs/heads/agent/seams")).toBe(tip);
    expect((await svc.repo("p")).unpushed).toEqual([]);
    expect(await svc.push("p", "agent/seams", tip)).toEqual({ pushed: false, output: "Nothing to push" });

    const wt = await svc.worktrees("p");
    expect(wt).toMatchObject({ active: 1, stale: 0 });
    svc.stop();
  }, 60_000);
});
