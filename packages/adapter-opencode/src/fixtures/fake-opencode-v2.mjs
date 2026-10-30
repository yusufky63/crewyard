// The 2.x half of the fake `opencode serve` (fake-opencode.mjs hands over when FAKE_OPENCODE_VERSION
// is 2.x). It speaks the subset of the 2.2.4 `/api` routes and bus events the adapter uses, as the
// generated @opencode/client 2.2.4 describes them, checks Basic auth against OPENCODE_PASSWORD, loads
// the plugins named in OPENCODE_CONFIG_CONTENT the way the adapter expects 2.x to, and plays a
// scenario chosen by keywords in the prompt. Everything it receives goes to FAKE_OPENCODE_LOG.
//
// FAKE_V2_GUARD: "skip" never loads plugins, "fail" reports the guard as failed to load.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const LOG = process.env.FAKE_OPENCODE_LOG;
const log = (entry) => {
  if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
};

const config = process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : {};
log({
  kind: "launch",
  pid: process.pid,
  argv,
  cwd: process.cwd(),
  passwordSet: Boolean(process.env.OPENCODE_PASSWORD),
  xdg: { config: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME, state: process.env.XDG_STATE_HOME, cache: process.env.XDG_CACHE_HOME },
  config,
  secret: process.env.FAKE_PROVIDER_KEY ? "present" : "missing",
});

const expectedAuth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? ""}`).toString("base64")}`;

// Plugins: each configured local package is a folder with index.js; its default export's setup()
// gets a ctx whose shell hooks run on every command, like the shell tool's environment.
const shellHooks = [];
const plugins = [];
for (const entry of config.plugins ?? []) {
  const dir = typeof entry === "string" ? entry : entry.package;
  if (process.env.FAKE_V2_GUARD === "skip") continue;
  try {
    const mod = await import(pathToFileURL(join(dir, "index.js")).href);
    const plugin = mod.default;
    await plugin.setup({ shell: { hook: (name, fn) => name === "create.before" && shellHooks.push(fn) } });
    plugins.push({ id: plugin.id, source: { type: "local", path: dir }, features: {}, state: process.env.FAKE_V2_GUARD === "fail" ? { status: "failed", error: "SyntaxError: bad plugin" } : { status: "active" } });
  } catch (err) {
    plugins.push({ source: { type: "local", path: dir }, features: {}, state: { status: "failed", error: String(err) } });
  }
}

/** What an agent's shell command would see for these names, after the plugins' hooks. */
function shellEnv(names) {
  const event = { command: "env", cwd: process.cwd(), timeout: 0, shell: "sh", env: { ...process.env } };
  for (const hook of shellHooks) hook(event);
  return Object.fromEntries(names.map((n) => [n, event.env[n] === undefined ? "unset" : event.env[n] === "" ? "blank" : "visible"]));
}

const STORE = process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "fake-sessions-v2.json") : null;
const sessions = new Map(STORE && existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")).map((s) => [s.id, { ...s, busy: false }]) : []);
const persist = () => {
  if (!STORE) return;
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify([...sessions.values()].map(({ id, title, model, permissions, messages, cost, tokens }) => ({ id, title, model, permissions, messages, cost, tokens }))));
};

const permissions = new Map();
const forms = new Map();
const waiters = new Map();
const clients = new Set();
let counter = 0;
const RUN = Math.random().toString(36).slice(2, 7);
const id = (prefix) => `${prefix}_${RUN}${String(++counter).padStart(4, "0")}`;
const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zero = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

function broadcast(type, data) {
  const frame = `data: ${JSON.stringify({ id: id("evt"), created: now(), type, data })}\n\n`;
  for (const res of clients) res.write(frame);
}

const info = (s) => ({ id: s.id, projectID: "p", cost: s.cost, tokens: s.tokens, time: { created: now(), updated: now() }, title: s.title, ...(s.model ? { model: s.model } : {}), ...(s.permissions?.length ? { permissions: s.permissions } : {}), location: { directory: process.cwd() } });

function waitFor(requestId) {
  return new Promise((resolve) => waiters.set(requestId, resolve));
}

// A prompt sent during a turn waits in the inbox and is delivered when the turn ends.
function enqueue(s, text, userID) {
  s.inbox = [...(s.inbox ?? []), { text, userID }];
  if (!s.busy) void drain(s);
}

async function drain(s) {
  s.busy = true;
  while (s.inbox?.length) {
    const { text, userID } = s.inbox.shift();
    s.messages.push({ type: "user", id: userID, time: { created: now() }, text });
    persist();
    broadcast("session.inbox.delivered", { sessionID: s.id, inboxID: userID });
    broadcast("session.execution.started", { sessionID: s.id });
    broadcast("session.status", { sessionID: s.id, status: { type: "busy" } });
    const outcome = await play(s, text);
    if (outcome === "dropped") return;
    s.messages.push({ type: "idle", id: id("msg"), time: { created: now() }, outcome: outcome.type, ...(outcome.error ? { error: outcome.error } : {}) });
    persist();
    if (outcome.type === "succeeded") broadcast("session.execution.succeeded", { sessionID: s.id });
    else if (outcome.type === "failed") broadcast("session.execution.failed", { sessionID: s.id, error: outcome.error });
    else broadcast("session.execution.interrupted", { sessionID: s.id, reason: "user" });
  }
  s.busy = false;
  broadcast("session.status", { sessionID: s.id, status: { type: "idle" } });
  broadcast("session.idle", { sessionID: s.id });
}

function step(s) {
  const msg = { type: "assistant", id: id("msg"), time: { created: now() }, agent: "build", model: s.model ?? { id: "m", providerID: "p" }, content: [] };
  s.messages.push(msg);
  broadcast("session.step.started", { sessionID: s.id, assistantMessageID: msg.id, agent: "build", model: msg.model, started: now() });
  return msg;
}

// Ordinals count text and reasoning blocks separately, as the 2.x server numbers them.
function say(s, msg, kind, chunks) {
  const ordinal = msg.content.filter((c) => c.type === kind).length;
  const block = { type: kind, text: "" };
  msg.content.push(block);
  broadcast(`session.${kind}.started`, { sessionID: s.id, assistantMessageID: msg.id, ordinal });
  for (const chunk of chunks) {
    block.text += chunk;
    broadcast(`session.${kind}.delta`, { sessionID: s.id, assistantMessageID: msg.id, ordinal, delta: chunk });
  }
  broadcast(`session.${kind}.ended`, { sessionID: s.id, assistantMessageID: msg.id, ordinal, text: block.text });
  persist();
}

function endStep(s, msg, cost, tokens) {
  msg.time.completed = now();
  msg.cost = cost;
  msg.tokens = tokens;
  s.cost += cost;
  s.tokens = { input: s.tokens.input + tokens.input, output: s.tokens.output + tokens.output, reasoning: s.tokens.reasoning + tokens.reasoning, cache: { read: s.tokens.cache.read + tokens.cache.read, write: s.tokens.cache.write + tokens.cache.write } };
  persist();
  broadcast("session.step.ended", { sessionID: s.id, assistantMessageID: msg.id, finish: "stop", cost, tokens });
  broadcast("session.usage.updated", { sessionID: s.id, cost: s.cost, tokens: s.tokens });
}

function tool(s, msg, name, input) {
  const callID = id("call");
  const item = { type: "tool", id: callID, name, state: { status: "streaming", input: "" }, time: { created: now() } };
  msg.content.push(item);
  broadcast("session.tool.input.started", { sessionID: s.id, assistantMessageID: msg.id, id: callID, name });
  item.state = { status: "running", input, metadata: {} };
  broadcast("session.tool.called", { sessionID: s.id, assistantMessageID: msg.id, id: callID, input, executed: true });
  return {
    callID,
    done(text) {
      item.state = { status: "completed", input, content: [{ type: "text", text }] };
      persist();
      broadcast("session.tool.success", { sessionID: s.id, assistantMessageID: msg.id, id: callID, content: [{ type: "text", text }], executed: true });
    },
    failed(message) {
      item.state = { status: "error", input, error: { type: "ToolError", message } };
      persist();
      broadcast("session.tool.failed", { sessionID: s.id, assistantMessageID: msg.id, id: callID, error: { type: "ToolError", message }, executed: true });
    },
  };
}

function ask(s, action, resources, metadata, source) {
  const req = { id: id("per"), sessionID: s.id, action, resources, metadata, ...(source ? { source } : {}) };
  permissions.set(req.id, req);
  broadcast("permission.asked", req);
  return waitFor(req.id);
}

async function play(s, prompt) {
  const ok = { type: "succeeded" };
  const msg = step(s);
  if (prompt.includes("basic")) {
    say(s, msg, "reasoning", ["thinking"]);
    say(s, msg, "text", ["Hel", "lo"]);
    const t = tool(s, msg, "shell", { command: "ls" });
    t.done("ok");
    endStep(s, msg, 0.0123, { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } });
  } else if (prompt.includes("approve")) {
    const t = tool(s, msg, "shell", { command: "dotnet test" });
    const reply = await ask(s, "shell", ["dotnet test"], { command: "dotnet test" }, { type: "tool", messageID: msg.id, id: t.callID });
    if (reply.decision === "reject") t.failed("rejected");
    else t.done("passed");
    say(s, msg, "text", [`shell:${reply.decision}`]);
  } else if (prompt.includes("edit")) {
    const reply = await ask(s, "edit", ["src/a.ts"], { filepath: "src/a.ts" });
    say(s, msg, "text", [`edit:${reply.decision}`]);
  } else if (prompt.includes("question")) {
    const form = {
      id: id("frm"),
      sessionID: s.id,
      title: "Which database?",
      fields: [{ key: "db", type: "string", options: [{ value: "sqlite", label: "SQLite", description: "local file" }, { value: "pg", label: "Postgres", description: "server" }], custom: true }],
    };
    forms.set(form.id, form);
    broadcast("form.created", { form });
    const reply = await waitFor(form.id);
    say(s, msg, "text", [reply.cancelled ? "question:cancelled" : `answer:${JSON.stringify(reply.answer)}`]);
  } else if (prompt.includes("envcheck")) {
    // What `echo $NAME` in the agent's shell would print, per name.
    say(s, msg, "text", [JSON.stringify(shellEnv(["FAKE_PROVIDER_KEY", "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "OPENCODE_CONFIG_CONTENT"]))]);
  } else if (prompt.includes("reconnect")) {
    say(s, msg, "reasoning", ["hmm"]);
    say(s, msg, "text", ["part1"]);
    await sleep(50);
    for (const res of clients) res.destroy();
    clients.clear();
    msg.content[1].text = "part1 part2";
    msg.time.completed = now();
    s.cost += 0.5;
    s.tokens = { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } };
    msg.tokens = s.tokens;
    s.messages.push({ type: "idle", id: id("msg"), time: { created: now() }, outcome: "succeeded" });
    s.busy = false;
    persist();
    log({ kind: "dropped" });
    return "dropped";
  } else if (prompt.includes("slow")) {
    say(s, msg, "text", ["working"]);
    await new Promise((resolve) => (s.onInterrupt = resolve));
    return { type: "interrupted" };
  } else if (prompt.includes("structured")) {
    const good = { verdict: "pass", summary: "Fine.", comments: [] };
    say(s, msg, "text", [prompt.includes("fix") && !prompt.includes("did not match") ? `\`\`\`json\n${JSON.stringify({ verdict: "maybe" })}\n\`\`\`` : `Done.\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``]);
  } else if (prompt.includes("did not match")) {
    say(s, msg, "text", [`\`\`\`json\n${JSON.stringify({ verdict: "pass", summary: "Fine.", comments: [] })}\n\`\`\``]);
  } else if (prompt.includes("fail")) {
    return { type: "failed", error: { type: "ProviderRequestError", message: "invalid key", status: 401 } };
  } else if (prompt.includes("crash")) {
    process.stderr.write(`fatal: lost the database\nserver password ${process.env.OPENCODE_PASSWORD}\n`);
    process.exit(3);
  } else {
    say(s, msg, "text", ["ok"]);
  }
  return ok;
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, value) {
  if (status === 204) {
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

const notFound = (res, tag, message) => json(res, 404, { _tag: tag, message });

const server = createServer(async (req, res) => {
  if (req.headers.authorization !== expectedAuth) return json(res, 401, { _tag: "UnauthorizedError", message: "unauthorized" });
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;
  const parts = path.split("/").filter(Boolean);
  log({ kind: "request", method: req.method, path, query: Object.fromEntries(url.searchParams) });
  if (parts[0] !== "api") return notFound(res, "NotFound", `no route ${path}`);

  if (req.method === "GET" && path === "/api/event") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ id: id("evt"), type: "server.connected", data: {} })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.method === "GET" && path === "/api/plugin") return json(res, 200, { location: { directory: process.cwd() }, data: plugins });
  if (req.method === "GET" && path === "/api/session/active") {
    const out = {};
    for (const s of sessions.values()) if (s.busy) out[s.id] = { type: "running" };
    return json(res, 200, { data: out });
  }
  if (req.method === "POST" && path === "/api/session") {
    const b = await body(req);
    const s = { id: id("ses"), title: b.title, model: b.model ?? null, permissions: b.permissions ?? [], messages: [], busy: false, cost: 0, tokens: zero() };
    sessions.set(s.id, s);
    persist();
    log({ kind: "session.create", body: b });
    return json(res, 200, { data: info(s) });
  }
  if (parts[1] === "session" && parts[2]) {
    const s = sessions.get(parts[2]);
    if (!s) return notFound(res, "SessionNotFoundError", `Session not found: ${parts[2]}`);
    const sub = parts.slice(3);
    if (req.method === "GET" && sub.length === 0) return json(res, 200, { data: info(s) });
    if (req.method === "PATCH" && sub.length === 0) {
      const b = await body(req);
      log({ kind: "session.update", session: s.id, body: b });
      if (b.permissions) s.permissions = b.permissions;
      persist();
      return json(res, 204);
    }
    if (req.method === "POST" && sub[0] === "model") {
      const b = await body(req);
      log({ kind: "model", session: s.id, body: b });
      s.model = b.model;
      persist();
      return json(res, 204);
    }
    if (req.method === "GET" && sub[0] === "message") {
      // Two pages when long enough, so the client follows the cursor.
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const size = 3;
      const page = s.messages.slice(start, start + size);
      const next = start + size < s.messages.length ? String(start + size) : null;
      return json(res, 200, { data: page, cursor: { next } });
    }
    if (req.method === "POST" && sub[0] === "prompt") {
      const b = await body(req);
      log({ kind: "prompt", session: s.id, body: b });
      const userID = id("msg");
      json(res, 200, { data: { id: userID, sessionID: s.id, time: { created: now() }, type: "user", payload: { text: b.text }, delivery: b.delivery ?? "steer" } });
      enqueue(s, b.text, userID);
      return;
    }
    if (req.method === "POST" && sub[0] === "interrupt") {
      log({ kind: "interrupt", session: s.id });
      s.onInterrupt?.();
      await sleep(20);
      return json(res, 200, { interrupted: true });
    }
    if (req.method === "POST" && sub[0] === "revert") {
      const b = sub[1] === "stage" ? await body(req) : {};
      log({ kind: `revert.${sub[1]}`, session: s.id, body: b });
      if (sub[1] === "stage") {
        if (!s.messages.some((m) => m.id === b.messageID)) return json(res, 400, { _tag: "InvalidRequestError", message: "no such message" });
        s.revert = { messageID: b.messageID };
        persist();
        return json(res, 200, { data: { messageID: b.messageID } });
      }
      return json(res, 204);
    }
    if (req.method === "GET" && sub[0] === "permission") return json(res, 200, { data: [...permissions.values()].filter((p) => p.sessionID === s.id) });
    if (req.method === "POST" && sub[0] === "permission" && sub[2] === "reply") {
      const b = await body(req);
      const p = permissions.get(sub[1]);
      if (!p) return notFound(res, "PermissionNotFoundError", "no such permission");
      permissions.delete(sub[1]);
      log({ kind: "permission.reply", id: sub[1], body: b });
      broadcast("permission.replied", { sessionID: s.id, requestID: p.id, reply: b.decision });
      waiters.get(sub[1])?.(b);
      return json(res, 204);
    }
    if (req.method === "GET" && sub[0] === "form") return json(res, 200, { data: [...forms.values()].filter((f) => f.sessionID === s.id) });
    if (sub[0] === "form" && sub[1]) {
      const f = forms.get(sub[1]);
      if (!f) return notFound(res, "FormNotFoundError", "no such form");
      forms.delete(sub[1]);
      if (req.method === "POST" && sub[2] === "reply") {
        const b = await body(req);
        log({ kind: "form.reply", id: sub[1], body: b });
        broadcast("form.replied", { id: f.id, sessionID: s.id, answer: b.answer });
        waiters.get(sub[1])?.(b);
        return json(res, 204);
      }
      if (req.method === "DELETE") {
        log({ kind: "form.cancel", id: sub[1] });
        broadcast("form.cancelled", { id: f.id, sessionID: s.id });
        waiters.get(sub[1])?.({ cancelled: true });
        return json(res, 204);
      }
    }
  }
  return notFound(res, "NotFound", `no route ${req.method} ${path}`);
});

server.listen(0, "127.0.0.1", () => {
  // 2.x prints its password too; the adapter must keep it out of every message.
  process.stdout.write(`server listening on http://127.0.0.1:${server.address().port}\nserver password ${process.env.OPENCODE_PASSWORD}\n`);
});
