// Live conformance run for the Claude Code adapter (PLAN.md §5.4). It spends API money, so it
// only runs with CREWYARD_LIVE=1. Run it through the key vault so the key never touches a file:
//
//   CREWYARD_LIVE=1 node ~/.claude/skills/env-vault/scripts/vault.mjs run -- node packages/adapter-claude/scripts/live.mjs
//
// Environment:
//   ANTHROPIC_API_KEY             key for Anthropic (or ANTHROPIC_AUTH_TOKEN with CREWYARD_LIVE_BASE_URL)
//   CREWYARD_LIVE_BASE_URL        optional Anthropic-compatible endpoint, e.g. https://api.deepseek.com/anthropic
//   CREWYARD_LIVE_MODEL           model id, default claude-haiku-4-5 (the cheapest that can use tools)
//   CREWYARD_LIVE_RECORD=<file>   also write every raw SDK frame as JSON lines, for new replay fixtures
//
// `node live.mjs --probe` only runs probe(), which reads `claude --version` and calls no API.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { createAdapter } from "../src/index.ts";

const probeOnly = process.argv.includes("--probe");
if (!probeOnly && process.env.CREWYARD_LIVE !== "1") {
  console.log("Skipped: set CREWYARD_LIVE=1 to run the live conformance suite (it calls the API and costs money).");
  process.exit(0);
}

const baseUrl = process.env.CREWYARD_LIVE_BASE_URL || null;
const key = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
const model = process.env.CREWYARD_LIVE_MODEL || "claude-haiku-4-5";

// Paths with spaces on purpose (AGENTS.md, Windows rules).
const root = mkdtempSync(join(tmpdir(), "crewyard live "));
const repo = join(root, "demo repo");
const configDir = join(root, "profile dir");
const profile = {
  id: "live",
  alias: "Claude · live",
  runner: "claude-code",
  providerId: baseUrl ? "custom" : "anthropic",
  credential: { kind: "api_key", secretRef: key ? "live" : null },
  defaultModel: model,
  configDir,
  baseUrl,
};

const frames = [];
const recordingQuery = (params) => {
  const q = sdkQuery(params);
  const next = q.next.bind(q);
  q.next = async (...args) => {
    const r = await next(...args);
    if (!r.done) frames.push(r.value);
    return r;
  };
  return q;
};
const adapter = createAdapter(process.env.CREWYARD_LIVE_RECORD ? { query: recordingQuery } : {});

const results = [];
const check = (name, ok, note = "") => {
  results.push({ name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
};

function processAlive(pid) {
  if (!pid) return false;
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", windowsHide: true });
    return out.includes(String(pid));
  } catch {
    return false;
  }
}

/** Runs one request to the end, answering requests with `onRequest`, and returns every event. */
async function drive(handle, onRequest = () => {}, onEvent = () => {}) {
  const events = [];
  for await (const e of adapter.events(handle)) {
    events.push(e);
    const brief = e.type === "message.delta" || e.type === "thought.delta" ? "" : JSON.stringify({ ...e, runId: undefined, at: undefined, source: undefined, input: undefined, output: undefined });
    if (brief) console.log(`  ${e.seq} ${e.type} ${brief.slice(0, 160)}`);
    if (e.type === "request.approval" || e.type === "request.question") await onRequest(e);
    onEvent(e);
  }
  return events;
}

const req = (prompt, policy = { writes: "worktree", allowCommands: [], network: "ask" }) => ({
  profile,
  cwd: repo,
  model,
  prompt,
  policy,
  env: key ? (baseUrl ? { ANTHROPIC_AUTH_TOKEN: key } : { ANTHROPIC_API_KEY: key }) : {},
});

async function main() {
  const probe = await adapter.probe(profile);
  console.log("probe:", JSON.stringify({ ...probe, capabilities: undefined }));
  check("probe finds claude", probe.installed && probe.version !== null, probe.version ?? "");
  if (probeOnly) return;
  if (!key) throw new Error("No key in the environment. Run this through the env-vault skill's `run --`.");

  execFileSync("git", ["init", "-q", repo], { windowsHide: true });
  writeFileSync(join(repo, "README.md"), "# demo\n");

  // 1. Plan, tool call, approve once, deny once, answer a question, usage.
  const prompt = [
    "Do these steps in order and keep every reply short.",
    "1. Use TodoWrite to record a three-item plan for these steps.",
    "2. Run the shell command `git status`.",
    "3. Create a file named notes.txt containing the word ok.",
    "4. Use AskUserQuestion to ask me which color I prefer, with the options red and blue.",
    "5. Reply with my answer in one word.",
  ].join("\n");
  let approvals = 0;
  const first = await adapter.start(req(prompt));
  const ev1 = await drive(first, async (e) => {
    if (e.type === "request.question") {
      await adapter.answer(first, e.requestId, { kind: "question", answers: [{ selected: ["blue"] }] });
    } else {
      approvals++;
      // Approve the first tool, deny every later one (the notes.txt write).
      await adapter.answer(first, e.requestId, approvals === 1 ? { kind: "approval", decision: "allow_once" } : { kind: "approval", decision: "deny", message: "Not this one." });
    }
  });
  const end1 = ev1.at(-1);
  check("receives a plan", ev1.some((e) => e.type === "plan.update" && e.steps.length > 0));
  check("receives a tool call", ev1.some((e) => e.type === "tool.call"));
  check("approve once", ev1.some((e) => e.type === "tool.update" && e.status === "completed"));
  check("deny once", approvals >= 2 && !existsSync(join(repo, "notes.txt")), `${approvals} approvals`);
  check("answers a question", ev1.some((e) => e.type === "request.question") && ev1.filter((e) => e.type === "message.delta").map((e) => e.text).join("").toLowerCase().includes("blue"));
  const usage = ev1.findLast((e) => e.type === "usage.update");
  check("reads usage", Boolean(usage && usage.tokensIn > 0 && usage.costProvenance === "estimated"), usage ? `${usage.tokensIn} in, ${usage.tokensOut} out, $${usage.costUsd}` : "none");
  check("first run completes", end1?.type === "run.ended" && end1.reason === "completed", end1?.detail ?? "");
  check("limits are not read for API keys", adapter.capabilities.reportedLimits === false && adapter.limits === undefined);

  // 2. Interrupt mid-turn.
  const second = await adapter.resume(first.nativeSession, req("Run the shell command `ping -n 20 127.0.0.1` and then summarize it."));
  let interrupted = false;
  const ev2 = await drive(second, async () => {
    if (!interrupted) {
      interrupted = true;
      await adapter.interrupt(second);
    }
  }, (e) => {
    if (!interrupted && (e.type === "message.delta" || e.type === "tool.call")) {
      interrupted = true;
      void adapter.interrupt(second);
    }
  });
  check("interrupt", ev2.at(-1)?.type === "run.ended" && ev2.at(-1).reason === "interrupted", ev2.at(-1)?.reason);

  // 3. Resume keeps the conversation.
  const third = await adapter.resume(first.nativeSession, req("Which color did I pick earlier? Answer in one word."));
  const ev3 = await drive(third);
  check("resume", ev3.filter((e) => e.type === "message.delta").map((e) => e.text).join("").toLowerCase().includes("blue"));

  // 4. Stop and confirm no process remains.
  const fourth = await adapter.resume(first.nativeSession, req("Count slowly from 1 to 200, one number per line."));
  let pid = null;
  const ev4 = await drive(fourth, () => {}, (e) => {
    if (pid === null && fourth.pid && e.type !== "run.state") {
      pid = fourth.pid;
      void adapter.stop(fourth);
    }
  });
  await new Promise((r) => setTimeout(r, 1500));
  check("stop", ev4.at(-1)?.reason === "stopped" && pid !== null && !processAlive(pid), `pid ${pid}`);
}

try {
  await main();
} catch (err) {
  check("suite ran", false, err instanceof Error ? err.message : String(err));
} finally {
  if (process.env.CREWYARD_LIVE_RECORD && frames.length) {
    writeFileSync(process.env.CREWYARD_LIVE_RECORD, frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
    console.log(`Recorded ${frames.length} frames to ${process.env.CREWYARD_LIVE_RECORD}`);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}
