import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentEvent, type Profile, type RolePolicy, type StartRequest } from "@crewyard/core";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter, compareVersions, type CodexStartRequest } from "./adapter.ts";
import { startLogin } from "./login.ts";

// Drives the real adapter end to end against src/__fixtures__/fake-app-server.mjs, spawned through
// @crewyard/proc exactly like codex. Every folder has a space in it on purpose.

const launcher = { command: process.execPath, args: [fileURLToPath(new URL("./__fixtures__/fake-app-server.mjs", import.meta.url))] };
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function home(config: object = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "crewyard codex test "));
  dirs.push(dir);
  writeFileSync(join(dir, "fake.json"), JSON.stringify(config));
  return dir;
}

function profile(configDir: string): Profile {
  return { id: "p1", alias: "work", runner: "codex", providerId: "openai", credential: { kind: "plan_signin", secretRef: null }, defaultModel: "gpt-5.5", configDir, baseUrl: null };
}

const writer: RolePolicy = { writes: "worktree", allowCommands: [], network: "ask" };

function request(configDir: string, over: Partial<CodexStartRequest> = {}): CodexStartRequest {
  return { profile: profile(configDir), cwd: configDir, model: null, prompt: "Fix the bug", policy: writer, env: { CREWYARD_TEST_SECRET: "s3cret" }, ...over };
}

function received(configDir: string): Array<Record<string, unknown>> {
  return readFileSync(join(configDir, "fake-log.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const sentBy = (log: Array<Record<string, unknown>>, method: string) => log.flatMap((e) => (e.in && (e.in as { method?: string }).method === method ? [(e.in as { params: Record<string, unknown> }).params] : []));

async function collect(adapter: CodexAdapter, run: Awaited<ReturnType<CodexAdapter["start"]>>, onEvent?: (e: AgentEvent) => void | Promise<void>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of adapter.events(run)) {
    out.push(AgentEvent.parse(e));
    await onEvent?.(e);
  }
  return out;
}

describe("CodexAdapter against a fake app-server", () => {
  it("runs a turn and streams normalized events", async () => {
    const dir = home({ scenario: "basic" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.start(request(dir, { effort: "high", model: "gpt-5.5-codex" }));
    expect(run.nativeSession).toEqual({ runner: "codex", sessionId: "thr-1" });
    expect(run.pid).toBeGreaterThan(0);
    const events = await collect(adapter, run);

    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.every((e) => e.source.adapter === "codex" && e.source.cliVersion === "0.147.0")).toBe(true);
    expect(events[0]).toMatchObject({ type: "run.state", state: "starting" });
    expect(events.at(-1)).toMatchObject({ type: "run.ended", reason: "completed" });
    expect(events.filter((e) => e.type === "message.delta").map((e) => (e.type === "message.delta" ? e.text : "")).join("")).toBe("Fixed the bug.");
    expect(events.find((e) => e.type === "limit.update")).toMatchObject({ window: "5h", usedPct: 12, provenance: "reported" });
    expect(events.find((e) => e.type === "usage.update")).toMatchObject({ contextSize: 272000 });

    const log = received(dir);
    expect(log[0]).toMatchObject({ env: { CODEX_HOME: dir, CREWYARD_TEST_SECRET: "s3cret", OPENAI_API_KEY: null }, cwd: dir });
    expect(sentBy(log, "initialize")[0]).toMatchObject({ clientInfo: { name: "crewyard" }, capabilities: { experimentalApi: true } });
    expect(log.some((e) => (e.in as { method?: string } | undefined)?.method === "initialized")).toBe(true);
    expect(sentBy(log, "thread/start")[0]).toEqual({ cwd: dir, approvalPolicy: "on-request", sandbox: "workspace-write", model: "gpt-5.5-codex" });
    expect(sentBy(log, "turn/start")[0]).toEqual({ threadId: "thr-1", input: [{ type: "text", text: "Fix the bug", text_elements: [] }], model: "gpt-5.5-codex", effort: "high" });
  });

  it("surfaces approvals and answers them through the JSON-RPC response", async () => {
    const dir = home({ scenario: "approval" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.start(request(dir));
    const events = await collect(adapter, run, async (e) => {
      if (e.type !== "request.approval") return;
      await adapter.answer(run, e.requestId, e.command ? { kind: "approval", decision: "allow_once" } : { kind: "approval", decision: "deny" });
    });
    const approvals = events.filter((e) => e.type === "request.approval");
    expect(approvals).toMatchObject([
      { requestId: "srv-1", toolCallId: "cmd-1", command: "npm install", cwd: "C:\\work\\my repo", network: true, paths: [] },
      { requestId: "102", toolCallId: "fc-1", command: null, paths: ["src/a b.ts"], network: false },
    ]);
    expect(events.filter((e) => e.type === "run.state").map((e) => (e.type === "run.state" ? e.state : ""))).toEqual(["starting", "running", "waiting_approval", "running", "waiting_approval", "running"]);
    const log = received(dir);
    expect(log.filter((e) => e.answered)).toEqual([
      { answered: "command", response: { decision: "accept" } },
      { answered: "file", response: { decision: "decline" } },
    ]);
  });

  it("uses an answer that arrived before codex asked", async () => {
    const dir = home({ scenario: "approval" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.start(request(dir));
    await adapter.answer(run, "srv-1", { kind: "approval", decision: "allow_always" });
    await collect(adapter, run, async (e) => {
      if (e.type === "request.approval" && e.requestId === "102") await adapter.answer(run, "102", { kind: "approval", decision: "allow_once" });
    });
    expect(received(dir).filter((e) => e.answered)).toEqual([
      { answered: "command", response: { decision: "acceptForSession" } },
      { answered: "file", response: { decision: "accept" } },
    ]);
  });

  it("rejects an answer of the wrong kind without answering codex", async () => {
    const dir = home({ scenario: "approval" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.start(request(dir));
    await collect(adapter, run, async (e) => {
      if (e.type !== "request.approval") return;
      await expect(adapter.answer(run, e.requestId, { kind: "question", answers: [] })).rejects.toThrow(/expects a approval answer/);
      await adapter.answer(run, e.requestId, { kind: "cancel" });
    });
    expect(received(dir).filter((e) => e.answered).map((e) => e.response)).toEqual([{ decision: "cancel" }, { decision: "cancel" }]);
  });

  it("enforces read-only roles with the sandbox and by declining every write approval", async () => {
    const dir = home({ scenario: "readonly" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.start(request(dir, { policy: { writes: "none", allowCommands: [], network: "ask" } }));
    const events = await collect(adapter, run);
    expect(events.some((e) => e.type === "request.approval")).toBe(false);
    expect(events.filter((e) => e.type === "run.state" && e.detail?.includes("read-only"))).toHaveLength(2);
    const log = received(dir);
    expect(sentBy(log, "thread/start")[0]).toMatchObject({ sandbox: "read-only" });
    expect(log.filter((e) => e.answered).map((e) => e.response)).toEqual([{ decision: "decline" }, { decision: "decline" }]);
  });

  it("maps requestUserInput to a question and answers by question id", async () => {
    const dir = home({ scenario: "question" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.start(request(dir));
    const events = await collect(adapter, run, async (e) => {
      if (e.type === "request.question") await adapter.answer(run, e.requestId, { kind: "question", answers: [{ selected: ["SQLite"] }, { selected: [], text: "users" }] });
    });
    expect(events.find((e) => e.type === "request.question")).toMatchObject({ questions: [{ prompt: "Which database?", allowFreeText: true }, { prompt: "Table name?" }] });
    expect(events.some((e) => e.type === "run.state" && e.state === "waiting_input")).toBe(true);
    expect(received(dir).find((e) => e.answered)).toEqual({ answered: "question", response: { answers: { db: { answers: ["SQLite"] }, name: { answers: ["users"] } } } });
  });

  it("drops a pending request that codex resolved itself", async () => {
    const dir = home({ scenario: "resolved" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.start(request(dir));
    const events = await collect(adapter, run);
    expect(events.some((e) => e.type === "run.state" && e.detail === "request resolved by codex")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "run.ended", reason: "stopped" });
  });

  it("interrupts the turn in flight", async () => {
    const dir = home({ scenario: "hang" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.start(request(dir));
    const events = await collect(adapter, run, async (e) => {
      if (e.type === "run.state" && e.state === "running") await adapter.interrupt(run);
    });
    expect(sentBy(received(dir), "turn/interrupt")[0]).toEqual({ threadId: "thr-1", turnId: "turn-1" });
    expect(events.at(-1)).toMatchObject({ type: "run.ended", reason: "stopped", detail: "interrupted" });
  });

  it("steers a running turn with send()", async () => {
    const dir = home({ scenario: "hang" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.start(request(dir));
    await adapter.send(run, { kind: "text", text: "also update the docs" });
    await adapter.stop(run);
    expect(sentBy(received(dir), "turn/steer")[0]).toEqual({ threadId: "thr-1", input: [{ type: "text", text: "also update the docs", text_elements: [] }], expectedTurnId: "turn-1" });
  });

  it("stops a run, ends its stream and leaves no process behind", async () => {
    const dir = home({ scenario: "hang" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.start(request(dir));
    const stream = collect(adapter, run);
    await adapter.stop(run);
    const events = await stream;
    expect(events.at(-1)).toMatchObject({ type: "run.ended", reason: "stopped" });
    expect(() => process.kill(run.pid ?? 0, 0)).toThrow();
  });

  it("ends as limit when codex reports a usage limit, and as failed when it crashes", async () => {
    const limitDir = home({ scenario: "limit" });
    const adapter = new CodexAdapter(launcher);
    const limited = await collect(adapter, await adapter.start(request(limitDir)));
    expect(limited.at(-1)).toMatchObject({ type: "run.ended", reason: "limit", detail: "You've hit your usage limit." });

    const crashDir = home({ scenario: "crash" });
    const crashed = await collect(adapter, await adapter.start(request(crashDir)));
    expect(crashed.at(-1)).toMatchObject({ type: "run.ended", reason: "failed" });
  });

  it("resumes a thread by id and starts a turn with the new prompt", async () => {
    const dir = home({ scenario: "basic" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.resume({ runner: "codex", sessionId: "thr-old" }, request(dir, { prompt: "Continue" }));
    expect(run.nativeSession).toEqual({ runner: "codex", sessionId: "thr-old" });
    await collect(adapter, run);
    const log = received(dir);
    expect(sentBy(log, "thread/resume")[0]).toMatchObject({ threadId: "thr-old", sandbox: "workspace-write", excludeTurns: true });
    expect(sentBy(log, "turn/start")[0]).toMatchObject({ threadId: "thr-old", input: [{ text: "Continue" }] });
  });

  it("refuses to resume another runner's session", async () => {
    await expect(new CodexAdapter(launcher).resume({ runner: "opencode", sessionId: "x" }, request(home()))).rejects.toThrow(/opencode/);
  });
});

describe("probe, limits and login", () => {
  it("reports version and signed-in state from the app-server", async () => {
    const adapter = new CodexAdapter(launcher);
    expect(await adapter.probe(profile(home()))).toMatchObject({ installed: true, version: "0.147.0", signedIn: true, problems: [] });
    expect(await adapter.probe(profile(home({ account: "none" })))).toMatchObject({ signedIn: false });
  });

  it.runIf(process.platform === "win32")("flags a Windows sandbox that is not set up", async () => {
    const probe = await new CodexAdapter(launcher).probe(profile(home({ sandbox: "notConfigured" })));
    expect(probe.problems).toEqual(["codex Windows sandbox is notConfigured; run `codex` once to set it up"]);
  });

  it("reports a broken install as a problem instead of throwing", async () => {
    const adapter = new CodexAdapter({ command: join(tmpdir(), "no such codex", "codex.exe") });
    const probe = await adapter.probe(profile(home()));
    expect(probe.signedIn).toBeNull();
    expect(probe.problems).toHaveLength(1);
  });

  it("reads reported limits for ChatGPT accounts and Unknown for API keys", async () => {
    const adapter = new CodexAdapter(launcher);
    expect(await adapter.limits(profile(home()))).toMatchObject([
      { profileId: "p1", window: "5h", usedPct: 0, provenance: "reported" },
      { profileId: "p1", window: "weekly", usedPct: 43, provenance: "reported" },
    ]);
    expect(await adapter.limits(profile(home({ account: "apiKey" })))).toMatchObject([
      { window: "5h", usedPct: null, provenance: "unknown" },
      { window: "weekly", usedPct: null, provenance: "unknown" },
    ]);
  });

  it("starts a ChatGPT or device-code login and reports completion", async () => {
    const dir = home();
    const browser = await startLogin(profile(dir), { launcher });
    expect(browser).toMatchObject({ loginId: "login-1", mode: "chatgpt", url: "https://auth.example.test/authorize", userCode: null });
    await expect(browser.completed).resolves.toEqual({ success: true, error: null });

    const device = await startLogin(profile(home()), { launcher, mode: "deviceCode" });
    expect(device).toMatchObject({ url: "https://auth.example.test/device", userCode: "ABCD-1234" });
    await expect(device.completed).resolves.toEqual({ success: true, error: null });
    expect(sentBy(received(dir), "account/login/start")[0]).toEqual({ type: "chatgpt" });
  });
});

it("compares versions numerically", () => {
  expect(compareVersions("0.147.0", "0.147.0")).toBe(0);
  expect(compareVersions("0.99.0", "0.147.0")).toBe(-1);
  expect(compareVersions("0.166.0-alpha.1", "0.147.0")).toBe(1);
});

// Keeps the StartRequest shape honest: CodexStartRequest must stay assignable to it.
const _assignable: StartRequest = request("x");
void _assignable;
