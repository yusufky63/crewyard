import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { ACTIVITY_LOG_MAX, redactLogLine, type LogLevel, type LogLine, type LogSource, type LogTail } from "@crewyard/core";

// Crewyard's own log files for the Activity drawer's Logs tab: the main process, the daemon's
// stdout and stderr, and the updater, all under <profile>\logs. Only the tail of each file is read,
// every line is redacted again on the way out (the writers redact too), and nothing here reads a
// runner's own output or config folder.

export const LOG_FILES: Record<LogSource, string> = { main: "main.log", daemon: "daemon.log", updater: "updater.log" };

/** Bytes read from the end of each file; enough for the newest few thousand lines. */
const TAIL_BYTES = 512 * 1024;

const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(debug|info|warn|warning|error)\b\s?(.*)$/i;

/** The last `maxBytes` of a file as text, without the first, partial line; "" when it is missing. */
export function readTail(path: string, maxBytes = TAIL_BYTES): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/**
 * Lines of one file, oldest first. `<ISO time> <level> <text>` is the format our writers use; a line
 * without it (a stack trace) keeps the time and level of the line above.
 */
export function parseLog(text: string, source: LogSource): Array<Omit<LogLine, "id">> {
  const out: Array<Omit<LogLine, "id">> = [];
  let at: string | null = null;
  let level: LogLevel = "info";
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = LINE.exec(raw);
    if (m) {
      at = m[1]!;
      const l = m[2]!.toLowerCase();
      level = l === "warning" ? "warn" : (l as LogLevel);
    }
    out.push({ source, at, level, text: redactLogLine(m ? m[3]! : raw) });
  }
  return out;
}

export function readLogs(dir: string, sources: LogSource[] = ["main", "daemon", "updater"], limit = 500): LogTail {
  const max = Math.max(1, Math.min(ACTIVITY_LOG_MAX, Math.floor(limit)));
  const all: LogLine[] = [];
  for (const source of sources) {
    const file = LOG_FILES[source];
    if (!file) continue;
    // The rotated file first, so its lines come before the current file's.
    const lines = [...parseLog(readTail(join(dir, `${file}.old`), TAIL_BYTES / 2), source), ...parseLog(readTail(join(dir, file)), source)];
    lines.forEach((l, i) => all.push({ ...l, id: `${source}:${lines.length - i}` }));
  }
  // Newest first across files; a line without a time stays next to its neighbours (stable sort).
  const ordered = all.map((l, i) => ({ l, i })).sort((a, b) => (b.l.at ?? "").localeCompare(a.l.at ?? "") || b.i - a.i);
  return { lines: ordered.slice(0, max).map((x) => x.l), more: ordered.length > max, dir };
}
