import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentEvent, REVIEW_VERDICT_OUTPUT, type Profile, type RolePolicy, type StartRequest } from "@crewyard/core";
import { WINDOWS_SYSTEM_VARS } from "@crewyard/proc";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter, compareVersions, shellEnvPolicy, type CodexStartRequest } from "./adapter.ts";
import { DEFAULT_ARGS, childEnv } from "./appserver.ts";
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
    // Read from disk here, not imported, so the test catches the version going back to a literal.
    const appVersion = (JSON.parse(readFileSync(fileURLToPath(new URL("../../../apps/desktop/package.json", import.meta.url)), "utf8")) as { version: string }).version;
    expect(sentBy(log, "initialize")[0]).toMatchObject({ clientInfo: { name: "crewyard", version: appVersion }, capabilities: { experimentalApi: true } });
    expect(log.some((e) => (e.in as { method?: string } | undefined)?.method === "initialized")).toBe(true);
    expect(sentBy(log, "thread/start")[0]).toEqual({ cwd: dir, approvalPolicy: "on-request", sandbox: "workspace-write", model: "gpt-5.5-codex", config: { "agents.enabled": false, "features.default_mode_request_user_input": true, ...shellEnvPolicy({ CREWYARD_TEST_SECRET: "s3cret" }) } });
    expect((sentBy(log, "thread/start")[0] as { config: object }).config).toMatchObject({ "shell_environment_policy.ignore_default_excludes": false, "shell_environment_policy.exclude": ["CODEX_API_KEY", "CREWYARD_TEST_SECRET", "OPENAI_API_KEY"] });
    expect(JSON.stringify(sentBy(log, "thread/start"))).not.toContain("s3cret");
    expect(sentBy(log, "turn/start")[0]).toEqual({ threadId: "thr-1", input: [{ type: "text", text: "Fix the bug", text_elements: [] }], model: "gpt-5.5-codex", effort: "high" });
  });

  it("surfaces approvals and answers them through the JSON-RPC response", async () => {
    const dir = home({ scenario: "approval" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.start(request(dir));
    const events = await collect(adapter, run, async (e) => {
      if (e.type !== "request.approval") return;
      await adapter.answer(run, e.requestId, e.command ? { kind: "approval", decision: "allow_once" } : { kind: "approval", decision: "deny", message: " Edit src/b.ts instead. " });
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
    // The reason has no place in the reply, so it reaches the agent as a steer into the same turn.
    expect(sentBy(log, "turn/steer")).toEqual([{ threadId: "thr-1", input: [{ type: "text", text: "The user denied that request: Edit src/b.ts instead.", text_elements: [] }], expectedTurnId: "turn-1" }]);
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

  it("lets a read-only role run the project's test command and nothing chained to it", async () => {
    const dir = home({ scenario: "reviewer-tests" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.start(request(dir, { policy: { writes: "none", allowCommands: ["npm test"], network: "denied" } }));
    const events = await collect(adapter, run);
    expect(events.some((e) => e.type === "request.approval")).toBe(false);
    expect(events.filter((e) => e.type === "run.state" && e.detail).map((e) => (e.type === "run.state" ? e.detail : ""))).toEqual(["command allowed: project test or build command: npm test", "command declined: read-only role: npm test; git push"]);
    expect(received(dir).filter((e) => e.answered).map((e) => e.response)).toEqual([{ decision: "accept" }, { decision: "decline" }]);
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
    expect(received(dir).some((e) => e.refused)).toBe(false);
  });

  it("turns on questions in Default mode for resumed threads too", async () => {
    const dir = home({ scenario: "question" });
    const adapter = new CodexAdapter(launcher);
    const run = await adapter.resume({ runner: "codex", sessionId: "thr-old" }, request(dir));
    const events = await collect(adapter, run, async (e) => {
      if (e.type === "request.question") await adapter.answer(run, e.requestId, { kind: "question", answers: [{ selected: ["Postgres"] }, { selected: [], text: "t" }] });
    });
    expect(sentBy(received(dir), "thread/resume")[0]).toMatchObject({ config: { "features.default_mode_request_user_input": true } });
    expect(events.some((e) => e.type === "request.question")).toBe(true);
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

  it("steers only a turn in flight, and takes queued follow-ups at the turn boundary as the next turn", async () => {
    const hung = home({ scenario: "hang" });
    const adapter = new CodexAdapter(launcher);
    const live = await adapter.start(request(hung));
    await collect(adapter, live, async (e) => {
      if (e.type === "run.state" && e.state === "running") {
        await adapter.steer(live, { kind: "text", text: "use the shared helper" });
        await adapter.stop(live);
      }
    });
    expect(sentBy(received(hung), "turn/steer")[0]).toMatchObject({ input: [{ type: "text", text: "use the shared helper", text_elements: [] }], expectedTurnId: "turn-1" });

    const dir = home({ scenario: "basic" });
    const queued = ["also update the docs", null];
    const run = await adapter.start(request(dir, { nextTurn: async () => queued.shift() ?? null }));
    const events = await collect(adapter, run);
    const starts = sentBy(received(dir), "turn/start");
    expect(starts.map((p) => (p.input as Array<{ text: string }>)[0]!.text)).toEqual(["Fix the bug", "also update the docs"]);
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "run.ended", reason: "completed" });
    await expect(adapter.steer(run, { kind: "text", text: "late" })).rejects.toThrow();
  });

  it("undoes a finished thread's last turn with thread/rollback and says when codex has none", async () => {
    const dir = home({});
    const adapter = new CodexAdapter(launcher);
    const req = { profile: profile(dir), cwd: dir, env: {}, session: { runner: "codex" as const, sessionId: "thr-9" }, turnRef: "turn-1" };
    expect(await adapter.rewind(req)).toEqual({ files: false, history: true, detail: null });
    const log = received(dir);
    expect(sentBy(log, "thread/resume")[0]).toMatchObject({ threadId: "thr-9", excludeTurns: true });
    expect(sentBy(log, "thread/rollback")[0]).toEqual({ threadId: "thr-9", numTurns: 1 });
    // A turn/start would cost a model call; an undo must never send one.
    expect(sentBy(log, "turn/start")).toEqual([]);

    const newer = home({ noRollback: true });
    expect(await adapter.rewind({ ...req, profile: profile(newer), cwd: newer })).toMatchObject({ files: false, history: false, detail: expect.stringContaining("thread/rollback") });
  });

  it("finds the thread's rollout file under CODEX_HOME/sessions, newest day first", async () => {
    const dir = home({});
    const day = join(dir, "sessions", "2026", "10", "30");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-2026-10-30T01-02-03-thr-7.jsonl"), "{}\n");
    const adapter = new CodexAdapter(launcher);
    const req = { profile: profile(dir), cwd: dir, env: {}, session: { runner: "codex" as const, sessionId: "thr-7" } };
    expect(await adapter.transcript(req)).toEqual({ kind: "file", path: join(day, "rollout-2026-10-30T01-02-03-thr-7.jsonl"), ext: "jsonl" });
    expect(await adapter.transcript({ ...req, session: { runner: "codex", sessionId: "thr-8" } })).toBeNull();
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

  // Windows ends children with 0x40010004 at sign-out or restart: interrupted, so it can resume.
  // Only Windows keeps that status whole; POSIX keeps the low 8 bits.
  it.runIf(process.platform === "win32")("ends as interrupted when Windows ends codex at shutdown", async () => {
    const adapter = new CodexAdapter(launcher);
    const shutdown = await collect(adapter, await adapter.start(request(home({ scenario: "shutdown" }))));
    expect(shutdown.at(-1)).toMatchObject({ type: "run.ended", reason: "interrupted", detail: "windows_shutdown" });
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

  it("keeps an earlier native review's spend in a resumed thread's totals, so they never drop", async () => {
    const dir = home({ scenario: "basic" });
    // The review subagent codex ran on thr-old before, as its rollout records it.
    const at = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = join(dir, "sessions", String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()));
    mkdirSync(day, { recursive: true });
    const name = `rollout-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}-rv-1.jsonl`;
    const meta = { type: "session_meta", payload: { id: "rv-1", parent_thread_id: "thr-old", source: { subagent: "review" } } };
    const count = { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 50_000, cached_input_tokens: 40_000, cache_write_input_tokens: 0, output_tokens: 2_000, reasoning_output_tokens: 500, total_tokens: 52_000 } } } };
    writeFileSync(join(day, name), `${JSON.stringify(meta)}\n${JSON.stringify(count)}\n`);
    const adapter = new CodexAdapter(launcher);
    const events = await collect(adapter, await adapter.resume({ runner: "codex", sessionId: "thr-old" }, request(dir, { prompt: "Continue" })));
    // The turn's own 4,000 / 3,000 / 8,000 / 1,200 plus the review's 10,000 / 2,000 / 40,000 / 500.
    expect(events.find((e) => e.type === "usage.update")).toMatchObject({ tokensIn: 14_000, tokensOut: 5_000, cacheRead: 48_000, reasoning: 1_700 });
  });

  it("starts a resumed thread's web requests from its rollout and its reviews', so they never drop", async () => {
    const dir = home({ scenario: "basic" });
    const at = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = join(dir, "sessions", String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()));
    mkdirSync(day, { recursive: true });
    const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
    const web = (action: string) => JSON.stringify({ type: "response_item", payload: { type: "web_search_call", id: `c-${action}`, status: "completed", action: { type: action } } });
    // Earlier turns of thr-old searched twice and opened a page; its review searched once.
    writeFileSync(join(day, `rollout-${stamp}-thr-old.jsonl`), [JSON.stringify({ type: "session_meta", payload: { id: "thr-old", source: "vscode" } }), web("search"), web("open_page"), web("search"), ""].join("\n"));
    writeFileSync(join(day, `rollout-${stamp}-rv-1.jsonl`), [JSON.stringify({ type: "session_meta", payload: { id: "rv-1", parent_thread_id: "thr-old", source: { subagent: "review" } } }), web("search"), ""].join("\n"));
    const adapter = new CodexAdapter(launcher);
    const events = await collect(adapter, await adapter.resume({ runner: "codex", sessionId: "thr-old" }, request(dir, { prompt: "Continue" })));
    expect(events.find((e) => e.type === "usage.update")).toMatchObject({ webSearchRequests: 3, webFetchRequests: 1 });
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

describe("CodexAdapter: schema-checked results", () => {
  const good = { verdict: "changes", summary: "One bug.", comments: [{ file: "src/a.ts", line: 3, severity: "major", body: "Off by one." }] };
  const ended = (events: AgentEvent[]) => events.find((e) => e.type === "run.ended") as Extract<AgentEvent, { type: "run.ended" }>;
  const reviewer: RolePolicy = { writes: "none", allowCommands: [], network: "denied" };

  it("sends outputSchema with the turn and reads the final message as the result", async () => {
    const dir = home({ scenario: "structured", answers: [JSON.stringify(good)] });
    const adapter = new CodexAdapter(launcher);
    const events = await collect(adapter, await adapter.start(request(dir, { policy: reviewer, outputSchema: REVIEW_VERDICT_OUTPUT })));
    expect(ended(events)).toMatchObject({ reason: "completed", output: { ok: true, value: good } });
    const turns = sentBy(received(dir), "turn/start");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.outputSchema).toEqual(REVIEW_VERDICT_OUTPUT.jsonSchema);
    expect(sentBy(received(dir), "thread/start")[0]).toMatchObject({ sandbox: "read-only", config: { "agents.enabled": false } });
  });

  it("retries once in the same thread with the problem, then takes the fixed answer", async () => {
    const dir = home({ scenario: "structured", answers: ["The code looks fine.", JSON.stringify(good)] });
    const adapter = new CodexAdapter(launcher);
    const events = await collect(adapter, await adapter.start(request(dir, { outputSchema: REVIEW_VERDICT_OUTPUT })));
    const turns = sentBy(received(dir), "turn/start");
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ threadId: "thr-1", outputSchema: REVIEW_VERDICT_OUTPUT.jsonSchema });
    expect(JSON.stringify(turns[1]?.input)).toContain("contained no JSON object");
    expect(events.filter((e) => e.type === "run.ended")).toHaveLength(1);
    expect(ended(events)).toMatchObject({ reason: "completed", output: { ok: true, value: good } });
  });

  it("completes with the problem after one failed retry", async () => {
    const dir = home({ scenario: "structured", answers: ["{\"verdict\": \"maybe\"}", "{\"verdict\": \"maybe\"}", JSON.stringify(good)] });
    const adapter = new CodexAdapter(launcher);
    const events = await collect(adapter, await adapter.start(request(dir, { outputSchema: REVIEW_VERDICT_OUTPUT })));
    expect(sentBy(received(dir), "turn/start")).toHaveLength(2);
    expect(ended(events)).toMatchObject({ reason: "completed", output: { ok: false, error: expect.stringMatching(/^verdict: /) } });
  });

  it("leaves output off a run that asked for none", async () => {
    const dir = home({ scenario: "structured", answers: ["plain text"] });
    const adapter = new CodexAdapter(launcher);
    const events = await collect(adapter, await adapter.start(request(dir)));
    expect(ended(events)).toEqual(expect.not.objectContaining({ output: expect.anything() }));
    expect(sentBy(received(dir), "turn/start")[0]).not.toHaveProperty("outputSchema");
  });
});

describe("native review and fork", () => {
  const verdict = { verdict: "changes", summary: "One bug.", comments: [{ file: "src/a.ts", line: 3, severity: "major", body: "Off by one." }] };
  const ended = (events: AgentEvent[]) => events.find((e) => e.type === "run.ended") as Extract<AgentEvent, { type: "run.ended" }>;
  const reviewer: RolePolicy = { writes: "none", allowCommands: [], network: "denied" };

  it("runs review/start against the base branch, then maps the review to the verdict in the same thread", async () => {
    const dir = home({ scenario: "review", reviewText: "[P1] Off by one in src/a.ts:3", answers: [JSON.stringify(verdict)] });
    const adapter = new CodexAdapter(launcher);
    const events = await collect(adapter, await adapter.start(request(dir, { policy: reviewer, outputSchema: REVIEW_VERDICT_OUTPUT, review: { target: { kind: "base_branch", branch: "main" } } })));
    const log = received(dir);
    expect(sentBy(log, "review/start")[0]).toEqual({ threadId: "thr-1", target: { type: "baseBranch", branch: "main" }, delivery: "inline" });
    const turns = sentBy(log, "turn/start");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.outputSchema).toEqual(REVIEW_VERDICT_OUTPUT.jsonSchema);
    expect(JSON.stringify(turns[0]?.input)).toContain("Off by one in src/a.ts:3");
    expect(events.some((e) => e.type === "message.delta" && e.text.includes("[P1]"))).toBe(true);
    expect(ended(events)).toMatchObject({ reason: "completed", output: { ok: true, value: verdict } });
  });

  it("counts what codex's review subagent spent, which codex itself never reports", async () => {
    const reviewSpend = { input: 50_000, cached: 40_000, output: 2_000, reasoning: 500 };
    const dir = home({ scenario: "review", reviewText: "Looks right.", answers: [JSON.stringify({ ...verdict, verdict: "pass", comments: [] })], reviewSpend });
    const adapter = new CodexAdapter(launcher);
    const events = await collect(adapter, await adapter.start(request(dir, { policy: reviewer, outputSchema: REVIEW_VERDICT_OUTPUT, review: { target: { kind: "base_branch", branch: "main" } } })));
    const usage = events.filter((e): e is Extract<AgentEvent, { type: "usage.update" }> => e.type === "usage.update");
    // The subagent's last total landed just before the review ended: the end waited for it.
    expect(usage[0]).toMatchObject({ tokensIn: 10_000, tokensOut: 2_000, cacheRead: 40_000, reasoning: 500, contextUsed: null });
    // The verdict turn's own 1,000 in / 50 out on top: totals only grow, never read as a restart.
    expect(usage.at(-1)).toMatchObject({ tokensIn: 11_000, tokensOut: 2_050, cacheRead: 40_000, reasoning: 500, contextSize: 258_400 });
    expect(usage.map((u) => u.tokensIn)).toEqual([...usage.map((u) => u.tokensIn)].sort((a, b) => a - b));
    expect(ended(events)).toMatchObject({ reason: "completed", output: { ok: true } });
  });

  it("pins a commit target to its sha", async () => {
    const dir = home({ scenario: "review", reviewText: "Looks right.", answers: [JSON.stringify({ ...verdict, verdict: "pass", comments: [] })] });
    const adapter = new CodexAdapter(launcher);
    await collect(adapter, await adapter.start(request(dir, { outputSchema: REVIEW_VERDICT_OUTPUT, review: { target: { kind: "commit", sha: "abc123", title: "fix" } } })));
    expect(sentBy(received(dir), "review/start")[0]).toMatchObject({ target: { type: "commit", sha: "abc123", title: "fix" } });
  });

  it("forks the source rollout by path under the target profile and compacts it", async () => {
    const source = home();
    const rollout = join(source, "sessions", "2026", "10", "30");
    mkdirSync(rollout, { recursive: true });
    // The source searched once and opened a page: the fork's history holds both.
    const web = (action: string) => JSON.stringify({ type: "response_item", payload: { type: "web_search_call", id: `c-${action}`, status: "completed", action: { type: action } } });
    writeFileSync(join(rollout, "rollout-2026-10-30T10-00-00-thr-src.jsonl"), `{}\n${web("search")}\n${web("open_page")}\n`);
    const target = home();
    const adapter = new CodexAdapter(launcher);
    const res = await adapter.fork({
      source: { profile: { ...request(source).profile, configDir: source }, session: { runner: "codex", sessionId: "thr-src" }, env: {} },
      target: { profile: { ...request(target).profile, configDir: target }, model: "deepseek-pro", env: { DEEPSEEK_API_KEY: "k" } },
      cwd: target,
      compact: true,
    });
    expect(res).toEqual({
      session: { runner: "codex", sessionId: "thr-fork" },
      compacted: true,
      summary: null,
      usage: { tokensIn: 600, tokensOut: 120, cacheRead: 0, costUsd: null },
      totals: { tokensIn: 1600, tokensOut: 120, cacheRead: 0, costUsd: null, webSearchRequests: 1, webFetchRequests: 1 },
    });
    const log = received(target);
    expect(sentBy(log, "thread/fork")[0]).toMatchObject({ threadId: "thr-src", path: join(rollout, "rollout-2026-10-30T10-00-00-thr-src.jsonl"), model: "deepseek-pro", config: { "agents.enabled": false } });
    expect(sentBy(log, "thread/compact/start")[0]).toEqual({ threadId: "thr-fork" });
    expect(sentBy(log, "turn/start")).toHaveLength(0);
  });

  it("says the session is gone when the source has no rollout, and when codex has no such thread", async () => {
    const adapter = new CodexAdapter(launcher);
    const source = home();
    const target = home();
    const req = {
      source: { profile: { ...request(source).profile, configDir: source }, session: { runner: "codex" as const, sessionId: "thr-missing" }, env: {} },
      target: { profile: { ...request(target).profile, configDir: target }, model: null, env: {} },
      cwd: target,
      compact: false,
    };
    await expect(adapter.fork(req)).rejects.toMatchObject({ sessionProblem: "gone" });
    const dir = home({ resumeGone: true });
    await expect(adapter.resume({ runner: "codex", sessionId: "thr-x" }, request(dir))).rejects.toMatchObject({ sessionProblem: "gone" });
  });
});

describe("app-server launch", () => {
  it("turns codex's own subagents off", () => {
    expect(DEFAULT_ARGS).toEqual(["app-server", "--disable", "plugins", "--disable", "multi_agent"]);
  });

  it("passes every Windows system variable once and blocks other accounts' variables in any case", () => {
    const parent = { Path: "C:\\Windows", SystemRoot: "C:\\Windows", SystemDrive: "C:", ProgramData: "C:\\ProgramData", windir: "C:\\Windows", TEMP: "C:\\T", TMP: "C:\\T", USERPROFILE: "C:\\Users\\a b", APPDATA: "C:\\A", LOCALAPPDATA: "C:\\L", PATHEXT: ".EXE", ComSpec: "C:\\Windows\\system32\\cmd.exe", Openai_Api_Key: "parent-key", CODEX_HOME: "C:\\other" };
    const env = childEnv({ codexHome: "C:\\profiles\\work dir", env: { DEEPSEEK_API_KEY: "k" } }, parent);
    for (const name of WINDOWS_SYSTEM_VARS) expect(Object.keys(env).filter((k) => k.toUpperCase() === name.toUpperCase()), name).toHaveLength(1);
    expect(env.Openai_Api_Key).toBeUndefined();
    expect(env.CODEX_HOME).toBe("C:\\profiles\\work dir");
    expect(env.DEEPSEEK_API_KEY).toBe("k");
  });
});
