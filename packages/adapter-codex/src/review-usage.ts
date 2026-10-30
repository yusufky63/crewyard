import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadTokenUsage } from "./protocol/index.ts";

export type TokenUsageBreakdown = ThreadTokenUsage["total"];

// codex 0.147.0 runs `review/start` in a subagent thread of its own and sends the client none of
// that thread's thread/tokenUsage/updated. In the live run of 2026-10-30 those reviews were two
// thirds of the DeepSeek bill and Crewyard saw none of it (one review alone read 1.3M input
// tokens). The subagent's rollout under CODEX_HOME/sessions/YYYY/MM/DD has them: its first line
// (session_meta) names the parent thread and the subagent kind, and every token_count event
// carries that thread's running total.

/** session_meta puts parent_thread_id and source within its first 500 bytes (codex 0.147.0). */
const HEAD_BYTES = 4_096;
/** A token_count line is about 1 KB; the tail of the file holds the last one. */
const TAIL_BYTES = 65_536;
/** Clock and filename-rounding slack when picking files by the time in their name. */
const SLACK_MS = 2 * 60_000;

export const NO_USAGE: TokenUsageBreakdown = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };

export function addUsage(a: TokenUsageBreakdown, b: TokenUsageBreakdown): TokenUsageBreakdown {
  return {
    totalTokens: a.totalTokens + b.totalTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

export const sameUsage = (a: TokenUsageBreakdown, b: TokenUsageBreakdown) => (Object.keys(a) as Array<keyof TokenUsageBreakdown>).every((k) => a[k] === b[k]);

/** codex thread ids are UUIDv7, so the id says when the thread began; null for any other id. */
export function threadCreatedAt(threadId: string): Date | null {
  const hex = threadId.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== "7") return null;
  return new Date(parseInt(hex.slice(0, 12), 16));
}

const pad = (n: number) => String(n).padStart(2, "0");
/** codex names rollouts by local time: rollout-2026-10-30T13-45-33-<thread id>.jsonl. */
const stampOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

async function readRange(file: string, start: number, length: number): Promise<string> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** The last complete token_count total in a rollout; a line still being written is skipped. */
export function lastTotal(text: string): TokenUsageBreakdown | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"token_count"')) continue;
    let total: Record<string, unknown> | undefined;
    try {
      total = JSON.parse(line)?.payload?.info?.total_token_usage;
    } catch {
      continue;
    }
    if (!total) continue;
    const n = (k: string) => (typeof total[k] === "number" ? (total[k] as number) : 0);
    return {
      totalTokens: n("total_tokens"),
      inputTokens: n("input_tokens"),
      cachedInputTokens: n("cached_input_tokens"),
      cacheWriteInputTokens: n("cache_write_input_tokens"),
      outputTokens: n("output_tokens"),
      reasoningOutputTokens: n("reasoning_output_tokens"),
    };
  }
  return null;
}

/**
 * Running token totals of every review subagent of one thread, read from their rollout files.
 * A file is matched to the thread once, and read again only when it has grown.
 */
export class ReviewUsage {
  private readonly sessions: string;
  private readonly head: string;
  private readonly since: string;
  private readonly sinceDay: string;
  private readonly found = new Map<string, { size: number; usage: TokenUsageBreakdown }>();
  private readonly others = new Set<string>();

  // No parameter properties: scripts import this file with Node's type stripping.
  constructor(codexHome: string, parentThreadId: string, since: Date | null) {
    this.sessions = join(codexHome, "sessions");
    this.head = `"parent_thread_id":"${parentThreadId}"`;
    const from = since ? new Date(since.getTime() - SLACK_MS) : new Date(0);
    this.since = stampOf(from);
    this.sinceDay = this.since.slice(0, 10);
  }

  async total(): Promise<TokenUsageBreakdown> {
    for (const file of await this.candidates()) await this.read(file).catch(() => undefined);
    return [...this.found.values()].reduce((sum, f) => addUsage(sum, f.usage), NO_USAGE);
  }

  private async candidates(): Promise<string[]> {
    const list = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort();
    const out: string[] = [];
    for (const y of await list(this.sessions)) {
      if (y < this.sinceDay.slice(0, 4)) continue;
      for (const m of await list(join(this.sessions, y))) {
        for (const d of await list(join(this.sessions, y, m))) {
          if (`${y}-${m}-${d}` < this.sinceDay) continue;
          for (const f of await list(join(this.sessions, y, m, d))) {
            if (f.startsWith("rollout-") && f.endsWith(".jsonl") && f.slice(8, 27) >= this.since) out.push(join(this.sessions, y, m, d, f));
          }
        }
      }
    }
    return out.filter((f) => !this.others.has(f));
  }

  private async read(file: string): Promise<void> {
    const { size } = await stat(file);
    const known = this.found.get(file);
    if (known && known.size === size) return;
    if (!known) {
      const head = await readRange(file, 0, Math.min(size, HEAD_BYTES));
      // session_meta is longer than the head (it carries the instructions), but its ids and
      // source come first. A file codex has only just opened is decided on a later read.
      if (!head.includes('"source"')) return;
      if (!head.includes(this.head) || !head.includes('"subagent":"review"')) {
        this.others.add(file);
        return;
      }
    }
    const tail = size > TAIL_BYTES ? await readRange(file, size - TAIL_BYTES, TAIL_BYTES) : await readRange(file, 0, size);
    const usage = lastTotal(tail) ?? (size > TAIL_BYTES ? lastTotal(await readRange(file, 0, size)) : null);
    this.found.set(file, { size, usage: usage ?? known?.usage ?? NO_USAGE });
  }
}
