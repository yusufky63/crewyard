import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { run } from "@crewyard/proc";
import { OrchestratorError } from "./errors.ts";

// Git through @crewyard/proc only. Worktrees live under `<projects parent>\.mc\worktrees\<repo>\<task>`
// (PLAN.md §10) and are never deleted here: cleanup is the GitHub work's job, after merge and a click.

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };

export async function git(cwd: string, args: string[], bin = "git"): Promise<string> {
  const res = await run(bin, args, { cwd, timeoutMs: 60_000, env: GIT_ENV });
  if (res.code !== 0) throw new OrchestratorError("git.failed", { command: args[0] ?? "", detail: (res.stderr || res.stdout).trim().slice(0, 400) });
  return res.stdout;
}

/** Default worktree root next to the projects folder, as the New project wizard proposes it. */
export const defaultWorktreeRoot = (projectPath: string) => join(dirname(projectPath), ".mc", "worktrees", basename(projectPath));

/** Short, path-safe folder and branch name for a task; keeps worktree paths well under 260 chars. */
export function taskSlug(title: string, taskId: string): string {
  const words = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return `${words || "task"}-${taskId.slice(0, 6)}`;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseSha: string;
}

/**
 * Creates the task's worktree on a new branch from `base` (or the repo's HEAD), or reuses an
 * existing one, e.g. after a restart.
 */
export async function ensureWorktree(repoPath: string, path: string, branch: string, base: string | null, bin = "git"): Promise<WorktreeInfo> {
  const baseSha = (await git(repoPath, ["rev-parse", "--verify", `${base ?? "HEAD"}^{commit}`], bin)).trim();
  if (existsSync(join(path, ".git"))) return { path, branch, baseSha };
  mkdirSync(dirname(path), { recursive: true });
  const exists = await run(bin, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath, env: GIT_ENV });
  if (exists.code === 0) await git(repoPath, ["worktree", "add", path, branch], bin);
  else await git(repoPath, ["worktree", "add", "-b", branch, path, baseSha], bin);
  return { path, branch, baseSha };
}

export const headSha = async (cwd: string, bin = "git") => (await git(cwd, ["rev-parse", "HEAD"], bin)).trim();

/** Local work-in-progress commit at a turn boundary (PLAN.md §8.2 step 4). Nothing is pushed. */
export async function checkpoint(cwd: string, message: string, bin = "git"): Promise<{ sha: string; committed: boolean }> {
  const dirty = (await git(cwd, ["status", "--porcelain"], bin)).trim().length > 0;
  if (dirty) {
    await git(cwd, ["add", "-A"], bin);
    await git(cwd, ["commit", "-m", message], bin);
  }
  return { sha: await headSha(cwd, bin), committed: dirty };
}

export const diffStat = async (cwd: string, baseSha: string, bin = "git") => (await git(cwd, ["diff", "--stat", baseSha, "HEAD"], bin)).trim();

export const isClean = async (cwd: string, bin = "git") => (await git(cwd, ["status", "--porcelain"], bin)).trim().length === 0;

/** Write to a temp file, then rename, retrying while antivirus or an editor holds the target. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        rmSync(tmp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}
