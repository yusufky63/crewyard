// Live check of turn control through Claude Code: a queued follow-up taken at the turn boundary
// (StartRequest.nextTurn), then "undo last turn" with the CLI's own --rewind-files on the ended
// session, and the transcript lookup. Two tiny file writes; it spends API money, so it only runs
// with CREWYARD_LIVE=1.
//
//   CREWYARD_LIVE=1 CREWYARD_LIVE_KEY_VAR=DEEPSEEK_API_KEY CREWYARD_LIVE_BASE_URL=https://api.deepseek.com/anthropic \
//   CREWYARD_LIVE_MODEL=deepseek-chat node ~/.claude/skills/env-vault/scripts/vault.mjs run --only DEEPSEEK_API_KEY -- node packages/adapter-claude/scripts/live-turns.mjs
//
// Prints event types, file states and token counts only, never keys.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapter } from "../src/index.ts";

if (process.env.CREWYARD_LIVE !== "1") {
  console.log("Skipped: set CREWYARD_LIVE=1 (this calls the API and costs money).");
  process.exit(0);
}

const baseUrl = process.env.CREWYARD_LIVE_BASE_URL || null;
const key = process.env[process.env.CREWYARD_LIVE_KEY_VAR || "ANTHROPIC_API_KEY"] || "";
const model = process.env.CREWYARD_LIVE_MODEL || "claude-haiku-4-5";

const root = mkdtempSync(join(tmpdir(), "crewyard live turns "));
const repo = join(root, "demo repo");
mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: repo, windowsHide: true, encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "live@crewyard.test");
git("config", "user.name", "live");
writeFileSync(join(repo, "README.md"), "# demo\n");
git("add", ".");
git("commit", "-qm", "init");

const profile = { id: "live", alias: "live", runner: "claude-code", providerId: baseUrl ? "custom" : "anthropic", credential: { kind: "api_key", secretRef: "live" }, defaultModel: model, configDir: join(root, "profile dir"), baseUrl };
const env = { ANTHROPIC_API_KEY: key, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1024" };
const queued = ["Now use the Write tool to create a file named b.txt containing exactly the word beta. Then reply DONE and nothing else."];
const adapter = createAdapter();
const run = await adapter.start({
  profile,
  cwd: repo,
  model,
  prompt: "Use the Write tool to create a file named a.txt containing exactly the word alpha. Then reply DONE and nothing else.",
  policy: { writes: "worktree", allowCommands: [], network: "denied" },
  env,
  nextTurn: async () => queued.shift() ?? null,
});
const timer = setTimeout(() => void adapter.stop(run), 240_000);
const turns = [];
let usage = null;
let ended = null;
for await (const ev of adapter.events(run)) {
  if (ev.type === "turn.started") turns.push(ev.turnRef);
  // The check approves its own file writes, as you would in the Inbox.
  if (ev.type === "request.approval") await adapter.answer(run, ev.requestId, { kind: "approval", decision: "allow_once" });
  if (ev.type === "usage.update") usage = ev;
  if (ev.type === "run.ended") ended = ev;
}
clearTimeout(timer);
const both = existsSync(join(repo, "a.txt")) && existsSync(join(repo, "b.txt"));
console.log("run.ended:", ended?.reason, ended?.detail ?? "");
console.log("turns:", turns.length, "a.txt and b.txt written:", both);

const session = { runner: "claude-code", sessionId: run.nativeSession.sessionId };
const rewind = await adapter.rewind({ profile, cwd: repo, env, session, turnRef: turns[1] ?? null });
const undone = existsSync(join(repo, "a.txt")) && !existsSync(join(repo, "b.txt"));
console.log("rewind:", JSON.stringify(rewind));
console.log("after undo: a.txt kept, b.txt gone:", undone);
const transcript = await adapter.transcript({ profile, cwd: repo, env, session });
console.log("transcript found:", transcript?.kind ?? null);
console.log("tokens in/out/cacheRead:", usage?.tokensIn, usage?.tokensOut, usage?.cacheRead);
rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(ended?.reason === "completed" && turns.length === 2 && both && rewind.files && undone && transcript ? 0 : 1);
