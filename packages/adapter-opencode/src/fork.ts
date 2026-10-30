import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { ForkUsage } from "@crewyard/core";
import { killTree, run as runCommand, start } from "@crewyard/proc";
import type { Message, Part } from "@opencode-ai/sdk/v2";

// How a session moves between two isolated profiles (checked against opencode 1.19.5 on
// 2026-10-30, CLI and source at tag v1.19.5):
// - `opencode export <id>` prints `{ info, messages: [{ info, parts }] }` on stdout; on a missing
//   session it exits 1 with "Session not found: <id>" on stderr.
// - `opencode import <file>` inserts that record into the profile's database under the SAME id,
//   re-homed to the project of its working directory; a second import keeps existing rows and
//   adds missing ones. The export carries no permission rules, so neither do the copies.
// - `POST /session/{id}/fork` copies every message into a new session with a new id.
// - `POST /session/{id}/summarize` answers only after the compaction turn has run, and writes it
//   as an assistant message with `summary: true` (mode "compaction"), text parts holding the summary.

export interface CliCall {
  executable: string;
  prefixArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type ExportOutcome = { ok: true } | { ok: false; gone: boolean; detail: string };

/**
 * Streams the export to a file: a long session's JSON easily passes the output cap of a collected
 * run, and the file is what `opencode import` reads anyway.
 */
export async function exportSession(call: CliCall, sessionId: string, file: string): Promise<ExportOutcome> {
  const child = start(call.executable, [...call.prefixArgs, "export", sessionId], { cwd: call.cwd, env: call.env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (d: string) => {
    stderr = (stderr + d).slice(-4_000);
  });
  const written = child.stdout ? pipeline(child.stdout, createWriteStream(file)).then(() => true, () => false) : Promise.resolve(false);
  let timedOut = false;
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void killTree(child.pid);
      resolve(null);
    }, call.timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  const flushed = await Promise.race([written, new Promise<boolean>((r) => setTimeout(() => r(false), 5_000))]);
  const detail = plain(stderr);
  if (timedOut) return { ok: false, gone: false, detail: `opencode export did not finish within ${call.timeoutMs} ms` };
  if (code !== 0) return { ok: false, gone: /session not found/i.test(detail), detail: detail || `opencode export exited (${code ?? "error"})` };
  if (!flushed) return { ok: false, gone: false, detail: "opencode export's output could not be written" };
  // The file must be the session asked for, or the import would copy something else.
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { info?: { id?: unknown }; messages?: unknown };
    if (parsed.info?.id !== sessionId || !Array.isArray(parsed.messages)) return { ok: false, gone: false, detail: "opencode export returned another session or no messages" };
  } catch {
    return { ok: false, gone: false, detail: "opencode export did not return JSON" };
  }
  return { ok: true };
}

export async function importSession(call: CliCall, sessionId: string, file: string): Promise<string | null> {
  const res = await runCommand(call.executable, [...call.prefixArgs, "import", file], { cwd: call.cwd, env: call.env, timeoutMs: call.timeoutMs });
  if (res.code === 0 && res.stdout.includes(`Imported session: ${sessionId}`)) return null;
  return plain(res.stderr) || plain(res.stdout) || `opencode import exited (${res.code ?? "timed out"})`;
}

/** The numbers the mapper's usage.update sums over a session's assistant messages. */
export function usageOf(messages: ReadonlyArray<{ info: Message }>): ForkUsage {
  const out: ForkUsage = { tokensIn: 0, tokensOut: 0, cacheRead: 0, costUsd: 0 };
  for (const { info } of messages) {
    if (info.role !== "assistant") continue;
    out.tokensIn += info.tokens.input;
    out.tokensOut += info.tokens.output;
    out.cacheRead += info.tokens.cache.read;
    out.costUsd = (out.costUsd ?? 0) + info.cost;
  }
  return out;
}

export type Compaction = { ok: true; summary: string | null; usage: ForkUsage } | { ok: false; error: string };

/** Reads what summarize wrote: every assistant message that was not there before it ran. */
export function compactionOf(before: ReadonlySet<string>, after: ReadonlyArray<{ info: Message; parts: Part[] }>): Compaction {
  const added = after.filter((m) => !before.has(m.info.id));
  const summary = added.findLast((m) => m.info.role === "assistant" && m.info.summary === true);
  if (!summary || summary.info.role !== "assistant") return { ok: false, error: "OpenCode wrote no summary" };
  if (summary.info.error) return { ok: false, error: errorText(summary.info.error) };
  if (!summary.info.time.completed) return { ok: false, error: "OpenCode's summary did not finish" };
  const text = summary.parts.flatMap((p) => (p.type === "text" && !p.ignored ? [p.text] : [])).join("\n").trim();
  return { ok: true, summary: text || null, usage: usageOf(added) };
}

export function errorText(error: { name: string; data?: unknown }): string {
  const data = error.data as { message?: unknown } | undefined;
  return typeof data?.message === "string" ? `${error.name}: ${data.message}` : error.name;
}

/** The SDK throws an Error whose cause holds the HTTP status and parsed body (throwOnError). */
export function isNotFound(err: unknown): boolean {
  const cause = (err as { cause?: { status?: unknown; body?: { name?: unknown } } } | null)?.cause;
  return cause?.status === 404 && cause.body?.name === "NotFoundError";
}

/** CLI errors arrive with ANSI colours and an "Error:" prefix; keep the last line, plain. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\r?\n/);
  return (lines.pop() ?? "").replace(/^Error:\s*/, "").slice(0, 300);
}
