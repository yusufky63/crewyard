import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentEvent, REVIEW_VERDICT_OUTPUT, type AgentAdapter, type RolePolicy, type RunHandle, type StartRequest } from "@crewyard/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapter } from "../index.ts";
import { GUARD_ID } from "./config.ts";

// End to end against the 2.x half of the fake `opencode serve` (real process, real HTTP, Basic auth
// and SSE). It checks the adapter against the API as documented for 2.2.4, not a live 2.x server.

const FAKE = fileURLToPath(new URL("../fixtures/fake-opencode.mjs", import.meta.url));
const WORKTREE: RolePolicy = { writes: "worktree", allowCommands: ["pnpm test"], network: "ask" };
const READ_ONLY: RolePolicy = { writes: "none", allowCommands: [], network: "denied" };

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "crewyard oc2 "));
  // The probe and every launch read it from the parent environment; this file runs in its own worker.
  process.env.FAKE_OPENCODE_VERSION = "2.2.4";
});
afterAll(async () => {
  delete process.env.FAKE_OPENCODE_VERSION;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function setup(name: string, prompt: string, policy: RolePolicy = WORKTREE, extraEnv: Record<string, string> = {}, allow = true) {
  const dir = join(root, name);
  const cwd = join(dir, "work tree");
  const configDir = join(dir, "profile dir");
  await mkdir(cwd, { recursive: true });
  const logFile = join(dir, "fake log.jsonl");
  const adapter = createAdapter({ executable: process.execPath, prefixArgs: [FAKE], reconnectDelayMs: 100, allowUntestedV2: allow });
  const req: StartRequest = {
    profile: { id: "p1", alias: "oc", runner: "opencode", providerId: "p", credential: { kind: "api_key", secretRef: "s" }, defaultModel: "m", configDir, baseUrl: null },
    cwd,
    model: null,
    prompt,
    policy,
    env: { FAKE_OPENCODE_LOG: logFile, FAKE_PROVIDER_KEY: "not-a-real-key", ...extraEnv },
  };
  return { adapter, req, logFile, configDir };
}

async function collect(adapter: AgentAdapter, run: RunHandle, onEvent?: (ev: AgentEvent) => void | Promise<void>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of adapter.events(run)) {
    const parsed = AgentEvent.safeParse(ev);
    if (!parsed.success) throw new Error(`invalid event ${JSON.stringify(ev)}: ${parsed.error.message}`);
    out.push(ev);
    await onEvent?.(ev);
  }
  return out;
}

async function readLog(file: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const texts = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "message.delta" ? [e.text] : []));
const ended = (events: AgentEvent[]) => events.find((e) => e.type === "run.ended");

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

describe("OpenCode 2.x adapter against a fake opencode serve", () => {
  it("offers the checked 2.x with what its path does, and reports the 2.x capabilities once the version is known", async () => {
    const { adapter, req } = await setup("checked", "basic", WORKTREE, {}, false);
    expect(adapter.capabilities.fork).toEqual({ compact: true });
    const probe = await adapter.probe(req.profile);
    expect(probe).toMatchObject({ installed: true, version: "2.2.4", problems: [], capabilities: { launch: true, undo: { files: true, history: true } } });
    expect(probe.capabilities.fork).toBeUndefined();
    expect(adapter.capabilities.fork).toBeUndefined();
    expect(adapter.capabilities.transcript).toBeUndefined();
  });

  it("does not offer another 2.x, and refuses to start it, naming the checked one", async () => {
    process.env.FAKE_OPENCODE_VERSION = "2.3.0";
    try {
      const { adapter, req } = await setup("gate", "basic", WORKTREE, {}, false);
      const probe = await adapter.probe(req.profile);
      expect(probe).toMatchObject({ installed: true, version: "2.3.0", capabilities: { launch: false } });
      expect(probe.problems).toEqual([expect.stringContaining("only 2.2.4 has")]);
      await expect(adapter.start(req)).rejects.toThrow(/crews do not use it/);
    } finally {
      process.env.FAKE_OPENCODE_VERSION = "2.2.4";
    }
  });

  it("streams a turn through the /api routes with the session's rules, the guard and no process left", async () => {
    const { adapter, req, logFile, configDir } = await setup("basic", "basic");
    const run = await adapter.start(req);
    expect(run.nativeSession?.sessionId).toMatch(/^ses_/);
    const events = await collect(adapter, run);

    expect(texts(events)).toEqual(["Hel", "lo"]);
    expect(events.filter((e) => e.type === "thought.delta").map((e) => (e.type === "thought.delta" ? e.text : ""))).toEqual(["thinking"]);
    expect(events.find((e) => e.type === "tool.call")).toMatchObject({ title: "shell", kind: "execute", input: { command: "ls" } });
    expect(events.filter((e) => e.type === "tool.update").map((e) => (e.type === "tool.update" ? e.status : ""))).toEqual(["in_progress", "completed"]);
    expect(events.find((e) => e.type === "usage.update")).toMatchObject({ tokensIn: 100, tokensOut: 20, cacheRead: 10, reasoning: 5, contextUsed: 130, costUsd: 0.0123, costProvenance: "estimated" });
    expect(events.find((e) => e.type === "turn.started")).toMatchObject({ turnRef: expect.stringMatching(/^msg_/) });
    expect(ended(events)).toMatchObject({ reason: "completed" });
    expect(events.every((e) => e.source.cliVersion === "2.2.4")).toBe(true);

    const log = await readLog(logFile);
    const launch = log.find((l) => l.kind === "launch") as { argv: string[]; passwordSet: boolean; xdg: Record<string, string>; config: { plugins: Array<{ package: string }>; update: string } };
    expect(launch.argv).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    expect(launch.passwordSet).toBe(true);
    expect(launch.xdg.data).toBe(join(configDir, "data"));
    expect(launch.config.update).toBe("disable");
    expect(launch.config.plugins).toEqual([{ package: join(configDir, "config", "opencode", "crewyard", GUARD_ID) }]);

    const create = log.find((l) => l.kind === "session.create") as { body: { title: string; model: unknown; permissions: Array<{ action: string; resource: string; effect: string }>; location: { directory: string } } };
    expect(create.body).toMatchObject({ title: "Crewyard: basic", model: { id: "m", providerID: "p" }, location: { directory: req.cwd } });
    const actions = new Set(create.body.permissions.map((r) => r.action));
    expect(actions.has("bash") || actions.has("task")).toBe(false);
    expect(create.body.permissions).toEqual(expect.arrayContaining([{ action: "subagent", resource: "*", effect: "deny" }, { action: "shell", resource: "pnpm test *", effect: "allow" }, { action: "external_directory", resource: "*", effect: "ask" }]));
    const prompt = log.find((l) => l.kind === "prompt") as { body: { text: string; delivery: string } };
    expect(prompt.body).toEqual({ text: "basic", delivery: "queue" });
    expect(await gone(run.pid)).toBe(true);
  });

  it("keeps the provider key and both password variables out of the agent's commands", async () => {
    const { adapter, req } = await setup("envcheck", "envcheck");
    const events = await collect(adapter, await adapter.start(req));
    expect(JSON.parse(texts(events).join(""))).toEqual({ FAKE_PROVIDER_KEY: "blank", OPENCODE_PASSWORD: "blank", OPENCODE_SERVER_PASSWORD: "blank", OPENCODE_CONFIG_CONTENT: "visible" });
  });

  it("refuses to run when the server did not load the guard, or loaded it with an error", async () => {
    for (const mode of ["skip", "fail"]) {
      const { adapter, req, logFile } = await setup(`guard ${mode}`, "basic", WORKTREE, { FAKE_V2_GUARD: mode });
      await expect(adapter.start(req)).rejects.toThrow(mode === "skip" ? /key guard plugin \(it was not loaded\)/ : /key guard plugin \(it failed to load: SyntaxError/);
      const log = await readLog(logFile);
      expect(log.some((l) => l.kind === "session.create")).toBe(false);
      expect(await gone((log.find((l) => l.kind === "launch") as { pid: number }).pid)).toBe(true);
    }
  });

  it("asks for a command and replies with the decision", async () => {
    const { adapter, req, logFile } = await setup("approve", "approve");
    const run = await adapter.start(req);
    const events = await collect(adapter, run, async (ev) => {
      if (ev.type === "request.approval") await adapter.answer(run, ev.requestId, { kind: "approval", decision: "allow_once" });
    });
    expect(events.find((e) => e.type === "request.approval")).toMatchObject({ command: "dotnet test", paths: [], network: false, toolCallId: expect.stringMatching(/^call_/) });
    expect(events.some((e) => e.type === "run.state" && e.state === "waiting_approval")).toBe(true);
    expect(texts(events)).toEqual(["shell:once"]);
    expect((await readLog(logFile)).find((l) => l.kind === "permission.reply")).toMatchObject({ body: { decision: "once" } });
  });

  it("refuses an edit for a read-only role without asking", async () => {
    const { adapter, req, logFile } = await setup("read only", "edit", READ_ONLY);
    const events = await collect(adapter, await adapter.start(req));
    expect(events.some((e) => e.type === "request.approval")).toBe(false);
    expect(texts(events)).toEqual(["edit:reject"]);
    expect((await readLog(logFile)).find((l) => l.kind === "permission.reply")).toMatchObject({ body: { decision: "reject", message: expect.stringContaining("refused by policy") } });
  });

  it("shows a form as a question and answers it by field, label back to value", async () => {
    const { adapter, req, logFile } = await setup("question", "question");
    const run = await adapter.start(req);
    const events = await collect(adapter, run, async (ev) => {
      if (ev.type === "request.question") await adapter.answer(run, ev.requestId, { kind: "question", answers: [{ selected: ["SQLite"] }] });
    });
    expect(events.find((e) => e.type === "request.question")).toMatchObject({ questions: [{ prompt: "Which database?", options: [{ label: "SQLite", description: "local file" }, { label: "Postgres" }], allowFreeText: true }] });
    expect((await readLog(logFile)).find((l) => l.kind === "form.reply")).toMatchObject({ body: { answer: { db: "sqlite" } } });
    expect(texts(events)).toEqual([`answer:${JSON.stringify({ db: "sqlite" })}`]);
  });

  it("closes the gap after the event stream drops, from the paged history", async () => {
    const { adapter, req } = await setup("reconnect", "reconnect");
    const events = await collect(adapter, await adapter.start(req));
    expect(texts(events).join("")).toBe("part1 part2");
    expect(ended(events)).toMatchObject({ reason: "completed" });
  });

  it("interrupts a running turn", async () => {
    const { adapter, req, logFile } = await setup("slow", "slow");
    const run = await adapter.start(req);
    const events = await collect(adapter, run, async (ev) => {
      if (ev.type === "message.delta") await adapter.interrupt(run);
    });
    expect(ended(events)).toMatchObject({ reason: "interrupted" });
    expect((await readLog(logFile)).some((l) => l.kind === "interrupt")).toBe(true);
  });

  it("asks for the JSON in the prompt and retries once when it does not fit", async () => {
    const { adapter, req, logFile } = await setup("structured", "structured fix", READ_ONLY);
    const events = await collect(adapter, await adapter.start({ ...req, outputSchema: REVIEW_VERDICT_OUTPUT }));
    const prompts = (await readLog(logFile)).filter((l) => l.kind === "prompt").map((l) => (l.body as { text: string }).text);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatch(/^structured fix\n\nWhen you have finished/);
    expect(prompts[1]).toMatch(/did not match/);
    expect(ended(events)).toMatchObject({ reason: "completed", output: { ok: true, value: { verdict: "pass" } } });
  });

  it("fails the run with the provider's error", async () => {
    const { adapter, req } = await setup("fail", "fail");
    expect(ended(await collect(adapter, await adapter.start(req)))).toMatchObject({ reason: "failed", detail: "invalid key" });
  });

  it("never puts the server password in a failure message", async () => {
    const { adapter, req } = await setup("crash", "crash");
    const end = ended(await collect(adapter, await adapter.start(req)));
    expect(end).toMatchObject({ reason: "failed", detail: expect.stringContaining("server password [password]") });
  });

  it("resumes without replaying history, sets the role's rules and model, and reverts a turn", async () => {
    const { adapter, req, logFile } = await setup("resume", "basic");
    const run = await adapter.start(req);
    const first = await collect(adapter, run);
    const turn = first.find((e) => e.type === "turn.started");
    const sessionId = run.nativeSession!.sessionId;
    const again = await adapter.resume({ runner: "opencode", sessionId }, { ...req, prompt: "plain", model: "m2", policy: READ_ONLY });
    const events = await collect(adapter, again);
    expect(texts(events)).toEqual(["ok"]);
    expect(events.filter((e) => e.type === "tool.call")).toHaveLength(0);
    const log = await readLog(logFile);
    expect(log.find((l) => l.kind === "model")).toMatchObject({ body: { model: { id: "m2", providerID: "p" } } });
    expect((log.find((l) => l.kind === "session.update") as { body: { permissions: Array<{ action: string; effect: string }> } }).body.permissions).toEqual(expect.arrayContaining([{ action: "edit", resource: "*", effect: "deny" }]));

    const rewound = await adapter.rewind!({ profile: req.profile, env: req.env, cwd: req.cwd, session: { runner: "opencode", sessionId }, turnRef: turn?.type === "turn.started" ? turn.turnRef : null });
    expect(rewound).toEqual({ files: true, history: true, detail: null });
    const after = await readLog(logFile);
    expect(after.find((l) => l.kind === "revert.stage")).toMatchObject({ body: { messageID: turn?.type === "turn.started" ? turn.turnRef : "", files: true } });
    expect(after.some((l) => l.kind === "revert.commit")).toBe(true);
  });

  it("has no transcript and no handoff fork on 2.x yet", async () => {
    const { adapter, req } = await setup("no fork", "");
    expect(await adapter.transcript!({ profile: req.profile, env: req.env, cwd: req.cwd, session: { runner: "opencode", sessionId: "ses_x" } })).toBeNull();
    const target = { profile: req.profile, env: req.env, model: null };
    await expect(adapter.fork!({ source: { profile: req.profile, env: req.env, session: { runner: "opencode", sessionId: "ses_x" } }, target, cwd: req.cwd, compact: false })).rejects.toThrow(/not supported yet/);
  });
});
