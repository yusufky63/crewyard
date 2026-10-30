import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ScanResult } from "@crewyard/core";

/** Lists direct subfolders of `root` that are git repositories (have a .git folder or file). */
export function scanForRepos(root: string, known: Set<string>): ScanResult {
  const abs = resolve(root);
  if (!existsSync(abs)) return { root: abs, repos: [] };
  const repos = readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => join(abs, d.name))
    .filter((p) => existsSync(join(p, ".git")))
    .map((p) => ({ name: basename(p), path: p, known: known.has(p.toLowerCase()), usedAt: lastUsed(p) }))
    // Most recently used first, so the repo you were just in is at the top of a long list.
    .sort((a, b) => (b.usedAt ?? "").localeCompare(a.usedAt ?? "") || a.name.localeCompare(b.name));
  return { root: abs, repos };
}

/**
 * When a repo was last used. Git rewrites `.git/index` on almost every command (status, add,
 * commit, checkout), so its time stands in; a `.git` file (a worktree or submodule) has no index of
 * its own, and then the file's own time is the best there is.
 */
export function lastUsed(repo: string): string | null {
  for (const f of [join(repo, ".git", "index"), join(repo, ".git", "HEAD"), join(repo, ".git")]) {
    try {
      return statSync(f).mtime.toISOString();
    } catch {
      // Not there in this layout; try the next.
    }
  }
  return null;
}

export function assertFolder(path: string): string {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`Not a folder: ${abs}`);
  return abs;
}
