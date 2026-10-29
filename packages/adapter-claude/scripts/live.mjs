// Live conformance run for the Claude Code adapter (PLAN.md §5.4). It spends API money, so it
// only runs with CREWYARD_LIVE=1. Run it through the key vault so the key never touches a file:
//
//   CREWYARD_LIVE=1 node ~/.claude/skills/env-vault/scripts/vault.mjs run --only ANTHROPIC_API_KEY -- node packages/adapter-claude/scripts/live.mjs
//
// DeepSeek through its Anthropic-compatible endpoint:
//
//   CREWYARD_LIVE=1 CREWYARD_LIVE_KEY_VAR=DEEPSEEK_API_KEY CREWYARD_LIVE_BASE_URL=https://api.deepseek.com/anthropic \
//   CREWYARD_LIVE_MODEL=deepseek-flash node ~/.claude/skills/env-vault/scripts/vault.mjs run --only DEEPSEEK_API_KEY -- node packages/adapter-claude/scripts/live.mjs
//
// Always pass --only: `vault run` exports every key, and only the one for this provider may reach it.
//
// Environment:
//   CREWYARD_LIVE_KEY_VAR         variable that holds the key, default ANTHROPIC_API_KEY
//   CREWYARD_LIVE_BASE_URL        optional Anthropic-compatible endpoint, e.g. https://api.deepseek.com/anthropic
//   CREWYARD_LIVE_MODEL           model id, default claude-haiku-4-5 (the cheapest that can use tools)
//   CREWYARD_LIVE_MAX_OUTPUT      output token cap per response, default 2048 (CLAUDE_CODE_MAX_OUTPUT_TOKENS)
//   CREWYARD_LIVE_RECORD=<file>   also write every raw SDK frame as JSON lines, for new replay fixtures
//   CREWYARD_LIVE_FEATURES=1      also try WebSearch and WebFetch and report whether they work
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
const key = process.env[process.env.CREWYARD_LIVE_KEY_VAR || "ANTHROPIC_API_KEY"] || "";
const maxOutput = process.env.CREWYARD_LIVE_MAX_OUTPUT || "2048";
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
// The SDK's Query iterates through its own iterator, so frames are teed from a wrapper generator.
const recordingQuery = (params) => {
  const q = sdkQuery(params);
  async function* tee() {
    for await (const frame of q) {
      frames.push(frame);
      yield frame;
    }
  }
  return Object.assign(tee(), { interrupt: () => q.interrupt(), setModel: (m) => q.setModel(m), close: () => q.close() });
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
  env: { ...(key ? (baseUrl ? { ANTHROPIC_AUTH_TOKEN: key } : { ANTHROPIC_API_KEY: key }) : {}), CLAUDE_CODE_MAX_OUTPUT_TOKENS: maxOutput },
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
    "1. Record a three-item plan for these steps with your todo or task list tool.",
    "2. Run the shell command `git add README.md`.",
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
      // Approve `git add`, deny everything else: the notes.txt write and any shell workaround for it.
      // (`git status` would not do here: the CLI runs read-only commands without asking.)
      const allow = e.command?.trim().startsWith("git add") === true;
      await adapter.answer(first, e.requestId, allow ? { kind: "approval", decision: "allow_once" } : { kind: "approval", decision: "deny", message: "Do not create notes.txt. Skip that step." });
    }
  });
  const end1 = ev1.at(-1);
  check("receives a plan", ev1.some((e) => e.type === "plan.update" && e.steps.length > 0));
  check("receives a tool call", ev1.some((e) => e.type === "tool.call"));
  const staged = execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], { encoding: "utf8", windowsHide: true });
  check("approve once", staged.includes("README.md"));
  check("deny once", approvals >= 2 && !existsSync(join(repo, "notes.txt")), `${approvals} approvals`);
  check("answers a question", ev1.some((e) => e.type === "request.question") && ev1.filter((e) => e.type === "message.delta").map((e) => e.text).join("").toLowerCase().includes("blue"));
  const usage = ev1.findLast((e) => e.type === "usage.update");
  // Session totals. The cost is Unknown when the CLI has no price for the model (any third-party model).
  const costOk = usage && (usage.costProvenance === "estimated" ? usage.costUsd !== null : usage.costUsd === null);
  check("reads usage", Boolean(usage && usage.tokensIn > 0 && costOk), usage ? `${usage.tokensIn} in, ${usage.tokensOut} out, ${usage.cacheRead} cache read, cost ${usage.costUsd ?? "unknown"} (${usage.costProvenance})` : "none");
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

  // 4. Server-side and helper-model tools, which third-party endpoints may not support. Reported, not gated.
  if (process.env.CREWYARD_LIVE_FEATURES === "1") {
    for (const [tool, prompt] of [
      ["WebSearch", "Use the WebSearch tool once to search for: Claude Code. Then reply with the title of the first result only."],
      ["WebFetch", "Use the WebFetch tool once on https://example.com and reply with the page title only."],
    ]) {
      const h = await adapter.resume(first.nativeSession, req(prompt));
      const ev = await drive(h, (e) => adapter.answer(h, e.requestId, e.type === "request.question" ? { kind: "cancel" } : { kind: "approval", decision: "allow_once" }));
      const calls = new Set(ev.filter((e) => e.type === "tool.call" && e.title.startsWith(tool)).map((e) => e.toolCallId));
      const updates = ev.filter((e) => e.type === "tool.update" && calls.has(e.toolCallId) && e.status !== "in_progress");
      const ok = updates.length > 0 && updates.every((e) => e.status === "completed");
      console.log(`INFO  ${tool}: ${calls.size === 0 ? "not called" : ok ? "works" : "failed"}${updates[0]?.output ? `  (${updates[0].output.replace(/\s+/g, " ").slice(0, 200)})` : ""}`);
    }
  }

  // 5. Stop and confirm no process remains.
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
