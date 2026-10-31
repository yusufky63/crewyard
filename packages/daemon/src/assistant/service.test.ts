import { join } from "node:path";
import { capabilities, FakeAdapter, type FakeStep } from "@crewyard/adapter-fake";
import type { AssistantView } from "@crewyard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantFor } from "../handlers/assistant.ts";
import { mcpServiceFor } from "../handlers/mcp.ts";
import type { HandlerContext } from "../handlers/types.ts";
import { pipePath } from "../mcp/pipe.ts";
import { ASSISTANT_KEY } from "../mcp/service.ts";
import { AdapterRegistry } from "../orchestrator/adapters.ts";
import type { Candidate } from "../orchestrator/directory.ts";
import { orchestratorFor } from "../orchestrator/index.ts";
import { candidate, cleanTemps, model, tempDir, tempRepo, waitFor } from "../orchestrator/testing.ts";
import { Store } from "../store.ts";

// The task assistant end to end inside the daemon: the real orchestrator, MCP service and report
// pipe, with the fake runner calling propose_task through the pipe as a CLI would (docs/adr/0014).

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const plain = { protect: async (b: Buffer) => Buffer.from(b), unprotect: async (b: Buffer) => Buffer.from(b) };
const say = (text: string): FakeStep => ({ emit: { type: "message.delta", text } });
const propose = (args: unknown): FakeStep => ({ mcp: { tool: "propose_task", arguments: args } });
const usage = (tokensIn: number, tokensOut: number): FakeStep => ({
  emit: { type: "usage.update", tokensIn, tokensOut, cacheRead: 0, cacheWrite: 0, reasoning: 0, contextUsed: null, contextSize: null, costUsd: null, costProvenance: "unknown" },
});

const TWO_DRAFTS: FakeStep[] = [
  { emit: { type: "turn.started", turnRef: null } },
  { emit: { type: "tool.call", toolCallId: "t1", title: "Read README.md", kind: "read", input: {} } },
  propose({ title: "Find why the Windows build is slow", description: "Measure a cold and a warm build.", kind: "research", acceptance_criteria: ["Which step takes longest?", "Does Defender scan the output folder?"], size: "S" }),
  propose({ title: "Cache the dependency install in CI", kind: "code", size: "M" }),
  say("I drafted two tasks: "),
  say("one to research, one to change CI."),
  usage(1_000_000, 100_000),
];

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
  cleanTemps();
});

async function setup(script: FakeStep[], opts: { candidates?: Candidate[]; idleMs?: number } = {}) {
  const root = tempDir("crewyard assistant-");
  const repo = await tempRepo(root);
  const store = new Store(join(root, "t.db"));
  const project = store.addProject(repo, "demo repo");
  const fake = new FakeAdapter(script);
  const adapters = new AdapterRegistry({});
  adapters.set("fake", fake);
  const topics: Array<{ topic: string; payload: unknown }> = [];
  const ctx: HandlerContext = { store, info: { startedAt: new Date().toISOString(), dbPath: join(root, "t.db"), dataDir: join(root, "data") }, emit: (topic, payload) => topics.push({ topic, payload }) };
  const candidates = opts.candidates ?? [candidate("cheap", "deepseek", model("deepseek-chat", { cost: { input: 0.27, output: 1.1, cacheRead: 0.07 } })), candidate("strong", "openai", model("gpt-5", { cost: { input: 1.25, output: 10, cacheRead: 0.125 } }))];
  const o = orchestratorFor(ctx, { adapters, directory: { candidates: () => candidates, envFor: () => ({ OPENAI_API_KEY: "sk-test-not-a-real-key-123456" }) }, tickMs: 0, stallCheckMs: 0, hibernateCheckMs: 0, scheduleCheckMs: 0, freeMemoryMb: () => 64_000 });
  const mcp = mcpServiceFor(ctx, { pipePath: pipePath(), protector: plain });
  const a = assistantFor(ctx, { emitMs: 0, freeMemoryMb: () => 64_000, idleMs: opts.idleMs ?? 60_000 });
  open.push(async () => {
    a.shutdown();
    o.shutdown();
    await o.settle();
    await mcp.close();
    store.close();
  });
  return { a, o, mcp, store, project, fake, topics, repo };
}

const waitState = (a: { get(id: string): AssistantView }, projectId: string, state: AssistantView["state"]) => waitFor(() => (a.get(projectId).state === state ? a.get(projectId) : null));

describe("task assistant", () => {
  it("drafts two tasks through propose_task, read-only, and adds one as a task waiting for its crew", async () => {
    const s = await setup(TWO_DRAFTS);
    const profiles = await s.a.profiles(s.project.id);
    // The cheapest eligible profile is the default.
    expect(profiles.map((p) => p.profileId)).toEqual(["cheap", "strong"]);
    await s.a.send(s.project.id, "strong", "The Windows build is slow and CI installs everything every time.");
    const view = await waitState(s.a, s.project.id, "waiting");

    const started = s.fake.inspect({ runId: "fake-1", runner: "fake", pid: null, nativeSession: null }).started;
    expect(started.prompt.split("\n")[0]).toBe("Role: Assistant");
    expect(started.prompt).toContain("The Windows build is slow");

    expect(view.lines.map((l) => [l.role, l.text])).toEqual([
      ["user", "The Windows build is slow and CI installs everything every time."],
      ["tool", "Read README.md"],
      ["assistant", "I drafted two tasks: one to research, one to change CI."],
    ]);
    expect(view.drafts).toHaveLength(2);
    expect(view.drafts[0]).toMatchObject({ title: "Find why the Windows build is slow", kind: "research", acceptance: ["Which step takes longest?", "Does Defender scan the output folder?"], size: "S", status: "open", taskId: null });
    expect(view.profileAlias).toBe("strong");
    // 1M in and 100k out at 1.25 / 10 per million: Estimated, from the catalog.
    expect(view.spend).toEqual({ usd: 2.25, label: "estimated", tokensIn: 1_000_000, tokensOut: 100_000 });
    expect(s.topics.some((t) => t.topic === "assistant.changed")).toBe(true);

    // Nothing became a task on its own.
    expect(s.o.list(s.project.id)).toHaveLength(0);
    const { taskId, draft } = await s.a.addDraft(view.drafts[0]!.id, { ...view.drafts[0]!, title: "Find why the Windows build is slow on CI", acceptance: ["Which step takes longest?"] });
    expect(draft).toMatchObject({ status: "added", taskId, title: "Find why the Windows build is slow on CI" });
    const task = s.o.get(taskId);
    expect(task).toMatchObject({ title: "Find why the Windows build is slow on CI", kind: "research", status: "proposed" });
    expect(task.description).toBe("Measure a cold and a warm build.\n\nAcceptance criteria:\n- Which step takes longest?");
    expect(task.runs).toHaveLength(0);
    // Adding twice gives the same task; a discarded draft cannot be added.
    expect((await s.a.addDraft(view.drafts[0]!.id)).taskId).toBe(taskId);
    expect(s.a.discardDraft(view.drafts[1]!.id).status).toBe("discarded");
    await expect(s.a.addDraft(view.drafts[1]!.id)).rejects.toThrow("assistant.draft_discarded");
    expect(() => s.a.discardDraft(view.drafts[0]!.id)).toThrow("assistant.draft_added");
    await expect(s.a.addDraft(view.drafts[1]!.id.replace(/./, "x"))).rejects.toThrow();
  });

  it("starts the runner with the read-only policy and only Crewyard's report server", async () => {
    const s = await setup(TWO_DRAFTS);
    const starts: unknown[] = [];
    const origStart = s.fake.start.bind(s.fake);
    s.fake.start = async (req) => {
      starts.push(req);
      return origStart(req);
    };
    await s.a.send(s.project.id, "cheap", "Plan the docs work");
    await waitState(s.a, s.project.id, "waiting");
    const req = starts[0] as { policy: unknown; mcpServers: Array<{ name: string; builtin: boolean; env: Record<string, string> }>; cwd: string };
    expect(req.policy).toEqual({ writes: "none", allowCommands: [], network: "denied" });
    expect(req.mcpServers.map((m) => [m.name, m.builtin])).toEqual([["crewyard", true]]);
    expect(req.cwd).toBe(s.repo);
  });

  it("denies every approval and cancels questions, and hands your next message to the waiting session", async () => {
    const s = await setup([
      { emit: { type: "request.approval", requestId: "a1", toolCallId: null, command: "git push", cwd: null, paths: [], network: false } },
      { awaitAnswer: "a1" },
      { emit: { type: "request.question", requestId: "q1", questions: [{ prompt: "Which?", options: [{ label: "x" }], allowFreeText: false }] } },
      { awaitAnswer: "q1" },
      say("Which part is slow?"),
    ]);
    await s.a.send(s.project.id, "cheap", "Speed things up");
    const view = await waitState(s.a, s.project.id, "waiting");
    const handle = { runId: "fake-1", runner: "fake" as const, pid: null, nativeSession: null };
    expect(s.fake.inspect(handle).answers).toEqual([{ kind: "approval", decision: "deny", message: expect.stringContaining("read-only") }, { kind: "cancel" }]);
    expect(view.lines.filter((l) => l.role === "notice").map((l) => l.text)).toEqual(["denied", "question_cancelled"]);
    await s.a.send(s.project.id, "cheap", "The tests.");
    await waitFor(() => s.fake.inspect(handle).inputs.length === 1);
    expect(s.fake.inspect(handle).inputs[0]).toMatchObject({ text: "The tests." });
    await expect(s.a.send(s.project.id, "strong", "other profile")).rejects.toThrow("assistant.profile_in_use");
  });

  it("stops when the panel closes, revokes its ticket, keeps the conversation, and resumes on the next message", async () => {
    const s = await setup(TWO_DRAFTS);
    await s.a.send(s.project.id, "cheap", "First");
    const before = await waitState(s.a, s.project.id, "waiting");
    const stopped = await s.a.stop(s.project.id);
    expect(stopped).toMatchObject({ state: "idle", ended: "closed" });
    expect(stopped.lines.at(-1)).toMatchObject({ role: "notice", text: "ended.closed" });
    expect(stopped.drafts).toHaveLength(2);
    expect(s.mcp.tickets.runFor("x".repeat(40))).toBeNull();
    expect(await s.a.toolCall(before.conversationId!, "propose_task", { title: "late", kind: "code" })).toMatchObject({ isError: true });
    // The pipe refuses the old ticket too: nothing holds a live assistant key any more.
    expect([...((s.mcp.tickets as unknown as { byRun: Map<string, string> }).byRun.keys())].some((k) => k.startsWith(ASSISTANT_KEY))).toBe(false);
    // A real runner resumes the session in a new process; the fake starts a fresh script for it.
    const resumed: Array<{ sessionId: string; prompt: string }> = [];
    s.fake.resume = async (ref, req) => {
      resumed.push({ sessionId: ref.sessionId, prompt: req.prompt });
      return s.fake.start(req);
    };
    await s.a.send(s.project.id, "cheap", "Second");
    const again = await waitState(s.a, s.project.id, "waiting");
    expect(again.conversationId).toBe(before.conversationId);
    // Resumed by session id with only the new message: the session already holds the rest.
    expect(resumed).toEqual([{ sessionId: "fake-1", prompt: "Second" }]);
    expect(again.lines.filter((l) => l.role === "user").map((l) => l.text)).toEqual(["First", "Second"]);
  });

  it("stops after the idle time and on New conversation clears open drafts", async () => {
    const s = await setup(TWO_DRAFTS, { idleMs: 200 });
    await s.a.send(s.project.id, "cheap", "Hello");
    await waitFor(() => (s.a.get(s.project.id).ended === "idle" ? true : null));
    expect(s.a.get(s.project.id).state).toBe("idle");
    const cleared = await s.a.clear(s.project.id);
    expect(cleared).toMatchObject({ conversationId: null, lines: [], drafts: [] });
  });

  it("refuses a profile that cannot run read-only or has no MCP, and a key whose daily cap is used up", async () => {
    const noMcp = { ...candidate("no-mcp", "openai", model("gpt-5")), capabilities: { ...capabilities, mcp: undefined } };
    const capped = { ...candidate("capped", "deepseek", model("deepseek-chat")), credentialId: "cred-capped" };
    const s = await setup(TWO_DRAFTS, { candidates: [noMcp, capped] });
    s.store.db.prepare("insert into credentials (id, alias, provider_id, kind, daily_cap_usd, task_cap_usd, created_at) values ('cred-capped', 'capped', 'deepseek', 'api_key', 0, null, '2026-10-30T00:00:00Z')").run();
    const profiles = await s.a.profiles(s.project.id);
    expect(profiles.find((p) => p.profileId === "no-mcp")?.unavailable).toBe("no_mcp");
    await expect(s.a.send(s.project.id, "no-mcp", "hi")).rejects.toThrow("assistant.unavailable.no_mcp");
    await expect(s.a.send(s.project.id, "capped", "hi")).rejects.toThrow("assistant.daily_cap");
    await expect(s.a.send(s.project.id, "missing", "hi")).rejects.toThrow("assistant.no_profile");
    await expect(s.a.send(s.project.id, "capped", "   ")).rejects.toThrow("assistant.message_empty");
    await expect(s.a.send(s.project.id, "capped", "x".repeat(8_001))).rejects.toThrow("assistant.message_too_long");
  });

  it("writes its spend to the key's ledger with no task, and stops when that reaches the daily cap", async () => {
    const keyed = { ...candidate("keyed", "openai", model("gpt-5", { cost: { input: 1.25, output: 10, cacheRead: 0.125 } })), credentialId: "cred-k" };
    const s = await setup([...TWO_DRAFTS, { wait: 50 }], { candidates: [keyed] });
    s.store.db.prepare("insert into credentials (id, alias, provider_id, kind, daily_cap_usd, task_cap_usd, created_at) values ('cred-k', 'k', 'openai', 'api_key', 1, null, '2026-10-30T00:00:00Z')").run();
    await s.a.send(s.project.id, "keyed", "Go");
    await waitFor(() => (s.a.get(s.project.id).ended === "daily_cap" ? true : null));
    const rows = s.store.db.prepare("select task_id, run_id, credential_id, cost_usd, source from spend").all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([{ task_id: null, run_id: null, credential_id: "cred-k", cost_usd: 2.25, source: "estimated" }]);
  });

  it("refuses bad drafts and more than the cap per conversation", async () => {
    const many = Array.from({ length: 21 }, (_, i) => propose({ title: `Task ${i}`, kind: "docs" }));
    const s = await setup([propose({ title: "", kind: "code" }), propose({ title: "x", kind: "deploy" }), ...many]);
    await s.a.send(s.project.id, "cheap", "Lots");
    await waitState(s.a, s.project.id, "waiting");
    const results = s.fake.inspect({ runId: "fake-1", runner: "fake", pid: null, nativeSession: null }).mcpResults;
    expect(results[0]).toMatchObject({ isError: true, text: expect.stringContaining("title must not be empty") });
    expect(results[1]).toMatchObject({ isError: true, text: expect.stringContaining("kind must be one of") });
    expect(results.at(-1)).toMatchObject({ isError: true, text: expect.stringContaining("already has 20 drafts") });
    expect(s.a.get(s.project.id).drafts).toHaveLength(20);
  });
});
