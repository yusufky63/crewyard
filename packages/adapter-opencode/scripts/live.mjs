// Live conformance run against the installed opencode (PLAN.md §5.4). It spends real tokens, so it
// runs only with CREWYARD_LIVE=1. Everything happens in a throwaway git repo under %TEMP%, output
// is capped per turn, and only event types, text and token counts are printed, never keys.
//
//   CREWYARD_LIVE=1                      required
//   CREWYARD_LIVE_MODEL=provider/model   e.g. deepseek/deepseek-flash
//   CREWYARD_LIVE_ENV=NAME,NAME          env vars passed to opencode, e.g. DEEPSEEK_API_KEY
//   CREWYARD_LIVE_MODEL2=provider/model  optional second model for the model-switch step
//   CREWYARD_LIVE_MAX_OUTPUT=512         output token cap per model call
//
// From the repo root, with the key from the vault:
//   node ~/.claude/skills/env-vault/scripts/vault.mjs run --only DEEPSEEK_API_KEY -- node packages/adapter-opencode/scripts/live.mjs

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.CREWYARD_LIVE !== "1") {
  console.log("Skipped: set CREWYARD_LIVE=1 to run against the real opencode (this spends tokens).");
  process.exit(0);
}
const model = process.env.CREWYARD_LIVE_MODEL;
if (!model) {
  console.log("Set CREWYARD_LIVE_MODEL=provider/model.");
  process.exit(1);
}

const { createAdapter } = await import("../src/index.ts");
const temp = await mkdtemp(join(tmpdir(), "crewyard live oc "));
const cwd = join(temp, "work tree");
const configDir = join(temp, "profile");
await mkdir(cwd, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd, windowsHide: true });

const secrets = Object.fromEntries((process.env.CREWYARD_LIVE_ENV ?? "").split(",").filter(Boolean).flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])));
const env = {
  ...secrets,
  OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: process.env.CREWYARD_LIVE_MAX_OUTPUT ?? "512",
  // The question tool is off for plain CLI clients unless enabled.
  OPENCODE_ENABLE_QUESTION_TOOL: "1",
};
console.log("env passed:", Object.keys(env).join(", "));

const profile = { id: "live", alias: "live", runner: "opencode", providerId: model.split("/")[0], credential: { kind: "api_key", secretRef: null }, defaultModel: model, configDir, baseUrl: null };
const worktree = { writes: "worktree", allowCommands: [], network: "denied" };
const readOnly = { writes: "none", allowCommands: [], network: "denied" };
const results = [];
// usage.update is cumulative per OpenCode session, so totals take the last value of each session.
const usageBySession = new Map();

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function turn(name, adapter, open, react = async () => {}) {
  const started = Date.now();
  const seen = { events: [], text: "", usage: null, approvals: [], questions: [] };
  let run;
  try {
    run = await open();
    const timer = setTimeout(() => void adapter.stop(run), 150_000);
    for await (const ev of adapter.events(run)) {
      seen.events.push(ev);
      if (ev.type === "message.delta") seen.text += ev.text;
      if (ev.type === "usage.update") seen.usage = ev;
      if (ev.type === "request.approval") seen.approvals.push(ev);
      if (ev.type === "request.question") seen.questions.push(ev);
      await react(ev, run, adapter);
    }
    clearTimeout(timer);
  } catch (err) {
    seen.error = err instanceof Error ? err.message : String(err);
  }
  if (run) await adapter.stop(run);
  await new Promise((r) => setTimeout(r, 1_000));
  seen.processLeft = run ? alive(run.pid) : false;
  seen.run = run;
  seen.ended = seen.events.at(-1);
  if (seen.usage && run?.nativeSession) usageBySession.set(run.nativeSession.sessionId, seen.usage);
  const kinds = [...new Set(seen.events.map((e) => e.type))].join(",");
  console.log(`\n[${name}] ${((Date.now() - started) / 1000).toFixed(1)}s ended=${seen.ended?.type === "run.ended" ? `${seen.ended.reason} ${seen.ended.detail ?? ""}` : "none"} process_left=${seen.processLeft}`);
  console.log(`  events: ${kinds}`);
  console.log(`  text: ${JSON.stringify(seen.text.slice(0, 200))}`);
  if (seen.usage) console.log(`  usage: in=${seen.usage.tokensIn} out=${seen.usage.tokensOut} cacheRead=${seen.usage.cacheRead} reasoning=${seen.usage.reasoning} cost=$${(seen.usage.costUsd ?? 0).toFixed(6)} (${seen.usage.costProvenance})`);
  for (const a of seen.approvals) console.log(`  approval: command=${JSON.stringify(a.command)} paths=${JSON.stringify(a.paths)}`);
  for (const t of seen.events.filter((e) => e.type === "tool.call")) console.log(`  tool: ${t.title} (${t.kind})`);
  if (seen.error) console.log(`  error: ${seen.error}`);
  return seen;
}

function check(step, ok, note = "") {
  results.push({ step, ok, note });
}

const reqFor = (prompt, policy = worktree, extra = {}) => ({ profile, cwd, model: null, prompt, policy, env, ...extra });
const adapter = createAdapter();

// CREWYARD_LIVE_STEPS=approve,resume,question,plan,readonly,interrupt,stop picks steps; resume needs approve.
const steps = new Set((process.env.CREWYARD_LIVE_STEPS ?? "approve,resume,question,plan,readonly,interrupt,stop").split(","));
if (steps.has("resume")) steps.add("approve");

try {
  const probe = await adapter.probe(profile);
  console.log("probe:", JSON.stringify({ version: probe.version, problems: probe.problems }));
  check("probe", probe.installed && probe.problems.length === 0, probe.version ?? "");

  let session = null;
  if (steps.has("approve")) {
    const a = await turn("approve once", adapter, () => adapter.start(reqFor("Run the shell command `git status --short` with the bash tool, then reply with one short sentence about the result.")), async (ev, run) => {
      if (ev.type === "request.approval") await adapter.answer(run, ev.requestId, { kind: "approval", decision: "allow_once" });
    });
    const aTool = a.events.find((e) => e.type === "tool.call" && e.kind === "execute");
    check("start + stream", a.ended?.reason === "completed" && a.text.length > 0);
    check("tool call", Boolean(aTool), aTool?.title ?? "");
    check("approve once", a.approvals.length > 0 && a.events.some((e) => e.type === "tool.update" && e.status === "completed"), a.approvals[0]?.command ?? "");
    check("usage", Boolean(a.usage && a.usage.tokensIn > 0), a.usage ? `cost provenance ${a.usage.costProvenance}` : "");
    check("no process left (completed)", !a.processLeft);
    session = a.run?.nativeSession ?? null;
  }

  if (steps.has("resume") && session) {
    // Resume the same session in a new server with another model, then deny the command.
    const model2 = process.env.CREWYARD_LIVE_MODEL2 ?? model;
    const b = await turn("resume + deny once", adapter, () => adapter.resume(session, reqFor("Now run the shell command `git log -1` with the bash tool, then reply in one short sentence.", worktree, { model: model2 })), async (ev, run) => {
      if (ev.type === "request.approval") await adapter.answer(run, ev.requestId, { kind: "approval", decision: "deny", message: "Not now." });
    });
    check("resume", b.run?.nativeSession?.sessionId === session.sessionId && b.ended?.reason === "completed");
    check("deny once", b.approvals.length > 0 && b.events.some((e) => e.type === "tool.update" && e.status === "failed"), b.approvals[0]?.command ?? "");
    check(`model per prompt (${model2})`, b.ended?.reason === "completed");
  }

  if (steps.has("question")) {
    const c = await turn("question", adapter, () => adapter.start(reqFor("Use the question tool to ask me one question: which color do I prefer, with the options red and blue. After my answer, reply with only that color.")), async (ev, run) => {
      if (ev.type === "request.question") await adapter.answer(run, ev.requestId, { kind: "question", answers: [{ selected: ["blue"] }] });
    });
    check("answer a question", c.questions.length > 0 && /blue/i.test(c.text), c.questions[0] ? JSON.stringify(c.questions[0].questions[0]?.options.map((o) => o.label)) : "no question asked");
  }

  if (steps.has("plan")) {
    const d = await turn("plan", adapter, () => adapter.start(reqFor("Use the todowrite tool to create a todo list with exactly two short items for writing a hello world script. Do not do the work. Then reply with: done.")));
    const plan = d.events.find((e) => e.type === "plan.update");
    check("plan", Boolean(plan), plan ? JSON.stringify(plan.steps.map((s) => s.title)) : "");
  }

  if (steps.has("readonly")) {
    // Edits never reach the user; commands still go to approval (a command can write too), and we deny them.
    const e = await turn("read-only edit", adapter, () => adapter.start(reqFor("Create a file named note.txt containing the word hi using your write tool. If that is refused, stop and reply with one short sentence.", readOnly)), async (ev, run) => {
      if (ev.type === "request.approval") await adapter.answer(run, ev.requestId, { kind: "approval", decision: "deny", message: "This role is read-only." });
    });
    const editAsked = e.approvals.some((a) => a.paths.length > 0);
    check("read-only denies edits", !editAsked && !existsSync(join(cwd, "note.txt")) && e.ended?.reason === "completed", `${e.approvals.length} command approvals denied`);
  }

  if (steps.has("interrupt")) {
    let interrupted = false;
    const f = await turn("interrupt", adapter, () => adapter.start(reqFor("Count from 1 to 300 in words, one number per line, without using any tools.")), async (ev, run) => {
      if (ev.type === "message.delta" && !interrupted) {
        interrupted = true;
        await adapter.interrupt(run);
      }
    });
    check("interrupt", f.ended?.reason === "interrupted");
    check("no process left (interrupt)", !f.processLeft);
  }

  if (steps.has("stop")) {
    let stopped = false;
    const g = await turn("stop", adapter, () => adapter.start(reqFor("Count from 1 to 300 in words, one number per line, without using any tools.")), async (ev, run) => {
      if (ev.type === "message.delta" && !stopped) {
        stopped = true;
        await adapter.stop(run);
      }
    });
    check("stop", g.ended?.reason === "stopped" && !g.processLeft, g.ended?.reason ?? "");
  }

  check("read limits", true, "not offered by OpenCode (reportedLimits: false)");
} finally {
  console.log("\nResults:");
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.step}${r.note ? `  (${r.note})` : ""}`);
  const totals = { tokensIn: 0, tokensOut: 0, cacheRead: 0, reasoning: 0, cost: 0 };
  for (const u of usageBySession.values()) {
    totals.tokensIn += u.tokensIn;
    totals.tokensOut += u.tokensOut;
    totals.cacheRead += u.cacheRead;
    totals.reasoning += u.reasoning;
    totals.cost += u.costUsd ?? 0;
  }
  console.log(`\nTotals (${usageBySession.size} sessions): in=${totals.tokensIn} out=${totals.tokensOut} cacheRead=${totals.cacheRead} reasoning=${totals.reasoning} estimated cost=$${totals.cost.toFixed(6)}`);
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
