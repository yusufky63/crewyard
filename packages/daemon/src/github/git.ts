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

export async function defaultBranch(path: string, remote: string): Promise<string | null> {
  const ref = await out(path, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  return ref ? ref.slice(remote.length + 1) : null;
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

/** Local branches with commits no remote-tracking ref has. */
export async function unpushedBranches(path: string): Promise<UnpushedBranch[]> {
  const refs = await out(path, ["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(upstream:short)", "refs/heads"]);
  if (!refs) return [];
  const rows = refs.split(/\r?\n/).map((l) => l.split("\t")).filter((r) => r[0] && r[1]);
  const result = await Promise.all(
    rows.map(async ([branch = "", headSha = "", upstream = ""]) => {
      const n = Number(await out(path, ["rev-list", "--count", headSha, "--not", "--remotes"]));
      return { branch, headSha, commits: Number.isFinite(n) ? n : 0, upstream: upstream || null };
    }),
  );
  return result.filter((b) => b.commits > 0);
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

export async function worktrees(path: string, unpushed: UnpushedBranch[], merged: Set<string>, defaultBranchName: string | null): Promise<WorktreeInfo[]> {
  const raw = parseWorktrees((await out(path, ["worktree", "list", "--porcelain"])) ?? "");
  const unpushedBy = new Map(unpushed.map((u) => [u.branch, u.commits]));
  return Promise.all(
    raw.map(async (w) => {
      const exists = existsSync(w.path);
      const dirty = exists ? await isDirty(w.path) : false;
      const n = w.branch ? (unpushedBy.get(w.branch) ?? 0) : 0;
      const isMerged = Boolean(w.branch && w.branch !== defaultBranchName && merged.has(w.branch));
      // The primary checkout is never offered for cleanup.
      return { path: w.path, branch: w.branch, dirty, unpushed: n, merged: isMerged, stale: !w.primary && isMerged && !dirty && n === 0 };
    }),
  );
}

/** Pushes one branch, never with force. Adds an upstream when the branch has none. */
export async function pushBranch(path: string, remote: string, branch: string, hasUpstream: boolean): Promise<{ ok: boolean; output: string }> {
  const args = ["push", ...(hasUpstream ? [] : ["--set-upstream"]), remote, `refs/heads/${branch}:refs/heads/${branch}`];
  const res = await git(path, args, 120_000);
  return { ok: res.code === 0, output: `${res.stdout}${res.stderr}`.trim() };
}

/** Workflow files as they are in a commit, because that is what GitHub runs for a push of it. */
export async function workflowFilesAt(path: string, sha: string): Promise<Array<{ file: string; text: string }>> {
  const ls = await git(path, ["ls-tree", "--name-only", `${sha}:.github/workflows`]);
  if (ls.code !== 0) return [];
  const names = ls.stdout.split(/\r?\n/).filter((n) => /\.ya?ml$/i.test(n));
  return Promise.all(
    names.map(async (n) => {
      const show = await git(path, ["show", `${sha}:.github/workflows/${n}`]);
      return { file: `.github/workflows/${n}`, text: show.code === 0 ? show.stdout : "" };
    }),
  );
}
