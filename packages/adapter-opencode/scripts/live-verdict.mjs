// Live check of the schema-checked reviewer verdict and the read-only ruleset through opencode. One
// small review of a two-line change; it spends tokens, so it only runs with CREWYARD_LIVE=1.
//
//   CREWYARD_LIVE=1 CREWYARD_LIVE_MODEL=deepseek/deepseek-flash CREWYARD_LIVE_ENV=DEEPSEEK_API_KEY \
//   node ~/.claude/skills/env-vault/scripts/vault.mjs run --only DEEPSEEK_API_KEY -- node packages/adapter-opencode/scripts/live-verdict.mjs
//
// Prints tool titles, the verdict and token counts only, never keys.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEW_VERDICT_OUTPUT } from "@crewyard/core";
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

const root = mkdtempSync(join(tmpdir(), "crewyard live verdict oc "));
const repo = join(root, "demo repo");
mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: repo, windowsHide: true, encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "live@crewyard.test");
git("config", "user.name", "live");
writeFileSync(join(repo, "sum.js"), "export function sum(a, b) {\n  return a + b;\n}\n");
git("add", ".");
git("commit", "-qm", "init");
// The change under review: an obvious bug.
writeFileSync(join(repo, "sum.js"), "export function sum(a, b) {\n  return a - b;\n}\n");

const secrets = Object.fromEntries((process.env.CREWYARD_LIVE_ENV ?? "").split(",").filter(Boolean).flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])));
const profile = { id: "live", alias: "live", runner: "opencode", providerId: model.split("/")[0], credential: { kind: "api_key", secretRef: null }, defaultModel: model, configDir: join(root, "profile dir"), baseUrl: null };
const adapter = createAdapter();
const run = await adapter.start({
  profile,
  cwd: repo,
  model,
  prompt: "You are the reviewer. Review the uncommitted change in this git repository (run `git diff`). Do not change any file.",
  policy: { writes: "none", allowCommands: [], network: "denied" },
  env: { ...secrets, OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "2048" },
  outputSchema: REVIEW_VERDICT_OUTPUT,
});
const timer = setTimeout(() => void adapter.stop(run), 180_000);
const tools = [];
let usage = null;
let ended = null;
for await (const ev of adapter.events(run)) {
  if (ev.type === "tool.call") tools.push(`${ev.title} ${JSON.stringify(ev.input).slice(0, 80)}`);
  if (ev.type === "tool.update" && ev.status === "failed") tools.push(`  failed: ${(ev.output ?? "").slice(0, 160)}`);
  if (ev.type === "request.approval") tools.push(`  approval asked: ${ev.command ?? ev.paths.join(", ")}`);
  if (ev.type === "run.state" && ev.detail) tools.push(`  state ${ev.state}: ${ev.detail.slice(0, 160)}`);
  if (ev.type === "usage.update") usage = ev;
  if (ev.type === "run.ended") ended = ev;
}
clearTimeout(timer);
const unchanged = readFileSync(join(repo, "sum.js"), "utf8").includes("a - b");
console.log("tools:", tools.length ? `\n  ${tools.join("\n  ")}` : "(none)");
console.log("run.ended:", ended?.reason, ended?.detail ?? "");
console.log("output:", JSON.stringify(ended?.output, null, 2));
console.log("worktree unchanged:", unchanged);
console.log("tokens in/out/cacheRead:", usage?.tokensIn, usage?.tokensOut, usage?.cacheRead);
rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(ended?.reason === "completed" && ended.output?.ok && unchanged ? 0 : 1);
