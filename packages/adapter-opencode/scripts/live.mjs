// Live check against the installed opencode. It spends real tokens, so it runs only with
// CREWYARD_LIVE=1. The run is read-only (edits and network denied, every command refused), uses a
// throwaway worktree, and prints event types and text only, never keys.
//
//   CREWYARD_LIVE=1                      required
//   CREWYARD_LIVE_MODEL=provider/model   model to use, e.g. deepseek/deepseek-chat
//   CREWYARD_LIVE_ENV=NAME,NAME          env vars passed to opencode, e.g. DEEPSEEK_API_KEY
//   CREWYARD_LIVE_PROFILE=<folder>       profile folder; defaults to a fresh temp folder
//   CREWYARD_LIVE_PROMPT=<text>          defaults to a one-word reply
//
// Run from the repo root: node packages/adapter-opencode/scripts/live.mjs

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.CREWYARD_LIVE !== "1") {
  console.log("Skipped: set CREWYARD_LIVE=1 to run against the real opencode (this spends tokens).");
  process.exit(0);
}

const { createAdapter } = await import("../src/index.ts");
const temp = await mkdtemp(join(tmpdir(), "crewyard live oc "));
const cwd = join(temp, "work tree");
const configDir = process.env.CREWYARD_LIVE_PROFILE || join(temp, "profile");
const env = Object.fromEntries((process.env.CREWYARD_LIVE_ENV ?? "").split(",").filter(Boolean).flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])));
await mkdir(cwd, { recursive: true });

const adapter = createAdapter();
const profile = { id: "live", alias: "live", runner: "opencode", providerId: "live", credential: { kind: Object.keys(env).length ? "api_key" : "plan_signin", secretRef: null }, defaultModel: process.env.CREWYARD_LIVE_MODEL ?? null, configDir, baseUrl: null };
console.log("probe:", JSON.stringify(await adapter.probe(profile)));
console.log("env passed:", Object.keys(env).join(", ") || "(none)");

let run;
try {
  run = await adapter.start({
    profile,
    cwd,
    model: null,
    prompt: process.env.CREWYARD_LIVE_PROMPT ?? "Reply with the single word: ready",
    policy: { writes: "none", allowCommands: [], network: "denied" },
    env,
  });
  console.log("session:", run.nativeSession?.sessionId, "pid:", run.pid);
  const timer = setTimeout(() => void adapter.stop(run), 180_000);
  for await (const ev of adapter.events(run)) {
    const extra = ev.type === "message.delta" || ev.type === "thought.delta" ? JSON.stringify(ev.text) : ev.type === "run.ended" ? `${ev.reason} ${ev.detail ?? ""}` : ev.type === "usage.update" ? `in=${ev.tokensIn} out=${ev.tokensOut} cost=${ev.costUsd} (${ev.costProvenance})` : "";
    console.log(ev.seq, ev.type, extra);
    if (ev.type === "request.approval") await adapter.answer(run, ev.requestId, { kind: "approval", decision: "deny", message: "live check is read-only" });
    if (ev.type === "request.question") await adapter.answer(run, ev.requestId, { kind: "cancel" });
  }
  clearTimeout(timer);
} finally {
  if (run) await adapter.stop(run);
  if (!process.env.CREWYARD_LIVE_PROFILE) await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
