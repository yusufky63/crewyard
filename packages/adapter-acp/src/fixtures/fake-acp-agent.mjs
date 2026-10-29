// A stand-in ACP agent for tests, built on the SDK's own agent app so the wire format is the real
// one. It behaves like a Gemini CLI that answers --version and --help, plays a scenario chosen by
// keywords in the prompt, and appends what it receives to FAKE_ACP_LOG as JSON lines.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_ACP_VERSION ?? "0.66.0"}\n`);
  process.exit(0);
}
if (argv.includes("--help")) {
  const flag = process.env.FAKE_ACP_HELP === "experimental" ? "--experimental-acp" : process.env.FAKE_ACP_HELP === "none" ? "--yolo" : "--acp";
  process.stdout.write(`Usage: gemini [options]\n\nOptions:\n  -m, --model  Model\n      ${flag}  Starts the agent in ACP mode\n`);
  process.exit(0);
}

const LOG = process.env.FAKE_ACP_LOG;
const log = (entry) => {
  if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
};
log({
  kind: "launch",
  argv,
  cwd: process.cwd(),
  home: process.env.GEMINI_CLI_HOME ?? null,
  fileStorage: process.env.GEMINI_FORCE_FILE_STORAGE ?? null,
  key: process.env.GEMINI_API_KEY ? "present" : "missing",
});

// Sessions persist in the profile folder so session/load works in a new process.
const STORE = process.env.GEMINI_CLI_HOME ? join(process.env.GEMINI_CLI_HOME, "fake-acp-sessions.json") : null;
const sessions = new Map(STORE && existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : []);
const persist = () => STORE && writeFileSync(STORE, JSON.stringify([...sessions.entries()]));
const cancels = new Map();
let authed = false;
let counter = 0;

const say = (client, sessionId, update) => client.notify(acp.methods.client.session.update, { sessionId, update });
const chunk = (client, sessionId, text) => say(client, sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const OPTIONS = [
  { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
  { optionId: "proceed_always", name: "Always allow", kind: "allow_always" },
  { optionId: "cancel", name: "Reject", kind: "reject_once" },
];

async function play(client, sessionId, text) {
  if (text.includes("basic")) {
    await say(client, sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    await chunk(client, sessionId, "Hel");
    await chunk(client, sessionId, "lo");
    await say(client, sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a.ts", kind: "read", status: "pending", rawInput: { path: "a.ts" } });
    await say(client, sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
    await say(client, sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "file body" } }] });
    await say(client, sessionId, { sessionUpdate: "plan", entries: [{ content: "Read the file", priority: "high", status: "completed" }, { content: "Fix it", priority: "medium", status: "pending" }] });
    await say(client, sessionId, { sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit a.ts", kind: "edit", status: "completed", content: [{ type: "diff", path: join(process.cwd(), "a.ts"), oldText: "a\nb", newText: "a\nc\nd" }] });
    await say(client, sessionId, { sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.01, currency: "USD" } });
    return "end_turn";
  }
  if (text.includes("approve") || text.includes("waitperm")) {
    await say(client, sessionId, { sessionUpdate: "tool_call", toolCallId: "t3", title: "dotnet test", kind: "execute", status: "pending", rawInput: { command: "dotnet test" } });
    const res = await client.request(acp.methods.client.session.requestPermission, { sessionId, toolCall: { toolCallId: "t3", title: "dotnet test" }, options: OPTIONS });
    log({ kind: "permission.outcome", outcome: res.outcome });
    if (res.outcome.outcome === "cancelled") return "cancelled";
    await chunk(client, sessionId, `outcome:${res.outcome.optionId}`);
    return "end_turn";
  }
  if (text.includes("edit")) {
    const file = text.includes("docs") ? join(process.cwd(), "docs", "guide.md") : join(process.cwd(), "src", "a.ts");
    const res = await client.request(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: { toolCallId: "t4", title: "Write file", kind: "edit", locations: [{ path: file }] },
      options: OPTIONS,
    });
    log({ kind: "permission.outcome", outcome: res.outcome });
    await chunk(client, sessionId, `edit:${res.outcome.outcome === "selected" ? res.outcome.optionId : "cancelled"}`);
    return "end_turn";
  }
  if (text.includes("slow")) {
    await chunk(client, sessionId, "working");
    await new Promise((resolve) => cancels.set(sessionId, resolve));
    return "cancelled";
  }
  if (text.includes("refuse")) return "refusal";
  if (text.includes("crash")) process.exit(4);
  await chunk(client, sessionId, "ok");
  return "end_turn";
}

const app = acp
  .agent({ name: "fake-gemini" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => {
    log({ kind: "initialize", params });
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: process.env.FAKE_ACP_LOAD !== "0" },
      authMethods: [
        { id: "oauth-personal", name: "Log in with Google", description: null },
        { id: "gemini-api-key", name: "Use Gemini API key", description: null },
      ],
    };
  })
  .onRequest(acp.methods.agent.authenticate, async ({ params }) => {
    log({ kind: "authenticate", params });
    if (params.methodId === "oauth-personal") {
      // Like Gemini CLI: print the page, wait for the browser, then cache credentials in the home folder.
      process.stderr.write("\n\nAttempting to open authentication page in your browser.\nOtherwise navigate to:\n\nhttps://accounts.google.com/o/oauth2/v2/auth?client_id=fake&state=x\n\n");
      if (process.env.FAKE_ACP_LOGIN === "pending") await new Promise(() => undefined);
      if (process.env.FAKE_ACP_LOGIN === "fail") throw new acp.RequestError(-32000, "Failed to authenticate");
      await new Promise((r) => setTimeout(r, 20));
      const dir = join(process.env.GEMINI_CLI_HOME ?? ".", ".gemini");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "oauth_creds.json"), "{}");
    }
    authed = true;
    return {};
  })
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    if (process.env.FAKE_ACP_REQUIRE_AUTH === "1" && !authed) throw acp.RequestError.authRequired();
    const sessionId = `sess-${process.pid}-${++counter}`;
    sessions.set(sessionId, { cwd: params.cwd, history: [] });
    persist();
    log({ kind: "session.new", params, sessionId });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    const s = sessions.get(params.sessionId);
    if (!s) throw acp.RequestError.invalidParams({ sessionId: params.sessionId }, "unknown session");
    log({ kind: "session.load", params });
    for (const text of s.history) await chunk(client, params.sessionId, `history:${text}`);
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    log({ kind: "prompt", sessionId: params.sessionId, text });
    const s = sessions.get(params.sessionId);
    s?.history.push(text);
    persist();
    return { stopReason: await play(client, params.sessionId, text) };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    log({ kind: "cancel", params });
    cancels.get(params.sessionId)?.();
  });

app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
