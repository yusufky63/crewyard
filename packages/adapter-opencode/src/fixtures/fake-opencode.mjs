// A stand-in for `opencode serve`, used only by tests. It speaks the subset of the 1.19.5 HTTP + SSE
// API the adapter uses, checks Basic auth, and plays a scenario chosen by keywords in the prompt.
// Everything it receives is appended as JSON lines to FAKE_OPENCODE_LOG so tests can assert on it.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:http";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_OPENCODE_VERSION ?? "1.19.5"}\n`);
  process.exit(0);
}
// 2.x speaks another API; its half of the fake lives next to this one.
if (Number((process.env.FAKE_OPENCODE_VERSION ?? "1").split(".")[0]) >= 2) {
  await import("./fake-opencode-v2.mjs");
} else {
  await runV1();
}

async function runV1() {

  const LOG = process.env.FAKE_OPENCODE_LOG;
  const log = (entry) => {
    if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
  };
  log({
    kind: "launch",
    pid: process.pid,
    argv,
    cwd: process.cwd(),
    passwordSet: Boolean(process.env.OPENCODE_SERVER_PASSWORD),
    xdg: {
      config: process.env.XDG_CONFIG_HOME,
      data: process.env.XDG_DATA_HOME,
      state: process.env.XDG_STATE_HOME,
      cache: process.env.XDG_CACHE_HOME,
    },
    inheritedOpencode: Object.keys(process.env).filter((k) => /^OPENCODE_/i.test(k) && k !== "OPENCODE_SERVER_PASSWORD" && k !== "OPENCODE_DISABLE_AUTOUPDATE" && k !== "OPENCODE_DISABLE_CLAUDE_CODE"),
    secret: process.env.FAKE_PROVIDER_KEY ? "present" : "missing",
  });

  const expectedAuth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD ?? ""}`).toString("base64")}`;
  // Sessions persist in the profile's data folder, like opencode.db, so resume works across launches.
  const STORE = process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "fake-sessions.json") : null;
  const sessions = new Map(STORE && existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")).map((s) => [s.id, { ...s, status: "idle", queued: 0 }]) : []);
  // `opencode export <session>`: the session as JSON on stdout, read from the same store.
  if (argv[0] === "export") {
    const found = sessions.get(argv[1]);
    if (!found) {
      process.stderr.write(`Session not found: ${argv[1]}\n`);
      process.exit(1);
    }
    log({ kind: "export", session: argv[1], data: process.env.XDG_DATA_HOME });
    process.stderr.write(`Exporting session: ${argv[1]}\n`);
    // Like the real export: no permission rules in the record.
    process.stdout.write(JSON.stringify({ info: { id: found.id, title: found.title }, messages: found.messages }));
    process.exit(0);
  }
  const persist = () => {
    if (!STORE) return;
    // Like OpenCode, which creates its data folder on first use.
    mkdirSync(dirname(STORE), { recursive: true });
    writeFileSync(STORE, JSON.stringify([...sessions.values()].map(({ id, title, permission, messages }) => ({ id, title, permission, messages }))));
  };
  // `opencode import <file>`: same id; existing messages are kept, missing ones added.
  if (argv[0] === "import") {
    if (!existsSync(argv[1])) {
      process.stderr.write(`\u001b[91m\u001b[1mError: \u001b[0mFile not found: ${argv[1]}\n`);
      process.exit(1);
    }
    const data = JSON.parse(readFileSync(argv[1], "utf8"));
    const existing = sessions.get(data.info.id);
    const known = new Set(existing?.messages.map((m) => m.info.id) ?? []);
    sessions.set(data.info.id, { id: data.info.id, title: data.info.title, permission: existing?.permission ?? [], messages: [...(existing?.messages ?? []), ...data.messages.filter((m) => !known.has(m.info.id))] });
    persist();
    log({ kind: "import", session: data.info.id, data: process.env.XDG_DATA_HOME, file: argv[1], cwd: process.cwd() });
    process.stdout.write(`Imported session: ${data.info.id}\n`);
    process.exit(0);
  }
  const permissions = new Map();
  const questions = new Map();
  const waiters = new Map();
  const clients = new Set();
  let counter = 0;
  // Unique across launches too: a fork in another profile must not reuse an imported id.
  const RUN = Math.random().toString(36).slice(2, 7);
  const id = (prefix) => `${prefix}_${RUN}${String(++counter).padStart(4, "0")}`;
  const now = () => Date.now();

  function broadcast(type, properties) {
    const frame = `data: ${JSON.stringify({ id: id("evt"), type, properties })}\n\n`;
    for (const res of clients) res.write(frame);
  }

  function setStatus(session, type) {
    session.status = type;
    broadcast("session.status", { sessionID: session.id, status: { type } });
    if (type === "idle") broadcast("session.idle", { sessionID: session.id });
  }

  function message(session, info) {
    const existing = session.messages.find((m) => m.info.id === info.id);
    if (existing) existing.info = info;
    else session.messages.push({ info, parts: [] });
    persist();
    broadcast("message.updated", { sessionID: session.id, info });
    return info;
  }

  function part(session, p) {
    const msg = session.messages.find((m) => m.info.id === p.messageID);
    const i = msg.parts.findIndex((x) => x.id === p.id);
    if (i >= 0) msg.parts[i] = p;
    else msg.parts.push(p);
    persist();
    broadcast("message.part.updated", { sessionID: session.id, part: p, time: now() });
    return p;
  }

  function delta(session, p, text) {
    p.text += text;
    broadcast("message.part.delta", { sessionID: session.id, messageID: p.messageID, partID: p.id, field: "text", delta: text });
  }

  const zeroTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

  function assistant(session, parentID) {
    return message(session, {
      id: id("msg"),
      sessionID: session.id,
      role: "assistant",
      time: { created: now() },
      parentID,
      modelID: "m",
      providerID: "p",
      mode: "build",
      agent: "build",
      path: { cwd: process.cwd(), root: process.cwd() },
      cost: 0,
      tokens: zeroTokens(),
    });
  }

  function text(session, messageID, value) {
    return part(session, { id: id("prt"), sessionID: session.id, messageID, type: "text", text: value });
  }

  function waitFor(requestId) {
    return new Promise((resolve) => waiters.set(requestId, resolve));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Like OpenCode, prompts sent while busy queue behind the running turn and idle comes once at the end.
  function enqueue(session, prompt, userID) {
    session.queued++;
    if (session.queued === 1) setStatus(session, "busy");
    session.chain = (session.chain ?? Promise.resolve()).then(async () => {
      const finished = await play(session, prompt, userID);
      session.queued--;
      if (finished && session.queued === 0) setStatus(session, "idle");
    });
  }

  async function play(session, prompt, userID) {
    const a = assistant(session, userID);
    const sid = session.id;

    if (prompt.includes("basic")) {
      part(session, { id: id("prt"), sessionID: sid, messageID: a.id, type: "reasoning", text: "thinking", time: { start: now() } });
      const t = text(session, a.id, "");
      delta(session, t, "Hel");
      delta(session, t, "lo");
      part(session, t);
      const tool = { id: id("prt"), sessionID: sid, messageID: a.id, type: "tool", callID: "call_1", tool: "bash", state: { status: "pending", input: { command: "ls" }, raw: "" } };
      part(session, tool);
      part(session, { ...tool, state: { status: "running", input: { command: "ls" }, title: "List files", time: { start: now() } } });
      part(session, { ...tool, state: { status: "completed", input: { command: "ls" }, output: "ok", title: "List files", metadata: {}, time: { start: now(), end: now() } } });
      broadcast("todo.updated", { sessionID: sid, todos: [{ content: "Write code", status: "in_progress", priority: "high" }, { content: "Dropped", status: "cancelled", priority: "low" }] });
      broadcast("session.diff", { sessionID: sid, diff: [{ file: "src/a.ts", additions: 3, deletions: 1 }] });
      message(session, { ...a, time: { created: a.time.created, completed: now() }, cost: 0.0123, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } } });
    } else if (prompt.includes("approve")) {
      const tool = { id: id("prt"), sessionID: sid, messageID: a.id, type: "tool", callID: "call_2", tool: "bash", state: { status: "pending", input: { command: "dotnet test" }, raw: "" } };
      part(session, tool);
      const req = { id: id("per"), sessionID: sid, permission: "bash", patterns: ["dotnet test"], metadata: { command: "dotnet test" }, always: ["dotnet *"], tool: { messageID: a.id, callID: "call_2" } };
      permissions.set(req.id, req);
      broadcast("permission.asked", req);
      const reply = await waitFor(req.id);
      if (reply.reply === "reject") part(session, { ...tool, state: { status: "error", input: tool.state.input, error: "rejected", time: { start: now(), end: now() } } });
      else part(session, { ...tool, state: { status: "completed", input: tool.state.input, output: "passed", title: "dotnet test", metadata: {}, time: { start: now(), end: now() } } });
      text(session, a.id, `bash:${reply.reply}`);
    } else if (prompt.includes("edit")) {
      const req = { id: id("per"), sessionID: sid, permission: "edit", patterns: ["src/a.ts"], metadata: { filepath: "src/a.ts" }, always: ["*"] };
      permissions.set(req.id, req);
      broadcast("permission.asked", req);
      const reply = await waitFor(req.id);
      text(session, a.id, `edit:${reply.reply}`);
    } else if (prompt.includes("question")) {
      const req = { id: id("que"), sessionID: sid, questions: [{ question: "Which database?", header: "DB", options: [{ label: "sqlite", description: "local file" }, { label: "postgres", description: "server" }] }] };
      questions.set(req.id, req);
      broadcast("question.asked", req);
      const reply = await waitFor(req.id);
      text(session, a.id, reply.rejected ? "question:rejected" : `answers:${JSON.stringify(reply.answers)}`);
    } else if (prompt.includes("reconnect")) {
      const t = text(session, a.id, "part1");
      await sleep(50);
      // Drop every subscriber, then finish the turn while nobody listens: only a resync can see it.
      for (const res of clients) res.destroy();
      clients.clear();
      const msg = session.messages.find((m) => m.info.id === a.id);
      msg.parts[msg.parts.indexOf(t)] = { ...t, text: "part1 part2" };
      msg.info = { ...a, time: { created: a.time.created, completed: now() }, cost: 0.5, tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } };
      persist();
      session.status = "idle";
      session.queued = 0;
      log({ kind: "dropped" });
      return false;
    } else if (prompt.includes("slow")) {
      text(session, a.id, "working");
      await new Promise((resolve) => (session.onAbort = resolve));
      message(session, { ...a, time: { created: a.time.created, completed: now() }, error: { name: "MessageAbortedError", data: { message: "aborted" } } });
    } else if (prompt.includes("refused")) {
      // A provider that rejects the forced tool choice behind `format`, as DeepSeek thinking models do.
      const done = { ...a, time: { created: a.time.created, completed: now() } };
      if (session.lastFormat) message(session, { ...done, error: { name: "APIError", data: { message: "Thinking mode does not support this tool_choice", isRetryable: false } } });
      else {
        text(session, a.id, `Here is my review:\n\`\`\`json\n${JSON.stringify({ verdict: "pass", summary: "Fine.", comments: [] })}\n\`\`\``);
        message(session, done);
      }
    } else if (prompt.includes("structured") || prompt.includes("did not match")) {
      // "structured ok" answers at once, "structured fix" only after the retry, "structured stubborn"
      // ends both turns with OpenCode's own StructuredOutputError.
      const retry = prompt.includes("did not match");
      if (!retry) session.scenario = prompt;
      const sc = session.scenario ?? "";
      const good = { verdict: "pass", summary: "Fine.", comments: [] };
      const done = { ...a, time: { created: a.time.created, completed: now() } };
      if (sc.includes("stubborn")) message(session, { ...done, error: { name: "StructuredOutputError", data: { message: "Model did not produce structured output", retries: 2 } } });
      else message(session, { ...done, structured: sc.includes("fix") && !retry ? { verdict: "maybe" } : good });
    } else if (prompt.includes("fail")) {
      broadcast("session.error", { sessionID: sid, error: { name: "APIError", data: { message: "invalid key", isRetryable: false } } });
    } else if (prompt.includes("crash")) {
      process.exit(3);
    } else if (prompt.includes("shutdown")) {
      // The status Windows gives children it ends at sign-out or restart.
      process.exit(0x40010004);
    } else {
      text(session, a.id, "ok");
    }
    return true;
  }

  async function body(req) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
  }

  function json(res, status, value) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(value === undefined ? "" : JSON.stringify(value));
  }

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== expectedAuth) return json(res, 401, { error: "unauthorized" });
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    const parts = path.split("/").filter(Boolean);
    log({ kind: "request", method: req.method, path, directory: url.searchParams.get("directory") ?? (req.headers["x-opencode-directory"] ? decodeURIComponent(String(req.headers["x-opencode-directory"])) : null) });

    if (req.method === "GET" && path === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ id: id("evt"), type: "server.connected", properties: {} })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST" && path === "/session") {
      const b = await body(req);
      const s = { id: id("ses"), title: b.title, permission: b.permission ?? [], messages: [], status: "idle", queued: 0 };
      sessions.set(s.id, s);
      persist();
      log({ kind: "session.create", body: b });
      return json(res, 200, { id: s.id, slug: "fake", projectID: "p", directory: process.cwd(), title: s.title, version: "1.19.5", time: { created: now(), updated: now() }, permission: s.permission });
    }
    if (req.method === "GET" && path === "/session/status") {
      const out = {};
      for (const s of sessions.values()) if (s.status !== "idle") out[s.id] = { type: s.status };
      return json(res, 200, out);
    }
    if (parts[0] === "session" && parts[1]) {
      const s = sessions.get(parts[1]);
      if (!s) return json(res, 404, { name: "NotFoundError", data: { message: "no such session" } });
      const info = () => ({ id: s.id, slug: "fake", projectID: "p", directory: process.cwd(), title: s.title, version: "1.19.5", time: { created: now(), updated: now() }, ...(s.permission?.length ? { permission: s.permission } : {}) });
      if (req.method === "GET" && parts.length === 2) return json(res, 200, info());
      if (req.method === "PATCH" && parts.length === 2) {
        const b = await body(req);
        log({ kind: "session.update", session: s.id, body: b });
        if (b.permission) s.permission = [...(s.permission ?? []), ...b.permission];
        persist();
        return json(res, 200, info());
      }
      if (req.method === "POST" && parts[2] === "fork") {
        const f = { id: id("ses"), title: `${s.title} (fork #1)`, permission: [], messages: [], status: "idle", queued: 0 };
        const ids = new Map();
        for (const m of s.messages) {
          const mid = id("msg");
          ids.set(m.info.id, mid);
          const parentID = m.info.parentID ? (ids.get(m.info.parentID) ?? m.info.parentID) : undefined;
          f.messages.push({ info: { ...m.info, id: mid, sessionID: f.id, ...(parentID ? { parentID } : {}) }, parts: m.parts.map((p) => ({ ...p, id: id("prt"), messageID: mid, sessionID: f.id })) });
        }
        sessions.set(f.id, f);
        persist();
        log({ kind: "fork", session: s.id, forked: f.id, data: process.env.XDG_DATA_HOME });
        return json(res, 200, { id: f.id, slug: "fake", projectID: "p", directory: process.cwd(), title: f.title, version: "1.19.5", time: { created: now(), updated: now() } });
      }
      if (req.method === "POST" && parts[2] === "summarize") {
        const b = await body(req);
        log({ kind: "summarize", session: s.id, body: b });
        // FAKE_SUMMARIZE: "hang" never answers, "error" ends the compaction like a context overflow.
        if (process.env.FAKE_SUMMARIZE === "hang") return;
        const user = message(s, { id: id("msg"), sessionID: s.id, role: "user", time: { created: now() }, agent: "build", model: { providerID: b.providerID, modelID: b.modelID } });
        part(s, { id: id("prt"), sessionID: s.id, messageID: user.id, type: "compaction", auto: Boolean(b.auto) });
        const a = message(s, { id: id("msg"), sessionID: s.id, role: "assistant", time: { created: now() }, parentID: user.id, modelID: b.modelID, providerID: b.providerID, mode: "compaction", agent: "compaction", summary: true, path: { cwd: process.cwd(), root: process.cwd() }, cost: 0, tokens: zeroTokens() });
        if (process.env.FAKE_SUMMARIZE === "error") {
          message(s, { ...a, time: { created: a.time.created, completed: now() }, finish: "error", error: { name: "ContextOverflowError", data: { message: "Session too large to compact" } } });
        } else {
          text(s, a.id, "Summary: the user asked for a greeting.");
          message(s, { ...a, time: { created: a.time.created, completed: now() }, finish: "stop", cost: 0.001, tokens: { input: 40, output: 8, reasoning: 0, cache: { read: 4, write: 0 } } });
        }
        return json(res, 200, true);
      }
      if (req.method === "GET" && parts[2] === "message") return json(res, 200, s.messages);
      if (req.method === "POST" && parts[2] === "prompt_async") {
        const b = await body(req);
        log({ kind: "prompt", session: s.id, body: b });
        s.lastFormat = b.format?.type === "json_schema" ? b.format : null;
        const user = message(s, { id: id("msg"), sessionID: s.id, role: "user", time: { created: now() }, agent: "build", model: b.model ?? { providerID: "p", modelID: "m" } });
        const prompt = b.parts?.map((p) => p.text).join("\n") ?? "";
        part(s, { id: id("prt"), sessionID: s.id, messageID: user.id, type: "text", text: prompt });
        json(res, 204);
        enqueue(s, prompt, user.id);
        return;
      }
      if (req.method === "POST" && parts[2] === "revert") {
        const b = await body(req);
        log({ kind: "revert", session: s.id, body: b });
        const at = s.messages.findIndex((m) => m.info.id === b.messageID);
        if (at < 0) return json(res, 400, { name: "BadRequestError", data: { message: "no such message" } });
        s.revert = { messageID: b.messageID };
        persist();
        return json(res, 200, { id: s.id, slug: "fake", projectID: "p", directory: process.cwd(), title: s.title, version: "1.19.5", time: { created: now(), updated: now() }, revert: s.revert });
      }
      if (req.method === "POST" && parts[2] === "abort") {
        log({ kind: "abort", session: s.id });
        // The real server publishes the aborted turn's idle before it answers the abort request.
        s.onAbort?.();
        await sleep(20);
        return json(res, 200, true);
      }
    }
    if (req.method === "GET" && path === "/permission") return json(res, 200, [...permissions.values()]);
    if (req.method === "GET" && path === "/question") return json(res, 200, [...questions.values()]);
    if (req.method === "POST" && parts[0] === "permission" && parts[2] === "reply") {
      const b = await body(req);
      const p = permissions.get(parts[1]);
      if (!p) return json(res, 404, { name: "NotFoundError", data: { message: "no such permission" } });
      permissions.delete(parts[1]);
      log({ kind: "permission.reply", id: parts[1], body: b });
      broadcast("permission.replied", { sessionID: p.sessionID, requestID: p.id, reply: b.reply });
      waiters.get(parts[1])?.(b);
      return json(res, 200, true);
    }
    if (req.method === "POST" && parts[0] === "question" && (parts[2] === "reply" || parts[2] === "reject")) {
      const b = parts[2] === "reply" ? await body(req) : { rejected: true };
      const q = questions.get(parts[1]);
      if (!q) return json(res, 404, { name: "NotFoundError", data: { message: "no such question" } });
      questions.delete(parts[1]);
      log({ kind: `question.${parts[2]}`, id: parts[1], body: b });
      broadcast(parts[2] === "reply" ? "question.replied" : "question.rejected", { sessionID: q.sessionID, requestID: q.id, answers: b.answers ?? [] });
      waiters.get(parts[1])?.(b);
      return json(res, 200, true);
    }
    return json(res, 404, { name: "NotFoundError", data: { message: `no route ${req.method} ${path}` } });
  });

  server.listen(0, "127.0.0.1", () => {
    process.stdout.write(`opencode server listening on http://127.0.0.1:${server.address().port}\n`);
  });
}
