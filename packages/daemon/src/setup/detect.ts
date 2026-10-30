import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { GitState, PackageManager, PathLengthCheck, ProjectTypeGuess } from "@crewyard/core";
import { run, which } from "@crewyard/proc";

// Read-only detection for the New project wizard (PLAN.md §11.1). Nothing here writes to the folder.

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const readJson = (file: string): Record<string, unknown> | null => {
  const text = readText(file);
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

// Checked in this order; a pnpm workspace file marks pnpm even before its lockfile exists.
const LOCKFILES: Array<[string, PackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["pnpm-workspace.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];
const MANAGERS: PackageManager[] = ["pnpm", "npm", "yarn", "bun"];

// npm init writes this placeholder; it is not a real test command.
const NPM_PLACEHOLDER_TEST = /no test specified/i;

function nodeGuess(dir: string, entries: string[]): ProjectTypeGuess {
  const pkg = readJson(join(dir, "package.json")) ?? {};
  const lock = LOCKFILES.find(([file]) => entries.includes(file));
  // Corepack's "packageManager" field is an explicit choice, so it wins over a stray lockfile
  // (the same order package-manager-detector uses).
  const name = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : null;
  const field = MANAGERS.find((m) => m === name) ?? null;
  const pm = field ?? lock?.[1] ?? null;
  const scripts = (pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {}) as Record<string, unknown>;
  const has = (name: string) => typeof scripts[name] === "string" && !(name === "test" && NPM_PLACEHOLDER_TEST.test(scripts[name] as string));
  // No lockfile and no packageManager field: the manager stays unknown, but npm ships with Node
  // and runs any package.json script, so the commands still have something to run them with.
  const runner = pm ?? "npm";
  const runCmd = (name: string) => (runner === "npm" ? `npm run ${name}` : `${runner} ${name}`);
  return {
    kind: "node",
    markers: ["package.json", ...(lock ? [lock[0]] : [])],
    packageManager: pm,
    build: has("build") ? runCmd("build") : null,
    test: has("test") ? `${runner} test` : null,
  };
}

function pythonGuess(dir: string, entries: string[]): ProjectTypeGuess {
  const pyproject = readText(join(dir, "pyproject.toml")) ?? "";
  const runner = entries.includes("uv.lock") ? "uv run " : entries.includes("poetry.lock") ? "poetry run " : "";
  const markers = ["pyproject.toml", ...["uv.lock", "poetry.lock"].filter((f) => entries.includes(f))];
  return {
    kind: "python",
    markers,
    packageManager: null,
    build: entries.includes("uv.lock") ? "uv build" : entries.includes("poetry.lock") ? "poetry build" : null,
    // Only suggest pytest when the project names it; otherwise we would be guessing.
    test: /\bpytest\b/.test(pyproject) ? `${runner}pytest` : null,
  };
}

/** Guesses the project type from marker files at the top of the folder. */
export function detectProjectType(dir: string): ProjectTypeGuess {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { kind: "unknown", markers: [], packageManager: null, build: null, test: null };
  }
  const csproj = entries.filter((f) => /\.csproj$/i.test(f));
  const sln = entries.filter((f) => /\.slnx?$/i.test(f));
  if (entries.includes("project.godot")) {
    // A Godot project with a C# project builds with dotnet; plain GDScript has no build or test step.
    return csproj.length > 0
      ? { kind: "godot-csharp", markers: ["project.godot", ...csproj], packageManager: null, build: "dotnet build", test: "dotnet test" }
      : { kind: "godot", markers: ["project.godot"], packageManager: null, build: null, test: null };
  }
  if (csproj.length > 0 || sln.length > 0) {
    return { kind: "dotnet", markers: [...sln, ...csproj], packageManager: null, build: "dotnet build", test: "dotnet test" };
  }
  if (entries.includes("package.json")) return nodeGuess(dir, entries);
  if (entries.includes("Cargo.toml")) return { kind: "rust", markers: ["Cargo.toml"], packageManager: null, build: "cargo build", test: "cargo test" };
  if (entries.includes("pyproject.toml")) return pythonGuess(dir, entries);
  return { kind: "unknown", markers: [], packageManager: null, build: null, test: null };
}

/** "owner/name" for github.com remotes in https, ssh or scp form; null for anything else. */
export function parseGithubRemote(url: string): string | null {
  const m = url.trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

// fsmonitor can name a program in the repo's own config; never let detection start it.
const SAFE_GIT = ["-c", "core.fsmonitor=false"];

const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

export async function gitState(dir: string): Promise<GitState> {
  const empty: GitState = { available: false, isRepo: false, parentRepo: null, branch: null, commits: 0, clean: null, remoteUrl: null, githubRepo: null, error: null };
  const git = await which("git");
  if (!git) return empty;
  const g = (...args: string[]) => run(git, [...SAFE_GIT, "-C", dir, ...args], { timeoutMs: 15_000 });
  const top = await g("rev-parse", "--show-toplevel");
  if (top.code !== 0) {
    const refused = /dubious ownership|safe\.directory/i.test(top.stderr);
    return { ...empty, available: true, error: refused ? top.stderr.trim().split(/\r?\n/)[0] ?? null : null };
  }
  const toplevel = top.stdout.trim();
  if (!samePath(toplevel, dir)) return { ...empty, available: true, parentRepo: resolve(toplevel) };
  const [branch, count, status, remote] = await Promise.all([
    g("symbolic-ref", "--short", "HEAD"),
    g("rev-list", "--count", "HEAD"),
    g("status", "--porcelain", "--untracked-files=normal"),
    g("remote", "get-url", "origin"),
  ]);
  const remoteUrl = remote.code === 0 ? remote.stdout.trim() || null : null;
  return {
    available: true,
    isRepo: true,
    parentRepo: null,
    // A detached HEAD has no branch name.
    branch: branch.code === 0 ? branch.stdout.trim() || null : null,
    // rev-list fails on a repo with no commits yet.
    commits: count.code === 0 ? Number.parseInt(count.stdout.trim(), 10) || 0 : 0,
    clean: status.code === 0 ? status.stdout.trim() === "" : null,
    remoteUrl,
    githubRepo: remoteUrl ? parseGithubRemote(remoteUrl) : null,
    error: null,
  };
}

/** PLAN.md §10: worktrees live next to the projects folder, e.g. C:\Projeler\.mc\worktrees\<repo>. */
export function defaultWorktreeRoot(projectPath: string): string {
  const abs = resolve(projectPath);
  return join(dirname(abs), ".mc", "worktrees", basename(abs));
}

/** Room left for the per-task folder under the worktree root (`<root>\<task>\`). Task slugs are cut to this. */
export const TASK_SEGMENT = 40;
export const MAX_PATH = 260;
const WALK_LIMIT = 50_000;
const DEPTH_LIMIT = 40;
// Never checked out (.git) or reinstalled per worktree and walked by nobody (node_modules).
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Longest relative file path under `dir`, from a bounded breadth-first walk. */
export function longestRelativePath(dir: string, limit = WALK_LIMIT): { path: string | null; seen: number; truncated: boolean } {
  let longest: string | null = null;
  let seen = 0;
  const queue: Array<[string, number]> = [["", 0]];
  while (queue.length > 0) {
    const [rel, depth] = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (seen >= limit) return { path: longest, seen, truncated: true };
      seen++;
      const child = rel ? `${rel}${sep}${e.name}` : e.name;
      if (!longest || child.length > longest.length) longest = child;
      if (e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name)) {
        if (depth + 1 < DEPTH_LIMIT) queue.push([child, depth + 1]);
      }
    }
  }
  return { path: longest, seen, truncated: false };
}

/** Worktree prefix (`<root>\<task>\`) plus the longest relative path, against 260 unless long paths are on. */
export function checkPathLength(dir: string, worktreeRoot: string, longPathsEnabled: boolean | null, walkLimit = WALK_LIMIT): PathLengthCheck {
  const walk = longestRelativePath(dir, walkLimit);
  const prefix = resolve(worktreeRoot).length + 1 + TASK_SEGMENT + 1;
  const longest = prefix + (walk.path?.length ?? 0);
  const limit = longPathsEnabled ? null : MAX_PATH;
  return { longest, longestRelative: walk.path, limit, ok: limit === null || longest < limit, truncated: walk.truncated, filesSeen: walk.seen };
}

/**
 * Folders next to `dir` whose names differ from it only by letter case. NTFS folders with case
 * sensitivity turned on (WSL, `fsutil file setCaseSensitiveInfo`) can hold both `App` and `app`;
 * everything else here compares paths without case (the projects table, the default worktree root
 * `.mc\worktrees\<name>`), so the two would share one project and one worktree folder
 * (vibe-kanban #2164). `list` is injectable for tests.
 */
export function caseTwins(dir: string, list: (parent: string) => string[] = readdirSync): string[] {
  const abs = resolve(dir);
  const name = basename(abs);
  let siblings: string[];
  try {
    siblings = list(dirname(abs));
  } catch {
    return [];
  }
  return siblings.filter((s) => s !== name && s.toLowerCase() === name.toLowerCase()).map((s) => join(dirname(abs), s));
}

/** The refusal for `setup.create`, or null. Raw text like the other folder errors here. */
export function caseTwinProblem(dir: string, list?: (parent: string) => string[]): string | null {
  const twins = caseTwins(dir, list);
  return twins.length ? `${dir} and ${twins.join(", ")} differ only by letter case; rename one first, since Crewyard would treat them as one project and one worktree folder.` : null;
}

export function folderState(dir: string): { exists: boolean; empty: boolean } {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { exists: false, empty: false };
  return { exists: true, empty: readdirSync(dir).length === 0 };
}

export function listWorkflows(dir: string): string[] {
  try {
    return readdirSync(join(dir, ".github", "workflows")).filter((f) => /\.ya?ml$/i.test(f)).sort();
  } catch {
    return [];
  }
}
