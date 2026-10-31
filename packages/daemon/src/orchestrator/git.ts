import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { run } from "@crewyard/proc";
import { OrchestratorError } from "./errors.ts";
import { CREWYARD_DIR } from "../setup/config.ts";

// Git through @crewyard/proc only. Worktrees live under `<projects parent>\.crewyard\worktrees\<repo>\<task>`
// (PLAN.md §10) and are never deleted as a side effect: removal is the GitHub work's job after merge
// and a click, or a confirmed park, which keeps the branch.

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };

export async function git(cwd: string, args: string[], bin = "git"): Promise<string> {
  const res = await run(bin, args, { cwd, timeoutMs: 60_000, env: GIT_ENV });
  if (res.code !== 0) throw new OrchestratorError("git.failed", { command: args[0] ?? "", detail: (res.stderr || res.stdout).trim().slice(0, 400) });
  return res.stdout;
}

/** Default worktree root next to the projects folder, as the New project wizard proposes it. */
export const defaultWorktreeRoot = (projectPath: string) => join(dirname(projectPath), CREWYARD_DIR, "worktrees", basename(projectPath));

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

/** Same folder on Windows: case-insensitive, after resolving. */
export const sameDir = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

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

/**
 * A read-only reviewer's own checkout of one commit (pinned review): a detached worktree next to
 * the task's, so the implementer can keep changing the task worktree without moving what the
 * reviewer reads. Reused when the same commit is already checked out there.
 */
export async function addDetachedCheckout(repoPath: string, path: string, sha: string, bin = "git"): Promise<void> {
  const regs = parseWorktreeList(await git(repoPath, ["worktree", "list", "--porcelain", "-z"], bin));
  const existing = regs.find((r) => samePath(r.path, path));
  if (existing && existsSync(path) && (await headSha(path, bin).catch(() => null)) === sha) return;
  if (existing) await git(repoPath, ["worktree", "remove", "--force", path], bin);
  else if (existsSync(path)) throw new OrchestratorError("worktree.path_taken", { path });
  await git(repoPath, ["worktree", "add", "--detach", path, sha], bin);
}

/**
 * Removes a review checkout the daemon made. `--force` is safe only because the folder is ours,
 * holds one detached commit, and its role cannot write; task worktrees never go through here.
 */
export async function removeDetachedCheckout(repoPath: string, path: string, bin = "git"): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", path], bin);
}

export const diffStat = async (cwd: string, baseSha: string, bin = "git") => (await git(cwd, ["diff", "--stat", baseSha, "HEAD"], bin)).trim();

/**
 * The oldest Git whose `merge-tree --write-tree` (with `--name-only` and `-z`) test-merges two
 * branches without a worktree (Git 2.38 release notes). Below it, every merge into a goal branch
 * is left to you (docs/adr/0019); the machine check names the same version.
 */
export const MIN_GIT_MERGE_TREE = "2.38.0";

/** Dotted versions compared numerically; a suffix like `.windows.3` is ignored. */
export function gitAtLeast(version: string | null, min: string = MIN_GIT_MERGE_TREE): boolean {
  if (!version) return false;
  const a = (version.match(/\d+(?:\.\d+)*/)?.[0] ?? "").split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** `git --version` as "2.56.0", or null when git does not answer. */
export async function gitVersion(bin = "git"): Promise<string | null> {
  const res = await run(bin, ["--version"], { timeoutMs: 15_000, env: GIT_ENV });
  return res.code === 0 ? (res.stdout.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null) : null;
}

export type MergeTreeResult = { clean: true; tree: string } | { clean: false; paths: string[] };

/**
 * `merge-tree --write-tree -z --name-only` output: the tree id, then the conflicted file names,
 * each NUL-terminated, then an empty field before git's informational messages.
 */
export function parseMergeTree(out: string): { tree: string; paths: string[] } {
  const fields = out.split("\0");
  const tree = (fields[0] ?? "").trim();
  const paths: string[] = [];
  for (const f of fields.slice(1)) {
    if (f === "") break;
    if (!paths.includes(f)) paths.push(f);
  }
  return { tree, paths };
}

/**
 * Test-merges `theirs` into `ours` with no worktree and no index. Through `run`, not `git()`:
 * exit 1 is git's normal answer for a conflict, and `git()` throws on any non-zero exit.
 */
export async function mergeTreeCheck(repoPath: string, ours: string, theirs: string, bin = "git"): Promise<MergeTreeResult> {
  for (const ref of [ours, theirs]) if (ref.startsWith("-")) throw new OrchestratorError("git.failed", { command: "merge-tree", detail: `bad ref ${ref}` });
  const res = await run(bin, ["merge-tree", "--write-tree", "-z", "--name-only", ours, theirs], { cwd: repoPath, timeoutMs: 60_000, env: GIT_ENV });
  const parsed = parseMergeTree(res.stdout);
  // A real answer always starts with the tree it wrote; a ref git cannot read can also exit 1.
  const answered = /^[0-9a-f]{40,64}$/.test(parsed.tree);
  if (res.code === 0 && answered) return { clean: true, tree: parsed.tree };
  if (res.code === 1 && answered) return { clean: false, paths: parsed.paths };
  throw new OrchestratorError("git.failed", { command: "merge-tree", detail: (res.stderr || res.stdout).trim().slice(0, 400) });
}

/**
 * `git merge --no-ff --no-edit <branch>` in a worktree Crewyard owns, under the repo's own
 * identity and hooks. A merge git refuses (a hook, a conflict that appeared since the check) is
 * aborted so the worktree is left as it was, and reported with git's words.
 */
export async function mergeNoFf(cwd: string, branch: string, bin = "git"): Promise<{ ok: true; sha: string } | { ok: false; detail: string }> {
  if (branch.startsWith("-")) throw new OrchestratorError("git.failed", { command: "merge", detail: `bad branch ${branch}` });
  const res = await run(bin, ["merge", "--no-ff", "--no-edit", branch], { cwd, timeoutMs: 120_000, env: GIT_ENV });
  if (res.code === 0) return { ok: true, sha: await headSha(cwd, bin) };
  await run(bin, ["merge", "--abort"], { cwd, timeoutMs: 60_000, env: GIT_ENV });
  return { ok: false, detail: (res.stderr || res.stdout).trim().slice(0, 400) };
}

/** Whether `ancestor` is already in `of`'s history (a merge that landed before a restart). */
export async function isAncestor(cwd: string, ancestor: string, of: string, bin = "git"): Promise<boolean> {
  const res = await run(bin, ["merge-base", "--is-ancestor", ancestor, of], { cwd, timeoutMs: 60_000, env: GIT_ENV });
  return res.code === 0;
}

/** The commit a branch points at, or null when it does not exist. */
export async function branchSha(repoPath: string, branch: string, bin = "git"): Promise<string | null> {
  const res = await run(bin, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { cwd: repoPath, timeoutMs: 60_000, env: GIT_ENV });
  return res.code === 0 ? res.stdout.trim() : null;
}

/** `git log --oneline before..after`, at most `max` lines: the commits a merge added. */
export async function commitsBetween(repoPath: string, before: string, after: string, max = 30, bin = "git"): Promise<string[]> {
  const res = await run(bin, ["log", "--oneline", "--no-decorate", `--max-count=${max}`, `${before}..${after}`], { cwd: repoPath, timeoutMs: 60_000, env: GIT_ENV });
  return res.code === 0 ? res.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

export const isClean = async (cwd: string, bin = "git") => (await git(cwd, ["status", "--porcelain"], bin)).trim().length === 0;

/** Write to a temp file, then rename, retrying while antivirus or an editor holds the target. */
export function writeFileAtomic(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  if (typeof content === "string") writeFileSync(tmp, content, "utf8");
  else writeFileSync(tmp, content);
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
