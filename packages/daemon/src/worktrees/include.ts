import { constants, copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { IncludeEntry, IncludePreview } from "@crewyard/core";
import { run } from "@crewyard/proc";

// The include list: gitignored files (`.env`, build caches) copied from the main checkout into a
// new task worktree. Copy only, never a link, so an agent editing its copy never touches the
// original. Only names, sizes and counts leave this module; file contents are never read here
// except by copyFileSync itself, and never logged.

const WALK_LIMIT = 100_000;
const MB = 1024 * 1024;

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Which of `paths` git ignores in `repo`. Tracked files never count as ignored. */
async function ignoredSet(repo: string, paths: string[], gitBin: string): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  // fsmonitor can name a program in the repo's own config; never let this start it.
  // quotePath off, so names with non-ASCII letters come back as typed. Include paths never hold newlines.
  const res = await run(gitBin, ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "check-ignore", "--", ...paths], { cwd: repo, timeoutMs: 30_000, env: GIT_ENV });
  // Exit 1 means "none of them is ignored"; anything else but 0 is a real failure.
  if (res.code !== 0 && res.code !== 1) throw new Error(`git check-ignore failed: ${res.stderr.trim().slice(0, 200)}`);
  return new Set(res.stdout.split(/\r?\n/).filter(Boolean).map(norm));
}

/** Inside `root` after resolving links in the path, so a junctioned parent cannot lead outside it. */
function inside(root: string, abs: string): boolean {
  try {
    const rel = relative(realpathSync(root), realpathSync(abs));
    // A different drive comes back absolute from relative().
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/** Regular files under `dir`, skipping links of any kind (symlinks and junctions both lstat as links). */
function walkFiles(dir: string, limit = WALK_LIMIT): { files: Array<{ rel: string; bytes: number }>; truncated: boolean } {
  const files: Array<{ rel: string; bytes: number }> = [];
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (files.length >= limit) return { files, truncated: true };
      const child = rel ? join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(child);
      else if (e.isFile()) {
        try {
          files.push({ rel: child, bytes: lstatSync(join(dir, child)).size });
        } catch {
          // Gone between readdir and lstat; nothing to copy.
        }
      }
    }
  }
  return { files, truncated: false };
}

/** What the include list would copy from `repo`, in list order, against the size cap. */
export async function previewInclude(repo: string, include: string[], maxMb: number, gitBin = "git"): Promise<IncludePreview> {
  const capBytes = maxMb * MB;
  const unique = [...new Map(include.map((p) => [norm(p), p.replace(/[\\/]+$/, "")])).values()];
  const present = unique.filter((p) => {
    try {
      lstatSync(join(repo, p));
      return true;
    } catch {
      return false;
    }
  });
  const ignored = await ignoredSet(repo, present, gitBin);
  const entries: IncludeEntry[] = [];
  let copyBytes = 0;
  let copyFiles = 0;
  for (const p of unique) {
    const abs = join(repo, p);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      entries.push({ path: p, state: "missing", kind: null, bytes: 0, files: 0 });
      continue;
    }
    if (st.isSymbolicLink() || !inside(repo, abs)) {
      entries.push({ path: p, state: "link", kind: null, bytes: 0, files: 0 });
      continue;
    }
    const kind = st.isDirectory() ? "folder" : "file";
    const walked = kind === "folder" ? walkFiles(abs) : { files: [{ rel: "", bytes: st.size }], truncated: false };
    const bytes = walked.files.reduce((n, f) => n + f.bytes, 0);
    const files = walked.files.length;
    if (!ignored.has(norm(p))) entries.push({ path: p, state: "not_ignored", kind, bytes, files });
    else if (kind === "folder" && files === 0) entries.push({ path: p, state: "link", kind, bytes: 0, files: 0 });
    else if (walked.truncated || copyBytes + bytes > capBytes) entries.push({ path: p, state: "over_cap", kind, bytes, files });
    else {
      entries.push({ path: p, state: "copy", kind, bytes, files });
      copyBytes += bytes;
      copyFiles += files;
    }
  }
  return { entries, copyBytes, copyFiles, capBytes };
}

/**
 * Copies the preview's `copy` entries from `repo` into `worktree`. A file already in the worktree
 * is left as it is (git put it there, or a previous run did), and the cap is checked again while
 * copying in case files grew since the preview.
 */
export function copyInclude(repo: string, worktree: string, preview: IncludePreview): { files: number; bytes: number; skipped: number } {
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  for (const entry of preview.entries.filter((e) => e.state === "copy")) {
    const src = join(repo, entry.path);
    const list = entry.kind === "folder" ? walkFiles(src).files.map((f) => ({ from: join(src, f.rel), to: join(worktree, entry.path, f.rel), bytes: f.bytes })) : [{ from: src, to: join(worktree, entry.path), bytes: entry.bytes }];
    for (const f of list) {
      if (bytes + f.bytes > preview.capBytes) {
        skipped++;
        continue;
      }
      mkdirSync(dirname(f.to), { recursive: true });
      try {
        copyFileSync(f.from, f.to, constants.COPYFILE_EXCL);
        files++;
        bytes += f.bytes;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ENOENT") skipped++;
        else throw err;
      }
    }
  }
  return { files, bytes, skipped };
}
