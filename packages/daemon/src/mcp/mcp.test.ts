import { connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import type { FakeStep } from "@crewyard/adapter-fake";
import { REPORT_LIMITS, type McpServerSpec } from "@crewyard/core";
import { start } from "@crewyard/proc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store.ts";
import { AdapterRegistry } from "../orchestrator/adapters.ts";
import { Orchestrator } from "../orchestrator/orchestrator.ts";
import { CANDIDATES, cleanTemps, ScriptedAdapter, tempDir, tempRepo, waitFor } from "../orchestrator/testing.ts";
import { SecretStore } from "../providers/secrets.ts";
import { pipePath } from "./pipe.ts";
import { PIPE_ENV, TICKET_ENV } from "./relay.ts";
import { McpServerStore } from "./servers.ts";
import { McpService } from "./service.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const plain = { protect: async (b: Buffer) => Buffer.from(b), unprotect: async (b: Buffer) => Buffer.from(b) };

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
  cleanTemps();
});

const running: FakeStep = { emit: { type: "run.state", state: "running" } };
/** Keeps the run live until the test answers "hold". */
const hold: FakeStep[] = [running, { emit: { type: "request.question", requestId: "hold", questions: [{ prompt: "hold", options: [{ label: "go" }], allowFreeText: false }] } }, { awaitAnswer: "hold" }];

async function setup(opts: { toolFilter?: boolean; mcp?: boolean } = {}) {
  const root = tempDir("crewyard mcp-");
  const repo = await tempRepo(root);
  const store = new Store(join(root, "t.db"));
  const project = store.addProject(repo, "demo repo");
  const adapter = new ScriptedAdapter(() => hold, { capabilities: { mcp: opts.mcp === false ? undefined : { toolFilter: opts.toolFilter ?? true } } });
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const topics: Array<{ topic: string; payload: unknown }> = [];
  const emit = (topic: string, payload: unknown) => topics.push({ topic, payload });
  const o = new Orchestrator({ store, dataDir: join(root, "data"), emit, adapters, directory: { candidates: () => CANDIDATES(), envFor: () => ({}) }, tickMs: 0, freeMemoryMb: () => 64_000, stopTimeoutMs: 2_000 });
  const servers = new McpServerStore(store.db, new SecretStore(join(root, "data"), plain));
  const mcp = new McpService({
    store,
    servers,
    emit,
    pipePath: pipePath(),
    resolve: async (command, args) => ({ ok: true, command: `C:\\tools\\${command}.exe`, args, env: {} }),
    host: {
      run: (id) => {
        try {
          return o.db.run(id);
        } catch {
          return null;
        }
      },
      task: (id) => o.db.task(id),
      propose: (p) => o.propose(p),
      message: (runId, text, seen) => o.message(runId, text, seen),
    },
  });
  o.setMcp(mcp);
  o.start();
  open.push(async () => {
    o.shutdown();
    await o.settle();
    await mcp.close();
    store.close();
  });
  return { o, store, project, adapter, mcp, servers, topics, repo };
}

/** Starts a research task (one read-only step) and waits for its run to be live. */
async function startRun(s: Awaited<ReturnType<typeof setup>>) {
  const draft = await s.o.propose({ projectId: s.project.id, title: "Research how the cache expires", kind: "research", size: "S" });
  await s.o.approve({ taskId: draft.id });
  await s.o.tick();
  const started = await waitFor(() => s.adapter.started[0]);
  const run = await waitFor(() => s.o.get(draft.id).runs.find((r) => r.state !== "ended" && s.o.requests({ taskId: draft.id }).length > 0));
  return { taskId: draft.id, runId: run.id, req: started.req };
}

const reportSpec = (req: { mcpServers?: McpServerSpec[] }) => {
  const spec = req.mcpServers?.find((m) => m.builtin);
  if (!spec) throw new Error("no report server");
  return spec;
};

/** What the PowerShell relay does, in Node: hello line, then MCP JSON-RPC lines. */
async function client(path: string, ticket: string) {
  const socket: Socket = netConnect(path);
  await new Promise<void>((r, j) => socket.once("connect", r).once("error", j));
  const closed = new Promise<void>((r) => socket.once("close", () => r()));
  socket.on("error", () => undefined);
  let buf = "";
  const waiting = new Map<number, (v: Record<string, unknown>) => void>();
  socket.setEncoding("utf8").on("data", (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      buf = buf.slice(nl + 1);
      waiting.get(msg.id as number)?.(msg);
    }
  });
  socket.write(`${JSON.stringify({ crewyard: 1, ticket })}\n`);
  let id = 0;
  const request = (method: string, params: unknown = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const n = ++id;
      waiting.set(n, resolve);
      closed.then(() => reject(new Error("closed")));
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
  const call = async (name: string, args: unknown) => (await request("tools/call", { name, arguments: args })).result as { content: Array<{ text: string }>; isError: boolean };
  return { socket, closed, request, call };
}

describe("report server", () => {
  it("gives every run the report server with its own ticket in the server's env only", async () => {
    const s = await setup();
    const { req } = await startRun(s);
    const spec = reportSpec(req);
    expect(spec.name).toBe("crewyard");
    expect(spec.command.toLowerCase()).toMatch(/powershell\.exe$/);
    expect(spec.args).toContain("-EncodedCommand");
    expect(spec.env[TICKET_ENV]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The ticket never reaches the runner's own env, so the agent's shell commands do not see it.
    expect(Object.values(req.env)).not.toContain(spec.env[TICKET_ENV]);
    expect(spec.args.join(" ")).not.toContain(spec.env[TICKET_ENV]);
  });

  it("gives no servers to a runner without the MCP capability", async () => {
    const s = await setup({ mcp: false });
    const { req } = await startRun(s);
    expect(req.mcpServers).toBeUndefined();
  });

  it("speaks MCP on the pipe and turns needs_input into an Inbox item and a timeline event", async () => {
    const s = await setup();
    const { req, taskId, runId } = await startRun(s);
    const spec = reportSpec(req);
    const c = await client(spec.env[PIPE_ENV]!, spec.env[TICKET_ENV]!);
    const init = (await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).result as Record<string, unknown>;
    expect(init.protocolVersion).toBe("2025-06-18");
    const tools = ((await c.request("tools/list")).result as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(["report", "propose_followup"]);
    expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);

    const res = await c.call("report", { kind: "needs_input", text: "Which <b>region</b> should the cache use?", artifacts: ["notes/cache.md"] });
    expect(res.isError).toBe(false);
    const items = s.mcp.reports.list({ projectId: s.project.id });
    expect(items).toMatchObject([{ type: "needs_input", taskId, runId, text: "Which <b>region</b> should the cache use?", artifacts: ["notes/cache.md"] }]);
    const ev = s.store.db.prepare("select kind, payload from events where kind = 'mcp.report' and run_id = ?").get(runId) as { payload: string };
    expect(JSON.parse(ev.payload)).toMatchObject({ type: "needs_input" });

    // A checkpoint goes to the timeline only, not to the Inbox.
    await c.call("report", { kind: "checkpoint", text: "Read the cache module." });
    expect(s.mcp.reports.list({ projectId: s.project.id })).toHaveLength(1);
    expect(s.mcp.reports.list({ runId, includeClosed: true })).toHaveLength(2);
  });

  it("refuses artifacts outside the working folder and oversized text, as tool errors", async () => {
    const s = await setup();
    const { req } = await startRun(s);
    const spec = reportSpec(req);
    const c = await client(spec.env[PIPE_ENV]!, spec.env[TICKET_ENV]!);
    await c.request("initialize", { protocolVersion: "2025-06-18" });
    for (const p of ["../outside.txt", "C:\\Windows\\win.ini", "\\\\server\\share\\x", "file.txt:stream"]) {
      expect((await c.call("report", { kind: "done", text: "x", artifacts: [p] })).isError).toBe(true);
    }
    const big = await c.call("report", { kind: "done", text: "x".repeat(REPORT_LIMITS.textBytes + 1) });
    expect(big).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("limit") }] });
    expect(s.mcp.reports.list({ includeClosed: true })).toHaveLength(0);
  });

  it("closes a connection with a wrong ticket, and one whose line passes the size cap", async () => {
    const s = await setup();
    const { req } = await startRun(s);
    const spec = reportSpec(req);
    const wrong = await client(spec.env[PIPE_ENV]!, "x".repeat(43));
    await wrong.closed;
    const huge = await client(spec.env[PIPE_ENV]!, spec.env[TICKET_ENV]!);
    huge.socket.write("{" + " ".repeat(REPORT_LIMITS.lineBytes + 10));
    await huge.closed;
  });

  it("refuses a ticket once its run has ended, and an old ticket after a new one was issued", async () => {
    const s = await setup();
    const { req, runId } = await startRun(s);
    const spec = reportSpec(req);
    const c = await client(spec.env[PIPE_ENV]!, spec.env[TICKET_ENV]!);
    await c.request("initialize", {});
    expect((await c.call("report", { kind: "checkpoint", text: "one" })).isError).toBe(false);

    // A new process of the same run (resume) gets a new ticket; the old one stops at the next call.
    s.mcp.tickets.issue(runId);
    expect(await c.call("report", { kind: "checkpoint", text: "two" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("no longer valid") }] });
    const stale = await client(spec.env[PIPE_ENV]!, spec.env[TICKET_ENV]!);
    await stale.closed;

    await s.o.stop(runId, { sessionId: null });
    expect(s.mcp.tickets.runFor(spec.env[TICKET_ENV])).toBeNull();
    expect(s.mcp.reports.list({ runId, includeClosed: true })).toHaveLength(1);
  });

  it("closes a run's open needs_input when the run ends, and keeps its follow-ups", async () => {
    const s = await setup();
    const { req, runId } = await startRun(s);
    const spec = reportSpec(req);
    const c = await client(spec.env[PIPE_ENV]!, spec.env[TICKET_ENV]!);
    await c.request("initialize", {});
    await c.call("report", { kind: "stuck", text: "Tests need a database." });
    await c.call("propose_followup", { title: "Add a test database container" });
    await s.o.stop(runId, { sessionId: null });
    expect(s.mcp.reports.list({ projectId: s.project.id }).map((r) => r.type)).toEqual(["followup"]);
  });
});

describe("follow-up proposals", () => {
  it("never start anything: accepting one only drafts a task whose crew waits for approval", async () => {
    const s = await setup();
    const { req } = await startRun(s);
    const spec = reportSpec(req);
    const c = await client(spec.env[PIPE_ENV]!, spec.env[TICKET_ENV]!);
    await c.request("initialize", {});
    const res = await c.call("propose_followup", { title: "Cache the session lookups", description: "The lookup runs twice per request." });
    expect(res.isError).toBe(false);
    const before = s.adapter.started.length;
    const tasksBefore = s.o.list(s.project.id).length;
    await s.o.tick();
    expect(s.o.list(s.project.id)).toHaveLength(tasksBefore);

    const [item] = s.mcp.reports.list({ projectId: s.project.id });
    expect(item).toMatchObject({ type: "followup", title: "Cache the session lookups", text: "The lookup runs twice per request." });
    const { taskId } = await s.mcp.reports.accept(item!.id);
    await s.o.tick();
    const draft = s.o.get(taskId);
    expect(draft.status).toBe("proposed");
    expect(draft.crew?.approvedAt).toBeNull();
    expect(draft.runs).toHaveLength(0);
    expect(s.adapter.started).toHaveLength(before);
    // Accepting twice returns the same draft instead of a second task.
    expect((await s.mcp.reports.accept(item!.id)).taskId).toBe(taskId);
    expect(s.o.list(s.project.id)).toHaveLength(tasksBefore + 1);
  });

  it("are capped per run", async () => {
    const s = await setup();
    const { req } = await startRun(s);
    const spec = reportSpec(req);
    const c = await client(spec.env[PIPE_ENV]!, spec.env[TICKET_ENV]!);
    await c.request("initialize", {});
    for (let i = 0; i < REPORT_LIMITS.followupsPerRun; i++) expect((await c.call("propose_followup", { title: `Idea ${i}` })).isError).toBe(false);
    expect((await c.call("propose_followup", { title: "One more" })).isError).toBe(true);
  });
});

describe("needs_input replies", () => {
  it("send your answer to the run like a typed message and close the item", async () => {
    const s = await setup();
    const { req, runId } = await startRun(s);
    const spec = reportSpec(req);
    const c = await client(spec.env[PIPE_ENV]!, spec.env[TICKET_ENV]!);
    await c.request("initialize", {});
    await c.call("report", { kind: "needs_input", text: "Which region?" });
    const [item] = s.mcp.reports.list({ projectId: s.project.id });
    const view = await s.mcp.reports.reply(item!.id, "eu-west-1", { sessionId: null });
    expect(view.closedBy).toBe("replied");
    const run = s.o.get(item!.taskId).runs.find((r) => r.id === runId)!;
    expect(JSON.stringify(run.queue) + JSON.stringify(s.adapter.inspect(s.adapter.started[0]!.runId).inputs)).toContain("eu-west-1");
  });
});

describe.runIf(process.platform === "win32")("the PowerShell relay", () => {
  it("carries MCP between a runner's stdio and the daemon's pipe", async () => {
    const s = await setup();
    const { req, runId } = await startRun(s);
    const spec = reportSpec(req);
    const child = start(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ["pipe", "pipe", "pipe"] });
    open.push(async () => {
      child.kill();
    });
    let out = "";
    const lines: Array<Record<string, unknown>> = [];
    child.stdout!.setEncoding("utf8").on("data", (d: string) => {
      out += d;
      let nl: number;
      while ((nl = out.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(out.slice(0, nl)) as Record<string, unknown>);
        out = out.slice(nl + 1);
      }
    });
    const send = (m: unknown) => child.stdin!.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await waitFor(() => lines.find((l) => l.id === 1), 20_000);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // Non-ASCII text survives the byte relay unchanged.
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "report", arguments: { kind: "checkpoint", text: "Önbellek modülü okundu" } } });
    const res = await waitFor(() => lines.find((l) => l.id === 2), 20_000);
    expect(res.result).toMatchObject({ isError: false });
    expect(s.mcp.reports.list({ runId, includeClosed: true })[0]?.text).toBe("Önbellek modülü okundu");
    const exited = new Promise((r) => child.once("exit", r));
    child.stdin!.end();
    await exited;
  });
});
