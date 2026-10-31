import { utf8Length, type AssistantLine, type AssistantView } from "@crewyard/core";

// Pure rules behind the task assistant's conversation (DESIGN.md `TaskAssistant`): how lines are
// grouped, what the live row under your message says, and which bits of agent text are paths.
// Agent and runner text is untrusted: everything here reads it as data and returns plain values.

export type Entry = { t: "line"; line: AssistantLine } | { t: "tools"; id: string; lines: AssistantLine[] };

/** Consecutive tool lines become one burst, folded to a summary line in the view. */
export function groupLines(lines: readonly AssistantLine[]): Entry[] {
  const out: Entry[] = [];
  for (const line of lines) {
    const last = out.at(-1);
    if (line.role === "tool" && last?.t === "tools") last.lines.push(line);
    else if (line.role === "tool") out.push({ t: "tools", id: line.id, lines: [line] });
    else out.push({ t: "line", line });
  }
  return out;
}

export type ToolCategory = "read" | "search" | "other";

const READ = /^(read|view|cat|open|readfile|read_file)\b/i;
const SEARCH = /^(grep|glob|search|find|ls|list|rg|websearch|codebase_search)\b/i;

/**
 * A runner's title for a call is free text ("Read: src/x.ts", "Grep: TODO", a bare path from
 * Codex); its first word, or a title that is only a path, says roughly what it did.
 */
export function toolCategory(title: string): ToolCategory {
  const t = title.trim();
  if (READ.test(t) || isPath(t)) return "read";
  if (SEARCH.test(t)) return "search";
  return "other";
}

export function toolCounts(lines: readonly AssistantLine[]): Record<ToolCategory, number> {
  const out: Record<ToolCategory, number> = { read: 0, search: 0, other: 0 };
  for (const l of lines) out[toolCategory(l.text)]++;
  return out;
}

// A relative or absolute path with at least one separator, or a bare file name with an extension,
// optionally followed by :line or :line:column. No spaces, no scheme: a URL is never a path here.
const PATH = /^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w@.+-]+[\\/])*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$|^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w@.+-]+[\\/])+[\w@.+-]+(?::\d+(?::\d+)?)?$/;

export function isPath(s: string): boolean {
  const t = s.trim();
  if (t.length < 3 || t.length > 260 || /\s/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
  return PATH.test(t);
}

/** The path a tool line names ("Read: a/b.ts", "Read a/b.ts:12", or a bare path), if any. */
export function pathIn(title: string): string | null {
  const t = title.trim();
  if (isPath(t)) return t;
  const m = /^[\w.-]+:?\s+(\S+)$/.exec(t);
  return m && isPath(m[1]!) ? m[1]! : null;
}

export type LivePhase = "sending" | "starting" | "thinking" | "tool" | "streaming";

export interface LiveState {
  phase: LivePhase;
  /** The runner's title of the latest call in this turn (untrusted text). */
  tool: string | null;
  /** That call's line, which the row stands in for while it is the latest thing in the turn. */
  toolId: string | null;
  /** When the line that started this turn was stored; the elapsed time counts from it. */
  since: string | null;
  /** Your messages waiting for the next turn boundary. */
  queued: number;
}

/**
 * A line that hands the session a new turn: your message, or a note Autopilot hands it
 * (`autopilot.on`, `autopilot.status.done`, …; service.ts notify). Autopilot's record of a call it
 * made (`autopilot.call.*`) is written during a turn and starts nothing. A queued line has not
 * been handed over yet.
 */
function startsTurn(l: AssistantLine): boolean {
  if (l.queued) return false;
  if (l.role === "user") return true;
  return l.role === "notice" && l.text.startsWith("autopilot.") && !l.text.startsWith("autopilot.call.");
}

/**
 * What the row at the end of the conversation says while a turn runs, or null when it has nothing
 * to say. While the reply streams, the reply itself stands in for the row, which only stays to say
 * that a queued message is waiting.
 */
export function liveState(view: Pick<AssistantView, "state" | "lines"> | undefined, sending: boolean): LiveState | null {
  const lines = view?.lines ?? [];
  const state = view?.state ?? "idle";
  const queued = lines.filter((l) => l.role === "user" && l.queued).length;
  const start = findLastIndex(lines, startsTurn);
  const since = start >= 0 ? lines[start]!.at : null;
  const idle = { tool: null, toolId: null, since, queued };
  if (state === "starting") return { phase: "starting", ...idle };
  if (state !== "working") return sending ? { phase: "sending", ...idle, since: null } : null;
  const after = lines.slice(start + 1).filter((l) => l.role === "assistant" || l.role === "tool");
  const last = after.at(-1);
  if (last?.role === "assistant") return queued > 0 ? { phase: "streaming", ...idle } : null;
  if (last?.role === "tool") return { phase: "tool", ...idle, tool: last.text, toolId: last.id };
  return { phase: "thinking", ...idle };
}

function findLastIndex<T>(xs: readonly T[], f: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i]!)) return i;
  return -1;
}

/** "m:ss" (or "h:mm:ss") from milliseconds; negative clock skew reads as zero. */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A reply quoted into the message box: each line behind `> `, then an empty line to write on. */
export function quoted(text: string, existing = ""): string {
  const q = text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
  const head = existing.trimEnd();
  return `${head ? `${head}\n\n` : ""}${q}\n\n`;
}

/** The first line of a reply with Markdown marks dropped and cut to `max` characters, to name it in a message. */
export function excerpt(text: string, max = 120): string {
  const first = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, "").replace(/[`*_]/g, "").trim())
    .find(Boolean) ?? "";
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

export interface ByteMeter {
  bytes: number;
  /** Shown only from here on, so the counter is not noise for short messages. */
  near: boolean;
  over: boolean;
}

export function byteMeter(text: string, cap: number): ByteMeter {
  const bytes = utf8Length(text.trim());
  return { bytes, near: bytes >= cap * 0.85, over: bytes > cap };
}
