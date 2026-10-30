import { existsSync } from "node:fs";
import { run, which } from "@crewyard/proc";
import type { GithubRemote, UnpushedBranch, WorktreeInfo } from "@crewyard/core";

// Local repository state through git itself, so it is right even when GitHub is unreachable.

let gitBin: Promise<string | null> | null = null;
const git = async (cwd: string, args: string[], timeoutMs = 15_000) => {
  gitBin ??= which("git");
  const bin = await gitBin;
  if (!bin) throw new Error("git was not found on PATH");
  return run(bin, ["-c", "core.quotepath=off", ...args], { cwd, timeoutMs });
};

const out = async (cwd: string, args: string[]): Promise<string | null> => {
  const res = await git(cwd, args);
  return res.code === 0 ? res.stdout.trim() : null;
};

/**
 * Owner and repo from a GitHub remote URL. Any user:token part of an https URL is dropped, so a
 * credential in a remote never reaches the UI.
 */
export function parseRemote(name: string, url: string): GithubRemote | null {
  const m =
    url.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ??
    url.match(/^(?:[^@]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m?.[1] || !m[2]) return null;
  return { name, owner: m[1], repo: m[2], webUrl: `https://github.com/${m[1]}/${m[2]}` };
}

export async function isRepo(path: string): Promise<boolean> {
  return (await out(path, ["rev-parse", "--is-inside-work-tree"])) === "true";
}

/** Prefers "origin"; returns the URL too so the caller can tell "no remote" from "not GitHub". */
export async function readRemote(path: string): Promise<{ name: string; url: string } | null> {
  const names = (await out(path, ["remote"]))?.split(/\r?\n/).filter(Boolean) ?? [];
  const name = names.includes("origin") ? "origin" : names[0];
  if (!name) return null;
  const url = await out(path, ["remote", "get-url", name]);
  return url ? { name, url } : null;
}

/**
 * The remote's default branch as the local clone knows it. `<remote>/HEAD` can still point at a
 * branch the remote deleted (renamed default, emdash #3198); that counts as unknown, so callers
 * fall back to GitHub's answer instead of a base that does not exist.
 */
export async function defaultBranch(path: string, remote: string): Promise<string | null> {
  const ref = await out(path, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  if (!ref) return null;
  return (await out(path, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`])) ? ref.slice(remote.length + 1) : null;
}

export async function currentBranch(path: string): Promise<string | null> {
  const b = await out(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return b || null;
}

export async function aheadBehind(path: string): Promise<{ ahead: number | null; behind: number | null }> {
  const counts = await out(path, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  const [behind, ahead] = counts?.split(/\s+/).map(Number) ?? [];
  return behind === undefined || ahead === undefined || Number.isNaN(behind) ? { ahead: null, behind: null } : { ahead, behind };
}

export async function isDirty(path: string): Promise<boolean> {
  const s = await out(path, ["status", "--porcelain"]);
  return Boolean(s);
}

/**
 * Commits reachable from `tip` inside the unpushed graph. The graph holds only commits no remote
 * has, so the walk stops at anything already pushed.
 */
export function countUnpushed(graph: Map<string, string[]>, tip: string): number {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const sha = stack.pop()!;
    if (seen.has(sha) || !graph.has(sha)) continue;
    seen.add(sha);
    stack.push(...graph.get(sha)!);
  }
  return seen.size;
}

/** Local branches with commits no remote-tracking ref has. Two git calls, however many branches there are. */
export async function unpushedBranches(path: string): Promise<UnpushedBranch[]> {
  const [refs, revs] = await Promise.all([
    out(path, ["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(upstream:short)", "refs/heads"]),
    out(path, ["rev-list", "--parents", "--branches", "--not", "--remotes"]),
  ]);
  if (!refs) return [];
  const graph = new Map<string, string[]>();
  for (const line of revs?.split(/\r?\n/) ?? []) {
    const [sha, ...parents] = line.trim().split(" ");
    if (sha) graph.set(sha, parents);
  }
  return refs
    .split(/\r?\n/)
    .map((l) => l.split("\t"))
    .filter((r) => r[0] && r[1])
    .map(([branch = "", headSha = "", upstream = ""]) => ({ branch, headSha, commits: countUnpushed(graph, headSha), upstream: upstream || null }))
    .filter((b) => b.commits > 0);
}

export async function branchTip(path: string, branch: string): Promise<string | null> {
  return out(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
}

/** Branches whose tip is already in `base` (e.g. origin/main). */
export async function mergedInto(path: string, base: string): Promise<Set<string>> {
  const list = await out(path, ["branch", "--format=%(refname:short)", "--merged", base]);
  return new Set(list?.split(/\r?\n/).filter(Boolean) ?? []);
}

export interface RawWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  primary: boolean;
}

export function parseWorktrees(porcelain: string): RawWorktree[] {
  const items: RawWorktree[] = [];
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.includes("bare")) continue;
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5) ?? null;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    items.push({ path, head, branch, primary: items.length === 0 });
  }
  return items;
}

/** Runs `fn` over `items` with at most `limit` running at once, so 100+ worktrees do not start 100+ git processes. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function worktrees(path: string, unpushed: UnpushedBranch[], merged: Set<string>, defaultBranchName: string | null): Promise<WorktreeInfo[]> {
  const raw = parseWorktrees((await out(path, ["worktree", "list", "--porcelain"])) ?? "");
  const unpushedBy = new Map(unpushed.map((u) => [u.branch, u.commits]));
  return pool(raw, 8, async (w) => {
    const exists = existsSync(w.path);
    const dirty = exists ? await isDirty(w.path) : false;
    const n = w.branch ? (unpushedBy.get(w.branch) ?? 0) : 0;
    const isMerged = Boolean(w.branch && w.branch !== defaultBranchName && merged.has(w.branch));
    // The primary checkout is never offered for cleanup.
    return { path: w.path, branch: w.branch, dirty, unpushed: n, merged: isMerged, stale: !w.primary && isMerged && !dirty && n === 0 };
  });
}

/** Pushes one branch, never with force. Adds an upstream when the branch has none. */
export async function pushBranch(path: string, remote: string, branch: string, hasUpstream: boolean): Promise<{ ok: boolean; output: string }> {
  const args = ["push", ...(hasUpstream ? [] : ["--set-upstream"]), remote, `refs/heads/${branch}:refs/heads/${branch}`];
  const res = await git(path, args, 120_000);
  return { ok: res.code === 0, output: `${res.stdout}${res.stderr}`.trim() };
}

// Workflow files by blob id: many branches share the same files, so each blob is read once.
const blobs = new Map<string, string>();

/** Workflow files as they are in a commit, because that is what GitHub runs for a push of it. */
export async function workflowFilesAt(path: string, sha: string): Promise<Array<{ file: string; text: string }>> {
  const ls = await git(path, ["ls-tree", `${sha}:.github/workflows`]);
  if (ls.code !== 0) return [];
  const entries = ls.stdout
    .split(/\r?\n/)
    .map((l) => l.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m?.[1] && m[2] && /\.ya?ml$/i.test(m[2])));
  return Promise.all(
    entries.map(async ([, blob = "", name = ""]) => {
      let text = blobs.get(blob);
      if (text === undefined) {
        const show = await git(path, ["cat-file", "blob", blob]);
        text = show.code === 0 ? show.stdout : "";
        if (blobs.size > 2000) blobs.clear();
        blobs.set(blob, text);
      }
      return { file: `.github/workflows/${name}`, text };
    }),
  );
}

// ---- Task pull requests

/** Full sha of any ref, or null when it does not exist. */
export async function refSha(path: string, ref: string): Promise<string | null> {
  return out(path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

/** Commits on `head` that `base` does not have. */
export async function revCount(path: string, base: string, head: string): Promise<number | null> {
  const n = await out(path, ["rev-list", "--count", `${base}..${head}`]);
  return n === null || Number.isNaN(Number(n)) ? null : Number(n);
}

/** Subjects of the commits on `head` that `base` does not have, oldest first. */
export async function commitSubjects(path: string, base: string, head: string, max = 30): Promise<string[]> {
  const log = await out(path, ["log", "--reverse", "--format=%s", `-n${max}`, `${base}..${head}`]);
  return log?.split(/\r?\n/).filter(Boolean) ?? [];
}

/** Files, added and removed lines between the merge base of `base` and `head`, and `head`. */
export async function diffTotals(path: string, base: string, head: string): Promise<{ files: number; added: number; removed: number } | null> {
  const stat = await out(path, ["diff", "--numstat", `${base}...${head}`]);
  if (stat === null) return null;
  const rows = stat.split(/\r?\n/).filter(Boolean).map((l) => l.split("\t"));
  // Binary files show "-" for both counts.
  const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : 0);
  return { files: rows.length, added: rows.reduce((n, r) => n + num(r[0]), 0), removed: rows.reduce((n, r) => n + num(r[1]), 0) };
}

export async function listWorktrees(path: string): Promise<RawWorktree[]> {
  return parseWorktrees((await out(path, ["worktree", "list", "--porcelain"])) ?? "");
}

/**
 * `git worktree remove` without --force: git itself refuses a worktree with changes or untracked
 * files, and a folder it does not list. Nothing else is deleted, and nothing is pruned repo-wide.
 */
export async function removeWorktree(repoPath: string, path: string): Promise<{ ok: boolean; output: string }> {
  const res = await git(repoPath, ["worktree", "remove", path], 60_000);
  return { ok: res.code === 0, output: `${res.stdout}${res.stderr}`.trim() };
}

/** Read limit of @crewyard/proc's run(); output at this size was cut. */
const OUTPUT_CAP = 4 * 1024 * 1024;

/**
 * Everything in a worktree against its base commit: committed, staged and unstaged changes to
 * tracked files. Never touches the index, so untracked files are listed separately.
 */
export async function worktreeDiff(path: string, baseSha: string): Promise<{ ok: boolean; text: string; cut: boolean; unreadable: string[] }> {
  const args = ["diff", "--no-color", "--no-ext-diff", "-U3", baseSha];
  const res = await git(path, ["diff", "--no-color", "--no-ext-diff", "--find-renames", "-U3", baseSha, "--"], 60_000);
  if (res.code === 0) return { ok: true, text: res.stdout, cut: res.stdout.length >= OUTPUT_CAP, unreadable: [] };
  // One file held open by another process makes git fail for all of them ("cannot hash"; orca
  // #33953). Listing names never reads file contents, so diff the rest file by file (renames then
  // show as a delete and an add).
  const names = await git(path, ["diff", "--name-only", "-z", baseSha, "--"]);
  if (names.code !== 0) return { ok: false, text: "", cut: false, unreadable: [] };
  const parts = await perFile(path, args, names.stdout.split("\0").filter(Boolean));
  const text = parts.ok.join("");
  return { ok: true, text, cut: text.length >= OUTPUT_CAP, unreadable: parts.failed };
}

const FALLBACK_BATCH = 50;

/**
 * Runs `git <args> -- <files>` in batches and only splits a batch that fails, so a thousand
 * changed files with one locked among them cost about twenty-one git runs, not a thousand.
 */
export async function perFile(path: string, args: string[], files: string[]): Promise<{ ok: string[]; failed: string[] }> {
  const ok: string[] = [];
  const failed: string[] = [];
  // A file named like a glob ("a*.txt") must match only itself.
  const spec = (f: string) => `:(literal)${f}`;
  let size = 0;
  for (let i = 0; i < files.length && size < OUTPUT_CAP; i += FALLBACK_BATCH) {
    const batch = files.slice(i, i + FALLBACK_BATCH);
    const res = await git(path, [...args, "--", ...batch.map(spec)], 60_000);
    if (res.code === 0) {
      ok.push(res.stdout);
      size += res.stdout.length;
      continue;
    }
    for (const file of batch) {
      const one = batch.length === 1 ? res : await git(path, [...args, "--", spec(file)], 60_000);
      if (one.code === 0) {
        ok.push(one.stdout);
        size += one.stdout.length;
      } else failed.push(file);
    }
  }
  return { ok, failed };
}

export async function untrackedFiles(path: string): Promise<string[]> {
  const res = await git(path, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return res.code === 0 ? res.stdout.split("\0").filter(Boolean) : [];
}
