import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileEntry, FilePreview, FolderListing } from "@crewyard/core";
import { run } from "@crewyard/proc";

// The inspector's Files tab: a read-only window into one task worktree. Every path the renderer
// sends is relative to the worktree root and is checked twice: by its text (no `..`, no drive or
// UNC prefix, no stream suffix) and again after resolving links on disk, so a junction or symlink
// inside the worktree can never lead the view to a file outside it. Nothing here writes.
//
// What this does not guard against: an agent swapping a folder for a junction between our
// realpath and our open. The agent runs as the same Windows user and could read that file
// itself, so the race gains it nothing; the check exists so the panel never shows, by its own
// steering, a file the user did not put in front of the agent.

/** Entries one folder listing returns; omux stops at 500, a worktree root rarely holds more. */
export const LIST_CAP = 1_000;
/** Text read for a preview; the timeline cuts tool output at a similar size. */
export const TEXT_CAP = 256 * 1024;
/** Images larger than this are not sent to the window. */
export const IMAGE_CAP = 5 * 1024 * 1024;
/** Longest relative path accepted; long Windows paths beyond MAX_PATH still fit. */
export const PATH_CAP = 2_048;
/** A NUL byte in this many leading bytes makes a file binary (git uses the same 8000-byte probe). */
const BINARY_PROBE = 8_000;
const STAT_BATCH = 64;
const IGNORE_BATCH = 100;

const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
} as const;

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
// Windows device names open the device, not a file, whatever the extension.
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

/** The IPC error is the code itself, so the renderer can translate it. */
export class FilesError extends Error {
  constructor(readonly code: "files.bad_path" | "files.outside" | "files.not_found" | "files.not_folder" | "files.not_file" | "files.missing" | "files.no_worktree") {
    super(code);
    this.name = "FilesError";
  }
}

/** Splits a relative path into its parts, refusing anything that could name a place outside the root. */
export function pathParts(rel: string, platform: NodeJS.Platform = process.platform): string[] {
  if (typeof rel !== "string" || rel.length > PATH_CAP || rel.includes("\0")) throw new FilesError("files.bad_path");
  if (rel === "") return [];
  // A colon is a drive (C:), a stream (a.txt:secret) or a device; none belongs in a relative path.
  if (rel.includes(":") || isAbsolute(rel) || /^[\\/]/.test(rel)) throw new FilesError("files.outside");
  const parts = rel.split(/[\\/]/);
  for (const p of parts) {
    if (p === "..") throw new FilesError("files.outside");
    if (p === "" || p === ".") throw new FilesError("files.bad_path");
    if (platform === "win32" && (DEVICE.test(p) || /[<>"|?*]/.test(p))) throw new FilesError("files.bad_path");
  }
  return parts;
}

/** `child` is `root` or below it. Case-insensitive on Windows, where C:\A and c:\a are one folder. */
export function within(root: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
  const r = fold(root).replace(/[\\/]+$/, "");
  const c = fold(child).replace(/[\\/]+$/, "");
  if (c === r) return true;
  const s = platform === "win32" ? /[\\/]/ : /\//;
  return c.startsWith(r) && s.test(c.charAt(r.length));
}

/** The real root and the real target of `rel` under it, refusing a target whose links lead outside. */
export async function confine(root: string, rel: string): Promise<{ rootReal: string; real: string; parts: string[] }> {
  const parts = pathParts(rel);
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new FilesError("files.missing");
  }
  const target = resolve(rootReal, ...parts);
  // The text check above already holds; this is the belt to its braces.
  if (!within(rootReal, target)) throw new FilesError("files.outside");
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new FilesError("files.not_found");
  }
  if (!within(rootReal, real)) throw new FilesError("files.outside");
  // relative() comes back absolute across drives; within() covers it, this keeps the rule obvious.
  if (isAbsolute(relative(rootReal, real))) throw new FilesError("files.outside");
  return { rootReal, real, parts };
}

/** Which of `paths` (relative, `/`-separated, folders ending in `/`) git ignores. Tracked files never count. */
async function ignoredSet(root: string, paths: string[], gitBin: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < paths.length; i += IGNORE_BATCH) {
    const batch = paths.slice(i, i + IGNORE_BATCH);
    // fsmonitor can name a program in the repo's own config; never let this start it. quotePath off
    // returns non-ASCII names as typed (-z needs --stdin, which run() has no pipe for); a name git
    // still quotes (a quote or newline in it) just stays unmarked.
    const res = await run(gitBin, ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "check-ignore", "--", ...batch], { cwd: root, timeoutMs: 15_000, env: GIT_ENV });
    // Exit 1 means none is ignored; anything else (no git, not a repo) leaves the marks off.
    if (res.code !== 0 && res.code !== 1) return out;
    for (const p of res.stdout.split(/\r?\n/)) if (p) out.add(p);
  }
  return out;
}

/** One folder of the worktree: folders first, then files, by name, at most LIST_CAP entries. */
export async function listFolder(root: string, rel: string, gitBin = "git"): Promise<FolderListing> {
  const { rootReal, real, parts } = await confine(root, rel);
  let dirents;
  try {
    dirents = await readdir(real, { withFileTypes: true });
  } catch (err) {
    throw new FilesError((err as NodeJS.ErrnoException).code === "ENOTDIR" ? "files.not_folder" : "files.not_found");
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const sorted = [...dirents].sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || byName(a, b));
  const kept = sorted.slice(0, LIST_CAP);
  const entries: FileEntry[] = [];
  for (let i = 0; i < kept.length; i += STAT_BATCH) {
    const batch = kept.slice(i, i + STAT_BATCH);
    // lstat, never stat: a junction lstats as a link on Windows, so it is shown and not followed.
    const stats = await Promise.all(batch.map((d) => lstat(join(real, d.name)).catch(() => null)));
    batch.forEach((d, j) => {
      const s = stats[j];
      if (!s) return;
      const kind = s.isSymbolicLink() ? "link" : s.isDirectory() ? "folder" : s.isFile() ? "file" : null;
      if (kind) entries.push({ name: d.name, kind, bytes: kind === "file" ? s.size : null, ignored: false });
    });
  }
  const prefix = parts.length ? `${parts.join("/")}/` : "";
  const ask = entries.filter((e) => e.name !== ".git").map((e) => `${prefix}${e.name}${e.kind === "folder" ? "/" : ""}`);
  const ignored = await ignoredSet(rootReal, ask, gitBin);
  for (const e of entries) e.ignored = e.name === ".git" || ignored.has(`${prefix}${e.name}${e.kind === "folder" ? "/" : ""}`);
  return { path: parts.join("/"), entries, total: dirents.length };
}

/** The start of one file: text up to TEXT_CAP, an image up to IMAGE_CAP, or just its size. */
export async function readPreview(root: string, rel: string): Promise<FilePreview> {
  const { real, parts } = await confine(root, rel);
  const path = parts.join("/");
  const fh = await open(real, "r").catch(() => {
    throw new FilesError("files.not_found");
  });
  try {
    const st = await fh.stat();
    if (st.isDirectory()) throw new FilesError("files.not_file");
    if (!st.isFile()) throw new FilesError("files.not_file");
    const bytes = st.size;
    const mime = IMAGE_MIME[extname(real).toLowerCase() as keyof typeof IMAGE_MIME];
    if (mime) {
      if (bytes > IMAGE_CAP) return { kind: "binary", path, bytes, reason: "too_large" };
      const buf = await readUpTo(fh, bytes);
      return { kind: "image", path, bytes, mime, base64: buf.toString("base64") };
    }
    const buf = await readUpTo(fh, Math.min(bytes, TEXT_CAP));
    if (buf.subarray(0, BINARY_PROBE).includes(0)) return { kind: "binary", path, bytes, reason: "binary" };
    const truncated = bytes > buf.length;
    // stream: true holds back a character cut in half at the cap instead of showing U+FFFD.
    const text = new TextDecoder("utf-8").decode(buf, { stream: truncated }).replace(/^\uFEFF/, "");
    return { kind: "text", path, bytes, text, truncated, cap: TEXT_CAP };
  } finally {
    await fh.close();
  }
}

async function readUpTo(fh: Awaited<ReturnType<typeof open>>, max: number): Promise<Buffer> {
  const buf = Buffer.alloc(max);
  let at = 0;
  while (at < max) {
    const { bytesRead } = await fh.read(buf, at, max - at, at);
    if (bytesRead === 0) break;
    at += bytesRead;
  }
  return buf.subarray(0, at);
}

/** For tests and the mention filter: the relative form of an absolute path under `root`, or null. */
export function relativeInside(root: string, abs: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!within(root, abs, platform)) return null;
  const rest = abs.slice(root.replace(/[\\/]+$/, "").length).replace(/^[\\/]+/, "");
  return rest.split(platform === "win32" ? /[\\/]/ : sep).join("/");
}
