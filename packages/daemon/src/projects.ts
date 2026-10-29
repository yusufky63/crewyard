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
    .map((p) => ({ name: basename(p), path: p, known: known.has(p.toLowerCase()) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { root: abs, repos };
}

export function assertFolder(path: string): string {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`Not a folder: ${abs}`);
  return abs;
}
