import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  branchSha,
  checkpoint,
  commitsBetween,
  defaultWorktreeRoot,
  ensureWorktree,
  gitAtLeast,
  gitVersion,
  isAncestor,
  isValidBranchName,
  mergeNoFf,
  mergeTreeCheck,
  MIN_GIT_MERGE_TREE,
  parseMergeTree,
  parseWorktreeList,
  resolveBase,
  sameDir,
  taskSlug,
  unindexedFiles,
} from "./git.ts";
import { holdExclusive } from "./locked-file.testkit.ts";
import { cleanTemps, git, tempDir, tempRepo } from "./testing.ts";

afterEach(cleanTemps);

describe("branch names", () => {
  it("accepts what git accepts and refuses domain accounts, '..', locks and control characters", () => {
    for (const ok of ["crewyard/fix-login-abc123", "feature/!bruno", "main", "release/v1.2", "a@b"]) expect(isValidBranchName(ok)).toBe(true);
    for (const bad of ["DOMAIN\\first.last/test", "a..b", "x.lock", "x/y.lock/z", "-x", "a//b", "a/", "a.", "/a", ".hidden/x", "a/.b", "with space", "a~1", "a^", "a:b", "a?", "a*", "a[b", "a@{1}", "@", "", "tab\tx"]) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });

  it("task slugs from awkward titles are always valid branch names", () => {
    for (const title of ["DOMAIN\\first.last: fix", "!bruno folder", "..lock", "@{-1}", "İçerik ğüşöç", "   ", "a/b/../c"]) {
      expect(isValidBranchName(`crewyard/${taskSlug(title, "abcdef123")}`), title).toBe(true);
    }
  });
});

// Every case spawns several git processes; under the full parallel suite on Windows that can pass 5 s.
describe("same folder", () => {
  // One rule for every caller (handoff package, run worktree, review checkouts, undo): Windows
  // paths compare without case and after resolving "." and "..".
  it("compares resolved paths without case", () => {
    const root = tempDir();
    expect(sameDir(join(root, "Demo Repo"), join(root, "demo repo"))).toBe(true);
    expect(sameDir(join(root, "a", "..", "b"), join(root, "b"))).toBe(true);
    expect(sameDir(join(root, "a"), join(root, "b"))).toBe(false);
  });
});

describe("worktree pre-flight", { timeout: 30_000 }, () => {
  it("creates a worktree from a repo and folders that hold '!' and spaces", async () => {
    const repo = await tempRepo(tempDir(), "my !repo");
    mkdirSync(join(repo, "!bruno"));
    writeFileSync(join(repo, "!bruno", "a b.bru"), "x\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "bang");
    const path = join(defaultWorktreeRoot(repo), "task !1");
    await ensureWorktree(repo, path, "crewyard/task-1", null);
    expect(readFileSync(join(path, "!bruno", "a b.bru"), "utf8").trim()).toBe("x");
  });

  it("drops a stale registration in its own root that holds the branch, and leaves foreign ones alone", async () => {
    const root = tempDir();
    const repo = await tempRepo(root);
    const base = defaultWorktreeRoot(repo);
    await ensureWorktree(repo, join(base, "old"), "crewyard/a", null);
    // The user's own worktree elsewhere, its folder gone too (an unplugged drive looks the same).
    const foreign = join(root, "elsewhere", "mine");
    await git(repo, "worktree", "add", "-q", "-b", "mine", foreign);
    rmSync(join(base, "old"), { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });

    // Without the pre-flight git says the branch "is already used by worktree at .../old".
    const wt = await ensureWorktree(repo, join(base, "new"), "crewyard/a", null);
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    const regs = parseWorktreeList(await git(repo, "worktree", "list", "--porcelain", "-z"));
    expect(regs.find((r) => r.branch === "mine")).toMatchObject({ prunable: true });
    expect(regs.some((r) => r.path.endsWith("/old"))).toBe(false);
  });

  it("keeps a locked stale registration and refuses instead", async () => {
    const repo = await tempRepo(tempDir());
    const path = join(defaultWorktreeRoot(repo), "kept");
    await ensureWorktree(repo, path, "crewyard/kept", null);
    await git(repo, "worktree", "lock", "--reason", "on a USB drive", path);
    rmSync(path, { recursive: true, force: true });
    await expect(ensureWorktree(repo, join(dirname(path), "other"), "crewyard/kept", null)).rejects.toMatchObject({ code: "worktree.branch_elsewhere" });
  });

  it("explains a dangling origin/HEAD and a missing base instead of a bare git failure", async () => {
    const repo = await tempRepo(tempDir());
    await git(repo, "update-ref", "refs/remotes/origin/prod", "HEAD");
    await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    await expect(resolveBase(repo, "origin/HEAD")).rejects.toMatchObject({ code: "worktree.base_dangling", params: { target: "refs/remotes/origin/main" } });
    await expect(ensureWorktree(repo, join(defaultWorktreeRoot(repo), "t"), "crewyard/t", "origin/HEAD")).rejects.toMatchObject({ code: "worktree.base_dangling" });
    await expect(resolveBase(repo, "no-such-branch")).rejects.toMatchObject({ code: "worktree.base_missing" });
    await expect(resolveBase(repo, "--output=x")).rejects.toMatchObject({ code: "worktree.base_missing" });
    await expect(ensureWorktree(repo, join(defaultWorktreeRoot(repo), "t"), "DOMAIN\\first.last/t", null)).rejects.toMatchObject({ code: "worktree.bad_branch" });

    await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/prod");
    expect(await resolveBase(repo, "origin/HEAD")).toBe((await git(repo, "rev-parse", "HEAD")).trim());
  });
});

describe("checkpoint with a locked file", { timeout: 30_000 }, () => {
  it("parses the files git add --ignore-errors skipped", () => {
    expect(unindexedFiles("error: open(\"b c.txt\"): Permission denied\nerror: unable to index file 'b c.txt'\nfatal: adding files failed\n")).toEqual(["b c.txt"]);
  });

  it.runIf(process.platform === "win32")("commits every other file and names the locked one", async () => {
    const repo = await tempRepo(tempDir());
    writeFileSync(join(repo, "free one.txt"), "a\n");
    writeFileSync(join(repo, "held open.txt"), "b\n");
    const lock = await holdExclusive(join(repo, "held open.txt"));
    try {
      const cp = await checkpoint(repo, "wip: locked");
      expect(cp).toMatchObject({ committed: true, skipped: ["held open.txt"] });
      expect((await git(repo, "show", "--name-only", "--format=", "HEAD")).trim()).toBe("free one.txt");
    } finally {
      await lock.release();
    }
    expect((await git(repo, "status", "--porcelain")).trim()).toBe("?? \"held open.txt\"");
  });
});

describe("goal branch merges (docs/adr/0019)", { timeout: 60_000 }, () => {
  it("reads merge-tree's -z --name-only output: the tree, then the conflicted names", () => {
    expect(parseMergeTree("abc123\0")).toEqual({ tree: "abc123", paths: [] });
    const out = ["def456", "src/giriş sayfası.ts", "docs/kullanım kılavuzu.md", "src/giriş sayfası.ts", "", "Auto-merging src/giriş sayfası.ts", "CONFLICT (content): ...", ""].join("\0");
    expect(parseMergeTree(out)).toEqual({ tree: "def456", paths: ["src/giriş sayfası.ts", "docs/kullanım kılavuzu.md"] });
  });

  it("compares Git versions numerically and ignores the Windows suffix", () => {
    expect(MIN_GIT_MERGE_TREE).toBe("2.38.0");
    for (const ok of ["2.38.0", "2.56.0.windows.3", "3.0", "2.38.1"]) expect(gitAtLeast(ok), ok).toBe(true);
    for (const old of ["2.37.9", "2.9.0", "1.99", null, ""]) expect(gitAtLeast(old), String(old)).toBe(false);
  });

  it("test-merges without a worktree, merges with --no-ff, and leaves a refused merge as it was", async () => {
    expect(gitAtLeast(await gitVersion())).toBe(true);
    const repo = await tempRepo(tempDir("crewyard goal git-"), "demo repo with spaces");
    const file = join(repo, "kılavuz notları.md");
    const goal = "crewyard/goal/demo-abc123";
    await git(repo, "checkout", "-q", "-b", goal);
    await git(repo, "checkout", "-q", "-b", "crewyard/task-a");
    writeFileSync(file, "A satırı\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "a: kılavuz");
    await git(repo, "checkout", "-q", goal);
    await git(repo, "checkout", "-q", "-b", "crewyard/task-b");
    writeFileSync(file, "B satırı\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "b: kılavuz");
    await git(repo, "checkout", "-q", goal);

    const before = (await branchSha(repo, goal))!;
    expect(await mergeTreeCheck(repo, goal, "crewyard/task-a")).toMatchObject({ clean: true });
    expect((await mergeNoFf(repo, "crewyard/task-a")).ok).toBe(true);
    const after = (await branchSha(repo, goal))!;
    expect(after).not.toBe(before);
    // --no-ff: a merge commit with two parents, and the task's commit is now in the goal branch.
    expect((await git(repo, "rev-list", "--parents", "-n", "1", after)).trim().split(" ")).toHaveLength(3);
    expect(await isAncestor(repo, (await branchSha(repo, "crewyard/task-a"))!, after)).toBe(true);
    expect(await commitsBetween(repo, before, after)).toEqual(expect.arrayContaining([expect.stringContaining("a: kılavuz")]));

    // The second task changed the same lines: a conflict with its file named; exit 1 is not an error.
    expect(await mergeTreeCheck(repo, goal, "crewyard/task-b")).toEqual({ clean: false, paths: ["kılavuz notları.md"] });
    const refused = await mergeNoFf(repo, "crewyard/task-b");
    expect(refused.ok).toBe(false);
    expect(await branchSha(repo, goal)).toBe(after);
    expect((await git(repo, "status", "--porcelain")).trim()).toBe("");
    // The checkout may write CRLF (core.autocrlf); the content is what matters.
    expect(readFileSync(file, "utf8").replace(/\r\n/g, "\n")).toBe("A satırı\n");
    await expect(mergeTreeCheck(repo, goal, "no-such-branch")).rejects.toThrow("git.failed");
    await expect(mergeTreeCheck(repo, "--output=x", "crewyard/task-b")).rejects.toThrow("git.failed");
  });
});
