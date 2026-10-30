import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, TranscriptRequest } from "@crewyard/core";
import type { Store } from "../store.ts";
import { writeFileAtomic } from "./git.ts";

// Transcript snapshots (feature scan A18; the "copy, atomically, never shrink" rule is Agent
// Monitor's `snapshot-store.js` idea, the code is ours). CLIs expire their own session files
// (Claude Code keeps 30 days), so at a handoff and when a run ends we copy the runner's record
// into the task folder and the handoff package cites our copy. One file per native session, so a
// resumed session's later run grows the same copy.

/** Largest copy kept; past it only the newest part is, from a line start (JSONL stays parseable). */
export const TRANSCRIPT_CAP = 64 * 1024 * 1024;

export interface TranscriptCopy {
  path: string;
  sourceBytes: number;
  copiedBytes: number;
  truncated: boolean;
  /** The runner's record was smaller than our copy, so ours was kept unchanged. */
  kept: boolean;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);

/** The last `cap` bytes of a file, starting after the first line break inside them. */
function readTail(path: string, size: number, cap: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(cap);
    const n = readSync(fd, buf, 0, cap, size - cap);
    const nl = buf.indexOf(0x0a);
    return buf.subarray(nl >= 0 && nl < n - 1 ? nl + 1 : 0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Copies the run's transcript to `<dataDir>/tasks/<task>/transcripts/<runner>-<session>.<ext>`.
 * Never shrinks: when the runner's record is smaller than the one we copied before (it was
 * pruned, compacted or expired), our copy stays as it was. Returns null when the runner has none.
 */
export async function snapshotTranscript(opts: {
  store: Store;
  dataDir: string;
  taskId: string;
  runId: string;
  adapter: AgentAdapter;
  req: TranscriptRequest;
  now: Date;
  cap?: number;
}): Promise<TranscriptCopy | null> {
  const { adapter, req } = opts;
  if (!adapter.capabilities.transcript || !adapter.transcript) return null;
  const source = await adapter.transcript(req);
  if (!source) return null;
  const cap = opts.cap ?? TRANSCRIPT_CAP;
  let text: string;
  let sourceBytes: number;
  if (source.kind === "file") {
    sourceBytes = statSync(source.path).size;
    text = sourceBytes > cap ? readTail(source.path, sourceBytes, cap) : readFileSync(source.path, "utf8");
  } else {
    sourceBytes = Buffer.byteLength(source.text, "utf8");
    text = sourceBytes > cap ? readTailOfText(source.text, cap) : source.text;
  }
  const path = join(opts.dataDir, "tasks", opts.taskId, "transcripts", `${safeName(req.session.runner)}-${safeName(req.session.sessionId)}.${safeName(source.ext)}`);
  const db = opts.store.db;
  const prior = db.prepare("select source_bytes, copied_bytes, truncated from run_transcripts where path = ? order by source_bytes desc limit 1").get(path) as
    | { source_bytes: number; copied_bytes: number; truncated: number }
    | undefined;
  let copy: TranscriptCopy;
  if (prior && sourceBytes < prior.source_bytes) {
    // The runner's record got smaller (pruned, compacted, expired): ours stays as it was.
    copy = { path, sourceBytes: prior.source_bytes, copiedBytes: prior.copied_bytes, truncated: prior.truncated === 1, kept: true };
  } else {
    writeFileAtomic(path, text);
    copy = { path, sourceBytes, copiedBytes: Buffer.byteLength(text, "utf8"), truncated: sourceBytes > cap, kept: false };
  }
  db.prepare(
    `insert into run_transcripts (run_id, path, source_bytes, copied_bytes, truncated, copied_at) values (?, ?, ?, ?, ?, ?)
     on conflict(run_id) do update set path = excluded.path, source_bytes = excluded.source_bytes, copied_bytes = excluded.copied_bytes, truncated = excluded.truncated, copied_at = excluded.copied_at`,
  ).run(opts.runId, path, copy.sourceBytes, copy.copiedBytes, copy.truncated ? 1 : 0, opts.now.toISOString());
  return copy;
}

/** The newest `cap` bytes of a text, from the first line start inside them. */
function readTailOfText(text: string, cap: number): string {
  const tail = Buffer.from(text, "utf8").subarray(-cap);
  const nl = tail.indexOf(0x0a);
  return tail.subarray(nl >= 0 && nl < tail.length - 1 ? nl + 1 : 0).toString("utf8");
}

/** Our copy for a run, if one was taken. */
export function transcriptPath(store: Store, runId: string): string | null {
  return (store.db.prepare("select path from run_transcripts where run_id = ?").get(runId) as { path: string } | undefined)?.path ?? null;
}
