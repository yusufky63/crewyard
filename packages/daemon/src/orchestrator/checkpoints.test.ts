import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitsSince, restore, restorePlan, snapshot } from "./checkpoints.ts";
import { cleanTemps, git, tempDir, tempRepo } from "./testing.ts";

afterEach(cleanTemps);

// git checks files out with the machine's line endings (core.autocrlf on Windows).
const lf = (text: string) => text.replace(/\r\n/g, "\n");
const read = (path: string) => lf(readFileSync(path, "utf8"));

describe("turn checkpoints", () => {
  it("records tracked, changed and untracked files without touching the index, HEAD or the files", async () => {
    const repo = await tempRepo(tempDir());
    writeFileSync(join(repo, "README.md"), "# changed\n");
    writeFileSync(join(repo, "new file.txt"), "untracked\n");
    writeFileSync(join(repo, ".gitignore"), "build/\n");
    mkdirSync(join(repo, "build"));
    writeFileSync(join(repo, "build", "out.js"), "ignored\n");
    await git(repo, "add", ".gitignore");
    const status = await git(repo, "status", "--porcelain");
    const head = (await git(repo, "rev-parse", "HEAD")).trim();

    const snap = await snapshot(repo, "refs/crewyard/checkpoints/t1");
    expect(snap.head).toBe(head);
    expect(await git(repo, "status", "--porcelain")).toBe(status);
    expect((await git(repo, "rev-parse", "HEAD")).trim()).toBe(head);
    expect((await git(repo, "rev-parse", "refs/crewyard/checkpoints/t1")).trim()).toBe(snap.sha);
    const files = (await git(repo, "ls-tree", "-r", "--name-only", snap.sha)).trim().split("\n");
    expect(files.sort()).toEqual([".gitignore", "README.md", "new file.txt"]);
    expect(lf(await git(repo, "show", `${snap.sha}:README.md`))).toBe("# changed\n");
  });

  it("previews and undoes a turn's edits, new files, deletions and commits, and keeps what it replaced", async () => {
    const repo = await tempRepo(tempDir());
    writeFileSync(join(repo, "notes.txt"), "mine, not committed\n");
    const before = await snapshot(repo, "refs/crewyard/checkpoints/t2");

    // The turn: edits a file, empties the user's untracked note, adds a file and commits it.
    writeFileSync(join(repo, "README.md"), "# demo\nmore\n");
    writeFileSync(join(repo, "added by agent.ts"), "export {};\n");
    await git(repo, "add", "added by agent.ts");
    await git(repo, "commit", "-q", "-m", "agent commit");
    writeFileSync(join(repo, "notes.txt"), "");
    const now = await snapshot(repo, null);

    const plan = await restorePlan(repo, now.sha, before.sha);
    expect(plan).toEqual(
      expect.arrayContaining([
        { path: "README.md", change: "restore", added: 0, removed: 1 },
        { path: "added by agent.ts", change: "delete", added: 0, removed: 1 },
        { path: "notes.txt", change: "restore", added: 1, removed: 0 },
      ]),
    );
    expect(await commitsSince(repo, before.head, now.head)).toBe(1);

    const { backup, unrestored } = await restore(repo, before, "refs/crewyard/undo/t2");
    expect(unrestored).toEqual([]);
    expect((await git(repo, "rev-parse", "HEAD")).trim()).toBe(before.head);
    expect(read(join(repo, "README.md"))).toBe("# demo\n");
    expect(read(join(repo, "notes.txt"))).toBe("mine, not committed\n");
    expect(existsSync(join(repo, "added by agent.ts"))).toBe(false);
    // The note is untracked again, as it was, and the index matches HEAD.
    expect(await git(repo, "status", "--porcelain")).toBe("?? notes.txt\n");
    // Nothing is lost: the replaced state, commit included, is one ref away.
    expect(lf(await git(repo, "show", `${backup.sha}:added by agent.ts`))).toBe("export {};\n");
    expect((await git(repo, "rev-parse", "refs/crewyard/undo/t2")).trim()).toBe(backup.sha);
  });
});
