// Live check against the installed Gemini CLI over ACP. It can spend quota or tokens, so it runs
// only with CREWYARD_LIVE=1. The run is read-only (edits and network denied, every command
// refused), uses a throwaway worktree, and prints event types and text only, never keys.
//
//   CREWYARD_LIVE=1                 required
//   CREWYARD_LIVE_PROFILE=<folder>  profile folder (GEMINI_CLI_HOME) that is already signed in;
//                                   defaults to a fresh temp folder, which then needs GEMINI_API_KEY
//   CREWYARD_LIVE_ENV=NAME,NAME     env vars passed to the agent, e.g. GEMINI_API_KEY
//   CREWYARD_LIVE_MODEL=<model>     optional, e.g. gemini-2.5-flash
//   CREWYARD_LIVE_PROMPT=<text>     defaults to a one-word reply
//
// Gemini CLI older than 0.25.0 ignores GEMINI_CLI_HOME; the adapter refuses it and this script
// only prints the probe. Run from the repo root: node packages/adapter-acp/scripts/live.mjs

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.CREWYARD_LIVE !== "1") {
  console.log("Skipped: set CREWYARD_LIVE=1 to run against the real Gemini CLI (this can spend quota).");
  process.exit(0);
}

const { createAdapter } = await import("../src/index.ts");
const temp = await mkdtemp(join(tmpdir(), "crewyard live acp "));
const cwd = join(temp, "work tree");
const configDir = process.env.CREWYARD_LIVE_PROFILE || join(temp, "profile");
const env = Object.fromEntries((process.env.CREWYARD_LIVE_ENV ?? "").split(",").filter(Boolean).flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])));
await mkdir(cwd, { recursive: true });

const adapter = createAdapter();
const profile = { id: "live", alias: "live", runner: "gemini-cli", providerId: "google", credential: { kind: env.GEMINI_API_KEY ? "api_key" : "plan_signin", secretRef: null }, defaultModel: process.env.CREWYARD_LIVE_MODEL ?? null, configDir, baseUrl: null };
const probe = await adapter.probe(profile);
console.log("probe:", JSON.stringify(probe));
console.log("env passed:", Object.keys(env).join(", ") || "(none)");

let run;
try {
  if (!probe.capabilities.launch) {
    console.log("Not starting a run:", probe.problems.join("; "));
  } else {
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
      const extra = ev.type === "message.delta" || ev.type === "thought.delta" ? JSON.stringify(ev.text) : ev.type === "run.ended" ? `${ev.reason} ${ev.detail ?? ""}` : ev.type === "usage.update" ? `context=${ev.contextUsed}/${ev.contextSize} cost=${ev.costUsd} (${ev.costProvenance})` : "";
      console.log(ev.seq, ev.type, extra);
      if (ev.type === "request.approval") await adapter.answer(run, ev.requestId, { kind: "approval", decision: "deny" });
    }
    clearTimeout(timer);
  }
} finally {
  if (run) await adapter.stop(run);
  if (!process.env.CREWYARD_LIVE_PROFILE) await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
