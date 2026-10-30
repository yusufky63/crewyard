// Live check of a handoff between two Claude Code profiles of the same provider (feature scan A11):
// one turn in profile A, fork() into profile C as it is and into profile B with compaction, then
// a resume in each asking what the first turn created. Each profile has its own config folder,
// as in the app. A few small model calls; it spends API money, so it only runs with CREWYARD_LIVE=1.
//
//   CREWYARD_LIVE=1 node ~/.claude/skills/env-vault/scripts/vault.mjs run --only DEEPSEEK_API_KEY -- node packages/adapter-claude/scripts/live-fork.mjs
//
// Defaults to DeepSeek's Anthropic endpoint; CREWYARD_LIVE_KEY_VAR, CREWYARD_LIVE_BASE_URL and
// CREWYARD_LIVE_MODEL point it elsewhere. Prints event types, token counts and entry types, never keys.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapter } from "../src/index.ts";

if (process.env.CREWYARD_LIVE !== "1") {
  console.log("Skipped: set CREWYARD_LIVE=1 (this calls the API and costs money).");
  process.exit(0);
}

const baseUrl = process.env.CREWYARD_LIVE_BASE_URL || "https://api.deepseek.com/anthropic";
const key = process.env[process.env.CREWYARD_LIVE_KEY_VAR || "DEEPSEEK_API_KEY"] || "";
const model = process.env.CREWYARD_LIVE_MODEL || "deepseek-flash";
if (!key) {
  console.log("No key in the environment.");
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), "crewyard live fork "));
const repo = join(root, "demo repo");
mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: repo, windowsHide: true, encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "live@crewyard.test");
git("config", "user.name", "live");
writeFileSync(join(repo, "README.md"), "# demo\n");
git("add", ".");
git("commit", "-qm", "init");

const profile = (name) => ({ id: name, alias: name, runner: "claude-code", providerId: "deepseek", credential: { kind: "api_key", secretRef: name }, defaultModel: model, configDir: join(root, `profile ${name}`), baseUrl });
const env = { ANTHROPIC_API_KEY: key, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2048" };
const policy = { writes: "worktree", allowCommands: [], network: "denied" };
const [A, B, C] = [profile("a"), profile("b"), profile("c")];
const adapter = createAdapter();
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function drive(run) {
  const timer = setTimeout(() => void adapter.stop(run), 120_000);
  let usage = null;
  let ended = null;
  let text = "";
  for await (const ev of adapter.events(run)) {
    if (ev.type === "request.approval") await adapter.answer(run, ev.requestId, { kind: "approval", decision: "allow_once" });
    if (ev.type === "message.delta") text += ev.text;
    if (ev.type === "usage.update") usage = ev;
    if (ev.type === "run.ended") ended = ev;
  }
  clearTimeout(timer);
  return { usage, ended, text: text.trim() };
}
const tokens = (u) => (u ? `in ${u.tokensIn} out ${u.tokensOut} cacheRead ${u.cacheRead} cost ${u.costUsd}` : "none");
const question = "Without using any tool: which file did you create earlier in this conversation, and what word is in it? Answer in one short line.";

let ok = true;
try {
  const first = await adapter.start({ profile: A, cwd: repo, model, prompt: "Use the Write tool to create a file named fork-marker.txt containing exactly the word kiwi. Then reply DONE and nothing else.", policy, env });
  const r1 = await drive(first);
  console.log("A turn:", r1.ended?.reason, "|", tokens(r1.usage));
  const sourceRef = { runner: "claude-code", sessionId: first.nativeSession.sessionId };
  const sourceFile = (await adapter.transcript({ profile: A, cwd: repo, env, session: sourceRef })).path;
  const types = {};
  for (const line of readFileSync(sourceFile, "utf8").split("\n").filter(Boolean)) {
    const t = JSON.parse(line).type;
    types[t] = (types[t] ?? 0) + 1;
  }
  console.log("source entry types:", JSON.stringify(types));
  const before = sha(sourceFile);

  // Fork as it is into C, then resume there.
  const plain = await adapter.fork({ source: { profile: A, session: sourceRef, env }, target: { profile: C, model, env }, cwd: repo, compact: false });
  console.log("fork C:", plain.session.sessionId !== sourceRef.sessionId ? "new id" : "SAME ID", "compacted", plain.compacted, "totals", JSON.stringify(plain.totals));
  const r2 = await drive(await adapter.resume(plain.session, { profile: C, cwd: repo, model, prompt: question, policy, env }));
  console.log("C resume:", r2.ended?.reason, "|", tokens(r2.usage), "| answer:", r2.text.slice(0, 160));
  ok &&= r2.ended?.reason === "completed" && /fork-marker/.test(r2.text);

  // Fork with compaction into B, then resume there.
  const compacted = await adapter.fork({ source: { profile: A, session: sourceRef, env }, target: { profile: B, model, env }, cwd: repo, compact: true });
  console.log("fork B: compacted", compacted.compacted, "| summary chars", compacted.summary?.length ?? null, "| usage", JSON.stringify(compacted.usage), "| totals", JSON.stringify(compacted.totals));
  if (compacted.summary) console.log("summary head:", compacted.summary.slice(0, 200).replace(/\s+/g, " "));
  const r3 = await drive(await adapter.resume(compacted.session, { profile: B, cwd: repo, model, prompt: question, policy, env }));
  console.log("B resume:", r3.ended?.reason, "|", tokens(r3.usage), "| answer:", r3.text.slice(0, 160));
  ok &&= compacted.compacted && r3.ended?.reason === "completed" && /fork-marker/.test(r3.text);

  const unchanged = sha(sourceFile) === before;
  console.log("source file unchanged:", unchanged);
  ok &&= unchanged;

  // The CLI's own refusal of an unknown session, through resume().
  const gone = await drive(await adapter.resume({ runner: "claude-code", sessionId: "11111111-2222-4333-8444-555555555555" }, { profile: B, cwd: repo, model, prompt: "hi", policy, env }));
  console.log("unknown session:", gone.ended?.reason, gone.ended?.detail);
  ok &&= gone.ended?.detail?.startsWith("session.gone:") ?? false;
} catch (err) {
  console.log("failed:", err instanceof Error ? err.message : String(err));
  ok = false;
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(ok ? 0 : 1);
