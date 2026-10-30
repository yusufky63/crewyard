import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { run } from "@crewyard/proc";
import { OrchestratorError } from "./errors.ts";
import { unindexedFiles } from "./git.ts";

// Turn checkpoints for "Undo last turn" (feature scan A10). The worktree's git is the source of
// truth: before a turn starts, the whole worktree (tracked, changed and untracked files that
// .gitignore does not exclude) is written as a commit object through a temporary index, so the
// user's index, HEAD and files are never touched by taking one. Undo restores that tree, after
// writing the state it replaces to another commit, so an undo can itself be undone with git.
// Restored files come back the way git checks them out, so line endings follow the repo's own
// settings (core.autocrlf, .gitattributes); files .gitignore excludes are neither saved nor touched.

const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  // commit-tree needs an identity, and a fresh machine or CI runner may have none configured.
  GIT_AUTHOR_NAME: "Crewyard",
  GIT_AUTHOR_EMAIL: "crewyard@localhost",
  GIT_COMMITTER_NAME: "Crewyard",
  GIT_COMMITTER_EMAIL: "crewyard@localhost",
};

export interface Snapshot {
  /** Commit object holding the worktree's files; its parent is HEAD. */
  sha: string;
  tree: string;
  /** HEAD when the snapshot was taken; null in a repository without commits. */
  head: string | null;
  /** Files git could not read (open in another program); they are missing from the snapshot. */
  skipped: string[];
}

export interface RestoreChange {
  path: string;
  change: "restore" | "delete" | "recreate";
  added: number;
  removed: number;
}

async function git(cwd: string, args: string[], bin: string, env: NodeJS.ProcessEnv = ENV, timeoutMs = 120_000): Promise<string> {
  const res = await run(bin, args, { cwd, env, timeoutMs });
  if (res.code !== 0) throw new OrchestratorError("git.failed", { command: args[0] ?? "", detail: (res.stderr || res.stdout).trim().slice(0, 400) });
  return res.stdout;
}

/**
 * Writes the worktree as it is now to a commit object, and points `ref` at it when given (an
 * unreferenced object is collected by git's own gc after two weeks). The real index is copied so
 * git can reuse its file stats instead of hashing every tracked file again.
 */
export async function snapshot(cwd: string, ref: string | null, bin = "git"): Promise<Snapshot> {
  const dir = mkdtempSync(join(tmpdir(), "crewyard-index-"));
  const index = join(dir, "index");
  try {
    const env = { ...ENV, GIT_INDEX_FILE: index };
    // One call for both, since every git start costs a few hundred ms on Windows: the index path, then HEAD (absent in a repo without commits).
    const lines = (await run(bin, ["rev-parse", "--git-path", "index", "--verify", "-q", "HEAD"], { cwd, env: ENV, timeoutMs: 30_000 })).stdout.trim().split(/\r?\n/);
    const real = lines[0] ?? "";
    const head = lines[1] || null;
    if (!real) throw new OrchestratorError("git.failed", { command: "rev-parse", detail: "not a git worktree" });
    const realPath = isAbsolute(real) ? real : resolve(cwd, real);
    if (existsSync(realPath)) copyFileSync(realPath, index);
    else if (head) await git(cwd, ["read-tree", head], bin, env);
    const add = await run(bin, ["add", "-A", "--ignore-errors"], { cwd, env, timeoutMs: 300_000 });
    const skipped = unindexedFiles(add.stderr);
    if (add.code !== 0 && skipped.length === 0) throw new OrchestratorError("git.failed", { command: "add", detail: add.stderr.trim().slice(0, 400) });
    const tree = (await git(cwd, ["write-tree"], bin, env)).trim();
    const sha = (await git(cwd, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "crewyard: turn checkpoint"], bin, env)).trim();
    if (ref) await git(cwd, ["update-ref", ref, sha], bin);
    return { sha, tree, head, skipped };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** NUL-separated `git diff -z --name-status` / `--numstat` output into records. */
function parseNameStatus(out: string): Array<{ status: string; path: string }> {
  const parts = out.split("\0");
  const rows: Array<{ status: string; path: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) rows.push({ status: parts[i]!.charAt(0), path: parts[i + 1]! });
  return rows;
}

function parseNumstat(out: string): Map<string, { added: number; removed: number }> {
  const map = new Map<string, { added: number; removed: number }>();
  for (const rec of out.split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
    if (!m) continue;
    // Binary files show "-"; they count as changed without lines.
    map.set(m[3]!, { added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return map;
}

/** What restoring `target` over `current` changes, file by file, from the worktree's point of view. */
export async function restorePlan(cwd: string, current: string, target: string, bin = "git"): Promise<RestoreChange[]> {
  const [names, nums] = await Promise.all([
    git(cwd, ["diff", "--no-renames", "--name-status", "-z", current, target], bin),
    git(cwd, ["diff", "--no-renames", "--numstat", "-z", current, target], bin),
  ]);
  const stats = parseNumstat(nums);
  return parseNameStatus(names).map(({ status, path }) => ({
    path,
    // From the current state to the target: an added path comes back, a deleted one goes away.
    change: status === "A" ? "recreate" : status === "D" ? "delete" : "restore",
    ...(stats.get(path) ?? { added: 0, removed: 0 }),
  }));
}

/** Commits on the branch since `from` (the turn's own commits), 0 when HEAD did not move. */
export async function commitsSince(cwd: string, from: string | null, to: string | null, bin = "git"): Promise<number> {
  if (!from || !to || from === to) return 0;
  return Number((await git(cwd, ["rev-list", "--count", `${from}..${to}`], bin)).trim()) || 0;
}

/**
 * Puts the worktree back to a checkpoint: the branch to the checkpoint's HEAD (soft, so only the
 * turn's commits leave the branch), files the turn created removed, every other file back to its
 * checkpoint content, and the index back to HEAD. Returns the snapshot of what was replaced and
 * the paths that still differ afterwards (a file held open by another program).
 */
export async function restore(cwd: string, target: Pick<Snapshot, "sha" | "head">, backupRef: string, bin = "git"): Promise<{ backup: Snapshot; unrestored: string[] }> {
  const backup = await snapshot(cwd, backupRef, bin);
  if (target.head && backup.head !== target.head) await git(cwd, ["reset", "-q", "--soft", target.head], bin);
  const failed = new Set<string>();
  const created = (await git(cwd, ["diff", "--no-renames", "--name-only", "-z", "--diff-filter=A", target.sha, backup.sha], bin)).split("\0").filter(Boolean);
  for (const path of created) {
    try {
      unlinkSync(join(cwd, path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") failed.add(path);
    }
  }
  const hasFiles = (await git(cwd, ["ls-tree", "--name-only", target.sha], bin)).trim().length > 0;
  if (hasFiles) {
    // A locked file fails the checkout as a whole on Windows; the check below names what is left.
    await run(bin, ["checkout", target.sha, "--", "."], { cwd, env: ENV, timeoutMs: 300_000 });
  }
  await git(cwd, ["reset", "-q"], bin);
  const after = await snapshot(cwd, null, bin);
  const left = after.tree === (await git(cwd, ["rev-parse", `${target.sha}^{tree}`], bin)).trim() ? [] : (await restorePlan(cwd, after.sha, target.sha, bin)).map((c) => c.path);
  return { backup, unrestored: [...new Set([...failed, ...left])] };
}
