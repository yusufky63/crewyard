import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentEvent, type AgentAdapter, type RolePolicy, type RunHandle, type StartRequest } from "@crewyard/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapter } from "./index.ts";

// End to end against a fake `opencode serve` (node script): real process, real HTTP, Basic auth and
// SSE, no network and no model calls. Folders contain spaces on purpose (PLAN.md §12).

const FAKE = fileURLToPath(new URL("./fixtures/fake-opencode.mjs", import.meta.url));
const WORKTREE: RolePolicy = { writes: "worktree", allowCommands: ["pnpm test"], network: "ask" };
const READ_ONLY: RolePolicy = { writes: "none", allowCommands: [], network: "denied" };

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "crewyard oc "));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

interface Setup {
  adapter: AgentAdapter;
  req: StartRequest;
  logFile: string;
  configDir: string;
}

async function setup(name: string, prompt: string, policy: RolePolicy = WORKTREE): Promise<Setup> {
  const dir = join(root, name);
  const cwd = join(dir, "work tree");
  const configDir = join(dir, "profile dir");
  await mkdir(cwd, { recursive: true });
  const logFile = join(dir, "fake log.jsonl");
  const adapter = createAdapter({ executable: process.execPath, prefixArgs: [FAKE], reconnectDelayMs: 100 });
  const req: StartRequest = {
    profile: { id: "p1", alias: "oc", runner: "opencode", providerId: "p", credential: { kind: "api_key", secretRef: "s" }, defaultModel: "p/m", configDir, baseUrl: null },
    cwd,
    model: null,
    prompt,
    policy,
    env: { FAKE_OPENCODE_LOG: logFile, FAKE_PROVIDER_KEY: "not-a-real-key" },
  };
  return { adapter, req, logFile, configDir };
}

type Ev = AgentEvent;

async function collect(adapter: AgentAdapter, run: RunHandle, onEvent?: (ev: Ev) => void | Promise<void>): Promise<Ev[]> {
  const out: Ev[] = [];
  for await (const ev of adapter.events(run)) {
    const parsed = AgentEvent.safeParse(ev);
    if (!parsed.success) throw new Error(`invalid event ${JSON.stringify(ev)}: ${parsed.error.message}`);
    out.push(ev);
    await onEvent?.(ev);
  }
  return out;
}

async function readLog(file: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(file, "utf8");
  return text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

const texts = (events: Ev[]) => events.flatMap((e) => (e.type === "message.delta" ? [e.text] : []));
const last = (events: Ev[]) => events[events.length - 1];

async function gone(pid: number | null): Promise<boolean> {
  if (pid === null) return false;
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe("OpenCode adapter against a fake opencode serve", () => {
  it("probes the version", async () => {
    const { adapter, req } = await setup("probe", "");
    const probe = await adapter.probe(req.profile);
    expect(probe).toMatchObject({ installed: true, version: "1.19.5", problems: [] });
  });

  it("streams a turn, isolates the profile and ends with no process left", async () => {
    const { adapter, req, logFile, configDir } = await setup("basic", "basic");
    process.env.OPENCODE_CONFIG = join(root, "someone else's config.json");
    let run: RunHandle;
    try {
      run = await adapter.start(req);
    } finally {
      delete process.env.OPENCODE_CONFIG;
    }
    expect(run.nativeSession?.sessionId).toMatch(/^ses_/);
    const events = await collect(adapter, run);

    expect(texts(events)).toEqual(["Hel", "lo"]);
    expect(events.filter((e) => e.type === "thought.delta").map((e) => (e.type === "thought.delta" ? e.text : ""))).toEqual(["thinking"]);
    expect(events.find((e) => e.type === "tool.call")).toMatchObject({ toolCallId: "call_1", kind: "execute", title: "bash", input: { command: "ls" } });
    expect(events.filter((e) => e.type === "tool.update").map((e) => (e.type === "tool.update" ? e.status : ""))).toEqual(["in_progress", "completed"]);
    expect(events.find((e) => e.type === "plan.update")).toMatchObject({ steps: [{ title: "Write code", status: "in_progress" }] });
    expect(events.find((e) => e.type === "diff.update")).toMatchObject({ files: [{ path: "src/a.ts", added: 3, removed: 1 }] });
    expect(events.find((e) => e.type === "usage.update")).toMatchObject({ tokensIn: 100, tokensOut: 20, cacheRead: 10, reasoning: 5, contextUsed: 130, costUsd: 0.0123, costProvenance: "estimated" });
    expect(last(events)).toMatchObject({ type: "run.ended", reason: "completed" });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.every((e) => e.source.adapter === "opencode" && e.source.cliVersion === "1.19.5")).toBe(true);

    const log = await readLog(logFile);
    const launch = log.find((l) => l.kind === "launch");
    expect(launch).toMatchObject({
      argv: ["serve", "--hostname", "127.0.0.1", "--port", "0"],
      cwd: req.cwd,
      passwordSet: true,
      secret: "present",
      inheritedOpencode: [],
      xdg: { config: join(configDir, "config"), data: join(configDir, "data"), state: join(configDir, "state"), cache: join(configDir, "cache") },
    });
    const create = log.find((l) => l.kind === "session.create") as { body: { permission: unknown[]; title: string } };
    expect(create.body.title).toBe("Crewyard: basic");
    expect(create.body.permission).toContainEqual({ permission: "bash", pattern: "*", action: "ask" });
    expect(create.body.permission).toContainEqual({ permission: "bash", pattern: "pnpm test *", action: "allow" });
    expect(log.find((l) => l.kind === "prompt")).toMatchObject({ body: { parts: [{ type: "text", text: "basic" }], model: { providerID: "p", modelID: "m" } } });
    expect(log.filter((l) => l.kind === "request").every((l) => l.directory === req.cwd)).toBe(true);
    expect(await gone(run.pid)).toBe(true);
  });

  it("answers a permission once and reports it as an approval request", async () => {
    const { adapter, req, logFile } = await setup("approve", "approve");
    const run = await adapter.start(req);
    const events = await collect(adapter, run, async (ev) => {
      if (ev.type === "request.approval") await adapter.answer(run, ev.requestId, { kind: "approval", decision: "allow_once" });
    });
    expect(events.find((e) => e.type === "request.approval")).toMatchObject({ toolCallId: "call_2", command: "dotnet test", cwd: req.cwd, paths: [], network: false });
    expect(events.some((e) => e.type === "run.state" && e.state === "waiting_approval")).toBe(true);
    expect(texts(events)).toEqual(["bash:once"]);
    expect((await readLog(logFile)).find((l) => l.kind === "permission.reply")).toMatchObject({ body: { reply: "once" } });
  });

  it("maps allow_always and deny with a message", async () => {
    for (const [decision, reply] of [["allow_always", "always"], ["deny", "reject"]] as const) {
      const { adapter, req, logFile } = await setup(`perm-${decision}`, "approve");
      const run = await adapter.start(req);
      await collect(adapter, run, async (ev) => {
        if (ev.type === "request.approval") await adapter.answer(run, ev.requestId, { kind: "approval", decision, message: "use the script" });
      });
      expect((await readLog(logFile)).find((l) => l.kind === "permission.reply")).toMatchObject({ body: { reply, message: "use the script" } });
    }
  });

  it("refuses edits for a read-only role without asking the user", async () => {
    const { adapter, req, logFile } = await setup("readonly", "edit", READ_ONLY);
    const run = await adapter.start(req);
    const events = await collect(adapter, run);
    expect(events.some((e) => e.type === "request.approval")).toBe(false);
    expect(texts(events)).toEqual(["edit:reject"]);
    const log = await readLog(logFile);
    const create = log.find((l) => l.kind === "session.create") as { body: { permission: unknown[] } };
    expect(create.body.permission).toContainEqual({ permission: "edit", pattern: "*", action: "deny" });
    expect(create.body.permission).toContainEqual({ permission: "webfetch", pattern: "*", action: "deny" });
    expect(log.find((l) => l.kind === "permission.reply")).toMatchObject({ body: { reply: "reject" } });
  });

  it("answers a question form, free text included", async () => {
    const { adapter, req, logFile } = await setup("question", "question");
    const run = await adapter.start(req);
    const events = await collect(adapter, run, async (ev) => {
      if (ev.type === "request.question") await adapter.answer(run, ev.requestId, { kind: "question", answers: [{ selected: ["sqlite"], text: "with WAL" }] });
    });
    expect(events.find((e) => e.type === "request.question")).toMatchObject({
      questions: [{ prompt: "Which database?", allowFreeText: true, options: [{ label: "sqlite", description: "local file" }, { label: "postgres", description: "server" }] }],
    });
    expect(events.some((e) => e.type === "run.state" && e.state === "waiting_input")).toBe(true);
    expect(texts(events)).toEqual([`answers:${JSON.stringify([["sqlite", "with WAL"]])}`]);
    expect((await readLog(logFile)).find((l) => l.kind === "question.reply")).toMatchObject({ body: { answers: [["sqlite", "with WAL"]] } });
  });

  it("rejects a question when the answer is cancel", async () => {
    const { adapter, req, logFile } = await setup("question-cancel", "question");
    const run = await adapter.start(req);
    const events = await collect(adapter, run, async (ev) => {
      if (ev.type === "request.question") await adapter.answer(run, ev.requestId, { kind: "cancel" });
    });
    expect(texts(events)).toEqual(["question:rejected"]);
    expect((await readLog(logFile)).some((l) => l.kind === "question.reject")).toBe(true);
  });

  it("re-reads session state after the event stream drops", async () => {
    const { adapter, req, logFile } = await setup("reconnect", "reconnect");
    const run = await adapter.start(req);
    const events = await collect(adapter, run);
    expect(texts(events).join("")).toBe("part1 part2");
    expect(events.find((e) => e.type === "usage.update")).toMatchObject({ tokensIn: 7, tokensOut: 3, costUsd: 0.5 });
    expect(last(events)).toMatchObject({ type: "run.ended", reason: "completed" });
    const log = await readLog(logFile);
    expect(log.some((l) => l.kind === "dropped")).toBe(true);
    expect(log.filter((l) => l.kind === "request" && l.path === "/event").length).toBeGreaterThanOrEqual(2);
  });

  it("interrupts a running turn", async () => {
    const { adapter, req, logFile } = await setup("interrupt", "slow");
    const run = await adapter.start(req);
    const events = await collect(adapter, run, async (ev) => {
      if (ev.type === "message.delta") await adapter.interrupt(run);
    });
    expect(last(events)).toMatchObject({ type: "run.ended", reason: "interrupted" });
    expect((await readLog(logFile)).some((l) => l.kind === "abort")).toBe(true);
    expect(await gone(run.pid)).toBe(true);
  });

  it("ends as failed with the provider error", async () => {
    const { adapter, req } = await setup("fail", "fail");
    const run = await adapter.start(req);
    const events = await collect(adapter, run);
    expect(last(events)).toMatchObject({ type: "run.ended", reason: "failed", detail: "APIError: invalid key" });
  });

  it("ends as failed when the server dies", async () => {
    const { adapter, req } = await setup("crash", "crash");
    const run = await adapter.start(req);
    const events = await collect(adapter, run);
    expect(last(events)).toMatchObject({ type: "run.ended", reason: "failed" });
    expect((last(events) as { detail?: string }).detail).toContain("exited");
  });

  it("switches the model for the next prompt and queues follow-up input", async () => {
    const { adapter, req, logFile } = await setup("model", "approve");
    const run = await adapter.start(req);
    await expect(adapter.setModel?.(run, "gpt-5")).rejects.toThrow(/provider\/model/);
    await collect(adapter, run, async (ev) => {
      if (ev.type === "request.approval") {
        await adapter.setModel?.(run, "openai/gpt-5.5");
        await adapter.send(run, { kind: "text", text: "and then this" });
        await adapter.answer(run, ev.requestId, { kind: "approval", decision: "allow_once" });
      }
    });
    const prompts = (await readLog(logFile)).filter((l) => l.kind === "prompt") as Array<{ body: { model?: unknown } }>;
    expect(prompts.map((p) => p.body.model)).toEqual([{ providerID: "p", modelID: "m" }, { providerID: "openai", modelID: "gpt-5.5" }]);
  });

  it("resumes a session in a new server without replaying history", async () => {
    const first = await setup("resume", "basic");
    const run = await first.adapter.start(first.req);
    await collect(first.adapter, run);
    const ref = run.nativeSession;
    if (!ref) throw new Error("no native session");

    const again = createAdapter({ executable: process.execPath, prefixArgs: [FAKE], reconnectDelayMs: 100 });
    const resumed = await again.resume(ref, { ...first.req, prompt: "continue" });
    expect(resumed.nativeSession).toEqual(ref);
    const events = await collect(again, resumed);
    expect(texts(events)).toEqual(["ok"]);
    expect(last(events)).toMatchObject({ type: "run.ended", reason: "completed" });
    const launches = (await readLog(first.logFile)).filter((l) => l.kind === "launch");
    expect(launches).toHaveLength(2);

    await expect(again.resume({ runner: "opencode", sessionId: "ses_missing" }, first.req)).rejects.toThrow();
  });

  it("stops a run and kills its server", async () => {
    const { adapter, req } = await setup("stop", "slow");
    const run = await adapter.start(req);
    const it = adapter.events(run)[Symbol.asyncIterator]();
    let ev = await it.next();
    while (!ev.done && ev.value.type !== "message.delta") ev = await it.next();
    await adapter.stop(run);
    const rest: Ev[] = [];
    for (ev = await it.next(); !ev.done; ev = await it.next()) rest.push(ev.value);
    expect(last(rest)).toMatchObject({ type: "run.ended", reason: "stopped" });
    expect(await gone(run.pid)).toBe(true);
    await adapter.stop(run);
  });
});
