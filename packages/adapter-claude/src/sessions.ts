import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

// Session files of one profile, and the CLI's own words for a session it will not resume.

export interface SessionFile {
  /** `<CLAUDE_CONFIG_DIR>/projects/<folder>/<session>.jsonl` */
  path: string;
  /** The project folder the CLI chose for the session's working directory. */
  folder: string;
}

/** Finds `<session>.jsonl` in any project folder of the profile (the CLI looks across folders too). */
export function findSession(configDir: string, sessionId: string): SessionFile | null {
  const root = join(configDir, "projects");
  if (!existsSync(root)) return null;
  const name = `${sessionId}.jsonl`;
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const path = join(root, dir.name, name);
    if (existsSync(path)) return { path, folder: dir.name };
  }
  return null;
}

/**
 * A SessionStore for the SDK's own `forkSession()` that reads one session file of the source
 * profile and writes the fork into a folder of the target profile. The SDK's filesystem variant
 * finds the config folder through the daemon's `process.env.CLAUDE_CONFIG_DIR`, so it cannot copy
 * between two profiles without changing the daemon's environment; through this store it never
 * looks there. The source file is only read.
 */
export function crossProfileStore(source: SessionFile, sourceId: string, targetDir: string): { store: SessionStore; written: string[] } {
  const written: string[] = [];
  const store: SessionStore = {
    async load(key: SessionKey) {
      if (key.sessionId !== sourceId || key.subpath !== undefined) return null;
      const entries: SessionStoreEntry[] = [];
      for (const line of readFileSync(source.path, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as unknown;
          if (entry && typeof entry === "object" && typeof (entry as { type?: unknown }).type === "string") entries.push(entry as SessionStoreEntry);
        } catch {
          // A line cut short by a crash mid-write; the CLI skips it on resume as well.
        }
      }
      return entries;
    },
    async append(key: SessionKey, entries: SessionStoreEntry[]) {
      // forkSession writes the main transcript only; subagent files stay with the source.
      if (key.subpath !== undefined || key.sessionId === sourceId) return;
      const path = join(targetDir, `${key.sessionId}.jsonl`);
      const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      mkdirSync(targetDir, { recursive: true });
      if (!written.includes(path) && existsSync(path)) throw new Error("A session with the forked id already exists in the target profile.");
      writeAtomic(path, written.includes(path) ? readFileSync(path, "utf8") + body : body);
      if (!written.includes(path)) written.push(path);
    },
  };
  return { store, written };
}

/** Write through a temp name, so a half-written transcript never looks like a session. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, text, "utf8");
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, path);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
        // Antivirus or the indexer holds new files for a moment on Windows.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function removeFiles(paths: string[]): void {
  for (const p of paths) rmSync(p, { force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Claude Code 2.1.306 / 2.1.312 in print (SDK) mode, seen on 2026-10-30:
 * - unknown id: an `error_during_execution` result whose errors say
 *   "No conversation found with session ID: <id>", and exit code 1;
 * - a session a live background session (`claude --bg`, its daemon) holds: the same result with
 *   `startup_failure_reason: "session_held_by_background"` and "Error: That session is running in
 *   the background. ...". A crashed holder leaves no lock: the CLI drops registry entries whose
 *   process is gone, and an interactive or SDK holder does not block a print-mode resume.
 */
const GONE_TEXT = "No conversation found with session ID:";
const LOCKED_REASON = "session_held_by_background";
const LOCKED_TEXT = /is running in the background\b.*resume it here/;

export const GONE_PREFIX = "session.gone:";
export const LOCKED_PREFIX = "session.locked:";

/** `session.gone: …` / `session.locked: …` when the CLI refused the session itself, else null. */
export function sessionProblemDetail(texts: readonly string[], startupFailureReason?: string): string | null {
  const lines = texts.flatMap((t) => t.split(/\r?\n/)).map((l) => l.trim()).filter(Boolean);
  const locked = lines.find((l) => LOCKED_TEXT.test(l));
  if (startupFailureReason === LOCKED_REASON || locked) return `${LOCKED_PREFIX} ${short(locked ?? lines[0] ?? "the session is running in the background")}`;
  const gone = lines.find((l) => l.includes(GONE_TEXT));
  if (gone) return `${GONE_PREFIX} ${short(gone.slice(gone.indexOf(GONE_TEXT)))}`;
  return null;
}

export function isSessionProblem(detail: string | undefined): boolean {
  return !!detail && (detail.startsWith(GONE_PREFIX) || detail.startsWith(LOCKED_PREFIX));
}

function short(line: string): string {
  // The SDK rethrows an error result as "Claude Code returned an error result: <errors>".
  const text = line.replace(/^Claude Code returned an error result:\s*/, "").replace(/^Error:\s*/, "");
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}
