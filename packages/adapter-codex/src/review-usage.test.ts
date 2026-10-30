import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addUsage, lastTotal, NO_USAGE, ReviewUsage, threadCreatedAt } from "./review-usage.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewyard codex home "));
  dirs.push(dir);
  return dir;
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

/** A rollout as codex 0.147.0 lays it out: sessions/YYYY/MM/DD/rollout-<local time>-<id>.jsonl. */
function rollout(codexHome: string, at: Date, id: string, meta: Record<string, unknown>): string {
  const dir = join(codexHome, "sessions", String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${stamp(at)}-${id}.jsonl`);
  // The instructions make the first line longer than the head the reader looks at.
  const payload = { session_id: meta.parent_thread_id ?? id, id, ...meta, timestamp: at.toISOString(), cwd: "C:\\a folder", base_instructions: { text: "x".repeat(8_000) } };
  writeFileSync(file, `${JSON.stringify({ timestamp: at.toISOString(), type: "session_meta", payload })}\n`);
  return file;
}

const review = (parent: string) => ({ parent_thread_id: parent, source: { subagent: "review" } });
const tokens = (input: number, cached: number, output: number, reasoning = 0) =>
  `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output } } } })}\n`;
const usage = (input: number, cached: number, output: number, reasoning = 0) => ({ ...NO_USAGE, totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning });

describe("ReviewUsage", () => {
  const now = new Date();

  it("adds up only the review subagents of its own thread", async () => {
    const h = home();
    appendFileSync(rollout(h, now, "rv-a", review("thr-1")), tokens(50_000, 40_000, 2_000, 500));
    appendFileSync(rollout(h, now, "rv-b", review("thr-1")), tokens(10_000, 8_000, 300));
    // Another thread's review, a non-review subagent and the main thread itself never count.
    appendFileSync(rollout(h, now, "rv-c", review("thr-2")), tokens(99_000, 0, 9_000));
    appendFileSync(rollout(h, now, "cp-a", { parent_thread_id: "thr-1", source: { subagent: "compact" } }), tokens(7_000, 0, 700));
    appendFileSync(rollout(h, now, "thr-1", { source: "vscode" }), tokens(14_000, 8_000, 90));
    expect(await new ReviewUsage(h, "thr-1", now).total()).toEqual(usage(60_000, 48_000, 2_300, 500));
  });

  it("takes the last complete token_count and reads a file again once it grows", async () => {
    const h = home();
    const file = rollout(h, now, "rv-a", review("thr-1"));
    const reader = new ReviewUsage(h, "thr-1", now);
    appendFileSync(file, tokens(1_000, 0, 10));
    // codex is still writing the next total.
    appendFileSync(file, tokens(2_000, 1_000, 20).slice(0, 60));
    expect(await reader.total()).toEqual(usage(1_000, 0, 10));
    appendFileSync(file, `${tokens(2_000, 1_000, 20).slice(60)}`);
    expect(await reader.total()).toEqual(usage(2_000, 1_000, 20));
  });

  it("decides on a rollout codex has only just opened at a later read", async () => {
    const h = home();
    const dir = join(h, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-${stamp(now)}-rv-a.jsonl`);
    writeFileSync(file, "");
    const reader = new ReviewUsage(h, "thr-1", now);
    expect(await reader.total()).toEqual(NO_USAGE);
    writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { id: "rv-a", ...review("thr-1") } })}\n${tokens(3_000, 0, 30)}`);
    expect(await reader.total()).toEqual(usage(3_000, 0, 30));
  });

  it("skips rollouts named before the thread began", async () => {
    const h = home();
    const dayBefore = new Date(now.getTime() - 24 * 3_600_000);
    appendFileSync(rollout(h, dayBefore, "rv-old", review("thr-1")), tokens(5_000, 0, 50));
    appendFileSync(rollout(h, now, "rv-new", review("thr-1")), tokens(1_000, 0, 10));
    expect(await new ReviewUsage(h, "thr-1", now).total()).toEqual(usage(1_000, 0, 10));
    // Without a start time (an id that is not a UUIDv7) every day is read.
    expect(await new ReviewUsage(h, "thr-1", null).total()).toEqual(usage(6_000, 0, 60));
  });

  it("is zero for a profile that never ran codex", async () => {
    expect(await new ReviewUsage(home(), "thr-1", now).total()).toEqual(NO_USAGE);
  });
});

describe("rollout helpers", () => {
  it("reads when a thread began from its UUIDv7 id", () => {
    // The main thread of a review in the live run of 2026-10-30, created at 10:45:32.988 UTC.
    expect(threadCreatedAt("01a18c6a-34bc-7cc1-bbf4-f18d82c59dd7")?.toISOString()).toBe("2026-10-30T10:45:32.988Z");
    expect(threadCreatedAt("thr-1")).toBeNull();
    // A UUIDv4 has no time in it.
    expect(threadCreatedAt("9b2f6c1e-3a4d-4f5b-8c7d-1e2f3a4b5c6d")).toBeNull();
  });

  it("finds no total in a rollout without token_count lines", () => {
    expect(lastTotal(`${JSON.stringify({ type: "session_meta", payload: {} })}\n`)).toBeNull();
    expect(addUsage(NO_USAGE, usage(1, 0, 2))).toEqual(usage(1, 0, 2));
  });
});
