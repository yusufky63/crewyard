import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { run } from "@crewyard/proc";
import { OrchestratorError } from "./errors.ts";

// Git through @crewyard/proc only. Worktrees live under `<projects parent>\.mc\worktrees\<repo>\<task>`
// (PLAN.md §10) and are never deleted as a side effect: removal is the GitHub work's job after merge
// and a click, or a confirmed park, which keeps the branch.

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

export interface Registration {
  path: string;
  branch: string | null;
  locked: boolean;
  /** git's own verdict that the folder is gone (`prunable <reason>`). */
  prunable: boolean;
}

/** `git worktree list --porcelain -z`: NUL-terminated attribute lines, an empty field between entries. */
export function parseWorktreeList(out: string): Registration[] {
  const regs: Registration[] = [];
  let cur: Registration | null = null;
  for (const field of out.split("\0")) {
    if (field === "") {
      if (cur) regs.push(cur);
      cur = null;
    } else if (field.startsWith("worktree ")) cur = { path: field.slice(9), branch: null, locked: false, prunable: false };
    else if (cur && field.startsWith("branch ")) cur.branch = field.slice(7).replace(/^refs\/heads\//, "");
    else if (cur && (field === "locked" || field.startsWith("locked "))) cur.locked = true;
    else if (cur && (field === "prunable" || field.startsWith("prunable "))) cur.prunable = true;
  }
  if (cur) regs.push(cur);
  return regs;
}

const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const inside = (child: string, dir: string) => resolve(child).toLowerCase().startsWith(`${resolve(dir).toLowerCase()}${sep}`);

/**
 * git check-ref-format rules for a branch we create (git-check-ref-format(1)), so a bad name
 * fails with our own error before git runs. Task branches are `crewyard/<slug>` and always pass;
 * this guards names built elsewhere, e.g. from a domain account (`DOMAIN\first.last`, claude-squad #220).
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name === "@" || name.startsWith("-") || name.endsWith("/") || name.endsWith(".")) return false;
  // Control characters and space, then ~ ^ : ? * [ \, "..", "@{" and "//" are never allowed.
  if ([...name].some((ch) => ch <= " " || ch === "\x7f")) return false;
  if (/[~^:?*[\\]|\.\.|@\{|\/\//.test(name)) return false;
  return !name.split("/").some((part) => part === "" || part.startsWith(".") || part.endsWith(".lock"));
}

/**
 * Resolves the commit a task branch starts from. A base that does not resolve gets a clear error:
 * either it does not exist, or it is a symbolic ref (typically `origin/HEAD` after the remote's
 * default branch was renamed) whose target was deleted (emdash #3198).
 */
export async function resolveBase(repoPath: string, base: string | null, bin = "git"): Promise<string> {
  const rev = base ?? "HEAD";
  if (rev.startsWith("-")) throw new OrchestratorError("worktree.base_missing", { base: rev });
  const res = await run(bin, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], { cwd: repoPath, env: GIT_ENV, timeoutMs: 60_000 });
  if (res.code === 0) return res.stdout.trim();
  const dangling = res.stderr.match(/dangling symref (\S+)/)?.[1];
  if (dangling) {
    const target = await run(bin, ["symbolic-ref", "--quiet", dangling], { cwd: repoPath, env: GIT_ENV });
    throw new OrchestratorError("worktree.base_dangling", { base: rev, ref: dangling, target: target.stdout.trim() });
  }
  throw new OrchestratorError("worktree.base_missing", { base: rev });
}

/**
 * Drops registrations git calls prunable (folder gone) inside this worktree root. They are
 * Crewyard's own task worktrees: the branch stays and a later start re-adds the folder, while
 * left alone they make `worktree add` fail with "already registered" or "already used by
 * worktree" (emdash #3247). One `git worktree remove` each, never a repo-wide `prune`:
 * registrations outside the root (the user's own, maybe on a drive unplugged right now) and
 * locked ones are not ours to drop.
 */
export async function pruneOwnStale(repoPath: string, root: string, regs: Registration[], bin = "git"): Promise<string[]> {
  const stale = regs.filter((r) => r.prunable && !r.locked && inside(r.path, root) && !existsSync(r.path));
  for (const r of stale) await git(repoPath, ["worktree", "remove", r.path], bin);
  return stale.map((r) => r.path);
}

/**
 * Creates the task's worktree on a new branch from `base` (or the repo's HEAD), or reuses it,
 * e.g. after a restart. Stale registrations in the task's worktree root are dropped first (see
 * pruneOwnStale); nothing else is pruned and no folder is ever deleted: a folder git does not
 * know may hold someone's work.
 */
export async function ensureWorktree(repoPath: string, path: string, branch: string, base: string | null, bin = "git"): Promise<WorktreeInfo> {
  if (!isValidBranchName(branch)) throw new OrchestratorError("worktree.bad_branch", { branch });
  const baseSha = await resolveBase(repoPath, base, bin);
  const list = async () => parseWorktreeList(await git(repoPath, ["worktree", "list", "--porcelain", "-z"], bin));
  let regs = await list();
  if ((await pruneOwnStale(repoPath, dirname(path), regs, bin)).length > 0) regs = await list();
  const here = regs.find((r) => samePath(r.path, path));
  const elsewhere = regs.find((r) => r.branch === branch && !samePath(r.path, path));
  if (elsewhere) throw new OrchestratorError("worktree.branch_elsewhere", { branch, path: elsewhere.path });

  const folder = existsSync(path);
  if (here && folder) return { path, branch, baseSha };
  if (here?.locked) throw new OrchestratorError("worktree.locked", { path });
  if (!here && folder && readdirSync(path).length > 0) throw new OrchestratorError("worktree.path_taken", { path });

  // Registered, folder gone, but not prunable yet (e.g. outside our root): `add --force`
  // re-registers just this path, and git still refuses it if a non-empty folder appeared in the
  // meantime, so a lost race fails instead of overwriting.
  const force = here ? ["--force"] : [];
  mkdirSync(dirname(path), { recursive: true });
  const exists = await run(bin, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath, env: GIT_ENV });
  if (exists.code === 0) await git(repoPath, ["worktree", "add", ...force, path, branch], bin);
  else await git(repoPath, ["worktree", "add", ...force, "-b", branch, path, baseSha], bin);
  return { path, branch, baseSha };
}

export const headSha = async (cwd: string, bin = "git") => (await git(cwd, ["rev-parse", "HEAD"], bin)).trim();

/** Files `git add --ignore-errors` could not read, from its "unable to index file" lines. */
export function unindexedFiles(stderr: string): string[] {
  return [...stderr.matchAll(/unable to index file '(.+)'/g)].map((m) => m[1]!);
}

/**
 * Local work-in-progress commit at a turn boundary (PLAN.md §8.2 step 4). Nothing is pushed.
 * A file another process holds open (editor, dev server, antivirus) makes a plain `git add -A`
 * fail for every file; `--ignore-errors` stages the rest and names the skipped ones, which stay
 * as changes in the worktree for the next turn.
 */
export async function checkpoint(cwd: string, message: string, bin = "git"): Promise<{ sha: string; committed: boolean; skipped: string[] }> {
  const dirty = (await git(cwd, ["status", "--porcelain"], bin)).trim().length > 0;
  let skipped: string[] = [];
  let committed = false;
  if (dirty) {
    const add = await run(bin, ["add", "-A", "--ignore-errors"], { cwd, env: GIT_ENV, timeoutMs: 60_000 });
    skipped = unindexedFiles(add.stderr);
    if (add.code !== 0 && skipped.length === 0) throw new OrchestratorError("git.failed", { command: "add", detail: add.stderr.trim().slice(0, 400) });
    committed = (await run(bin, ["diff", "--cached", "--quiet"], { cwd, env: GIT_ENV })).code === 1;
    if (committed) await git(cwd, ["commit", "-m", message], bin);
  }
  return { sha: await headSha(cwd, bin), committed, skipped };
}

/**
 * Removes one task worktree folder and its registration; the branch stays. No --force, so git
 * itself refuses a worktree that still has changes or untracked files.
 */
export async function removeWorktreeKeepBranch(repoPath: string, path: string, bin = "git"): Promise<void> {
  await git(repoPath, ["worktree", "remove", path], bin);
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
