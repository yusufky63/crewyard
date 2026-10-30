// A stand-in for `codex app-server`, used only by adapter.test.ts. It speaks the same JSONL
// JSON-RPC, reads its scenario from $CODEX_HOME/fake.json and appends every message it receives
// to $CODEX_HOME/fake-log.jsonl so tests can check what the adapter sent.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const home = process.env.CODEX_HOME ?? "";
const config = (() => {
  try {
    return JSON.parse(readFileSync(join(home, "fake.json"), "utf8"));
  } catch {
    return {};
  }
})();
const scenario = config.scenario ?? "basic";
const fixture = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
const log = (entry) => appendFileSync(join(home, "fake-log.jsonl"), `${JSON.stringify(entry)}\n`);

log({ env: { CODEX_HOME: home, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null, CREWYARD_TEST_SECRET: process.env.CREWYARD_TEST_SECRET ?? null, CREWYARD_RUN_TICKET: process.env.CREWYARD_RUN_TICKET ?? null, GH_TOKEN: process.env.GH_TOKEN ?? null }, cwd: process.cwd() });

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method, params) => send({ method, params });
const waiting = new Map();
let nextServerId = 0;
/** Sends a server request and resolves with the client's response. Ids alternate string/number like codex may. */
function ask(method, params) {
  const id = nextServerId++ % 2 === 0 ? `srv-${nextServerId}` : 100 + nextServerId;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

const turn = (status, error = null) => ({ id: "turn-1", items: [], itemsView: "notLoaded", status, error, startedAt: 1, completedAt: null, durationMs: null });
const started = () => notify("turn/started", { threadId: "thr-1", turn: turn("inProgress") });
const completed = (status, error = null) => notify("turn/completed", { threadId: "thr-1", turn: turn(status, error) });
const tick = () => new Promise((r) => setTimeout(r, 5));
let turns = 0;

const usage = (input, output) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 });
const pad = (n) => String(n).padStart(2, "0");
/** A review subagent's rollout, named and laid out as codex 0.147.0 writes it (local time in the name). */
function reviewRollout() {
  const d = new Date();
  const dir = join(home, "sessions", String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  mkdirSync(dir, { recursive: true });
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const file = join(dir, `rollout-${stamp}-thr-review.jsonl`);
  const meta = { session_id: "thr-1", id: "thr-review", parent_thread_id: "thr-1", timestamp: d.toISOString(), cwd: home, originator: "crewyard", cli_version: "0.147.0", source: { subagent: "review" }, base_instructions: { text: "x".repeat(6000) } };
  writeFileSync(file, `${JSON.stringify({ timestamp: d.toISOString(), type: "session_meta", payload: meta })}\n`);
  return file;
}
const tokenCount = (s) =>
  `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: s.input, cached_input_tokens: s.cached, cache_write_input_tokens: 0, output_tokens: s.output, reasoning_output_tokens: s.reasoning, total_tokens: s.input + s.output } } } })}\n`;

async function runTurn() {
  await tick();
  switch (scenario) {
    case "basic":
      for (const n of fixture("turn-basic.json")) notify(n.method, n.params);
      return;
    case "approval":
    case "readonly": {
      started();
      notify("item/started", { threadId: "thr-1", turnId: "turn-1", startedAtMs: 1, item: { type: "fileChange", id: "fc-1", changes: [{ path: "src/a b.ts", kind: { type: "add" }, diff: "" }], status: "inProgress" } });
      const cmd = await ask("item/commandExecution/requestApproval", { threadId: "thr-1", turnId: "turn-1", itemId: "cmd-1", startedAtMs: 1, environmentId: null, command: "npm install", cwd: "C:\\work\\my repo", networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" }, commandActions: [{ type: "unknown", command: "npm install" }] });
      log({ answered: "command", response: cmd });
      const file = await ask("item/fileChange/requestApproval", { threadId: "thr-1", turnId: "turn-1", itemId: "fc-1", startedAtMs: 1, reason: null, grantRoot: null });
      log({ answered: "file", response: file });
      completed("completed");
      return;
    }
    case "mcp": {
      started();
      // An MCP tool approval (codex 0.147: mcpServer/elicitation/request with _meta.codex_approval_kind), then a form.
      const tool = await ask("mcpServer/elicitation/request", { threadId: "thr-1", turnId: "turn-1", serverName: "github", request: { mode: "form", message: "Allow create_issue?", requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "create_issue" } } });
      log({ answered: "mcp", response: tool });
      const form = await ask("mcpServer/elicitation/request", { threadId: "thr-1", turnId: "turn-1", serverName: "github", request: { mode: "form", message: "Pick a repo", requestedSchema: { type: "object", properties: {} } } });
      log({ answered: "form", response: form });
      completed("completed");
      return;
    }
    case "reviewer-tests": {
      started();
      // codex sends the whole argv shell-quoted; on Windows the script sits inside PowerShell.
      const ps = String.raw`'C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe' -Command`;
      const tests = await ask("item/commandExecution/requestApproval", { threadId: "thr-1", turnId: "turn-1", itemId: "cmd-1", startedAtMs: 1, environmentId: null, command: `${ps} 'npm test'`, cwd: "C:\\work\\my repo", commandActions: [{ type: "unknown", command: "npm test" }] });
      log({ answered: "command", response: tests });
      const chained = await ask("item/commandExecution/requestApproval", { threadId: "thr-1", turnId: "turn-1", itemId: "cmd-2", startedAtMs: 1, environmentId: null, command: `${ps} 'npm test; git push'`, cwd: "C:\\work\\my repo", commandActions: [{ type: "unknown", command: "npm test; git push" }] });
      log({ answered: "command", response: chained });
      completed("completed");
      return;
    }
    case "question": {
      started();
      const res = await ask("item/tool/requestUserInput", { threadId: "thr-1", turnId: "turn-1", itemId: "q-1", isBlocking: true, autoResolutionMs: null, questions: [
        { id: "db", header: "Database", question: "Which database?", isOther: true, isSecret: false, options: [{ label: "Postgres", description: "Default" }, { label: "SQLite", description: "" }] },
        { id: "name", header: "Name", question: "Table name?", isOther: false, isSecret: false, options: null },
      ] });
      log({ answered: "question", response: res });
      completed("completed");
      return;
    }
    case "resolved": {
      started();
      void ask("item/commandExecution/requestApproval", { threadId: "thr-1", turnId: "turn-1", itemId: "cmd-1", startedAtMs: 1, environmentId: null, command: "make", cwd: null });
      await tick();
      notify("serverRequest/resolved", { threadId: "thr-1", requestId: "srv-1" });
      completed("interrupted");
      return;
    }
    case "limit":
      started();
      notify("error", { threadId: "thr-1", turnId: "turn-1", willRetry: false, error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded", additionalDetails: null } });
      completed("failed", { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded", additionalDetails: null });
      return;
    case "crash":
      started();
      await tick();
      process.exit(3);
      return;
    case "shutdown":
      // The status Windows gives children it ends at sign-out or restart (0x40010004).
      started();
      await tick();
      process.exit(0x40010004);
      return;
    case "structured": {
      // One final message per turn from config.answers, as codex sends it under outputSchema.
      started();
      const text = (config.answers ?? [])[turns - 1] ?? "";
      notify("item/completed", { threadId: "thr-1", turnId: "turn-1", completedAtMs: 1, item: { type: "agentMessage", id: `msg-${turns}`, text, phase: null, memoryCitation: null } });
      completed("completed");
      return;
    }
    case "review": {
      // review/start is the first turn: codex's own review items; the next turn/start is the verdict turn.
      started();
      if (turns === 1) {
        notify("item/completed", { threadId: "thr-1", turnId: "turn-1", completedAtMs: 1, item: { type: "enteredReviewMode", id: "rv-in", review: "current changes" } });
        // As codex 0.147.0: the review subagent's spend goes only to its rollout, the last
        // token_count landing just before the review ends.
        if (config.reviewSpend) {
          const file = reviewRollout();
          appendFileSync(file, tokenCount({ ...config.reviewSpend, input: Math.round(config.reviewSpend.input / 2) }));
          await tick();
          appendFileSync(file, tokenCount(config.reviewSpend));
        }
        notify("item/completed", { threadId: "thr-1", turnId: "turn-1", completedAtMs: 1, item: { type: "exitedReviewMode", id: "rv-out", review: config.reviewText ?? "" } });
      } else {
        const text = (config.answers ?? [])[turns - 2] ?? "";
        if (config.reviewSpend) notify("thread/tokenUsage/updated", { threadId: "thr-1", turnId: "turn-1", tokenUsage: { total: usage(1000, 50), last: usage(1000, 50), modelContextWindow: 258_400 } });
        notify("item/completed", { threadId: "thr-1", turnId: "turn-1", completedAtMs: 1, item: { type: "agentMessage", id: `msg-${turns}`, text, phase: null, memoryCitation: null } });
      }
      completed("completed");
      return;
    }
    case "hang":
      // Stays in the turn until turn/interrupt or the process is killed.
      started();
      return;
  }
}

const handlers = {
  initialize: () => ({ userAgent: "crewyard/0.147.0 (Windows 10.0.26200; x86_64) fake", codexHome: home, platformFamily: "windows", platformOs: "windows" }),
  "account/read": () => {
    if (config.account === "none") return { account: null, requiresOpenaiAuth: true };
    if (config.account === "apiKey") return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
    return { account: { type: "chatgpt", email: "someone@example.com", planType: "plus" }, requiresOpenaiAuth: true };
  },
  "account/rateLimits/read": () => fixture("rate-limits-0.147.json"),
  "windowsSandbox/readiness": () => ({ status: config.sandbox ?? "ready" }),
  "account/logout": () => ({}),
  "account/login/start": (params) => {
    // "pending" waits for account/login/cancel, like a user who never finishes in the browser.
    if (config.login !== "pending") setTimeout(() => notify("account/login/completed", { loginId: "login-1", success: true, error: null, onboardingEntrypoint: null }), 20);
    return params.type === "chatgptDeviceCode"
      ? { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.example.test/device", userCode: "ABCD-1234" }
      : { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.example.test/authorize" };
  },
  "account/login/cancel": () => {
    setTimeout(() => notify("account/login/completed", { loginId: "login-1", success: false, error: "cancelled", onboardingEntrypoint: null }), 5);
    return { status: "canceled" };
  },
  "thread/start": () => ({ thread: { id: "thr-1" } }),
  "thread/resume": (params) => {
    if (config.resumeGone) throw Object.assign(new Error("no rollout found for thread id " + params.threadId), { rpcCode: -32600 });
    return { thread: { id: params.threadId } };
  },
  "turn/start": () => {
    turns++;
    void runTurn();
    return { turn: turn("inProgress") };
  },
  "turn/steer": () => ({ turnId: "turn-1" }),
  "review/start": () => {
    turns++;
    void runTurn();
    return { turn: turn("inProgress"), reviewThreadId: "thr-1" };
  },
  "thread/fork": (params) => {
    if (config.forkGone) throw Object.assign(new Error("no rollout found for thread id " + params.threadId), { rpcCode: -32600 });
    return { thread: { id: "thr-fork" } };
  },
  "thread/compact/start": (params) => {
    notify("thread/tokenUsage/updated", { threadId: params.threadId, turnId: "turn-c", tokenUsage: { total: usage(1000, 0), last: usage(1000, 0), modelContextWindow: null } });
    setTimeout(() => {
      notify("thread/tokenUsage/updated", { threadId: params.threadId, turnId: "turn-c", tokenUsage: { total: usage(1600, 120), last: usage(600, 120), modelContextWindow: null } });
      notify("item/completed", { threadId: params.threadId, turnId: "turn-c", completedAtMs: 1, item: { type: "contextCompaction", id: "cc-1" } });
      notify("turn/completed", { threadId: params.threadId, turn: { ...turn("completed"), id: "turn-c" } });
    }, 5);
    return {};
  },
  // History only, as in 0.147.0; "noRollback" plays a newer codex that dropped the method.
  ...(config.noRollback ? {} : { "thread/rollback": (params) => ({ thread: { id: params.threadId, turns: [] } }) }),
  "turn/interrupt": () => {
    setTimeout(() => completed("interrupted"), 5);
    return {};
  },
};

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  log({ in: msg });
  if (msg.method === undefined) {
    waiting.get(msg.id)?.(msg.result ?? { error: msg.error });
    waiting.delete(msg.id);
    return;
  }
  if (msg.id === undefined) return;
  const handler = handlers[msg.method];
  if (!handler) send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  else {
    try {
      send({ id: msg.id, result: handler(msg.params ?? {}) });
    } catch (err) {
      send({ id: msg.id, error: { code: err.rpcCode ?? -32603, message: err.message } });
    }
  }
});
rl.on("close", () => process.exit(0));
