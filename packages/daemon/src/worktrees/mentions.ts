import type { DatabaseSync } from "node:sqlite";
import { lstat } from "node:fs/promises";
import type { FileMention } from "@crewyard/core";
import { confine, relativeInside } from "./files.ts";

// "Mentioned by the agent": file paths a task's runs named in tool calls, approvals, diffs and
// their own messages. Like omux's terminal scan, text is cut into path-shaped tokens and only
// tokens that turn out to be files of the worktree survive, so a false hit costs one lstat and
// never reaches the panel. Structured fields (a tool's `file_path`, an approval's `paths`, a
// diff's files) are taken whole, so names with spaces still count.

/** Newest events read per call; a long task keeps its recent mentions, the oldest fall off. */
export const MENTION_EVENTS = 20_000;
/** Distinct candidates checked on disk, and mentions returned. */
export const MENTION_CANDIDATES = 600;
export const MENTION_MAX = 100;
/** Message text scanned per run, and per tool string; a pasted log never stalls the daemon. */
const TEXT_SCAN = 200_000;
const FIELD_SCAN = 20_000;

const KINDS = ["run.tool.call", "run.request.approval", "run.diff.update", "run.message.delta"] as const;
/** Keys whose string (or string array) value is a path, in the shapes the runners use. */
const PATH_KEY = /^(?:file_?path|path|paths|notebook_?path|filename|file|files|target_?file|absolute_?path|relative_?path|uri)$/i;

export interface Candidate {
  text: string;
  count: number;
  at: string;
}

type Row = { kind: string; at: string; run_id: string | null; payload: string };

/** Path-shaped tokens of free text: a slash or a file extension, no spaces, trailing punctuation and `:line:col` off. */
export function pathTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.slice(0, TEXT_SCAN).split(/[\s"'`()<>[\]{},;|*=]+/)) {
    const t = clean(raw);
    if (t && (/[\\/]/.test(t) || /\.[A-Za-z0-9]{1,10}$/.test(t)) && /^[\w.@~+\-\\/: ]+$/.test(t) && !/^\.+$/.test(t)) out.push(t);
  }
  return out;
}

function clean(raw: string): string | null {
  let t = raw.trim();
  if (t.startsWith("file://")) {
    try {
      t = decodeURIComponent(t.slice("file://".length)).replace(/^\/([A-Za-z]:)/, "$1");
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null; // a URL, not a file
  t = t.replace(/(?::\d+){1,2}$/, "").replace(/[.:!?]+$/, "");
  if (t.startsWith("./") || t.startsWith(".\\")) t = t.slice(2);
  if (t.startsWith("@")) t = t.slice(1); // "@src/a.ts" is how some runners cite a file
  return t.length > 0 && t.length <= 400 ? t : null;
}

/** Candidate path strings from one stored event, in the order they appear. */
export function candidatesOf(kind: string, payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const p = payload as Record<string, unknown>;
  const out: string[] = [];
  if (kind === "run.diff.update" && Array.isArray(p.files)) {
    for (const f of p.files) if (f && typeof (f as { path?: unknown }).path === "string") out.push((f as { path: string }).path);
  } else if (kind === "run.request.approval") {
    if (Array.isArray(p.paths)) for (const x of p.paths) if (typeof x === "string") out.push(x);
    if (typeof p.command === "string") out.push(...pathTokens(p.command.slice(0, FIELD_SCAN)));
  } else if (kind === "run.tool.call") {
    if (typeof p.title === "string") out.push(...pathTokens(p.title));
    walk(p.input, out, 0);
  }
  return out.map((x) => clean(x)).filter((x): x is string => x !== null);
}

function walk(v: unknown, out: string[], depth: number, key = ""): void {
  if (depth > 6 || v === null || v === undefined) return;
  if (typeof v === "string") {
    if (PATH_KEY.test(key)) out.push(v);
    // Commands, patches and patterns: scan for path-shaped words. Codex patches name files as
    // "*** Update File: <path>", which the tokenizer reads as a path after the colon.
    else out.push(...pathTokens(v.slice(0, FIELD_SCAN)));
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v.slice(0, 200)) walk(x, out, depth + 1, key);
    return;
  }
  if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 100)) walk(x, out, depth + 1, k);
}

/** Every candidate in `rows` (oldest first) with how often and when it was last named. */
export function collectCandidates(rows: Row[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  const add = (text: string, at: string) => {
    const c = seen.get(text);
    if (c) {
      c.count += 1;
      if (at > c.at) c.at = at;
    } else seen.set(text, { text, count: 1, at });
  };
  // Message deltas split words across events, so a run's text is joined before it is scanned.
  const messages = new Map<string, { text: string; at: string }>();
  for (const r of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(r.payload);
    } catch {
      continue;
    }
    if (r.kind === "run.message.delta") {
      const text = (payload as { text?: unknown }).text;
      if (typeof text !== "string") continue;
      const key = r.run_id ?? "";
      const m = messages.get(key) ?? { text: "", at: r.at };
      if (m.text.length < TEXT_SCAN) m.text += text;
      m.at = r.at;
      messages.set(key, m);
      continue;
    }
    for (const c of candidatesOf(r.kind, payload)) add(c, r.at);
  }
  for (const m of messages.values()) for (const c of pathTokens(m.text)) add(c, m.at);
  return [...seen.values()].sort((a, b) => b.at.localeCompare(a.at) || b.count - a.count);
}

/** The candidate as a worktree-relative path, or null when it names a place outside the worktree. */
export function toRelative(rootReal: string, text: string, platform: NodeJS.Platform = process.platform): string | null {
  const abs = /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\") || (platform !== "win32" && text.startsWith("/"));
  if (abs) return relativeInside(rootReal, text, platform);
  return text.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Mentions that are files of the worktree now, most recent first, merged by their relative path. */
export async function resolveMentions(root: string, candidates: Candidate[]): Promise<FileMention[]> {
  const { rootReal } = await confine(root, "");
  const merged = new Map<string, FileMention>();
  for (const c of candidates.slice(0, MENTION_CANDIDATES)) {
    const rel = toRelative(rootReal, c.text);
    if (!rel) continue;
    const key = process.platform === "win32" ? rel.toLowerCase() : rel;
    const known = merged.get(key);
    if (known) {
      known.count += c.count;
      continue;
    }
    try {
      const { real, parts } = await confine(rootReal, rel);
      if (!(await lstat(real)).isFile()) continue;
      merged.set(key, { path: parts.join("/"), count: c.count, at: c.at });
    } catch {
      continue;
    }
    if (merged.size >= MENTION_MAX) break;
  }
  return [...merged.values()];
}

/** Reads the task's newest events and returns the files they named. */
export async function taskMentions(db: DatabaseSync, taskId: string, root: string, max = MENTION_EVENTS): Promise<FileMention[]> {
  const marks = KINDS.map(() => "?").join(", ");
  const rows = db.prepare(`select kind, at, run_id, payload from events where task_id = ? and kind in (${marks}) order by seq desc limit ?`).all(taskId, ...KINDS, max) as Row[];
  return resolveMentions(root, collectCandidates(rows.reverse()));
}
