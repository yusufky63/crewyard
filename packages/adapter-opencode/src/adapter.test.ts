import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentEvent, REVIEW_VERDICT_OUTPUT, sessionProblemOf, type AgentAdapter, type ForkRequest, type Profile, type RolePolicy, type RunHandle, type StartRequest } from "@crewyard/core";
import { WINDOWS_SYSTEM_VARS } from "@crewyard/proc";
import { childEnv } from "./server.ts";
import { v2Pending } from "./adapter.ts";
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
    profile: { id: "p1", alias: "oc", runner: "opencode", providerId: "p", credential: { kind: "api_key", secretRef: "s" }, defaultModel: "m", configDir, baseUrl: null },
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

  it("does not offer OpenCode 2.x before its conformance run, at probe and at start, with the reason", async () => {
    process.env.FAKE_OPENCODE_VERSION = "2.2.2";
    try {
      const { adapter, req } = await setup("v2", "basic");
      const probe = await adapter.probe(req.profile);
      expect(probe.version).toBe("2.2.2");
      expect(probe.capabilities).toMatchObject({ launch: false, undo: { files: true, history: true } });
      expect(probe.capabilities.fork).toBeUndefined();
      expect(probe.capabilities.transcript).toBeUndefined();
      expect(probe.problems).toEqual([expect.stringContaining("OpenCode 2.2.2 runs through Crewyard's OpenCode 2.x client, which has not passed")]);
      await expect(adapter.start(req)).rejects.toThrow(/has not passed its conformance and live runs/);
    } finally {
      delete process.env.FAKE_OPENCODE_VERSION;
    }
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
    let interrupted: Promise<void> | null = null;
    const events = await collect(adapter, run, (ev) => {
      if (ev.type === "message.delta") interrupted ??= adapter.interrupt(run);
    });
    expect(last(events)).toMatchObject({ type: "run.ended", reason: "interrupted" });
    // The fake answers the abort 1.5 s after the idle that ends the run, as OpenCode 1.19.5 answers
    // only once the turn is over; closing the server on that idle used to reset the connection.
    await expect(interrupted).resolves.toBeUndefined();
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

  it("ends as interrupted when Windows ends the server at shutdown", async () => {
    const { adapter, req } = await setup("shutdown", "shutdown");
    const run = await adapter.start(req);
    expect(last(await collect(adapter, run))).toMatchObject({ type: "run.ended", reason: "interrupted", detail: "windows_shutdown" });
  });

  it("switches the model for the next prompt and queues follow-up input", async () => {
    const { adapter, req, logFile } = await setup("model", "approve");
    const run = await adapter.start(req);
    await expect(adapter.setModel?.(run, " ")).rejects.toThrow(/needs a provider and a model/);
    await collect(adapter, run, async (ev) => {
      if (ev.type === "request.approval") {
        // A model id with a slash of its own stays whole: the provider comes from the profile.
        await adapter.setModel?.(run, "x-ai/grok-4.3");
        await adapter.send(run, { kind: "text", text: "and then this" });
        await adapter.answer(run, ev.requestId, { kind: "approval", decision: "allow_once" });
      }
    });
    const prompts = (await readLog(logFile)).filter((l) => l.kind === "prompt") as Array<{ body: { model?: unknown } }>;
    expect(prompts.map((p) => p.body.model)).toEqual([{ providerID: "p", modelID: "m" }, { providerID: "p", modelID: "x-ai/grok-4.3" }]);
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

describe("OpenCode adapter: schema-checked results", () => {
  const good = { verdict: "pass", summary: "Fine.", comments: [] };
  const ended = (events: Ev[]) => events.find((e) => e.type === "run.ended") as Extract<Ev, { type: "run.ended" }>;
  const prompts = async (file: string) => (await readLog(file)).filter((l) => l.kind === "prompt") as Array<{ body: { format?: unknown; parts: Array<{ text: string }> } }>;

  it("sends format with the prompt and reads the structured result", async () => {
    const { adapter, req, logFile } = await setup("structured ok", "structured ok", READ_ONLY);
    const events = await collect(adapter, await adapter.start({ ...req, outputSchema: REVIEW_VERDICT_OUTPUT }));
    expect(ended(events)).toMatchObject({ reason: "completed", output: { ok: true, value: good } });
    const sent = await prompts(logFile);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.format).toEqual({ type: "json_schema", schema: REVIEW_VERDICT_OUTPUT.jsonSchema });
  });

  it("retries once in the session when the result does not fit", async () => {
    const { adapter, req, logFile } = await setup("structured fix", "structured fix", READ_ONLY);
    const events = await collect(adapter, await adapter.start({ ...req, outputSchema: REVIEW_VERDICT_OUTPUT }));
    const sent = await prompts(logFile);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body.parts[0]?.text).toContain("verdict: ");
    expect(ended(events)).toMatchObject({ reason: "completed", output: { ok: true, value: good } });
  });

  it("falls back to JSON in the prompt when the provider refuses the forced tool choice", async () => {
    const { adapter, req, logFile } = await setup("structured refused", "refused", READ_ONLY);
    const events = await collect(adapter, await adapter.start({ ...req, outputSchema: REVIEW_VERDICT_OUTPUT }));
    const sent = await prompts(logFile);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.body.format).toBeDefined();
    expect(sent[1]?.body.format).toEqual({ type: "text" });
    expect(sent[1]?.body.parts[0]?.text).toMatch(/^refused\n\nWhen you have finished/);
    expect(events.some((e) => e.type === "run.state" && /refused structured output/.test(e.detail ?? ""))).toBe(true);
    expect(ended(events)).toMatchObject({ reason: "completed", output: { ok: true, value: good } });
  });

  it("completes with OpenCode's own error when the retry fails too", async () => {
    const { adapter, req, logFile } = await setup("structured stubborn", "structured stubborn", READ_ONLY);
    const events = await collect(adapter, await adapter.start({ ...req, outputSchema: REVIEW_VERDICT_OUTPUT }));
    expect(await prompts(logFile)).toHaveLength(2);
    expect(ended(events)).toMatchObject({ reason: "completed", output: { ok: false, error: expect.stringContaining("StructuredOutputError") } });
  });
});

describe("OpenCode child environment", () => {
  it("passes every Windows system variable once and no inherited OPENCODE_ setting", () => {
    const parent = { Path: "C:\\Windows", SystemRoot: "C:\\Windows", SystemDrive: "C:", ProgramData: "C:\\ProgramData", windir: "C:\\Windows", TEMP: "C:\\T", TMP: "C:\\T", USERPROFILE: "C:\\Users\\a b", APPDATA: "C:\\A", LOCALAPPDATA: "C:\\L", PATHEXT: ".EXE", ComSpec: "C:\\Windows\\system32\\cmd.exe", Opencode_Config: "C:\\x.json" };
    const env = childEnv("C:\\profiles\\oc dir", { KEY: "k" }, "pw", parent);
    for (const name of WINDOWS_SYSTEM_VARS) expect(Object.keys(env).filter((k) => k.toUpperCase() === name.toUpperCase()), name).toHaveLength(1);
    expect(env.Opencode_Config).toBeUndefined();
    expect(env.OPENCODE_SERVER_PASSWORD).toBe("pw");
  });

  it("knows which versions wait for the 2.x conformance run", () => {
    expect(v2Pending("1.19.5")).toBeNull();
    expect(v2Pending("1.25.0")).toBeNull();
    expect(v2Pending(null)).toBeNull();
    expect(v2Pending("2.0.0")).toMatch(/has not passed its conformance and live runs/);
  });
});

describe("OpenCode adapter: turn control", () => {
  it("takes queued follow-ups at the turn boundary, names each turn by its user message, reverts the last one and exports the session", async () => {
    const { adapter, req, logFile } = await setup("turns", "basic");
    const queued = ["and the plain one", null];
    const run = await adapter.start({ ...req, nextTurn: async () => queued.shift() ?? null });
    const events = await collect(adapter, run);
    const prompts = (await readLog(logFile)).filter((l) => l.kind === "prompt").map((l) => ((l.body as { parts: Array<{ text: string }> }).parts[0]!.text));
    expect(prompts).toEqual(["basic", "and the plain one"]);
    const turns = events.filter((e) => e.type === "turn.started") as Array<Extract<Ev, { type: "turn.started" }>>;
    expect(turns).toHaveLength(2);
    expect(last(events)).toMatchObject({ type: "run.ended", reason: "completed" });

    const session = { runner: "opencode" as const, sessionId: run.nativeSession!.sessionId };
    const result = await adapter.rewind!({ profile: req.profile, cwd: req.cwd, env: req.env, session, turnRef: turns[1]!.turnRef });
    expect(result).toEqual({ files: true, history: true, detail: null });
    const reverts = (await readLog(logFile)).filter((l) => l.kind === "revert");
    expect(reverts).toEqual([{ kind: "revert", session: session.sessionId, body: { messageID: turns[1]!.turnRef } }]);
    // The undo ran on a server of its own and left it closed: no model call, no prompt.
    expect((await readLog(logFile)).filter((l) => l.kind === "prompt")).toHaveLength(2);

    const exported = await adapter.transcript!({ profile: req.profile, cwd: req.cwd, env: req.env, session });
    expect(exported?.kind).toBe("text");
    expect(JSON.parse((exported as { text: string }).text).info.id).toBe(session.sessionId);
    expect(await adapter.transcript!({ profile: req.profile, cwd: req.cwd, env: req.env, session: { ...session, sessionId: "ses_missing" } })).toBeNull();
  });
});

describe("OpenCode adapter: fork between profiles", () => {
  interface ForkSetup extends Setup {
    target: Profile;
    targetEnv: Record<string, string>;
    fork: (over?: Partial<ForkRequest>) => ForkRequest;
    ref: { runner: "opencode"; sessionId: string };
  }

  // One finished turn in the source profile, and a second profile on the same provider.
  async function forkSetup(name: string, targetEnv: Record<string, string> = {}, forkTimeoutMs?: number): Promise<ForkSetup> {
    const s = await setup(name, "basic");
    const adapter = createAdapter({ executable: process.execPath, prefixArgs: [FAKE], reconnectDelayMs: 100, ...(forkTimeoutMs ? { forkTimeoutMs } : {}) });
    const run = await adapter.start(s.req);
    await collect(adapter, run);
    const ref = { runner: "opencode" as const, sessionId: run.nativeSession!.sessionId };
    const target: Profile = { ...s.req.profile, id: "p2", alias: "oc two", configDir: join(root, name, "target profile") };
    const env = { FAKE_OPENCODE_LOG: s.logFile, FAKE_PROVIDER_KEY: "not-a-real-key-either", ...targetEnv };
    const fork = (over: Partial<ForkRequest> = {}): ForkRequest => ({ source: { profile: s.req.profile, session: ref, env: s.req.env }, target: { profile: target, model: "m2", env }, cwd: s.req.cwd, compact: true, ...over });
    return { ...s, adapter, target, targetEnv: env, fork, ref };
  }

  // Export and import get no run secrets, so the fake's log path reaches them through the parent.
  async function withLog<T>(file: string, fn: () => Promise<T>): Promise<T> {
    process.env.FAKE_OPENCODE_LOG = file;
    try {
      return await fn();
    } finally {
      delete process.env.FAKE_OPENCODE_LOG;
    }
  }

  const steps = (log: Array<Record<string, unknown>>) => log.filter((l) => ["export", "import", "fork", "summarize"].includes(String(l.kind)));
  const lastLaunch = (log: Array<Record<string, unknown>>) => log.filter((l) => l.kind === "launch" && (l.argv as string[])[0] === "serve").at(-1) as { pid: number; xdg: { data: string } };

  it("exports from the source, imports into the target, forks and summarizes there, and the copy resumes under the target's rules", async () => {
    const f = await forkSetup("fork ok");
    const sourceStore = join(f.configDir, "data", "fake-sessions.json");
    const before = await readFile(sourceStore, "utf8");

    const result = await withLog(f.logFile, () => f.adapter.fork!(f.fork()));
    expect(result.session.sessionId).toMatch(/^ses_/);
    expect(result.session.sessionId).not.toBe(f.ref.sessionId);
    expect(result).toMatchObject({ compacted: true, summary: "Summary: the user asked for a greeting.", usage: { tokensIn: 40, tokensOut: 8, cacheRead: 4, costUsd: 0.001 } });
    // The history's turn plus the summary: what the resumed run's first usage report starts from.
    expect(result.totals).toEqual({ tokensIn: 140, tokensOut: 28, cacheRead: 14, costUsd: expect.closeTo(0.0133, 6) });

    const log = await readLog(f.logFile);
    const sourceData = join(f.configDir, "data");
    const targetData = join(f.target.configDir, "data");
    expect(steps(log)).toEqual([
      { kind: "export", session: f.ref.sessionId, data: sourceData },
      { kind: "import", session: f.ref.sessionId, data: targetData, file: expect.stringContaining(join(f.target.configDir, "cache", "crewyard-fork-")), cwd: f.req.cwd },
      { kind: "fork", session: f.ref.sessionId, forked: result.session.sessionId, data: targetData },
      { kind: "summarize", session: result.session.sessionId, body: { providerID: "p", modelID: "m2", auto: false } },
    ]);
    expect(lastLaunch(log).xdg.data).toBe(targetData);
    expect(await gone(lastLaunch(log).pid)).toBe(true);
    expect(await readFile(sourceStore, "utf8")).toBe(before);
    expect((await readdir(join(f.target.configDir, "cache"))).filter((n) => n.startsWith("crewyard-fork-"))).toEqual([]);

    const again = createAdapter({ executable: process.execPath, prefixArgs: [FAKE], reconnectDelayMs: 100 });
    const resumed = await again.resume(result.session, { ...f.req, profile: f.target, env: f.targetEnv, prompt: "continue" });
    expect(texts(await collect(again, resumed))).toEqual(["ok"]);
    const update = (await readLog(f.logFile)).find((l) => l.kind === "session.update") as { session: string; body: { permission: unknown[] } };
    expect(update.session).toBe(result.session.sessionId);
    expect(update.body.permission).toContainEqual({ permission: "bash", pattern: "*", action: "ask" });

    // The target's runner itself has no such session: gone, not an ordinary failure.
    const missing = await again.resume({ runner: "opencode", sessionId: "ses_missing" }, { ...f.req, profile: f.target, env: f.targetEnv }).catch((e: unknown) => e);
    expect(sessionProblemOf(missing)).toBe("gone");
  });

  it("copies without a model call when compact is off", async () => {
    const f = await forkSetup("fork plain");
    const result = await withLog(f.logFile, () => f.adapter.fork!(f.fork({ compact: false })));
    expect(result).toMatchObject({ compacted: false, summary: null, usage: null, totals: { tokensIn: 100, tokensOut: 20, cacheRead: 10 } });
    expect(steps(await readLog(f.logFile)).map((l) => l.kind)).toEqual(["export", "import", "fork"]);
  });

  it("reports a source session the runner does not have as gone, before touching the target", async () => {
    const f = await forkSetup("fork gone");
    const err = await withLog(f.logFile, () => f.adapter.fork!(f.fork({ source: { profile: f.req.profile, session: { runner: "opencode", sessionId: "ses_missing" }, env: f.req.env } }))).catch((e: unknown) => e);
    expect(sessionProblemOf(err)).toBe("gone");
    const log = await readLog(f.logFile);
    expect(steps(log)).toEqual([]);
    expect(lastLaunch(log).xdg.data).toBe(join(f.configDir, "data"));
  });

  it("fails as an ordinary error when the compaction fails, and stops the server", async () => {
    const f = await forkSetup("fork overflow", { FAKE_SUMMARIZE: "error" });
    const err = await withLog(f.logFile, () => f.adapter.fork!(f.fork())).catch((e: unknown) => e);
    expect(String(err)).toMatch(/could not compact the session: ContextOverflowError/);
    expect(sessionProblemOf(err)).toBeNull();
    expect(await gone(lastLaunch(await readLog(f.logFile)).pid)).toBe(true);
  });

  it("gives up on a summarize that never answers and kills the server", async () => {
    const f = await forkSetup("fork hang", { FAKE_SUMMARIZE: "hang" }, 4_000);
    const err = await withLog(f.logFile, () => f.adapter.fork!(f.fork())).catch((e: unknown) => e);
    expect(String(err)).toMatch(/did not finish within 4000 ms/);
    expect(await gone(lastLaunch(await readLog(f.logFile)).pid)).toBe(true);
  });
});
