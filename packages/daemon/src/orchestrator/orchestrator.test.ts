import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultProjectConfig, type FallbackMode, type IpcMessage, type ProjectConfig, type StartRequest } from "@crewyard/core";
import type { FakeStep } from "@crewyard/adapter-fake";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHandlers, handleMessage } from "../server.ts";
import { Store } from "../store.ts";
import { AdapterRegistry } from "./adapters.ts";
import type { Candidate } from "./directory.ts";
import { orchestratorFor } from "./index.ts";
import { Orchestrator, type OrchestratorOptions } from "./orchestrator.ts";
import { CANDIDATES, cleanTemps, git, ScriptedAdapter, tempDir, tempRepo, waitFor } from "./testing.ts";

// Git on Windows is slow enough that a whole crew can take a few seconds.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

type Picker = (role: string, req: StartRequest, resumed: boolean) => FakeStep[];

const open: Array<{ o: Orchestrator; store: Store }> = [];
afterEach(async () => {
  const all = open.splice(0);
  all.forEach(({ o }) => o.shutdown());
  for (const { o } of all) await o.settle();
  new Set(all.map((x) => x.store)).forEach((s) => s.close());
  cleanTemps();
});

const running: FakeStep = { emit: { type: "run.state", state: "running" } };
const say = (text: string): FakeStep => ({ emit: { type: "message.delta", text } });
const question = (id: string, prompt = "Which store?"): FakeStep[] => [
  { emit: { type: "request.question", requestId: id, questions: [{ prompt, options: [{ label: "redis" }, { label: "memory" }], allowFreeText: false }] } },
  { awaitAnswer: id },
];
const approval = (id: string, command: string | null, paths: string[] = [], network = false): FakeStep[] => [
  { emit: { type: "request.approval", requestId: id, toolCallId: null, command, cwd: null, paths, network } },
  { awaitAnswer: id },
];
const quick: Picker = (role) => [running, say(`${role} done`)];

async function setup(opts: { pick: Picker; candidates?: Candidate[]; config?: (c: ProjectConfig) => void; options?: Partial<OrchestratorOptions> }) {
  const root = tempDir();
  const repo = await tempRepo(root);
  if (opts.config) {
    const cfg = defaultProjectConfig("demo repo", join(root, ".mc", "worktrees", "demo repo"));
    opts.config(cfg);
    mkdirSync(join(repo, ".mission"), { recursive: true });
    writeFileSync(join(repo, ".mission", "project.json"), JSON.stringify(cfg));
  }
  const store = new Store(join(root, "t.db"));
  const project = store.addProject(repo, "demo repo");
  const adapter = new ScriptedAdapter(opts.pick);
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const topics: Array<{ topic: string; payload: unknown }> = [];
  const cands = opts.candidates ?? CANDIDATES();
  const options: OrchestratorOptions = {
    store,
    dataDir: join(root, "data"),
    emit: (topic, payload) => topics.push({ topic, payload }),
    adapters,
    directory: { candidates: () => cands, envFor: () => ({}) },
    tickMs: 0,
    freeMemoryMb: () => 64_000,
    stopTimeoutMs: 2_000,
    ...opts.options,
  };
  const o = new Orchestrator(options);
  o.start();
  open.push({ o, store });
  return { o, store, project, adapter, topics, root, repo, options };
}

const CODE_M = { title: "Implement rate limiting for the login endpoint", description: "Five attempts per minute per account, a clear error message, and tests for the limiter and the handler." };
const CODE_S = { title: "Fix typo in the login error message", description: "" };

describe("end to end", () => {
  it("runs a code crew: propose, approve, plan, implement with a question, test and review", async () => {
    const pick: Picker = (role) =>
      role === "planner"
        ? [running, { emit: { type: "plan.update", steps: [{ title: "Add a token bucket", status: "pending" }] } }, say("plan")]
        : role === "implementer"
          ? [running, ...question("q1"), { emit: { type: "diff.update", files: [{ path: "src/login.ts", added: 12, removed: 1 }] } }, say("done")]
          : [running, say("pass")];
    const { o, project, adapter, topics, root } = await setup({ pick });

    const proposed = await o.propose({ projectId: project.id, ...CODE_M });
    expect(proposed.kind).toBe("code");
    expect(proposed.size).toBe("M");
    expect(proposed.status).toBe("proposed");
    expect(proposed.crew?.members.map((m) => m.role)).toEqual(["planner", "implementer", "tester", "reviewer"]);
    // A proposal has no side effects beyond the stored draft.
    expect(proposed.runs).toEqual([]);
    expect(existsSync(join(root, ".mc"))).toBe(false);
    expect(adapter.started).toEqual([]);

    const implementer = proposed.crew!.members.find((m) => m.role === "implementer")!;
    const reviewer = proposed.crew!.members.find((m) => m.role === "reviewer")!;
    expect(reviewer.chosen!.model).not.toBe(implementer.chosen!.model);
    expect(implementer.standby.length).toBeGreaterThan(0);
    expect(proposed.crew!.estimate.provenance).toBe("estimated");

    await o.approve({ taskId: proposed.id });
    const q = await waitFor(() => o.requests({ taskId: proposed.id })[0]);
    expect(q.kind).toBe("question");
    expect(o.get(proposed.id).status).toBe("needs_input");

    const detail = o.get(proposed.id);
    expect(detail.worktree?.path.startsWith(join(root, ".mc", "worktrees", "demo repo"))).toBe(true);
    expect(detail.worktree?.branch).toMatch(/^crewyard\/implement-rate-limiting/);
    const implStart = adapter.started.find((s) => s.role === "implementer")!;
    expect(implStart.req.cwd).toBe(detail.worktree?.path);
    expect(implStart.req.policy.writes).toBe("worktree");
    expect(implStart.req.prompt).toContain("1. Add a token bucket");
    expect(adapter.started.find((s) => s.role === "planner")!.req.policy.writes).toBe("none");

    await o.answer(q.id, { kind: "question", answers: [{ selected: ["redis"] }] });
    await waitFor(() => o.get(proposed.id).status === "review");
    const done = o.get(proposed.id);
    expect(done.runs.map((r) => [r.role, r.endReason])).toEqual(
      expect.arrayContaining([
        ["planner", "completed"],
        ["implementer", "completed"],
        ["tester", "completed"],
        ["reviewer", "completed"],
      ]),
    );
    expect(done.runs.find((r) => r.role === "implementer")!.diff).toEqual([{ path: "src/login.ts", added: 12, removed: 1 }]);
    // Tester and reviewer run read-only inside the implementer's worktree.
    expect(adapter.started.find((s) => s.role === "reviewer")!.req.cwd).toBe(detail.worktree?.path);
    expect(adapter.inspect(implStart.runId).answers).toEqual([{ kind: "question", answers: [{ selected: ["redis"] }] }]);
    const kinds = new Set(topics.map((t) => t.topic));
    expect([...kinds].sort()).toEqual(["requests.changed", "runs.event", "tasks.changed"]);
  });

  it("finishes a research task as done", async () => {
    const { o, project } = await setup({ pick: quick });
    const t = await o.propose({ projectId: project.id, title: "Research how other tools store API keys on Windows" });
    expect(t.kind).toBe("research");
    expect(t.crew?.members.map((m) => m.role)).toEqual(["researcher"]);
    await o.approve({ taskId: t.id });
    await waitFor(() => o.get(t.id).status === "done");
    expect(o.get(t.id).worktree).toBeNull();
  });

  it("proposes the same crew for the same input", async () => {
    const { o, project } = await setup({ pick: quick });
    const a = await o.propose({ projectId: project.id, ...CODE_M });
    const b = await o.propose({ projectId: project.id, ...CODE_M });
    const crew = (t: typeof a) => t.crew!.members.map((m) => [m.role, m.chosen?.profileId, m.standby.map((s) => s.profileId)]);
    expect(crew(a)).toEqual(crew(b));
  });

  it("refuses to approve a crew that breaks the independence rule or misses a profile", async () => {
    const { o, project } = await setup({ pick: quick });
    const t = await o.propose({ projectId: project.id, ...CODE_S });
    const impl = t.crew!.members.find((m) => m.role === "implementer")!;
    const rev = t.crew!.members.find((m) => m.role === "reviewer")!;
    await expect(o.approve({ taskId: t.id, edits: [{ memberId: rev.id, profileId: impl.chosen!.profileId }] })).rejects.toThrow("crew.independence");
    expect(o.get(t.id).status).toBe("proposed");

    const lonely = await setup({ pick: quick, candidates: [CANDIDATES()[0]!] });
    const t2 = await lonely.o.propose({ projectId: lonely.project.id, ...CODE_S });
    expect(t2.crew!.members.find((m) => m.role === "reviewer")!.reasons[0]?.code).toBe("no_independent_candidate");
    await expect(lonely.o.approve({ taskId: t2.id })).rejects.toThrow("crew.missing_profile");
  });

  it("remembers crew edits as preferences", async () => {
    const { o, project } = await setup({ pick: quick });
    const t = await o.propose({ projectId: project.id, title: "Research token storage" });
    const m = t.crew!.members[0]!;
    const other = m.standby[0]!;
    await o.approve({ taskId: t.id, edits: [{ memberId: m.id, profileId: other.profileId }] });
    expect(o.get(t.id).crew!.members[0]!.edited).toBe(true);
    const next = await o.propose({ projectId: project.id, title: "Research token storage" });
    expect(next.crew!.members[0]!.chosen!.profileId).toBe(other.profileId);
    expect(next.crew!.members[0]!.chosen!.reasons.map((r) => r.code)).toContain("history.preferred");
  });
});

describe("admission control", () => {
  const blockingResearch: Picker = () => [running, ...question("hold")];

  it("holds a ready step while the project has no free slot", async () => {
    const { o, project } = await setup({ pick: blockingResearch, config: (c) => (c.rules.slots = 1) });
    const a = await o.propose({ projectId: project.id, title: "Research A" });
    const b = await o.propose({ projectId: project.id, title: "Research B" });
    await o.approve({ taskId: a.id });
    await o.approve({ taskId: b.id });
    const qa = await waitFor(() => o.requests({ taskId: a.id })[0]);
    expect(o.get(b.id).runs).toEqual([]);
    expect(o.get(b.id).crew!.members[0]!.blockedBy).toEqual({ code: "admission.project_slots", params: { used: 1, slots: 1 } });
    expect(o.get(b.id).status).toBe("queued");

    await o.answer(qa.id, { kind: "question", answers: [{ selected: ["redis"] }] });
    const qb = await waitFor(() => o.requests({ taskId: b.id })[0]);
    expect(o.get(b.id).crew!.members[0]!.blockedBy).toBeNull();
    await o.answer(qb.id, { kind: "question", answers: [{ selected: ["memory"] }] });
    await waitFor(() => o.get(b.id).status === "done");
  });

  it("holds a step while its profile is busy or memory is low", async () => {
    let freeMb = 64_000;
    const { o, project } = await setup({ pick: blockingResearch, options: { limits: { perProfile: 1 }, freeMemoryMb: () => freeMb } });
    const pins = { researcher: "openai-key" };
    const a = await o.propose({ projectId: project.id, title: "Research A", pins });
    const b = await o.propose({ projectId: project.id, title: "Research B", pins });
    expect(b.crew!.members[0]!.chosen!.reasons[0]?.code).toBe("pinned");
    await o.approve({ taskId: a.id });
    await o.approve({ taskId: b.id });
    await waitFor(() => o.requests({ taskId: a.id })[0]);
    expect(o.get(b.id).crew!.members[0]!.blockedBy?.code).toBe("admission.profile_busy");

    freeMb = 100;
    const c = await o.propose({ projectId: project.id, title: "Research C", pins: { researcher: "anthropic-key" } });
    await o.approve({ taskId: c.id });
    expect(o.get(c.id).crew!.members[0]!.blockedBy).toEqual({ code: "admission.memory", params: { freeMb: 100, neededMb: 1024 } });
    expect(o.get(c.id).runs).toEqual([]);
  });
});

describe("risk routing", () => {
  it("approves only low risk by policy, enforces read-only roles and never auto-approves medium or high", async () => {
    const pick: Picker = (role) =>
      role === "implementer"
        ? [running, ...approval("a1", "git status"), ...approval("a2", "git push origin main"), ...approval("a3", "python tools/gen.py"), say("done")]
        : [running, ...approval("r1", null, ["src/login.ts"]), say("reviewed")];
    const { o, project, adapter } = await setup({ pick });
    const t = await o.propose({ projectId: project.id, ...CODE_S });
    expect(t.size).toBe("S");
    await o.approve({ taskId: t.id });

    const high = await waitFor(() => o.requests({ taskId: t.id })[0]);
    expect(high.risk).toBe("high");
    expect(high.payload).toMatchObject({ kind: "approval", command: "git push origin main", policy: null });
    await expect(o.answer(high.id, { kind: "approval", decision: "allow_always" })).rejects.toThrow("request.always_high_risk");
    await o.answer(high.id, { kind: "approval", decision: "deny" });

    const medium = await waitFor(() => o.requests({ taskId: t.id })[0]);
    expect(medium.risk).toBe("medium");
    await o.answer(medium.id, { kind: "approval", decision: "allow_once" });
    await waitFor(() => o.get(t.id).status === "review");

    const impl = adapter.started.find((s) => s.role === "implementer")!;
    expect(adapter.inspect(impl.runId).answers.map((a) => (a.kind === "approval" ? a.decision : a.kind))).toEqual(["allow_once", "deny", "allow_once"]);
    const rev = adapter.started.find((s) => s.role === "reviewer")!;
    expect(adapter.inspect(rev.runId).answers).toEqual([{ kind: "approval", decision: "deny", message: "policy.role_read_only" }]);

    const byPolicy = o.requests({ taskId: t.id, includeAnswered: true }).filter((q) => q.answeredBy === "policy");
    expect(byPolicy.map((q) => [q.payload.kind === "approval" ? q.payload.policy : null, q.risk])).toEqual([
      ["policy.allowlisted", "low"],
      ["policy.role_read_only", "high"],
    ]);
  });
});

describe("handoff", () => {
  const resetsLater = () => new Date(Date.now() + 3 * 3_600_000).toISOString();

  /** The first implementer hits its limit after a question; any later implementer finishes. */
  const limited = (resetsAt: () => string): Picker => {
    let implementers = 0;
    return (role) => {
      if (role !== "implementer") return [running, say(`${role} ok`)];
      if (implementers++ > 0) return [running, say("continued")];
      return [running, ...question("q1"), { emit: { type: "limit.update", window: "5h", usedPct: 100, resetsAt: resetsAt(), provenance: "reported", reached: true } }, { awaitAnswer: "never" }];
    };
  };

  async function startLimited(fallback: FallbackMode, resetsAt = resetsLater) {
    const env = await setup({ pick: limited(resetsAt) });
    const t = await env.o.propose({ projectId: env.project.id, ...CODE_S, fallback });
    await env.o.approve({ taskId: t.id });
    const q = await waitFor(() => env.o.requests({ taskId: t.id })[0]);
    // Uncommitted work in the worktree, which the handoff must checkpoint.
    writeFileSync(join(env.o.get(t.id).worktree!.path, "limiter.ts"), "export const limit = 5;\n");
    await env.o.answer(q.id, { kind: "question", answers: [{ selected: ["redis"] }] });
    return { ...env, t, source: o2run(env.o, t.id) };
  }

  const o2run = (o: Orchestrator, taskId: string) => o.get(taskId).runs.find((r) => r.role === "implementer")!;

  async function expectHandedOff(env: Awaited<ReturnType<typeof startLimited>>, mode: FallbackMode) {
    const { o, t, adapter } = env;
    const h = await waitFor(() => o.get(t.id).handoffs.find((x) => x.outcome === "completed"));
    expect(h.mode).toBe(mode);
    expect(h.kind).toBe("new_session");
    expect(h.trigger).toBe("limit");
    const detail = o.get(t.id);
    const source = detail.runs.find((r) => r.id === h.fromRunId)!;
    expect([source.endReason, source.endDetail, source.handoffId]).toEqual(["limit", "handed_off", h.id]);
    const target = detail.runs.find((r) => r.id === h.toRunId)!;
    expect(target.resumedFrom).toBe(source.id);
    expect(target.cwd).toBe(source.cwd);
    expect(target.profileId).not.toBe(source.profileId);
    const pkg = readFileSync(h.packagePath!, "utf8");
    expect(pkg).toContain("# Handoff package");
    expect(pkg).toContain("limiter.ts");
    expect(adapter.started.filter((s) => s.role === "implementer")[1]!.req.prompt).toContain("# Handoff package");
    expect(await git(detail.worktree!.path, "log", "-1", "--format=%s", h.checkpointSha!)).toContain(`wip: handoff from ${source.id}`);
    await waitFor(() => o.get(t.id).status === "review");
    // The reviewer stays independent of every model that implemented.
    const rev = o.get(t.id).runs.find((r) => r.role === "reviewer")!;
    expect([source.model, target.model]).not.toContain(rev.model);
  }

  it("Manual: pauses, asks in the Inbox without a proposed target, then hands off on your click", async () => {
    const env = await startLimited("manual");
    const { o, t, topics } = env;
    const q = await waitFor(() => o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    expect(o.get(t.id).status).toBe("needs_input");
    expect(o2run(o, t.id).state).toBe("rate_limited");
    expect(q.payload).toMatchObject({ kind: "handoff", trigger: "limit", window: "5h", proposedTarget: null });
    expect(topics.some((x) => x.topic === "limits.notice" && (x.payload as { kind: string }).kind === "reached")).toBe(true);
    if (q.payload.kind !== "handoff") throw new Error("unexpected payload");
    await expect(o.answer(q.id, { kind: "handoff", decision: "hand_off" })).rejects.toThrow("request.no_target");
    await o.answer(q.id, { kind: "handoff", decision: "hand_off", targetProfileId: q.payload.candidates[0]!.profileId });
    await expectHandedOff(env, "manual");
  });

  it("Ask: names the proposed target and continues on one click", async () => {
    const env = await startLimited("ask");
    const q = await waitFor(() => env.o.requests({ taskId: env.t.id }).find((r) => r.kind === "handoff"));
    expect(q.payload.kind === "handoff" && q.payload.proposedTarget?.profileId).toBeTruthy();
    await env.o.answer(q.id, { kind: "handoff", decision: "hand_off" });
    await expectHandedOff(env, "ask");
  });

  it("Auto: continues on the next standby target and records it", async () => {
    const env = await startLimited("auto");
    await expectHandedOff(env, "auto");
    expect(env.o.requests({ taskId: env.t.id, includeAnswered: true }).filter((r) => r.kind === "handoff")).toEqual([]);
    const kinds = env.store.eventsSince(0, 5_000).map((e) => e.kind);
    expect(kinds).toContain("handoff.completed");
  });

  it("Wait for reset: resumes the same session when the window resets soon", async () => {
    const env = await startLimited("wait_for_reset", () => new Date(Date.now() + 150).toISOString());
    const { o, t, adapter } = env;
    await waitFor(() => o.get(t.id).status === "review");
    const impls = o.get(t.id).runs.filter((r) => r.role === "implementer");
    expect(impls).toHaveLength(1);
    expect([impls[0]!.endReason, impls[0]!.limitReached, impls[0]!.resumeAt]).toEqual(["completed", false, null]);
    expect(o.get(t.id).handoffs).toEqual([]);
    // One native resume of the same session, no second implementer start.
    expect(adapter.started.map((s) => [s.role, s.resumed])).toEqual([
      ["implementer", false],
      ["unknown", true],
      ["reviewer", false],
    ]);
  });

  it("Wait for reset: falls back to Ask when the reset is too far away", async () => {
    const env = await startLimited("wait_for_reset");
    const q = await waitFor(() => env.o.requests({ taskId: env.t.id }).find((r) => r.kind === "handoff"));
    expect(q.payload.kind === "handoff" && q.payload.proposedTarget).toBeTruthy();
  });

  it("stops at a budget cap and asks, even in Auto mode", async () => {
    const pick: Picker = (role) =>
      role === "implementer"
        ? [running, { emit: { type: "usage.update", tokensIn: 1_000_000, tokensOut: 100_000, cacheRead: 0, cacheWrite: 0, reasoning: 0, contextUsed: null, contextSize: null, costUsd: null, costProvenance: "unknown" } }, { awaitAnswer: "never" }]
        : [running];
    const { o, project } = await setup({ pick });
    const t = await o.propose({ projectId: project.id, ...CODE_S, fallback: "auto", budgetUsd: 0.05 });
    await o.approve({ taskId: t.id });
    const q = await waitFor(() => o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    expect(q.payload).toMatchObject({ kind: "handoff", trigger: "budget", window: "budget-task", proposedTarget: null });
    expect(o.get(t.id).spend.provenance).toBe("estimated");
    expect(o.get(t.id).handoffs).toEqual([]);
  });
});

describe("recovery", () => {
  it("marks runs whose process is gone as interrupted and resumes them only on request", async () => {
    const pick: Picker = (_role, _req, resumed) => (resumed ? [running, say("back")] : [running, ...question("hold")]);
    const env = await setup({ pick });
    const t = await env.o.propose({ projectId: env.project.id, title: "Research A" });
    await env.o.approve({ taskId: t.id });
    await waitFor(() => env.o.requests({ taskId: t.id })[0]);
    const before = env.o.get(t.id).runs[0]!;
    // Its recorded pid is still alive (this test process): orphaned, and never killed.
    env.store.db.prepare("update runs set pid = ? where id = ?").run(process.pid, before.id);

    // Simulate a daemon crash: drop handles without ending anything, then start over on the same database.
    env.o.shutdown();
    const adapter = new ScriptedAdapter(pick);
    const adapters = new AdapterRegistry({});
    adapters.set("fake", adapter);
    const o2 = new Orchestrator({ ...env.options, adapters });
    o2.start();
    open.push({ o: o2, store: env.store });

    const run = o2.get(t.id).runs[0]!;
    expect([run.endReason, run.endDetail]).toEqual(["interrupted", "process_orphaned"]);
    expect(o2.requests({ taskId: t.id })).toEqual([]);
    expect(o2.requests({ taskId: t.id, includeAnswered: true })[0]!.answeredBy).toBe("system");
    expect(o2.get(t.id).resumableRunIds).toEqual([run.id]);
    expect(adapter.started).toEqual([]);

    const resumed = await o2.resume(run.id);
    expect(resumed.resumedFrom).toBe(run.id);
    expect(adapter.started[0]!.resumed).toBe(true);
    await waitFor(() => o2.get(t.id).status === "done");
    expect(o2.get(t.id).resumableRunIds).toEqual([]);
  });

  it("pauses and stops runs on request", async () => {
    const { o, project } = await setup({ pick: () => [running, ...question("hold")] });
    const t = await o.propose({ projectId: project.id, title: "Research A" });
    await o.approve({ taskId: t.id });
    await waitFor(() => o.requests({ taskId: t.id })[0]);
    const run = o.get(t.id).runs[0]!;
    expect((await o.pause(run.id)).state).toBe("paused");
    const stopped = await o.stop(run.id);
    expect([stopped.endReason, stopped.endDetail]).toEqual(["stopped", "user_stop"]);
    await expect(o.message(run.id, "hi")).rejects.toThrow("run.ended");
    const cancelled = await o.cancel(t.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.resumableRunIds).toEqual([]);
  });
});

describe("ipc handlers", () => {
  it("serves the tasks area through the daemon's handler map", async () => {
    const root = tempDir();
    const repo = await tempRepo(root);
    const store = new Store(join(root, "t.db"));
    const ctx = { store, info: { startedAt: "now", dbPath: "t.db", dataDir: root }, emit: () => {} };
    const o = orchestratorFor(ctx, { tickMs: 0 });
    open.push({ o, store });
    const handlers = createHandlers(ctx);
    const call = (id: number, method: string, params: unknown) => handleMessage(handlers, { kind: "request", id, method, params } as IpcMessage);

    const project = store.addProject(repo, "demo repo");
    const proposed = (await call(1, "tasks.propose", { projectId: project.id, title: "Research A" })) as { ok: true; result: { id: string; crew: { members: Array<{ chosen: unknown; reasons: Array<{ code: string }> }> } } };
    expect(proposed.ok).toBe(true);
    // No providers wired yet: the crew says so instead of inventing a profile.
    expect(proposed.result.crew.members[0]).toMatchObject({ chosen: null, reasons: [{ code: "no_candidate" }] });
    expect(await call(2, "tasks.approve", { taskId: proposed.result.id })).toMatchObject({ ok: false, error: "crew.missing_profile" });
    expect(await call(3, "tasks.list", {})).toMatchObject({ ok: true, result: [{ id: proposed.result.id, status: "proposed" }] });
    expect(await call(4, "requests.list", {})).toMatchObject({ ok: true, result: [] });
    expect(await call(5, "tasks.get", { taskId: "missing" })).toMatchObject({ ok: false, error: "task.not_found" });
  });
});
