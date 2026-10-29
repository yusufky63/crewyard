import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentEvent, type AgentAdapter, type Profile, type RolePolicy, type RunHandle, type StartRequest } from "@crewyard/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { capabilities, createAdapter } from "./index.ts";

// End to end against a fake ACP agent (node script on the SDK's agent app) over real stdio, using
// the real Gemini spec for flags, folders and auth. No network, no model calls. Paths have spaces.

const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const WORKTREE: RolePolicy = { writes: "worktree", allowCommands: [], network: "ask" };
const READ_ONLY: RolePolicy = { writes: "none", allowCommands: [], network: "denied" };
const DOCS: RolePolicy = { writes: "docs", allowCommands: [], network: "ask" };

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "crewyard acp "));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const TOGGLES = ["FAKE_ACP_VERSION", "FAKE_ACP_HELP", "FAKE_ACP_LOAD"];
afterEach(() => {
  for (const k of TOGGLES) delete process.env[k];
});

interface Setup {
  adapter: AgentAdapter;
  req: StartRequest;
  logFile: string;
  configDir: string;
}

const fakeAdapter = () => createAdapter({ executable: process.execPath, prefixArgs: [FAKE], cancelGraceMs: 2_000 });

async function setup(name: string, prompt: string, policy: RolePolicy = WORKTREE, credential: Profile["credential"] = { kind: "plan_signin", secretRef: null }, env: Record<string, string> = {}): Promise<Setup> {
  const dir = join(root, name);
  const cwd = join(dir, "work tree");
  const configDir = join(dir, "profile dir");
  await mkdir(cwd, { recursive: true });
  const logFile = join(dir, "fake log.jsonl");
  const req: StartRequest = {
    profile: { id: "g1", alias: "gemini work", runner: "gemini-cli", providerId: "google", credential, defaultModel: null, configDir, baseUrl: null },
    cwd,
    model: "gemini-2.5-pro",
    prompt,
    policy,
    env: { FAKE_ACP_LOG: logFile, ...env },
  };
  return { adapter: fakeAdapter(), req, logFile, configDir };
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
  const text = await readFile(file, "utf8").catch(() => "");
  return text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
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

describe("ACP adapter against a fake Gemini agent", () => {
  it("keeps questions and model switching off", () => {
    expect(capabilities).toMatchObject({ answerQuestions: false, setModel: false });
    expect(fakeAdapter().setModel).toBeUndefined();
  });

  it("probes version, ACP flag and resume support through initialize", async () => {
    const { adapter, req } = await setup("probe", "");
    expect(await adapter.probe(req.profile)).toMatchObject({ installed: true, version: "0.66.0", problems: [], capabilities: { launch: true, resume: true } });
    process.env.FAKE_ACP_LOAD = "0";
    expect(await fakeAdapter().probe(req.profile)).toMatchObject({ problems: [], capabilities: { resume: false } });
    process.env.FAKE_ACP_HELP = "none";
    const noFlag = await fakeAdapter().probe(req.profile);
    expect(noFlag.capabilities.launch).toBe(false);
    expect(noFlag.problems[0]).toMatch(/no ACP mode flag/);
  });

  it("refuses Gemini versions that ignore GEMINI_CLI_HOME before spawning anything", async () => {
    process.env.FAKE_ACP_VERSION = "0.6.1";
    const { adapter, req, logFile } = await setup("old", "basic");
    const probe = await adapter.probe(req.profile);
    expect(probe.capabilities.launch).toBe(false);
    expect(probe.problems[0]).toMatch(/0\.6\.1 ignores GEMINI_CLI_HOME/);
    await expect(adapter.start(req)).rejects.toThrow(/update it to 0\.25\.0/);
    expect(await readLog(logFile)).toEqual([]);
  });

  it("uses --experimental-acp when that is the flag the CLI offers", async () => {
    process.env.FAKE_ACP_HELP = "experimental";
    const { adapter, req, logFile } = await setup("experimental", "hello");
    const run = await adapter.start(req);
    await collect(adapter, run);
    expect((await readLog(logFile)).find((l) => l.kind === "launch")).toMatchObject({ argv: ["--experimental-acp", "--model", "gemini-2.5-pro"] });
  });

  it("streams a turn in the profile folder and ends with no process left", async () => {
    const { adapter, req, logFile, configDir } = await setup("basic", "basic");
    const run = await adapter.start(req);
    expect(run.nativeSession?.sessionId).toMatch(/^sess-/);
    const events = await collect(adapter, run);

    expect(texts(events)).toEqual(["Hel", "lo"]);
    expect(events.find((e) => e.type === "thought.delta")).toMatchObject({ text: "thinking" });
    expect(events.find((e) => e.type === "tool.call")).toMatchObject({ toolCallId: "t1", kind: "read", title: "Read a.ts", input: { path: "a.ts" } });
    const updates = events.filter((e) => e.type === "tool.update");
    expect(updates.map((e) => (e.type === "tool.update" ? [e.toolCallId, e.status] : []))).toEqual([["t1", "in_progress"], ["t1", "completed"], ["t2", "completed"]]);
    expect(updates[1]).toMatchObject({ output: "file body" });
    expect(events.find((e) => e.type === "plan.update")).toMatchObject({ steps: [{ title: "Read the file", status: "completed" }, { title: "Fix it", status: "pending" }] });
    expect(events.find((e) => e.type === "diff.update")).toMatchObject({ files: [{ path: join(req.cwd, "a.ts"), added: 2, removed: 1 }] });
    expect(events.find((e) => e.type === "usage.update")).toMatchObject({ contextUsed: 1200, contextSize: 200000, costUsd: 0.01, costProvenance: "reported" });
    expect(last(events)).toMatchObject({ type: "run.ended", reason: "completed" });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.every((e) => e.source.adapter === "acp" && e.source.cliVersion === "0.66.0")).toBe(true);

    const log = await readLog(logFile);
    expect(log.find((l) => l.kind === "launch")).toMatchObject({ argv: ["--acp", "--model", "gemini-2.5-pro"], cwd: req.cwd, home: configDir, fileStorage: "true" });
    expect(log.find((l) => l.kind === "initialize")).toMatchObject({ params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } });
    expect(log.find((l) => l.kind === "session.new")).toMatchObject({ params: { cwd: req.cwd, mcpServers: [] } });
    expect(await gone(run.pid)).toBe(true);
  });

  it("maps each approval decision onto the agent's own options", async () => {
    for (const [decision, optionId] of [["allow_once", "proceed_once"], ["allow_always", "proceed_always"], ["deny", "cancel"]] as const) {
      const { adapter, req, logFile } = await setup(`perm-${decision}`, "approve");
      const run = await adapter.start(req);
      const events = await collect(adapter, run, async (ev) => {
        if (ev.type === "request.approval") await adapter.answer(run, ev.requestId, { kind: "approval", decision });
      });
      expect(events.find((e) => e.type === "request.approval")).toMatchObject({ toolCallId: "t3", command: "dotnet test", cwd: req.cwd, paths: [], network: false });
      expect(events.some((e) => e.type === "run.state" && e.state === "waiting_approval")).toBe(true);
      expect(texts(events)).toEqual([`outcome:${optionId}`]);
      expect((await readLog(logFile)).find((l) => l.kind === "permission.outcome")).toMatchObject({ outcome: { outcome: "selected", optionId } });
    }
  });

  it("refuses edits for a read-only role without asking the user", async () => {
    const { adapter, req } = await setup("readonly", "edit", READ_ONLY);
    const run = await adapter.start(req);
    const events = await collect(adapter, run);
    expect(events.some((e) => e.type === "request.approval")).toBe(false);
    expect(texts(events)).toEqual(["edit:cancel"]);
  });

  it("lets a docs role ask about docs files only", async () => {
    const docs = await setup("docs-ok", "docs edit", DOCS);
    const run = await docs.adapter.start(docs.req);
    const events = await collect(docs.adapter, run, async (ev) => {
      if (ev.type === "request.approval") await docs.adapter.answer(run, ev.requestId, { kind: "approval", decision: "allow_once" });
    });
    expect(events.find((e) => e.type === "request.approval")).toMatchObject({ paths: [join(docs.req.cwd, "docs", "guide.md")] });
    expect(texts(events)).toEqual(["edit:proceed_once"]);

    const code = await setup("docs-code", "edit", DOCS);
    const run2 = await code.adapter.start(code.req);
    expect(texts(await collect(code.adapter, run2))).toEqual(["edit:cancel"]);
  });

  it("interrupts a running turn with session/cancel", async () => {
    const { adapter, req, logFile } = await setup("interrupt", "slow");
    const run = await adapter.start(req);
    const events = await collect(adapter, run, async (ev) => {
      if (ev.type === "message.delta") await adapter.interrupt(run);
    });
    expect(last(events)).toMatchObject({ type: "run.ended", reason: "interrupted" });
    expect((await readLog(logFile)).some((l) => l.kind === "cancel")).toBe(true);
    expect(await gone(run.pid)).toBe(true);
  });

  it("answers an open permission with cancelled when interrupted", async () => {
    const { adapter, req, logFile } = await setup("interrupt-perm", "waitperm");
    const run = await adapter.start(req);
    const events = await collect(adapter, run, async (ev) => {
      if (ev.type === "request.approval") await adapter.interrupt(run);
    });
    expect(last(events)).toMatchObject({ type: "run.ended", reason: "interrupted" });
    expect((await readLog(logFile)).find((l) => l.kind === "permission.outcome")).toMatchObject({ outcome: { outcome: "cancelled" } });
  });

  it("ends as failed on a refusal and when the agent dies", async () => {
    const refuse = await setup("refuse", "refuse");
    const run = await refuse.adapter.start(refuse.req);
    expect(last(await collect(refuse.adapter, run))).toMatchObject({ type: "run.ended", reason: "failed", detail: "stopped: refusal" });

    const crash = await setup("crash", "crash");
    const run2 = await crash.adapter.start(crash.req);
    const ended = last(await collect(crash.adapter, run2));
    expect(ended).toMatchObject({ type: "run.ended", reason: "failed" });
    expect((ended as { detail?: string }).detail).toMatch(/exited|closed/i);
  });

  it("authenticates an API-key profile when the agent asks for it, and never a sign-in profile", async () => {
    const keyed = await setup("auth-key", "hello", WORKTREE, { kind: "api_key", secretRef: "s" }, { FAKE_ACP_REQUIRE_AUTH: "1", GEMINI_API_KEY: "not-a-real-key" });
    const run = await keyed.adapter.start(keyed.req);
    expect(last(await collect(keyed.adapter, run))).toMatchObject({ type: "run.ended", reason: "completed" });
    const log = await readLog(keyed.logFile);
    expect(log.find((l) => l.kind === "authenticate")).toMatchObject({ params: { methodId: "gemini-api-key" } });
    expect(log.find((l) => l.kind === "launch")).toMatchObject({ key: "present" });

    const signin = await setup("auth-signin", "hello", WORKTREE, { kind: "plan_signin", secretRef: null }, { FAKE_ACP_REQUIRE_AUTH: "1" });
    await expect(signin.adapter.start(signin.req)).rejects.toThrow(/not signed in for profile "gemini work"/);
    expect((await readLog(signin.logFile)).some((l) => l.kind === "authenticate")).toBe(false);
  });

  it("runs input sent during a turn after it, then completes", async () => {
    const { adapter, req, logFile } = await setup("queue", "approve");
    const run = await adapter.start(req);
    const events = await collect(adapter, run, async (ev) => {
      if (ev.type === "request.approval") {
        await adapter.send(run, { kind: "text", text: "and then this" });
        await adapter.answer(run, ev.requestId, { kind: "approval", decision: "allow_once" });
      }
    });
    expect(texts(events)).toEqual(["outcome:proceed_once", "ok"]);
    expect(last(events)).toMatchObject({ type: "run.ended", reason: "completed" });
    expect((await readLog(logFile)).filter((l) => l.kind === "prompt").map((l) => l.text)).toEqual(["approve", "and then this"]);
  });

  it("resumes with session/load in a new process without replaying history", async () => {
    const first = await setup("resume", "basic");
    const run = await first.adapter.start(first.req);
    await collect(first.adapter, run);
    const ref = run.nativeSession;
    if (!ref) throw new Error("no native session");

    const again = fakeAdapter();
    const resumed = await again.resume(ref, { ...first.req, prompt: "next" });
    const events = await collect(again, resumed);
    expect(texts(events)).toEqual(["ok"]);
    expect((await readLog(first.logFile)).find((l) => l.kind === "session.load")).toMatchObject({ params: { sessionId: ref.sessionId, cwd: first.req.cwd } });

    process.env.FAKE_ACP_LOAD = "0";
    await expect(fakeAdapter().resume(ref, first.req)).rejects.toThrow(/does not support session\/load/);
  });

  it("stops a run and kills the agent", async () => {
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
