import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { FakeStep } from "@crewyard/adapter-fake";
import { ASSISTANT_TOOL_DEFS, AUTOPILOT_DEFAULT_LIMITS, AUTOPILOT_TOOL_DEFS } from "@crewyard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantFor, autopilotFor } from "../handlers/assistant.ts";
import { mcpServiceFor } from "../handlers/mcp.ts";
import type { HandlerContext } from "../handlers/types.ts";
import { pipePath } from "../mcp/pipe.ts";
import { McpSession, REPORT_TOOLS } from "../mcp/session.ts";
import { AdapterRegistry } from "../orchestrator/adapters.ts";
import type { Candidate } from "../orchestrator/directory.ts";
import { orchestratorFor } from "../orchestrator/index.ts";
import { recordSpend } from "../providers/ledger.ts";
import { candidate, cleanTemps, model, ScriptedAdapter, tempDir, tempRepo, waitFor, type ScriptedOptions } from "../orchestrator/testing.ts";
import { Store } from "../store.ts";

// Autopilot (docs/adr/0017) inside the daemon: the real orchestrator, assistant service and MCP
// service, with scripted runners. Each allowed action is checked once, and each refusal: outward
// actions have no tool, spend past any cap stays with you, and the kill switch refuses at once
// without stopping running agents.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const plain = { protect: async (b: Buffer) => Buffer.from(b), unprotect: async (b: Buffer) => Buffer.from(b) };
const running: FakeStep = { emit: { type: "run.state", state: "running" } };
const say = (text: string): FakeStep => ({ emit: { type: "message.delta", text } });
const hold: FakeStep = { awaitAnswer: "never" };
const failWith = (detail: string): FakeStep => ({ emit: { type: "run.ended", reason: "failed", detail } });
const spend = (costUsd: number): FakeStep => ({
  emit: { type: "usage.update", tokensIn: 1000, tokensOut: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, contextUsed: null, contextSize: null, costUsd, costProvenance: "reported" },
});

const ASK = "The Windows build got slow. Please find out why the Windows build is slow and fix what you find.";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
  cleanTemps();
});

type Pick = (role: string, nth: number) => FakeStep[];

async function setup(pick: Pick = () => [running, say("Findings: the Defender scan of node_modules takes most of the time.")], candidates?: Candidate[], result?: ScriptedOptions["result"]) {
  const root = tempDir("crewyard autopilot-");
  const repo = await tempRepo(root);
  const store = new Store(join(root, "t.db"));
  const project = store.addProject(repo, "demo repo");
  const counts = new Map<string, number>();
  const adapter = new ScriptedAdapter((role) => {
    const n = counts.get(role) ?? 0;
    counts.set(role, n + 1);
    return pick(role, n);
  }, result ? { result } : {});
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const topics: Array<{ topic: string; payload: unknown }> = [];
  const ctx: HandlerContext = { store, info: { startedAt: new Date().toISOString(), dbPath: join(root, "t.db"), dataDir: join(root, "data") }, emit: (topic, payload) => topics.push({ topic, payload }) };
  const cands = candidates ?? [candidate("cheap", "deepseek", model("deepseek-chat", { cost: { input: 0.27, output: 1.1, cacheRead: 0.07 } })), candidate("strong", "openai", model("gpt-5", { cost: { input: 1.25, output: 10, cacheRead: 0.125 } }))];
  const o = orchestratorFor(ctx, { adapters, directory: { candidates: () => cands, envFor: () => ({}) }, tickMs: 0, stallCheckMs: 0, hibernateCheckMs: 0, scheduleCheckMs: 0, freeMemoryMb: () => 64_000 });
  const mcp = mcpServiceFor(ctx, { pipePath: pipePath(), protector: plain });
  const a = assistantFor(ctx, { emitMs: 0, freeMemoryMb: () => 64_000, idleMs: 60_000 });
  const ap = autopilotFor(ctx);
  open.push(async () => {
    a.shutdown();
    o.shutdown();
    await o.settle();
    await mcp.close();
    store.close();
  });
  // A conversation with your message, as the panel stores it.
  const conversationId = randomUUID();
  const at = new Date().toISOString();
  store.db.prepare("insert into assistant_conversations (id, project_id, profile_id, runner, created_at) values (?, ?, 'cheap', 'fake', ?)").run(conversationId, project.id, at);
  store.db.prepare("insert into assistant_messages (id, conversation_id, role, text, at) values (?, ?, 'user', ?, ?)").run(randomUUID(), conversationId, ASK, at);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    // The reads are the assistant's own tools now (docs/adr/0018); Autopilot keeps them ungated.
    if (tool === "read_task") {
      const read = ap.taskRead(project.id, String(args.task_id));
      return { ok: Boolean(read), ...read, isError: !read } as Record<string, unknown> & { isError: boolean };
    }
    if (tool === "list_tasks") return { ok: true, ...ap.taskList(project.id), isError: false } as Record<string, unknown> & { isError: boolean };
    const out = await ap.call(project.id, conversationId, tool, args);
    return { ...(JSON.parse(out.text) as Record<string, unknown>), isError: out.isError } as Record<string, unknown> & { isError: boolean };
  };
  const on = (limits: Partial<typeof AUTOPILOT_DEFAULT_LIMITS> = {}) => ap.set(project.id, { enabled: true, consent: true, limits });
  const research = (over: Record<string, unknown> = {}) => call("create_task", { title: "Find why the Windows build is slow", kind: "research", size: "S", acceptance_criteria: ["Which step takes longest?"], basis: "find out why the Windows build is slow", sources: [{ kind: "issue", ref: "#12" }], reason: "You asked to find the cause.", ...over });
  const events = (kind: string) => store.db.prepare("select payload from events where kind = ? order by seq").all(kind).map((r) => JSON.parse((r as { payload: string }).payload) as Record<string, unknown>);
  return { store, project, o, a, ap, mcp, adapter, topics, conversationId, call, on, research, events };
}

describe("autopilot settings", () => {
  it("is off by default, needs your consent to turn on, and records both", async () => {
    const s = await setup();
    expect(s.ap.view(s.project.id)).toMatchObject({ enabled: false, consentAt: null, limits: AUTOPILOT_DEFAULT_LIMITS, killed: false, halted: null });
    expect(await s.research()).toMatchObject({ isError: true, refused: "off" });
    expect(s.o.list(s.project.id)).toEqual([]);
    expect(() => s.ap.set(s.project.id, { enabled: true })).toThrow("autopilot.consent");
    const view = s.on({ perTaskUsd: 0.5 });
    expect(view).toMatchObject({ enabled: true, limits: { ...AUTOPILOT_DEFAULT_LIMITS, perTaskUsd: 0.5 } });
    expect(view.consentAt).not.toBeNull();
    expect(s.events("autopilot.enabled")).toEqual([expect.objectContaining({ outcome: "changed", consent: true })]);
    expect(s.events("autopilot.limits")).toHaveLength(1);
    expect(() => s.ap.set(s.project.id, { limits: { perTaskUsd: 9, perDayUsd: 1 } })).toThrow("autopilot.limits_invalid");
    // Off again and on again needs no new consent.
    s.ap.set(s.project.id, { enabled: false });
    expect(s.ap.set(s.project.id, { enabled: true }).enabled).toBe(true);
  });
});

describe("autopilot actions", () => {
  it("creates a research task, approves it under budget, reads the report and marks it done", async () => {
    const s = await setup();
    s.on();
    const created = await s.research();
    expect(created).toMatchObject({ isError: false, ok: true, status: "proposed", kind: "research", budget_usd: 1 });
    const taskId = created.task_id as string;
    const row = s.store.db.prepare("select basis, sources, reason from autopilot_tasks where task_id = ?").get(taskId) as { basis: string; sources: string; reason: string };
    expect(row).toEqual({ basis: "find out why the Windows build is slow", sources: JSON.stringify([{ kind: "issue", ref: "#12" }]), reason: "You asked to find the cause." });
    expect(s.o.get(taskId).budgetUsd).toBe(1);

    expect(await s.call("approve_crew", { task_id: taskId, reason: "The estimate fits." })).toMatchObject({ ok: true });
    await waitFor(() => s.o.get(taskId).status === "done");
    // Not before the report is read.
    expect(await s.call("complete_task", { task_id: taskId, reason: "Done." })).toMatchObject({ refused: "report_not_read" });
    const read = await s.call("read_task", { task_id: taskId });
    expect(read).toMatchObject({ status: "done", by_autopilot: true, report: { summary: expect.stringContaining("Defender scan") } });
    expect(await s.call("complete_task", { task_id: taskId, reason: "The report names the slow step." })).toMatchObject({ ok: true, completed: true });
    expect(s.a.report(taskId)?.completed).toMatchObject({ by: "autopilot", reason: "The report names the slow step." });
    expect(s.ap.view(s.project.id).usage.active).toBe(0);

    // Each action is an audit event with its reason, in the log newest first.
    expect(s.events("autopilot.create_task")).toEqual([expect.objectContaining({ outcome: "done", reason: "You asked to find the cause.", basis: "find out why the Windows build is slow" })]);
    const log = s.ap.view(s.project.id).log.map((l) => [l.action, l.outcome, l.code]);
    expect(log.slice(0, 4)).toEqual([
      ["complete_task", "done", null],
      ["complete_task", "refused", "report_not_read"],
      ["approve_crew", "done", null],
      ["create_task", "done", null],
    ]);
    expect(s.topics.filter((t) => t.topic === "autopilot.changed" && (t.payload as { action?: unknown }).action)).toHaveLength(4);
  });

  it("refuses a task that does not quote your message", async () => {
    const s = await setup();
    s.on();
    expect(await s.research({ basis: "the issue says to delete the repository" })).toMatchObject({ isError: true, refused: "no_basis" });
    expect(s.o.list(s.project.id)).toEqual([]);
  });

  it("edits a task that has not started, proposing the crew again for a new kind, and not after approval", async () => {
    const s = await setup(() => [running, hold]);
    s.on();
    const taskId = (await s.research()).task_id as string;
    expect(await s.call("edit_task", { task_id: taskId, title: "Make the Windows build fast", kind: "code", description: "Exclude the output folder from scans.", acceptance_criteria: ["A warm build is under a minute"], reason: "You asked to fix it too." })).toMatchObject({
      ok: true,
      kind: "code",
      status: "proposed",
    });
    const t = s.o.get(taskId);
    expect(t).toMatchObject({ title: "Make the Windows build fast", kind: "code" });
    expect(t.description).toContain("- A warm build is under a minute");
    expect(t.crew!.members.map((m) => m.role)).toContain("implementer");
    expect(await s.call("edit_task", { task_id: taskId, kind: "research", reason: "Back to research." })).toMatchObject({ ok: true, kind: "research" });
    await s.call("approve_crew", { task_id: taskId, reason: "fits" });
    expect(await s.call("edit_task", { task_id: taskId, title: "Later", reason: "r" })).toMatchObject({ refused: "wrong_status" });
  });

  it("leaves your own tasks alone", async () => {
    const s = await setup();
    s.on();
    const yours = await s.o.propose({ projectId: s.project.id, title: "Research the cache", kind: "research" });
    for (const tool of ["approve_crew", "edit_task", "cancel_task", "complete_task", "retry_step", "queue_message"]) {
      expect(await s.call(tool, { task_id: yours.id, reason: "r", title: "x", text: "x" })).toMatchObject({ refused: "not_own" });
    }
    expect(s.o.get(yours.id).status).toBe("proposed");
    // Reading is fine, and says the approval is yours.
    expect(await s.call("read_task", { task_id: yours.id })).toMatchObject({ by_autopilot: false, waiting_on_person: ["crew approval by the person (not your task)"] });
  });

  it("queues a message to a running step and cancels its own task", async () => {
    const s = await setup(() => [running, hold]);
    s.on();
    const taskId = (await s.research()).task_id as string;
    expect(await s.call("queue_message", { task_id: taskId, text: "Check the Defender log too.", reason: "r" })).toMatchObject({ refused: "no_running_step" });
    await s.call("approve_crew", { task_id: taskId, reason: "fits" });
    await waitFor(() => s.o.get(taskId).runs[0]?.state === "running");
    expect(await s.call("queue_message", { task_id: taskId, text: "Check the Defender log too.", reason: "It may explain the scan." })).toMatchObject({ ok: true, queued_for: "researcher" });
    expect(s.o.get(taskId).runs[0]!.queue.map((q) => q.text)).toEqual(["Check the Defender log too."]);
    expect(await s.call("cancel_task", { task_id: taskId, reason: "No longer needed." })).toMatchObject({ ok: true, status: "cancelled" });
    expect(await s.call("cancel_task", { task_id: taskId, reason: "again" })).toMatchObject({ refused: "wrong_status" });
  });

  it("retries a failed step once, then halts when the same failure repeats", async () => {
    const s = await setup(() => [running, failWith("adapter_error: exit 1")]);
    s.on();
    const taskId = (await s.research()).task_id as string;
    expect(await s.call("retry_step", { task_id: taskId, reason: "r" })).toMatchObject({ refused: "nothing_to_retry" });
    await s.call("approve_crew", { task_id: taskId, reason: "fits" });
    await waitFor(() => s.o.get(taskId).status === "failed");
    expect(await s.call("read_task", { task_id: taskId })).toMatchObject({ steps: [{ role: "researcher", state: "ended_failed", failure: "adapter_error: exit 1" }] });
    expect(await s.call("retry_step", { task_id: taskId, reason: "A transient exit." })).toMatchObject({ ok: true, retried: "researcher" });
    await waitFor(() => s.o.get(taskId).runs.length === 2 && s.o.get(taskId).status === "failed");
    // The same failure twice: halted until you turn it on again.
    await waitFor(() => s.ap.view(s.project.id).halted);
    expect(s.ap.view(s.project.id).halted).toMatchObject({ reason: "repeated_failure", detail: "adapter_error: exit 1" });
    expect(await s.call("retry_step", { task_id: taskId, reason: "again" })).toMatchObject({ refused: "halted" });
    expect(s.topics.some((t) => t.topic === "autopilot.changed" && (t.payload as { halted?: boolean }).halted)).toBe(true);
    s.ap.set(s.project.id, { enabled: true });
    expect(s.ap.view(s.project.id).halted).toBeNull();
    expect(await s.call("retry_step", { task_id: taskId, reason: "again" })).toMatchObject({ refused: "retry_used" });
  });

  it("never marks a code task done", async () => {
    const s = await setup();
    s.on();
    const taskId = (await s.research({ kind: "code", title: "Exclude the output folder from Defender" })).task_id as string;
    expect(await s.call("complete_task", { task_id: taskId, reason: "r" })).toMatchObject({ refused: "code_task" });
  });
});

describe("autopilot guards", () => {
  it("refuses an estimate over the per-task or per-day limit, or Unknown", async () => {
    const s = await setup();
    s.on({ perTaskUsd: 0.01, perDayUsd: 0.01 });
    const big = (await s.research({ size: "L" })).task_id as string;
    const est = s.o.get(big).crew!.estimate.usd!;
    expect(est).toBeGreaterThan(0.01);
    expect(await s.call("approve_crew", { task_id: big, reason: "r" })).toMatchObject({ refused: "over_task_limit" });
    expect(s.o.get(big).status).toBe("proposed");

    const unpriced = await setup(undefined, [candidate("free", "local", model("mystery", { cost: null }))]);
    unpriced.on();
    const t = (await unpriced.research()).task_id as string;
    expect(unpriced.o.get(t).crew!.estimate.provenance).toBe("unknown");
    expect(await unpriced.call("approve_crew", { task_id: t, reason: "r" })).toMatchObject({ refused: "estimate_unknown" });
  });

  it("counts today's committed spend against the per-day limit, and lowers an old task's budget to a lowered limit", async () => {
    const s = await setup();
    s.on({ perTaskUsd: 1, perDayUsd: 1 });
    const first = (await s.research()).task_id as string;
    s.ap.set(s.project.id, { limits: { perTaskUsd: 0.5 } });
    expect(await s.call("approve_crew", { task_id: first, reason: "fits" })).toMatchObject({ ok: true });
    expect(s.o.get(first).budgetUsd).toBe(0.5);
    await waitFor(() => s.o.get(first).status === "done");
    // What it spent counts when it is more than its estimate.
    s.store.db.prepare("insert into credentials (id, alias, provider_id, kind, created_at) values ('cred-x', 'x', 'deepseek', 'api_key', '2026-10-30T00:00:00Z')").run();
    recordSpend(s.store.db, { credentialId: "cred-x", profileId: "cheap", taskId: first, runId: null, providerId: "deepseek", model: "deepseek-chat", tokensIn: 0, tokensOut: 0, tokensCache: 0, tokensReasoning: 0, costUsd: 0.99, source: "billed", catalogVersion: null }, new Date());
    expect(s.ap.view(s.project.id).usage.committedTodayUsd).toBeCloseTo(0.99, 6);
    const second = (await s.research({ title: "Find why CI is slow" })).task_id as string;
    expect(await s.call("approve_crew", { task_id: second, reason: "r" })).toMatchObject({ refused: "over_day_limit" });
  });

  it("refuses an approval that would pass a key's own cap", async () => {
    const s = await setup(undefined, [{ ...candidate("cheap", "deepseek", model("deepseek-chat", { cost: { input: 0.27, output: 1.1, cacheRead: 0.07 } })), credentialId: "cred-tiny" }]);
    s.store.db.prepare("insert into credentials (id, alias, provider_id, kind, daily_cap_usd, task_cap_usd, created_at) values ('cred-tiny', 'tiny', 'deepseek', 'api_key', 0.000001, null, '2026-10-30T00:00:00Z')").run();
    s.on();
    const t = (await s.research()).task_id as string;
    expect(await s.call("approve_crew", { task_id: t, reason: "r" })).toMatchObject({ refused: "key_cap" });
  });

  it("caps tasks created and started per hour, and concurrent tasks", async () => {
    const s = await setup(() => [running, hold]);
    s.on({ tasksPerHour: 2, concurrent: 1 });
    const a = (await s.research()).task_id as string;
    const b = (await s.research({ title: "Find why CI is slow" })).task_id as string;
    expect(await s.research({ title: "A third" })).toMatchObject({ refused: "rate_created" });
    expect(await s.call("approve_crew", { task_id: a, reason: "fits" })).toMatchObject({ ok: true });
    await waitFor(() => s.o.get(a).status === "running");
    expect(await s.call("approve_crew", { task_id: b, reason: "r" })).toMatchObject({ refused: "concurrent" });
    s.ap.set(s.project.id, { limits: { tasksPerHour: 1, concurrent: 4 } });
    expect(await s.call("approve_crew", { task_id: b, reason: "r" })).toMatchObject({ refused: "rate_started" });
  });

  it("leaves spend past the task budget to you: the step pauses in the Inbox and Autopilot cannot go on", async () => {
    const s = await setup(() => [running, spend(5), hold]);
    s.on();
    const t = (await s.research()).task_id as string;
    await s.call("approve_crew", { task_id: t, reason: "fits" });
    await waitFor(() => s.o.requests({ taskId: t }).length > 0);
    expect(await s.call("read_task", { task_id: t })).toMatchObject({ waiting_on_person: expect.arrayContaining([expect.stringContaining("Inbox")]) });
    expect(await s.call("retry_step", { task_id: t, reason: "go on" })).toMatchObject({ refused: "nothing_to_retry" });
    for (const tool of ["answer_request", "continue_past_cap", "approve_request"]) expect(await s.call(tool, { task_id: t, reason: "r" })).toMatchObject({ refused: "invalid", detail: "unknown tool." });
    expect(s.o.requests({ taskId: t }).every((q) => q.answeredAt === null)).toBe(true);
  });

  it("has no tool for push, PR, merge or deletes: the MCP session refuses them before Autopilot", async () => {
    const s = await setup();
    s.on();
    const tools = (await assistantTools()).map((t) => t.name);
    expect(tools).toEqual(["propose_task", "create_task", "edit_task", "approve_crew", "queue_message", "retry_step", "cancel_task", "complete_task", "create_goal", "approve_goal_plan"]);
    for (const read of ["list_tasks", "read_task"]) expect(await s.ap.call(s.project.id, s.conversationId, read, { task_id: "x" })).toMatchObject({ isError: true });
    for (const outward of ["push", "create_pr", "merge_pr", "delete_worktree", "delete_branch"]) {
      expect(tools).not.toContain(outward);
      expect(await s.call(outward, { task_id: "x", reason: "r" })).toMatchObject({ refused: "invalid" });
    }
    // Crew runs never get the Autopilot tools.
    expect(REPORT_TOOLS.tools.map((t) => t.name)).toEqual(["report", "propose_followup"]);
  });

  it("the kill switch refuses every call at once and leaves running agents alone", async () => {
    const s = await setup(() => [running, hold]);
    s.on();
    const t = (await s.research()).task_id as string;
    await s.call("approve_crew", { task_id: t, reason: "fits" });
    await waitFor(() => s.o.get(t).status === "running");
    expect(s.ap.kill(true)).toMatchObject({ killed: true, projects: [{ projectId: s.project.id, name: "demo repo", halted: false }] });
    for (const tool of ["create_task", "cancel_task", "approve_crew"]) expect(await s.call(tool, { task_id: t, reason: "r" })).toMatchObject({ refused: "killed" });
    // Reading is not acting: the reads still work, and say Autopilot is stopped.
    expect(await s.call("list_tasks")).toMatchObject({ ok: true, autopilot: { killed: true, on: false } });
    expect(s.o.get(t).status).toBe("running");
    expect(s.o.get(t).runs[0]!.endedAt).toBeNull();
    expect(s.events("autopilot.killed")).toHaveLength(1);
    s.ap.kill(false);
    expect(await s.call("list_tasks")).toMatchObject({ ok: true, autopilot: { killed: false, on: true } });
  });
});

// Autopilot's goal tools (docs/adr/0022): Plan goal and Approve and start for goals it creates,
// through the same GoalPlanner, GoalViews and GoalEditor paths as your clicks, with a scripted planner.
describe("autopilot goals", () => {
  const GOAL = "Find out why the Windows build is slow and write down what to change.";
  const planTask = (key: string, over: Record<string, unknown> = {}) => ({
    key,
    title: `Görev ${key}`,
    kind: "research",
    mode: "solo",
    size: "S",
    description: `${key} için yapılacaklar.`,
    acceptance: ["Bir rapor var"],
    basis: "Windows build is slow",
    dependsOn: [],
    paths: [],
    reason: "Hedef bunu istiyor.",
    priority: "medium",
    ...over,
  });
  const TWO = { summary: "İki araştırma.", tasks: [planTask("scan"), planTask("cache", { dependsOn: ["scan"] })] };
  const ONE = { summary: "Tek araştırma.", tasks: [planTask("scan")] };
  const planner = (plan: unknown): ScriptedOptions["result"] => (_role, _nth, req) => (req.outputSchema?.name === "goal_plan" ? { ok: true, value: plan } : undefined);
  const create = (s: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}) => s.call("create_goal", { text: GOAL, basis: "find out why the Windows build is slow", reason: "You asked for a plan.", ...over });
  const ready = (s: Awaited<ReturnType<typeof setup>>, goalId: string) => waitFor(() => s.o.goalViews.detail(goalId).revisions.at(-1)?.state === "ready", 20_000);
  const setting = (s: Awaited<ReturnType<typeof setup>>, key: string) => s.store.db.prepare("select value from settings where key = ?").get(key);

  it("plans a goal, hears that its plan is ready, and approves it once within the limits", async () => {
    const s = await setup(undefined, undefined, planner(TWO));
    s.on({ perTaskUsd: 2, perDayUsd: 10 });
    const created = await create(s);
    expect(created).toMatchObject({ ok: true, status: "planning", revision: 1, planner: expect.any(String), planning_ceiling_usd: expect.any(Number) });
    const goalId = created.goal_id as string;
    // Your settings are yours: the first-goal card stays due and no planner is remembered for you.
    expect(setting(s, `orchestra.introduced.${s.project.id}`)).toBeUndefined();
    expect(setting(s, `orchestra.planner.${s.project.id}`)).toBeUndefined();
    expect(s.events("autopilot.create_goal")).toEqual([expect.objectContaining({ outcome: "done", goalId, basis: "find out why the Windows build is slow" })]);
    expect(s.ap.view(s.project.id).usage).toMatchObject({ createdLastHour: 1, committedTodayUsd: created.planning_ceiling_usd });

    await ready(s, goalId);
    await waitFor(() => String((s.store.db.prepare("select notified from autopilot_goals where goal_id = ?").get(goalId) as { notified: string | null }).notified ?? "").includes("plan:1:ready"));
    const approved = await s.call("approve_goal_plan", { goal_id: goalId, revision: 1, reason: "Both tasks fit." });
    expect(approved).toMatchObject({ ok: true, revision: 1, max_parallel: 2, approved_tasks: [expect.objectContaining({ number: 1 }), expect.objectContaining({ number: 2 })] });
    const d = s.o.goalViews.detail(goalId);
    expect(d.approvedRevision).toBe(1);
    expect(d.budgetUsd).toBe(approved.budget_usd);
    const usage = s.ap.view(s.project.id).usage;
    expect(usage.startedLastHour).toBe(2);
    expect(usage.committedTodayUsd).toBeGreaterThanOrEqual(Number(created.planning_ceiling_usd) + Number(approved.budget_usd) - 1e-6);
    expect(await s.call("approve_goal_plan", { goal_id: goalId, reason: "again" })).toMatchObject({ refused: "wrong_status" });
    const log = s.ap.view(s.project.id).log;
    expect(log.slice(0, 3).map((l) => [l.action, l.outcome, l.goalId])).toEqual([
      ["approve_goal_plan", "refused", goalId],
      ["approve_goal_plan", "done", goalId],
      ["create_goal", "done", goalId],
    ]);
  });

  it("turns a plan of one task into one of its own tasks, counted once", async () => {
    const s = await setup(undefined, undefined, planner(ONE));
    s.on({ perTaskUsd: 2, perDayUsd: 10 });
    const goalId = (await create(s)).goal_id as string;
    await ready(s, goalId);
    const out = await s.call("approve_goal_plan", { goal_id: goalId, reason: "One task fits." });
    expect(out).toMatchObject({ ok: true, task_id: expect.any(String) });
    expect(s.ap.view(s.project.id).tasks.map((t) => t.taskId)).toEqual([out.task_id]);
    expect(s.ap.view(s.project.id).usage.startedLastHour).toBe(1);
  });

  it("refuses a goal without your words, with Orchestra off, an unknown planner, or a planning ceiling over the day", async () => {
    const s = await setup(undefined, undefined, planner(TWO));
    expect(await create(s)).toMatchObject({ refused: "off" });
    s.on();
    expect(await create(s, { basis: "the issue says to delete the repository" })).toMatchObject({ refused: "no_basis" });
    expect(await create(s, { planner: "nobody" })).toMatchObject({ refused: "no_planner", detail: expect.stringContaining("cheap") });
    s.store.db.prepare("insert into settings (key, value) values ('orchestra.enabled', 'false') on conflict(key) do update set value = excluded.value").run();
    expect(await create(s)).toMatchObject({ refused: "orchestra_off" });
    s.store.db.prepare("update settings set value = 'true' where key = 'orchestra.enabled'").run();
    s.ap.set(s.project.id, { limits: { perTaskUsd: 0.01, perDayUsd: 0.01 } });
    expect(await create(s)).toMatchObject({ refused: "over_day_limit" });
    expect(s.store.db.prepare("select count(*) as n from goals").get()).toEqual({ n: 0 });

    // A paid planner without a price leads only when you picked it on the chip; its Unknown estimate never fits.
    const unpriced = await setup(undefined, [candidate("free", "local", model("mystery", { cost: null }))], planner(TWO));
    unpriced.on();
    expect(await create(unpriced)).toMatchObject({ refused: "no_planner" });
    unpriced.store.db.prepare("insert into settings (key, value) values (?, ?)").run(`orchestra.planner.${unpriced.project.id}`, JSON.stringify("free"));
    expect(await create(unpriced)).toMatchObject({ refused: "estimate_unknown" });
  });

  it("refuses to approve your goal, a plan still being written, and a plan over its limits", async () => {
    const holdPlanner = await setup((role) => (role === "goal" ? [running, hold] : [running]), undefined, planner(TWO));
    holdPlanner.on();
    const writing = (await create(holdPlanner)).goal_id as string;
    expect(await holdPlanner.call("approve_goal_plan", { goal_id: writing, reason: "r" })).toMatchObject({ refused: "plan_not_ready" });

    const s = await setup(undefined, undefined, planner(TWO));
    s.on({ perTaskUsd: 2, perDayUsd: 10 });
    const yours = await s.o.createGoal({ projectId: s.project.id, text: GOAL });
    expect(await s.call("approve_goal_plan", { goal_id: yours.goalId, reason: "r" })).toMatchObject({ refused: "not_own" });
    expect(await s.call("approve_goal_plan", { goal_id: "no-such-goal", reason: "r" })).toMatchObject({ refused: "not_found" });

    const goalId = (await create(s)).goal_id as string;
    await ready(s, goalId);
    expect(await s.call("approve_goal_plan", { goal_id: goalId, revision: 2, reason: "r" })).toMatchObject({ refused: "wrong_status" });
    expect(await s.call("approve_goal_plan", { goal_id: goalId, max_parallel: 3, reason: "r" })).toMatchObject({ refused: "concurrent" });
    s.ap.set(s.project.id, { limits: { tasksPerHour: 1 } });
    expect(await s.call("approve_goal_plan", { goal_id: goalId, reason: "r" })).toMatchObject({ refused: "rate_started" });
    s.ap.set(s.project.id, { limits: { tasksPerHour: 4, perTaskUsd: 0.000001 * 10_000, perDayUsd: 10 } });
    expect(await s.call("approve_goal_plan", { goal_id: goalId, reason: "r" })).toMatchObject({ refused: "over_task_limit", detail: expect.stringContaining("over the per-task limit") });
    expect(s.o.goalViews.detail(goalId).approvedRevision).toBeNull();
  });
});

describe("autopilot with the live assistant", () => {
  it("routes tool calls through the pipe and tells the live session when its task finishes", async () => {
    const script = (role: string): FakeStep[] =>
      role === "assistant"
        ? [
            { mcp: { tool: "create_task", arguments: { title: "Find why the Windows build is slow", kind: "research", size: "S", basis: "find out why the Windows build is slow", reason: "You asked." } } },
            { mcp: { tool: "approve_crew", arguments: { task_id: "{{mcp.0.task_id}}", reason: "It fits." } } },
            say("Started a research task."),
            { awaitTurn: true },
            { mcp: { tool: "read_task", arguments: { task_id: "{{mcp.0.task_id}}" } } },
            { mcp: { tool: "complete_task", arguments: { task_id: "{{mcp.0.task_id}}", reason: "The report answers it." } } },
            say("Marked it done."),
          ]
        : [running, say("Findings: Defender scans the output folder.")];
    const s = await setup((role) => script(role));
    s.on();
    await s.a.send(s.project.id, "cheap", ASK);
    const view = await waitFor(() => (s.a.get(s.project.id).lines.some((l) => l.text === "Marked it done.") ? s.a.get(s.project.id) : null), 20_000);
    const lines = view.lines.map((l) => [l.role, l.text]);
    expect(lines).toEqual(
      expect.arrayContaining([
        ["notice", "autopilot.call.done.create_task"],
        ["notice", "autopilot.call.done.approve_crew"],
        ["notice", "autopilot.status.done"],
        ["notice", "autopilot.call.done.complete_task"],
      ]),
    );
    const prompt = s.adapter.started.find((x) => x.role === "assistant")!.req.prompt;
    expect(prompt).toContain("Autopilot is ON for this project");
    const taskId = s.ap.view(s.project.id).tasks[0]!.taskId;
    expect(s.o.get(taskId).status).toBe("done");
    expect(s.ap.view(s.project.id).tasks[0]!.completedAt).not.toBeNull();
  });

  it("tells the live session when its goal's plan is ready, and the session approves it through the pipe", async () => {
    const plan = { summary: "Tek araştırma ve belge.", tasks: ["scan", "notes"].map((key) => ({ key, title: `Görev ${key}`, kind: "research", mode: "solo", size: "S", description: "Yapılacaklar.", acceptance: ["Bir rapor var"], basis: "Windows build is slow", dependsOn: [], paths: [], reason: "Hedef.", priority: "medium" })) };
    const script = (role: string): FakeStep[] =>
      role === "assistant"
        ? [
            { mcp: { tool: "create_goal", arguments: { text: "Find out why the Windows build is slow.", basis: "find out why the Windows build is slow", reason: "You asked." } } },
            say("Planning the goal."),
            { awaitTurn: true },
            { mcp: { tool: "approve_goal_plan", arguments: { goal_id: "{{mcp.0.goal_id}}", reason: "Every estimate fits." } } },
            say("Approved the plan."),
          ]
        : [running];
    const s = await setup((role) => script(role), undefined, (_role, _nth, req) => (req.outputSchema?.name === "goal_plan" ? { ok: true, value: plan } : undefined));
    s.on({ perTaskUsd: 2, perDayUsd: 10 });
    await s.a.send(s.project.id, "cheap", ASK);
    const view = await waitFor(() => (s.a.get(s.project.id).lines.some((l) => l.text === "Approved the plan.") ? s.a.get(s.project.id) : null), 25_000);
    expect(view.lines.map((l) => [l.role, l.text])).toEqual(
      expect.arrayContaining([
        ["notice", "autopilot.call.done.create_goal"],
        ["notice", "autopilot.goal.plan_ready"],
        ["notice", "autopilot.call.done.approve_goal_plan"],
      ]),
    );
    const goalId = (s.store.db.prepare("select goal_id from autopilot_goals").get() as { goal_id: string }).goal_id;
    expect(s.o.goalViews.detail(goalId).approvedRevision).toBe(1);
  });
});

/** What an assistant connection lists, as the MCP session answers tools/list. */
async function assistantTools(): Promise<Array<{ name: string }>> {
  const session = new McpSession(async () => ({ text: "", isError: false }), "1", { tools: [...ASSISTANT_TOOL_DEFS, ...AUTOPILOT_TOOL_DEFS], instructions: "" });
  await session.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  return (JSON.parse((await session.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })))!) as { result: { tools: Array<{ name: string }> } }).result.tools;
}

