import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { holdExclusive } from "../orchestrator/locked-file.testkit.ts";
import { cleanTemps, git, tempDir, tempRepo } from "../orchestrator/testing.ts";
import { defaultBranch, perFile, worktreeDiff } from "./git.ts";

afterEach(cleanTemps);

describe("worktree diff with a file another process holds open", { timeout: 30_000 }, () => {
  it.runIf(process.platform === "win32")("diffs every other file and names the locked one instead of failing all", async () => {
    const repo = await tempRepo(tempDir());
    for (const f of ["a one.txt", "b two.txt", "c[1].txt"]) writeFileSync(join(repo, f), "old\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "files");
    const base = (await git(repo, "rev-parse", "HEAD")).trim();
    for (const f of ["a one.txt", "b two.txt", "c[1].txt"]) writeFileSync(join(repo, f), "new\n");

    const lock = await holdExclusive(join(repo, "b two.txt"));
    try {
      const res = await worktreeDiff(repo, base);
      expect(res.ok).toBe(true);
      expect(res.unreadable).toEqual(["b two.txt"]);
      expect(res.text).toContain("+++ b/a one.txt");
      expect(res.text).toContain("+++ b/c[1].txt");
      expect(res.text).not.toContain("b two.txt");
    } finally {
      await lock.release();
    }
    const after = await worktreeDiff(repo, base);
    expect(after.unreadable).toEqual([]);
    expect(after.text).toContain("+++ b/b two.txt");
  });

  it("splits only the batch that fails and matches file names literally", async () => {
    const repo = await tempRepo(tempDir());
    const files = Array.from({ length: 120 }, (_, i) => `f ${i}.txt`);
    for (const f of files) writeFileSync(join(repo, f), "x\n");
    await git(repo, "add", "-A");
    // Untracked: as a glob it would match ten tracked files, as a literal name it matches none.
    writeFileSync(join(repo, "f [0-9].txt"), "glob\n");
    // ls-files --error-unmatch fails for a name it does not know, standing in for a locked file.
    const res = await perFile(repo, ["ls-files", "--error-unmatch"], [...files, "f [0-9].txt", "gone 7.txt"]);
    expect(res.failed).toEqual(["f [0-9].txt", "gone 7.txt"]);
    expect(res.ok.join("").split("\n").filter(Boolean).sort()).toEqual([...files].sort());
  });
});

describe("default branch", { timeout: 30_000 }, () => {
  it("treats an origin/HEAD that points at a deleted branch as unknown", async () => {
    const repo = await tempRepo(tempDir());
    await git(repo, "update-ref", "refs/remotes/origin/prod", "HEAD");
    await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    expect(await defaultBranch(repo, "origin")).toBeNull();
    await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/prod");
    expect(await defaultBranch(repo, "origin")).toBe("prod");
  });
});
