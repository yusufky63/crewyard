// A stand-in for `codex app-server`, used only by adapter.test.ts. It speaks the same JSONL
// JSON-RPC, reads its scenario from $CODEX_HOME/fake.json and appends every message it receives
// to $CODEX_HOME/fake-log.jsonl so tests can check what the adapter sent.

import { appendFileSync, readFileSync } from "node:fs";
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

log({ env: { CODEX_HOME: home, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null, CREWYARD_TEST_SECRET: process.env.CREWYARD_TEST_SECRET ?? null }, cwd: process.cwd() });

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
  "thread/resume": (params) => ({ thread: { id: params.threadId } }),
  "turn/start": () => {
    turns++;
    void runTurn();
    return { turn: turn("inProgress") };
  },
  "turn/steer": () => ({ turnId: "turn-1" }),
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
  else send({ id: msg.id, result: handler(msg.params ?? {}) });
});
rl.on("close", () => process.exit(0));
