// Live check of a handoff between two OpenCode profiles on one provider: a turn in profile A,
// fork() into profile B with compaction on B's model, then a resume in B that must still know
// what A was told. Three small model calls; it spends tokens, so it only runs with CREWYARD_LIVE=1.
//
//   CREWYARD_LIVE=1 CREWYARD_LIVE_MODEL=deepseek/deepseek-flash CREWYARD_LIVE_ENV=DEEPSEEK_API_KEY \
//   node ~/.claude/skills/env-vault/scripts/vault.mjs run --only DEEPSEEK_API_KEY -- node packages/adapter-opencode/scripts/live-fork.mjs
//
// Prints ids, token counts, costs and the summary's length only, never keys.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionProblemOf } from "@crewyard/core";
import { createAdapter } from "../src/index.ts";

if (process.env.CREWYARD_LIVE !== "1") {
  console.log("Skipped: set CREWYARD_LIVE=1 (this spends tokens).");
  process.exit(0);
}
const model = process.env.CREWYARD_LIVE_MODEL;
if (!model) {
  console.log("Set CREWYARD_LIVE_MODEL=provider/model.");
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), "crewyard live fork oc "));
const repo = join(root, "demo repo");
mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: repo, windowsHide: true, encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "live@crewyard.test");
git("config", "user.name", "live");
writeFileSync(join(repo, "README.md"), "# demo\n");
git("add", ".");
git("commit", "-qm", "init");

const secrets = Object.fromEntries((process.env.CREWYARD_LIVE_ENV ?? "").split(",").filter(Boolean).flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])));
const [providerId, ...rest] = model.split("/");
const modelId = rest.join("/");
const profile = (id) => ({ id, alias: id, runner: "opencode", providerId, credential: { kind: "api_key", secretRef: null }, defaultModel: modelId, configDir: join(root, `profile ${id}`), baseUrl: null });
const a = profile("a");
const b = profile("b");
const env = { ...secrets, OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "1024" };
const policy = { writes: "none", allowCommands: [], network: "denied" };
const adapter = createAdapter();

async function turn(handle) {
  const timer = setTimeout(() => void adapter.stop(handle), 90_000);
  let text = "";
  let firstUsage = null;
  let lastUsage = null;
  let ended = null;
  for await (const ev of adapter.events(handle)) {
    if (ev.type === "message.delta") text += ev.text;
    if (ev.type === "usage.update") {
      firstUsage ??= ev;
      lastUsage = ev;
    }
    if (ev.type === "run.ended") ended = ev;
  }
  clearTimeout(timer);
  return { text: text.trim(), firstUsage, lastUsage, ended };
}

let ok;
try {
  const first = await adapter.start({ profile: a, cwd: repo, model: modelId, prompt: "Remember this code word for later: PAPAYA. Reply with OK and nothing else.", policy, env });
  const t1 = await turn(first);
  console.log("A turn:", t1.ended?.reason, JSON.stringify(t1.text.slice(0, 40)));
  const source = { runner: "opencode", sessionId: first.nativeSession.sessionId };
  const exportBefore = await adapter.transcript({ profile: a, cwd: repo, env, session: source });

  const started = Date.now();
  const forked = await adapter.fork({ source: { profile: a, session: source, env }, target: { profile: b, model: modelId, env }, cwd: repo, compact: true });
  console.log("fork:", source.sessionId, "->", forked.session.sessionId, `${Date.now() - started} ms`, "compacted:", forked.compacted, "summary chars:", forked.summary?.length ?? null);
  console.log("summarize usage:", JSON.stringify(forked.usage));
  console.log("new session totals:", JSON.stringify(forked.totals));
  const exportAfter = await adapter.transcript({ profile: a, cwd: repo, env, session: source });
  const sourceUnchanged = exportBefore?.text === exportAfter?.text;
  console.log("source session unchanged:", sourceUnchanged);

  const resumed = await adapter.resume(forked.session, { profile: b, cwd: repo, model: modelId, prompt: "What was the code word I gave you? Reply with the word only.", policy, env });
  const t2 = await turn(resumed);
  const remembered = /papaya/i.test(t2.text);
  console.log("B resume:", t2.ended?.reason, JSON.stringify(t2.text.slice(0, 40)), "remembered:", remembered);
  const u = t2.firstUsage;
  const grows = u && forked.totals ? u.tokensIn >= forked.totals.tokensIn && u.tokensOut >= forked.totals.tokensOut : false;
  console.log("B first usage.update:", u ? JSON.stringify({ tokensIn: u.tokensIn, tokensOut: u.tokensOut, cacheRead: u.cacheRead, costUsd: u.costUsd }) : null, "starts from totals:", grows);

  const missing = await adapter.resume({ runner: "opencode", sessionId: "ses_doesnotexist" }, { profile: b, cwd: repo, model: modelId, prompt: "", policy, env }).catch((e) => e);
  console.log("resume of an unknown id:", sessionProblemOf(missing));
  // OpenCode's own estimate from its models.dev prices (Estimated), not the provider's bill.
  const spent = (t1.lastUsage?.costUsd ?? 0) + (forked.usage?.costUsd ?? 0) + ((t2.lastUsage?.costUsd ?? 0) - (forked.totals?.costUsd ?? 0));
  console.log("estimated cost of the three calls (USD):", spent.toFixed(6));
  ok = t1.ended?.reason === "completed" && forked.compacted && sourceUnchanged && t2.ended?.reason === "completed" && remembered && grows && sessionProblemOf(missing) === "gone";
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
process.exit(ok ? 0 : 1);
