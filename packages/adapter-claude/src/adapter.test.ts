import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { AgentEvent, REVIEW_VERDICT_OUTPUT, type Profile, type RolePolicy, type StartRequest } from "@crewyard/core";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { SDK_CLI_VERSION, compareVersions, type ClaudeAdapterDeps } from "./adapter.ts";
import { fakeQuery, type Step } from "./fake-query.ts";
import { SESSION, assistant, errorResult, init, progress, result, stream, textDelta, thinkingDelta, toolResult, toolUse } from "./fixtures.ts";
import { capabilities, createAdapter } from "./index.ts";

const KEY = "sk-ant-api03-test-0000000000000000";
const EXE = "C:\\Users\\Test User\\.local\\bin\\claude.exe";

const profile: Profile = {
  id: "p1",
  alias: "Claude · work",
  runner: "claude-code",
  providerId: "anthropic",
  credential: { kind: "api_key", secretRef: "claude-work" },
  defaultModel: "claude-sonnet-5",
  configDir: "C:\\Users\\Test User\\AppData\\Roaming\\Crewyard\\profiles\\claude-code\\work",
  baseUrl: null,
};
const writer: RolePolicy = { writes: "worktree", allowCommands: [], network: "ask" };
const reviewer: RolePolicy = { writes: "none", allowCommands: [], network: "denied" };
const req = (over: Partial<StartRequest> = {}): StartRequest => ({ profile, cwd: "C:\\Work Trees\\demo repo", model: null, prompt: "Fix the failing test", policy: writer, env: { ANTHROPIC_API_KEY: KEY }, ...over });

function setup(turns: Step[][], deps: Partial<ClaudeAdapterDeps> = {}) {
  const fq = fakeQuery(turns);
  const killTree = vi.fn(async () => {});
  const adapter = createAdapter({
    query: fq.query,
    which: async () => EXE,
    run: async () => ({ code: 0, stdout: "2.1.312 (Claude Code)\n", stderr: "" }),
    killTree,
    env: { Path: "C:\\Windows", ANTHROPIC_API_KEY: "inherited-should-not-leak", anthropic_base_url: "https://elsewhere.example", CLAUDECODE: "1" },
    ...deps,
  });
  return { adapter, rec: fq.rec, killTree };
}

async function collect(events: AsyncIterable<AgentEvent>, onEvent: (e: AgentEvent) => void = () => {}): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) {
    out.push(e);
    onEvent(e);
  }
  return out;
}

const bash = { command: "pnpm test", description: "Run tests" };

describe("Claude adapter: one turn", () => {
  it("streams text and thoughts, asks for approval, reports plan and usage, then completes", async () => {
    const { adapter, rec } = setup([
      [
        init(),
        stream("msg_1", "start"),
        stream("msg_1", thinkingDelta("Check the test first.")),
        stream("msg_1", textDelta("Running the tests.")),
        assistant("msg_1", [{ type: "thinking", thinking: "Check the test first.", signature: "x" }, { type: "text", text: "Running the tests." }, toolUse("toolu_1", "Bash", bash)]),
        { ask: { tool: "Bash", input: bash, id: "toolu_1" } },
        progress("toolu_1"),
        progress("toolu_1", true),
        toolResult("toolu_1", "1 passed"),
        assistant("msg_2", [toolUse("toolu_2", "TodoWrite", { todos: [{ content: "Fix test", status: "completed", activeForm: "Fixing" }, { content: "Run lint", status: "in_progress", activeForm: "Linting" }] })]),
        assistant("msg_3", [{ type: "text", text: "All green." }]),
        result(),
      ],
    ]);
    const run = await adapter.start(req());
    expect(run.nativeSession?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const events = await collect(adapter.events(run), (e) => {
      if (e.type === "request.approval") void adapter.answer(run, e.requestId, { kind: "approval", decision: "allow_once" });
    });

    for (const e of events) expect(AgentEvent.safeParse(e).success).toBe(true);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.every((e) => e.source.adapter === "claude-code")).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      // turn.started carries the uuid of the prompt we sent: the turn's file checkpoint id.
      "run.state", "turn.started", "run.state", "thought.delta", "message.delta", "tool.call", "request.approval", "run.state", "run.state",
      "tool.update", "tool.update", "tool.call", "plan.update", "message.delta", "usage.update", "run.ended",
    ]);
    expect(events.filter((e) => e.type === "message.delta").map((e) => e.type === "message.delta" && e.text)).toEqual(["Running the tests.", "All green."]);
    expect(events.find((e) => e.type === "request.approval")).toMatchObject({ requestId: "perm-toolu_1", toolCallId: "toolu_1", command: "pnpm test", cwd: "C:\\Work Trees\\demo repo", network: false });
    expect(events.find((e) => e.type === "tool.call")).toMatchObject({ toolCallId: "toolu_1", kind: "execute", title: "Bash: Run tests" });
    expect(events.find((e) => e.type === "plan.update")).toMatchObject({ steps: [{ title: "Fix test", status: "completed" }, { title: "Run lint", status: "in_progress" }] });
    expect(events.find((e) => e.type === "usage.update")).toMatchObject({ tokensIn: 1800, tokensOut: 220, cacheRead: 6000, cacheWrite: 400, reasoning: 40, contextSize: 200_000, contextUsed: 4680, costUsd: 0.0151, costProvenance: "estimated" });
    expect(events.at(-1)).toMatchObject({ type: "run.ended", reason: "completed" });
    expect(events.at(-1)?.source.cliVersion).toBe("2.1.312");
    expect(rec.decisions).toEqual([{ tool: "Bash", result: { behavior: "allow", updatedInput: bash } }]);
  });

  it("starts the CLI with the profile's folder, its key, manual approvals and our own session id", async () => {
    const { adapter, rec } = setup([[init(), result()]]);
    const run = await adapter.start(req({ model: "claude-opus-4-8" }));
    await collect(adapter.events(run));
    const o = rec.options!;
    expect(o.pathToClaudeCodeExecutable).toBe(EXE);
    expect(o.cwd).toBe("C:\\Work Trees\\demo repo");
    expect(o.model).toBe("claude-opus-4-8");
    expect(o.permissionMode).toBe("default");
    expect(o.includePartialMessages).toBe(true);
    expect(o.allowedTools).toEqual(["TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]);
    expect(o.sessionId).toBe(run.nativeSession?.sessionId);
    expect(o.resume).toBeUndefined();
    expect(o.env).toMatchObject({ Path: "C:\\Windows", CLAUDE_CONFIG_DIR: profile.configDir, ANTHROPIC_API_KEY: KEY });
    expect(o.env).not.toHaveProperty("anthropic_base_url");
    expect(o.env).not.toHaveProperty("CLAUDECODE");
    expect(rec.prompts[0]?.message).toEqual({ role: "user", content: "Fix the failing test" });
  });

  it("refuses to start without a key or with a claude.ai sign-in profile", async () => {
    const { adapter } = setup([]);
    await expect(adapter.start(req({ env: {} }))).rejects.toThrow(/No API key/);
    await expect(adapter.start(req({ profile: { ...profile, credential: { kind: "plan_signin", secretRef: null } } }))).rejects.toThrow(/API key/);
    const missing = setup([], { which: async () => null }).adapter;
    await expect(missing.start(req())).rejects.toThrow(/not installed/);
  });
});

describe("Claude adapter: approvals and questions", () => {
  it("denies once with the user's message and keeps the CLI's always-allow rules in the session only", async () => {
    const write = { file_path: "C:\\Work Trees\\demo repo\\a.ts", content: "x" };
    const { adapter, rec } = setup([[init(), { ask: { tool: "Bash", input: bash, id: "t1" } }, { ask: { tool: "Write", input: write, id: "t2" } }, result()]]);
    const run = await adapter.start(req());
    await collect(adapter.events(run), (e) => {
      if (e.type !== "request.approval") return;
      void adapter.answer(run, e.requestId, e.toolCallId === "t1" ? { kind: "approval", decision: "deny", message: "Not now" } : { kind: "approval", decision: "allow_always" });
    });
    expect(rec.decisions[0]?.result).toEqual({ behavior: "deny", message: "Not now" });
    expect(rec.decisions[1]?.result).toEqual({ behavior: "allow", updatedInput: write, updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Write" }], behavior: "allow", destination: "session" }] });
  });

  it("uses an answer that arrived before the CLI asked", async () => {
    const { adapter, rec } = setup([[init(), { ask: { tool: "Bash", input: bash, id: "first" } }, { ask: { tool: "Bash", input: bash, id: "second" } }, result()]]);
    const run = await adapter.start(req());
    // Only the first request is answered from the stream; the second must come from the buffer.
    const events = await collect(adapter.events(run), (e) => {
      if (e.type !== "request.approval" || e.requestId !== "perm-first") return;
      void adapter.answer(run, "perm-second", { kind: "approval", decision: "deny" }).then(() => adapter.answer(run, "perm-first", { kind: "approval", decision: "allow_once" }));
    });
    expect(rec.decisions.map((d) => d.result.behavior)).toEqual(["allow", "deny"]);
    expect(events.filter((e) => e.type === "request.approval")).toHaveLength(2);
  });

  it("turns AskUserQuestion into request.question and fills in the answers by question text", async () => {
    const input = {
      questions: [
        { question: "Which test runner?", header: "Runner", multiSelect: false, options: [{ label: "Vitest", description: "Fast" }, { label: "Jest", description: "Familiar" }] },
        { question: "Which checks?", header: "Checks", multiSelect: true, options: [{ label: "Lint", description: "" }, { label: "Types", description: "" }] },
      ],
    };
    const { adapter, rec } = setup([[init(), { ask: { tool: "AskUserQuestion", input, id: "q1" } }, result()]]);
    const run = await adapter.start(req());
    const events = await collect(adapter.events(run), (e) => {
      if (e.type === "request.question") void adapter.answer(run, e.requestId, { kind: "question", answers: [{ selected: ["Vitest"] }, { selected: ["Lint", "Types"], text: "Lint first" }] });
    });
    expect(events.find((e) => e.type === "request.question")).toMatchObject({
      requestId: "q-q1",
      questions: [{ prompt: "Which test runner?", options: [{ label: "Vitest", description: "Fast" }, { label: "Jest", description: "Familiar" }], allowFreeText: true }, { prompt: "Which checks?" }],
    });
    expect(events.map((e) => (e.type === "run.state" ? e.state : null)).filter(Boolean)).toContain("waiting_input");
    expect(rec.decisions[0]?.result).toEqual({
      behavior: "allow",
      updatedInput: { ...input, answers: { "Which test runner?": "Vitest", "Which checks?": "Lint, Types" }, annotations: { "Which checks?": { notes: "Lint first" } } },
    });
  });

  it("enforces read-only roles without asking: the engine runs in dontAsk, write, network and subagent tools are denied", async () => {
    const { adapter, rec } = setup([[init(), { ask: { tool: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" }, id: "e1" } }, { ask: { tool: "WebFetch", input: { url: "https://example.com" }, id: "w1" } }, result()]]);
    const run = await adapter.start(req({ policy: { ...reviewer, allowCommands: ["pnpm test"] } }));
    const events = await collect(adapter.events(run));
    expect(events.some((e) => e.type === "request.approval")).toBe(false);
    expect(rec.decisions.map((d) => d.result.behavior)).toEqual(["deny", "deny"]);
    expect(rec.options?.permissionMode).toBe("dontAsk");
    expect(rec.options?.disallowedTools).toEqual(expect.arrayContaining(["Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Workflow", "AskUserQuestion"]));
    // The test command is pre-approved, since dontAsk would deny it and no approval can reach us.
    expect(rec.options?.allowedTools).toEqual(expect.arrayContaining(["Bash(pnpm test)", "Bash(pnpm test *)", "PowerShell(pnpm test)", "PowerShell(pnpm test *)"]));

    const hook = rec.options?.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const base = { session_id: SESSION, transcript_path: "t", cwd: "c", hook_event_name: "PreToolUse" as const, tool_use_id: "x" };
    const signal = new AbortController().signal;
    await expect(hook({ ...base, tool_name: "Write", tool_input: {} }, "x", { signal })).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await expect(hook({ ...base, tool_name: "Agent", tool_input: {} }, "x", { signal })).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    // Commands are the engine's call in dontAsk: read-only ones and the allowlist run, others are denied.
    await expect(hook({ ...base, tool_name: "Bash", tool_input: { command: "git diff" } }, "x", { signal })).resolves.toEqual({});
    await expect(hook({ ...base, tool_name: "Bash", tool_input: { command: "git log --oneline | head -5" } }, "x", { signal })).resolves.toEqual({});
    await expect(hook({ ...base, tool_name: "Read", tool_input: {} }, "x", { signal })).resolves.toEqual({});
    // The allowlist is pre-approved by prefix, so a chained or multi-line command on it is refused here.
    for (const command of ["pnpm test && curl https://example.com", "pnpm test\ncurl https://example.com", "pnpm test > out.txt", "pnpm test; Remove-Item x"]) {
      await expect(hook({ ...base, tool_name: "Bash", tool_input: { command } }, "x", { signal }), command).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    }
    await expect(hook({ ...base, tool_name: "PowerShell", tool_input: { command: "pnpm test | Out-File x" } }, "x", { signal })).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await expect(hook({ ...base, tool_name: "Bash", tool_input: { command: "pnpm test --run" } }, "x", { signal })).resolves.toEqual({});
  });

  it("gives a writer role manual approvals and only the subagent ban", async () => {
    const { adapter, rec } = setup([[init(), { ask: { tool: "Agent", input: { prompt: "explore" }, id: "a1" } }, result()]]);
    await collect(adapter.events(await adapter.start(req())));
    expect(rec.options?.permissionMode).toBe("default");
    expect(rec.options?.disallowedTools).toEqual(["Agent", "Workflow"]);
    expect(rec.decisions.map((d) => d.result.behavior)).toEqual(["deny"]);
    const hook = rec.options?.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const base = { session_id: SESSION, transcript_path: "t", cwd: "c", hook_event_name: "PreToolUse" as const, tool_use_id: "x" };
    const signal = new AbortController().signal;
    await expect(hook({ ...base, tool_name: "Workflow", tool_input: {} }, "x", { signal })).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await expect(hook({ ...base, tool_name: "Edit", tool_input: {} }, "x", { signal })).resolves.toEqual({});
  });
});

describe("Claude adapter: schema-checked results", () => {
  const good = { verdict: "pass", summary: "Looks right.", comments: [] };
  const ended = (events: AgentEvent[]) => events.find((e) => e.type === "run.ended") as Extract<AgentEvent, { type: "run.ended" }>;

  it("asks the CLI for json_schema output, hides its carrier tool and puts the checked value on run.ended", async () => {
    const carrier = assistant("msg_so", [toolUse("toolu_so", "StructuredOutput", good)]);
    const { adapter, rec } = setup([[init(), carrier, toolResult("toolu_so", "Structured output provided successfully"), result({ structured_output: good })]]);
    const events = await collect(adapter.events(await adapter.start(req({ policy: reviewer, outputSchema: REVIEW_VERDICT_OUTPUT }))));
    expect(rec.options?.outputFormat).toEqual({ type: "json_schema", schema: REVIEW_VERDICT_OUTPUT.jsonSchema });
    expect(events.some((e) => (e.type === "tool.call" || e.type === "tool.update") && e.toolCallId === "toolu_so")).toBe(false);
    expect(ended(events)).toMatchObject({ reason: "completed", output: { ok: true, value: good } });
    expect(rec.prompts).toHaveLength(1);
  });

  it("retries once in the same session when the value does not fit, then accepts the fix", async () => {
    const { adapter, rec } = setup([[init(), result({ structured_output: { verdict: "maybe" } })], [result({ structured_output: good })]]);
    const events = await collect(adapter.events(await adapter.start(req({ policy: reviewer, outputSchema: REVIEW_VERDICT_OUTPUT }))));
    expect(rec.prompts).toHaveLength(2);
    expect(String(rec.prompts[1]?.message.content)).toContain("did not match the required review_verdict JSON format: verdict:");
    expect(ended(events)).toMatchObject({ reason: "completed", output: { ok: true, value: good } });
  });

  it("completes with the problem when the retry fails too, and never retries twice", async () => {
    const { adapter, rec } = setup([[init(), result()], [errorResult("error_max_structured_output_retries", { errors: ["schema mismatch"] })], [result({ structured_output: good })]]);
    const events = await collect(adapter.events(await adapter.start(req({ policy: reviewer, outputSchema: REVIEW_VERDICT_OUTPUT }))));
    expect(rec.prompts).toHaveLength(2);
    expect(String(rec.prompts[1]?.message.content)).toContain("no JSON result was returned");
    expect(ended(events)).toMatchObject({ reason: "completed", output: { ok: false, error: expect.stringContaining("schema mismatch") } });
  });

  it("puts no output on a run that failed for another reason", async () => {
    const { adapter } = setup([[init(), errorResult("error_during_execution")]]);
    const events = await collect(adapter.events(await adapter.start(req({ outputSchema: REVIEW_VERDICT_OUTPUT }))));
    expect(ended(events).reason).toBe("failed");
    expect(ended(events).output).toBeUndefined();
  });
});

describe("Claude adapter: control", () => {
  it("interrupt cancels the open request and ends the run as interrupted", async () => {
    const { adapter, rec } = setup([[init(), { ask: { tool: "Bash", input: bash, id: "t1" } }, { block: true }]]);
    const run = await adapter.start(req());
    const events = await collect(adapter.events(run), (e) => {
      if (e.type === "request.approval") void adapter.interrupt(run);
    });
    expect(rec.decisions[0]?.result).toMatchObject({ behavior: "deny", interrupt: true });
    expect(rec.interrupts).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "run.ended", reason: "interrupted" });
  });

  it("resume passes the native session id to the SDK", async () => {
    const { adapter, rec } = setup([[init(), result()]]);
    const run = await adapter.resume({ runner: "claude-code", sessionId: SESSION }, req({ prompt: "Continue" }));
    await collect(adapter.events(run));
    expect(rec.options?.resume).toBe(SESSION);
    expect(rec.options?.sessionId).toBeUndefined();
    expect(run.nativeSession).toEqual({ runner: "claude-code", sessionId: SESSION });
    await expect(adapter.resume({ runner: "codex", sessionId: "x" }, req())).rejects.toThrow(/codex/);
  });

  it("setModel goes to the live query", async () => {
    const { adapter, rec } = setup([[init(), { ask: { tool: "Bash", input: bash, id: "t1" } }, result()]]);
    const run = await adapter.start(req());
    await collect(adapter.events(run), (e) => {
      if (e.type !== "request.approval") return;
      void adapter.setModel!(run, "claude-haiku-4-5").then(() => adapter.answer(run, e.requestId, { kind: "approval", decision: "allow_once" }));
    });
    expect(rec.models).toEqual(["claude-haiku-4-5"]);
  });

  it("stop closes the query and kills the CLI's process tree", async () => {
    const fakeChild = { pid: 4242, stderr: { setEncoding: () => ({ on: () => {} }) } } as unknown as ChildProcess;
    const spawn = vi.fn(() => fakeChild);
    const { adapter, rec, killTree } = setup([[init(), { spawn: { pid: 4242 } }, progress("t0"), { block: true }]], { spawn });
    const run = await adapter.start(req());
    const done = collect(adapter.events(run), (e) => {
      if (e.type === "tool.update") void adapter.stop(run);
    });
    const events = await done;
    expect(spawn).toHaveBeenCalledWith("claude.exe", [], expect.objectContaining({ cwd: "C:\\Work Trees\\demo repo" }));
    expect(run.pid).toBe(4242);
    expect(killTree).toHaveBeenCalledWith(4242);
    expect(rec.closed).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "run.ended", reason: "stopped" });
  });

  it("keeps the CLI open for a message sent mid-turn and closes it after that turn", async () => {
    const { adapter, rec } = setup([[init(), { ask: { tool: "Bash", input: bash, id: "t1" } }, result()], [result({ result: "Second" })]]);
    const run = await adapter.start(req());
    const events = await collect(adapter.events(run), (e) => {
      if (e.type !== "request.approval") return;
      void adapter.send(run, { kind: "text", text: "Also update the docs" }).then(() => adapter.answer(run, e.requestId, { kind: "approval", decision: "allow_once" }));
    });
    expect(rec.prompts.map((p) => p.message.content)).toEqual(["Fix the failing test", "Also update the docs"]);
    expect(events.filter((e) => e.type === "usage.update")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "run.ended", reason: "completed" });
    await expect(adapter.send(run, { kind: "text", text: "late" })).rejects.toThrow();
  });

  it("reports a CLI that Windows ended at shutdown as interrupted, not failed", async () => {
    // 0x40010004 is the status Windows gives children it ends at sign-out or restart.
    const fakeChild = Object.assign(new EventEmitter(), { pid: 4243, exitCode: null as number | null, stderr: { setEncoding: () => ({ on: () => {} }) } });
    const spawn = vi.fn(() => fakeChild as unknown as ChildProcess);
    const { adapter } = setup([[init(), { spawn: { pid: 4243 } }, { fail: "Claude Code process exited" }]], { spawn });
    const run = await adapter.start(req());
    setTimeout(() => fakeChild.emit("exit", 0x40010004, null), 20);
    const events = await collect(adapter.events(run));
    expect(events.at(-1)).toMatchObject({ type: "run.ended", reason: "interrupted", detail: "windows_shutdown" });
  });

  it("reports a crash as failed without leaking the key", async () => {
    const { adapter } = setup([[init(), { fail: `spawn failed with ANTHROPIC_API_KEY=${KEY}` }]]);
    const run = await adapter.start(req());
    const events = await collect(adapter.events(run));
    const end = events.at(-1);
    expect(end).toMatchObject({ type: "run.ended", reason: "failed" });
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(end?.type === "run.ended" && end.detail).toContain("[redacted]");
  });

  it("refuses a profile folder that is signed in to claude.ai", async () => {
    const { adapter, rec } = setup([[init({ apiKeySource: "oauth" }), { block: true }]]);
    const run = await adapter.start(req());
    const events = await collect(adapter.events(run));
    expect(rec.closed).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "run.ended", reason: "failed", detail: expect.stringMatching(/API keys/) });
  });
});

describe("Claude adapter: probe", () => {
  it("reports installation, version and credential problems without calling the API", async () => {
    const runCmd = vi.fn(async () => ({ code: 0, stdout: "2.1.306 (Claude Code)\n", stderr: "" }));
    const { adapter } = setup([], { run: runCmd });
    const p = await adapter.probe(profile);
    expect(p).toMatchObject({ installed: true, executable: EXE, version: "2.1.306", signedIn: true, capabilities });
    expect(p.problems).toEqual([expect.stringMatching(/older than 2\.1\.312/)]);
    expect(runCmd).toHaveBeenCalledWith(EXE, ["--version"], expect.objectContaining({ env: expect.objectContaining({ CLAUDE_CONFIG_DIR: profile.configDir }) }));

    const none = await setup([], { which: async () => null }).adapter.probe({ ...profile, credential: { kind: "api_key", secretRef: null } });
    expect(none).toMatchObject({ installed: false, executable: null, version: null, signedIn: false });
    expect(none.problems).toEqual([expect.stringMatching(/not installed/), expect.stringMatching(/No API key/)]);

    const signin = await setup([]).adapter.probe({ ...profile, credential: { kind: "plan_signin", secretRef: null } });
    expect(signin.problems).toEqual([expect.stringMatching(/claude\.ai sign-in is not supported/)]);
  });

  it("knows which CLI version the installed SDK was built for", () => {
    const pkg = JSON.parse(readFileSync(new URL("../node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url), "utf8")) as { claudeCodeVersion: string };
    expect(SDK_CLI_VERSION).toBe(pkg.claudeCodeVersion);
    expect(compareVersions("2.1.306", "2.1.312")).toBeLessThan(0);
    expect(compareVersions("2.2.0", "2.1.312")).toBeGreaterThan(0);
    expect(compareVersions("2.1.312-beta.1", "2.1.312")).toBe(0);
  });
});

describe("Claude adapter: turn control", () => {
  it("asks for queued follow-ups at the turn boundary and sends them as the next turn of the same session", async () => {
    const { adapter, rec } = setup([[init(), result()], [result()]]);
    const queued = ["Also add a test.", null];
    const nextTurn = vi.fn(async () => queued.shift() ?? null);
    const events = await collect(adapter.events(await adapter.start(req({ nextTurn }))));
    expect(rec.prompts.map((p) => p.message.content)).toEqual(["Fix the failing test", "Also add a test."]);
    expect(nextTurn).toHaveBeenCalledTimes(2);
    // Each prompt we send starts a turn, named by the uuid Claude Code checkpoints files under.
    const turns = events.filter((e) => e.type === "turn.started") as Array<Extract<AgentEvent, { type: "turn.started" }>>;
    expect(turns.map((e) => e.turnRef)).toEqual(rec.prompts.map((p) => p.uuid));
    expect(events.at(-1)).toMatchObject({ type: "run.ended", reason: "completed" });
    expect(rec.options?.enableFileCheckpointing).toBe(true);
    expect(rec.options?.extraArgs).toEqual({ "replay-user-messages": null });
  });

  it("does not ask for follow-ups after a failed turn", async () => {
    const nextTurn = vi.fn(async () => "never sent");
    const { adapter, rec } = setup([[init(), errorResult("error_during_execution")]]);
    await collect(adapter.events(await adapter.start(req({ nextTurn }))));
    expect(nextTurn).not.toHaveBeenCalled();
    expect(rec.prompts).toHaveLength(1);
  });

  it("rewinds a finished session's files with the CLI's own --rewind-files, on the profile's key only", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined; cwd: string | undefined }> = [];
    const run = vi.fn(async (_cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) => {
      calls.push({ args, env: opts.env, cwd: opts.cwd });
      return { code: 0, stdout: "Files rewound to state at message u-1\n", stderr: "" };
    });
    const { adapter } = setup([], { run });
    const rewind = { profile, cwd: req().cwd, env: { ANTHROPIC_API_KEY: KEY }, session: { runner: "claude-code" as const, sessionId: SESSION }, turnRef: "u-1" };
    expect(await adapter.rewind!(rewind)).toEqual({ files: true, history: false, detail: null });
    expect(calls[0]!.args).toEqual(["-p", "--resume", SESSION, "--rewind-files", "u-1"]);
    expect(calls[0]!.cwd).toBe(req().cwd);
    expect(calls[0]!.env).toMatchObject({ CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true", ANTHROPIC_API_KEY: KEY, CLAUDE_CONFIG_DIR: profile.configDir });

    run.mockResolvedValueOnce({ code: 1, stdout: "", stderr: `No file checkpoint found for this message (key ${KEY})\n` });
    const failed = await adapter.rewind!(rewind);
    expect(failed.files).toBe(false);
    expect(failed.detail).toContain("No file checkpoint found");
    expect(failed.detail).not.toContain(KEY);
    expect(await adapter.rewind!({ ...rewind, turnRef: null })).toMatchObject({ files: false });
  });

  it("finds the session's JSONL in the profile folder", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "crewyard claude profile "));
    try {
      mkdirSync(join(dir, "projects", "C--Work-Trees-demo-repo"), { recursive: true });
      writeFileSync(join(dir, "projects", "C--Work-Trees-demo-repo", `${SESSION}.jsonl`), "{}\n");
      const { adapter } = setup([]);
      const t = { profile: { ...profile, configDir: dir }, cwd: dir, env: {}, session: { runner: "claude-code" as const, sessionId: SESSION } };
      expect(await adapter.transcript!(t)).toEqual({ kind: "file", path: join(dir, "projects", "C--Work-Trees-demo-repo", `${SESSION}.jsonl`), ext: "jsonl" });
      expect(await adapter.transcript!({ ...t, session: { ...t.session, sessionId: "other" } })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("claims undo for files only and no steer", () => {
    expect(capabilities.undo).toEqual({ files: true, history: false });
    expect(capabilities.steer).toBeUndefined();
  });
});
