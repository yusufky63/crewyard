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
import { CANDIDATES, candidate, cleanTemps, git, model, ScriptedAdapter, tempDir, tempRepo, waitFor } from "./testing.ts";

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
    expect(adapter.inspect(rev.runId).answers).toEqual([{ kind: "approval", decision: "deny", message: "Denied by Crewyard: this role is read-only and may not change files." }]);

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
    expect([h.mode, h.phase]).toEqual([mode, "closed"]);
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

describe("usage and cost", () => {
  const usage = (tokensIn: number, tokensOut: number, costUsd: number | null): FakeStep => ({
    emit: { type: "usage.update", tokensIn, tokensOut, cacheRead: 0, cacheWrite: 0, reasoning: 0, contextUsed: null, contextSize: null, costUsd, costProvenance: costUsd === null ? "unknown" : "reported" },
  });

  it("counts only the growth of a resumed native session's running totals for the new run", async () => {
    const pick: Picker = (_role, _req, resumed) => (resumed ? [running, usage(1_500, 150, 0.015), say("back")] : [running, usage(1_000, 100, 0.01), ...question("hold")]);
    const { o, project } = await setup({ pick });
    const t = await o.propose({ projectId: project.id, title: "Research A" });
    await o.approve({ taskId: t.id });
    await waitFor(() => o.requests({ taskId: t.id })[0]);
    const first = (await o.stop(o.get(t.id).runs[0]!.id)).id;
    const second = (await o.resume(first)).id;
    await waitFor(() => o.get(t.id).status === "done");
    const runs = o.get(t.id).runs;
    const r1 = runs.find((r) => r.id === first)!;
    const r2 = runs.find((r) => r.id === second)!;
    expect(r2.nativeSessionId).toBe(r1.nativeSessionId);
    expect([r1.tokensIn, r1.tokensOut, r1.cost.usd]).toEqual([1_000, 100, 0.01]);
    expect([r2.tokensIn, r2.tokensOut, r2.cost.usd, r2.cost.provenance]).toEqual([500, 50, 0.005, "reported"]);
    expect(o.get(t.id).spend.usd).toBeCloseTo(0.015, 6);
  });

  it("prices tokens the runner could not price from the catalog, and keeps them Unknown without a price", async () => {
    const pick: Picker = () => [running, usage(1_000_000, 0, null), usage(2_000_000, 0, null), say("done")];
    const { o, project } = await setup({ pick, candidates: [...CANDIDATES(), candidate("no-price", "custom", null)] });
    const priced = await o.propose({ projectId: project.id, title: "Research A", pins: { researcher: "deepseek-key" } });
    const unpriced = await o.propose({ projectId: project.id, title: "Research B", pins: { researcher: "no-price" } });
    await o.approve({ taskId: priced.id });
    await o.approve({ taskId: unpriced.id });
    await waitFor(() => o.get(priced.id).status === "done" && o.get(unpriced.id).status === "done");
    // deepseek-chat input is $0.27 per million; two cumulative reports add up to 2M tokens, not 3M.
    expect(o.get(priced.id).runs[0]!.cost).toEqual({ usd: 0.54, provenance: "estimated" });
    expect(o.get(unpriced.id).runs[0]!.cost).toEqual({ usd: null, provenance: "unknown" });
    expect(o.get(unpriced.id).spend.provenance).toBe("unknown");
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

  it("holds messages for a step without a process and delivers them to the run that continues it", async () => {
    const pick: Picker = (_role, _req, resumed) => (resumed ? [running, { wait: 50 }, say("back")] : [running, ...question("hold")]);
    const { o, project, adapter } = await setup({ pick });
    const t = await o.propose({ projectId: project.id, title: "Research A" });
    await o.approve({ taskId: t.id });
    await waitFor(() => o.requests({ taskId: t.id })[0]);
    const run = o.get(t.id).runs[0]!;
    await o.pause(run.id);
    await waitFor(() => o.get(t.id).runs[0]!.state === "paused");

    const queued = await o.message(run.id, "Use the OS keychain, not a file.");
    expect(queued.queuedMessages).toBe(1);
    expect(adapter.inspect(adapter.started[0]!.runId).inputs).toEqual([]);

    await o.resume(run.id);
    await waitFor(() => o.get(t.id).status === "done");
    expect(o.get(t.id).runs[0]!.queuedMessages).toBe(0);
    expect(adapter.inspect(adapter.started[1]!.runId).inputs.map((i) => i.text)).toEqual(["Use the OS keychain, not a file."]);
    await expect(o.message(run.id, "late")).rejects.toThrow("run.ended");
  });

  it("closes a handoff interrupted by a restart with the phase it reached, and allows one open handoff per run", async () => {
    const env = await setup({ pick: () => [running, ...question("hold")] });
    const t = await env.o.propose({ projectId: env.project.id, title: "Research A" });
    await env.o.approve({ taskId: t.id });
    await waitFor(() => env.o.requests({ taskId: t.id })[0]);
    const run = env.o.get(t.id).runs[0]!;
    const insert = env.store.db.prepare(
      "insert into handoffs (id, task_id, from_run_id, mode, trigger_kind, phase, opened_at) values (?, ?, ?, 'auto', 'limit', 'starting_target', '2026-10-30T00:00:00Z')",
    );
    insert.run("h1", t.id, run.id);
    expect(() => insert.run("h2", t.id, run.id)).toThrow(/UNIQUE/);
    expect(env.o.get(t.id).status).toBe("needs_input");

    env.o.shutdown();
    const o2 = new Orchestrator({ ...env.options, adapters: new AdapterRegistry({}) });
    o2.start();
    open.push({ o: o2, store: env.store });
    expect(o2.get(t.id).handoffs[0]).toMatchObject({ outcome: "interrupted", detail: "starting_target", phase: "closed" });
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
    // A stopped run can be resumed, so a message waits for it.
    expect((await o.message(run.id, "hi")).queuedMessages).toBe(1);
    const cancelled = await o.cancel(t.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.resumableRunIds).toEqual([]);
    await expect(o.message(run.id, "hi")).rejects.toThrow("run.ended");
  });
});

describe("spend caps", () => {
  const usage = (tokensIn: number): FakeStep => ({
    emit: { type: "usage.update", tokensIn, tokensOut: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, contextUsed: null, contextSize: null, costUsd: null, costProvenance: "unknown" },
  });
  // deepseek-chat input is $0.27 per million tokens.
  const paidCandidates = (): Candidate[] => CANDIDATES().map((c) => (c.profile.id === "deepseek-key" ? { ...c, credentialId: "cred-ds", catalogVersion: "cat-1" } : c));
  const addCredential = (store: Store, daily: number | null) =>
    store.db
      .prepare("insert into credentials (id, alias, provider_id, kind, daily_cap_usd, task_cap_usd, created_at) values ('cred-ds', 'ds', 'deepseek', 'api_key', ?, null, '2026-10-30T00:00:00Z')")
      .run(daily);
  const spendRows = (store: Store) => store.db.prepare("select run_id, cost_usd, source, catalog_version from spend order by id").all() as Array<{ run_id: string; cost_usd: number; source: string; catalog_version: string | null }>;

  it("records every usage delta on the key, pauses at the daily cap and continues only after you approve", async () => {
    const pick: Picker = (_role, _req, resumed) => (resumed ? [running, usage(2_000_000), say("done")] : [running, usage(1_000_000), { awaitAnswer: "never" }]);
    const { o, project, store, topics } = await setup({ pick, candidates: paidCandidates() });
    addCredential(store, 0.1);
    const t = await o.propose({ projectId: project.id, title: "Research A", pins: { researcher: "deepseek-key" } });
    await o.approve({ taskId: t.id });

    const q = await waitFor(() => o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    expect(q.payload).toMatchObject({ kind: "handoff", trigger: "budget", window: "budget-day", proposedTarget: null, cap: { kind: "daily_cap", spentUsd: 0.27, capUsd: 0.1, credentialId: "cred-ds" } });
    if (q.payload.kind !== "handoff") throw new Error("unexpected payload");
    expect(Date.parse(q.payload.resetsAt!)).toBeGreaterThan(Date.now());
    const run = o.get(t.id).runs[0]!;
    expect(run.state).toBe("rate_limited");
    expect(spendRows(store)).toEqual([{ run_id: run.id, cost_usd: 0.27, source: "estimated", catalog_version: "cat-1" }]);
    expect(topics.some((x) => x.topic === "limits.notice" && (x.payload as { kind: string; window: string }).kind === "reached" && (x.payload as { window: string }).window === "budget-day")).toBe(true);
    // Resume never walks past a cap; only the Inbox answer does.
    await expect(o.resume(run.id)).rejects.toThrow("run.still_limited");
    await expect(o.answer(q.id, { kind: "question", answers: [] })).rejects.toThrow("request.answer_kind");

    await o.answer(q.id, { kind: "handoff", decision: "continue" });
    await waitFor(() => o.get(t.id).status === "done");
    // The second report grows the session total by 1M more tokens; the approved cap does not ask again.
    expect(spendRows(store).map((r) => r.cost_usd)).toEqual([0.27, 0.27]);
    expect(o.requests({ taskId: t.id })).toEqual([]);
  });

  it("holds a paid run before it starts when its key is already past a cap", async () => {
    const pick: Picker = () => [running, say("done")];
    const { o, project, store, adapter } = await setup({ pick, candidates: paidCandidates() });
    addCredential(store, 0);
    const t = await o.propose({ projectId: project.id, title: "Research A", pins: { researcher: "deepseek-key" } });
    await o.approve({ taskId: t.id });

    const q = await waitFor(() => o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    expect(q.payload).toMatchObject({ trigger: "budget", cap: { kind: "daily_cap", capUsd: 0 } });
    expect(adapter.started).toEqual([]);
    const run = o.get(t.id).runs[0]!;
    expect([run.state, run.nativeSessionId]).toEqual(["rate_limited", null]);
    await expect(o.retry(run.id)).rejects.toThrow("run.still_limited");

    await o.answer(q.id, { kind: "handoff", decision: "continue" });
    await waitFor(() => o.get(t.id).status === "done");
    expect(adapter.started.map((s) => [s.role, s.resumed])).toEqual([["researcher", false]]);
    expect(o.get(t.id).runs).toHaveLength(1);
  });

  it("refuses continue on a request that is not about spend", async () => {
    const env = await setup({ pick: () => [running, { emit: { type: "limit.update", window: "5h", usedPct: 100, resetsAt: new Date(Date.now() + 3_600_000).toISOString(), provenance: "reported", reached: true } }, { awaitAnswer: "never" }] });
    const t = await env.o.propose({ projectId: env.project.id, title: "Research A", fallback: "manual" });
    await env.o.approve({ taskId: t.id });
    const q = await waitFor(() => env.o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    await expect(env.o.answer(q.id, { kind: "handoff", decision: "continue" })).rejects.toThrow("request.not_budget");
  });
});

describe("manual handoff and retry", () => {
  it("hands a step to another AI on request through the durable handoff", async () => {
    let starts = 0;
    const pick: Picker = () => (starts++ === 0 ? [running, ...question("hold")] : [running, say("moved")]);
    const cands = [...CANDIDATES(), { ...candidate("capped-key", "moonshot", model("kimi-k2")), credentialId: "cred-capped" }];
    const { o, project, store, adapter } = await setup({ pick, candidates: cands });
    store.db.prepare("insert into credentials (id, alias, provider_id, kind, daily_cap_usd, task_cap_usd, created_at) values ('cred-capped', 'capped', 'moonshot', 'api_key', 0, null, '2026-10-30T00:00:00Z')").run();
    const t = await o.propose({ projectId: project.id, title: "Research A", pins: { researcher: "anthropic-key" } });
    await o.approve({ taskId: t.id });
    await waitFor(() => o.requests({ taskId: t.id })[0]);
    const source = o.get(t.id).runs[0]!;

    await expect(o.handoff(source.id, "anthropic-key")).rejects.toThrow("handoff.same_profile");
    await expect(o.handoff(source.id, "missing")).rejects.toThrow("crew.unknown_profile");
    await expect(o.handoff(source.id, "capped-key")).rejects.toThrow("handoff.over_cap");
    expect(o.get(t.id).handoffs).toEqual([]);

    await o.handoff(source.id, "openai-key");
    await expect(o.handoff(source.id, "deepseek-key")).rejects.toThrow(/handoff.open|run.superseded/);
    const h = await waitFor(() => o.get(t.id).handoffs.find((x) => x.outcome === "completed"));
    expect([h.trigger, h.mode, h.kind]).toEqual(["manual", "manual", "new_session"]);
    await waitFor(() => o.get(t.id).status === "done");
    const runs = o.get(t.id).runs;
    const from = runs.find((r) => r.id === source.id)!;
    const to = runs.find((r) => r.id === h.toRunId)!;
    expect([from.endReason, from.endDetail]).toEqual(["stopped", "handed_off"]);
    expect([to.profileId, to.resumedFrom, to.endReason]).toEqual(["openai-key", source.id, "completed"]);
    expect(adapter.started[1]!.req.prompt).toContain("Reason for the handoff: manual");
    await expect(o.handoff(to.id, "deepseek-key")).rejects.toThrow("run.ended");
  });

  it("retries a failed step as a fresh run of the same member and refuses finished or superseded runs", async () => {
    let researchers = 0;
    const pick: Picker = () => (researchers++ === 0 ? [running, { emit: { type: "run.ended", reason: "failed", detail: "boom" } }] : [running, say("ok")]);
    const { o, project, adapter } = await setup({ pick });
    const t = await o.propose({ projectId: project.id, title: "Research A", fallback: "manual" });
    await o.approve({ taskId: t.id });
    await waitFor(() => o.get(t.id).runs[0]?.endReason === "failed");
    const failed = o.get(t.id).runs[0]!;

    const fresh = await o.retry(failed.id);
    expect([fresh.memberId, fresh.profileId, fresh.resumedFrom]).toEqual([failed.memberId, failed.profileId, failed.id]);
    await waitFor(() => o.get(t.id).status === "done");
    expect(adapter.started.map((s) => [s.role, s.resumed])).toEqual([
      ["researcher", false],
      ["researcher", false],
    ]);
    // The crash question about the failed run closed when you retried it.
    expect(o.requests({ taskId: t.id })).toEqual([]);
    await expect(o.retry(failed.id)).rejects.toThrow("run.superseded");
    await expect(o.retry(fresh.id)).rejects.toThrow("run.ended");
  });

  it("re-checks a limit on retry: refuses while the window is used up, continues once it cleared", async () => {
    const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const pick: Picker = (_role, _req, resumed) =>
      resumed ? [running, say("back")] : [running, { emit: { type: "limit.update", window: "5h", usedPct: 100, resetsAt, provenance: "reported", reached: true } }, { awaitAnswer: "never" }];
    const { o, project } = await setup({ pick });
    const t = await o.propose({ projectId: project.id, title: "Research A", fallback: "manual" });
    await o.approve({ taskId: t.id });
    await waitFor(() => o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    const run = o.get(t.id).runs[0]!;

    await expect(o.retry(run.id)).rejects.toThrow("run.still_limited");
    expect(o.get(t.id).status).toBe("needs_input");

    o.ingestSample({ profileId: run.profileId, window: "5h", usedPct: 12, resetsAt, provenance: "reported", observedAt: new Date(Date.now() + 1_000).toISOString() });
    const continued = await o.retry(run.id);
    expect([continued.id, continued.limitReached]).toEqual([run.id, false]);
    await waitFor(() => o.get(t.id).status === "done");
    expect(o.requests({ taskId: t.id })).toEqual([]);
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

describe("safety (feature scan F3, F4, F8, F11, F17)", () => {
  const usageOf = (tokensIn: number): FakeStep => ({
    emit: { type: "usage.update", tokensIn, tokensOut: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, contextUsed: null, contextSize: null, costUsd: null, costProvenance: "unknown" },
  });
  const failWith = (detail: string): FakeStep => ({ emit: { type: "run.ended", reason: "failed", detail } });
  const addCredential = (store: Store, id: string, daily: number | null, task: number | null = null) =>
    store.db.prepare("insert into credentials (id, alias, provider_id, kind, daily_cap_usd, task_cap_usd, created_at) values (?, ?, 'x', 'api_key', ?, ?, '2026-10-30T00:00:00Z')").run(id, id, daily, task);
  const reservations = (store: Store) =>
    store.db.prepare("select run_id, amount_usd, settled_at is not null as settled, actual_usd from spend_reservations order by created_at").all() as Array<{ run_id: string; amount_usd: number; settled: number; actual_usd: number | null }>;

  it("F3: parallel steps on one key never overshoot its daily cap together", async () => {
    // Test and Review share one key; each estimate fits the cap alone, both together do not.
    const shared = (c: Candidate): Candidate => (c.profile.id === "anthropic-key" ? c : { ...c, credentialId: "cred-shared" });
    const pick: Picker = (role) => (role === "tester" ? [running, usageOf(10_000), ...question("hold-t"), say("tests pass")] : role === "reviewer" ? [running, say("looks good")] : [running, say(`${role} done`)]);
    const { o, project, store, adapter } = await setup({ pick, candidates: CANDIDATES().map(shared) });
    const t = await o.propose({ projectId: project.id, ...CODE_M, pins: { planner: "anthropic-key", implementer: "anthropic-key", tester: "openai-key", reviewer: "deepseek-key" } });
    const est = (role: string) => t.crew!.members.find((m) => m.role === role)!.chosen!.estimate.usd!;
    const [tester, reviewer] = [est("tester"), est("reviewer")];
    const cap = Math.max(tester, reviewer) + Math.min(tester, reviewer) / 2;
    expect(tester + reviewer).toBeGreaterThan(cap);
    addCredential(store, "cred-shared", cap);
    await o.approve({ taskId: t.id });

    // The tester holds its estimate, so the reviewer waits in the queue instead of starting too.
    await waitFor(() => o.requests({ taskId: t.id })[0]);
    const waiting = o.get(t.id).crew!.members.find((m) => m.role === "reviewer")!;
    expect(waiting.blockedBy).toMatchObject({ code: "admission.budget_reserved", params: { capUsd: cap, cap: "daily_cap" } });
    expect(o.get(t.id).runs.filter((r) => r.role === "reviewer")).toEqual([]);
    const testRun = o.get(t.id).runs.find((r) => r.role === "tester")!;
    expect(reservations(store).find((r) => r.run_id === testRun.id)).toMatchObject({ amount_usd: tester, settled: 0 });

    // The tester ends and settles to what it spent ($0.0125 of gpt-5 input); then the reviewer fits.
    await o.answer(o.requests({ taskId: t.id })[0]!.id, { kind: "question", answers: [{ selected: ["redis"] }] });
    await waitFor(() => o.get(t.id).status === "review");
    expect(reservations(store).find((r) => r.run_id === testRun.id)).toMatchObject({ settled: 1, actual_usd: 0.0125 });
    expect(reservations(store).every((r) => r.settled === 1)).toBe(true);
    expect(adapter.started.map((s) => s.role)).toEqual(["planner", "implementer", "tester", "reviewer"]);
    expect(o.requests({ taskId: t.id })).toEqual([]);
  });

  it("F3: a step that would pass a cap even alone asks in the Inbox with the reservation shown", async () => {
    const paid = CANDIDATES().map((c) => ({ ...c, credentialId: "cred-small" }));
    const { o, project, store, adapter } = await setup({ pick: () => [running, say("done")], candidates: paid });
    const t = await o.propose({ projectId: project.id, title: "Research A", pins: { researcher: "openai-key" } });
    addCredential(store, "cred-small", t.crew!.members[0]!.chosen!.estimate.usd! / 2);
    await o.approve({ taskId: t.id });
    const q = await waitFor(() => o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    expect(q.payload).toMatchObject({ trigger: "budget", cap: { kind: "daily_cap", spentUsd: 0, estimateUsd: t.crew!.members[0]!.chosen!.estimate.usd } });
    expect(adapter.started).toEqual([]);
    await o.answer(q.id, { kind: "handoff", decision: "continue" });
    await waitFor(() => o.get(t.id).status === "done");
  });

  it("F4: a capped task never starts on a model without a price until you approve it", async () => {
    const cands = [...CANDIDATES(), { ...candidate("mystery-key", "custom", null), credentialId: "cred-m" }];
    const { o, project, store, adapter } = await setup({ pick: () => [running, usageOf(1_000), say("done")], candidates: cands });
    addCredential(store, "cred-m", 5);
    const t = await o.propose({ projectId: project.id, title: "Research A", pins: { researcher: "mystery-key" }, budgetUsd: 1 });
    await o.approve({ taskId: t.id });

    const q = await waitFor(() => o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    expect(q.payload).toMatchObject({ kind: "handoff", trigger: "unpriced", proposedTarget: null, unpriced: { caps: ["daily_cap", "task_budget"] } });
    expect(adapter.started).toEqual([]);
    const run = o.get(t.id).runs[0]!;
    expect(run.state).toBe("rate_limited");
    await expect(o.resume(run.id)).rejects.toThrow("run.price_unknown");
    await expect(o.retry(run.id)).rejects.toThrow("run.price_unknown");

    await o.answer(q.id, { kind: "handoff", decision: "continue" });
    await waitFor(() => o.get(t.id).status === "done");
    // Approved for this run: the unpriced usage report does not ask a second time.
    expect(o.requests({ taskId: t.id })).toEqual([]);
    expect(o.get(t.id).runs[0]!.cost).toEqual({ usd: null, provenance: "unknown" });
  });

  it("F4: a run that turns out unpriced after a cap appears stops and asks before it continues", async () => {
    const cands = [...CANDIDATES(), { ...candidate("mystery-key", "custom", null), credentialId: "cred-m" }];
    const pick: Picker = () => [running, ...question("hold"), usageOf(1_000), { awaitAnswer: "never" }];
    const { o, project, store } = await setup({ pick, candidates: cands });
    addCredential(store, "cred-m", null);
    const t = await o.propose({ projectId: project.id, title: "Research A", pins: { researcher: "mystery-key" } });
    await o.approve({ taskId: t.id });
    const hold = await waitFor(() => o.requests({ taskId: t.id })[0]);
    // A daily cap set while the run works: the next unpriced report must not slip past it.
    store.db.prepare("update credentials set daily_cap_usd = 2 where id = 'cred-m'").run();
    await o.answer(hold.id, { kind: "question", answers: [{ selected: ["redis"] }] });
    const q = await waitFor(() => o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    expect(q.payload).toMatchObject({ trigger: "unpriced", unpriced: { caps: ["daily_cap"] } });
    expect(o.get(t.id).status).toBe("needs_input");
  });

  it("F8: a request every provider would refuse never hands off, falls back or retries", async () => {
    const { o, project, adapter } = await setup({ pick: () => [running, failWith('API Error: 400 {"type":"invalid_request_error"}')] });
    const t = await o.propose({ projectId: project.id, title: "Research A", fallback: "auto" });
    await o.approve({ taskId: t.id });
    await waitFor(() => o.get(t.id).status === "failed");
    await o.settle();
    expect(adapter.started).toHaveLength(1);
    expect(o.get(t.id).handoffs).toEqual([]);
    expect(o.requests({ taskId: t.id, includeAnswered: true })).toEqual([]);
    expect(o.get(t.id).runs[0]!.resumeAt).toBeNull();
  });

  it("F8: a transient error retries the same profile after Retry-After, then continues", async () => {
    let first = true;
    const pick: Picker = () => (first ? ((first = false), [running, failWith("API Error: 503 Service Unavailable, retry-after: 1")]) : [running, say("ok")]);
    const { o, project, adapter, store } = await setup({ pick });
    const t = await o.propose({ projectId: project.id, title: "Research A", fallback: "manual" });
    await o.approve({ taskId: t.id });
    const failed = await waitFor(() => o.get(t.id).runs.find((r) => r.endReason === "failed" && r.resumeAt));
    // Waiting for its retry is not failed, and nobody is asked yet.
    expect(o.get(t.id).status).not.toBe("failed");
    expect(Date.parse(failed.resumeAt!) - Date.parse(failed.endedAt!)).toBeGreaterThanOrEqual(900);
    expect(o.requests({ taskId: t.id })).toEqual([]);
    await waitFor(() => o.get(t.id).status === "done", 5_000);
    expect(adapter.started.map((s) => s.resumed)).toEqual([false, true]);
    const retried = o.get(t.id).runs.find((r) => r.resumedFrom === failed.id)!;
    expect([retried.profileId, retried.nativeSessionId]).toEqual([failed.profileId, failed.nativeSessionId]);
    expect(store.db.prepare("select attempt, failure, status, delay_ms from run_retries").all()).toEqual([{ attempt: 1, failure: "transient", status: 503, delay_ms: 1000 }]);
  });

  it("F8: a transient error asks after three same-profile retries", async () => {
    const { o, project, adapter } = await setup({ pick: () => [running, failWith("HTTP status 502 Bad Gateway retry-after: 1")] });
    const t = await o.propose({ projectId: project.id, title: "Research A", fallback: "manual" });
    await o.approve({ taskId: t.id });
    const q = await waitFor(() => o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"), 10_000);
    expect(q.payload).toMatchObject({ trigger: "crashed" });
    expect(adapter.started).toHaveLength(4);
  });

  it("F8: a transient error in Auto mode switches profile at once, without waiting", async () => {
    let first = true;
    const pick: Picker = () => (first ? ((first = false), [running, failWith("API Error: 429 rate_limit_error, retry-after: 30")]) : [running, say("ok")]);
    const { o, project } = await setup({ pick });
    const t = await o.propose({ projectId: project.id, title: "Research A", fallback: "auto" });
    await o.approve({ taskId: t.id });
    const started = Date.now();
    await waitFor(() => o.get(t.id).status === "done");
    expect(Date.now() - started).toBeLessThan(10_000);
    const [source, target] = o.get(t.id).runs;
    expect(source!.resumeAt).toBeNull();
    expect(target!.profileId).not.toBe(source!.profileId);
    expect(o.get(t.id).handoffs[0]).toMatchObject({ trigger: "crashed", outcome: "completed" });
  });

  it("F11: stop, message and answer refuse a session a handoff replaced since you looked", async () => {
    let starts = 0;
    const pick: Picker = () => (starts++ === 0 ? [running, ...question("hold")] : [running, ...question("again"), say("moved")]);
    const { o, project } = await setup({ pick });
    const t = await o.propose({ projectId: project.id, title: "Research A", pins: { researcher: "anthropic-key" } });
    await o.approve({ taskId: t.id });
    const asked = await waitFor(() => o.requests({ taskId: t.id })[0]);
    const seen = o.get(t.id).runs[0]!;
    expect(asked.sessionId).toBe(seen.nativeSessionId);
    await expect(o.stop(seen.id, { sessionId: "another-session" })).rejects.toThrow("run.session_changed");

    await o.handoff(seen.id, "openai-key");
    const target = await waitFor(() => o.get(t.id).runs.find((r) => r.resumedFrom === seen.id && r.nativeSessionId));
    await expect(o.stop(seen.id, { sessionId: seen.nativeSessionId })).rejects.toThrow("run.session_changed");
    await expect(o.pause(seen.id, { sessionId: seen.nativeSessionId })).rejects.toThrow("run.session_changed");
    await expect(o.message(seen.id, "hi", { sessionId: seen.nativeSessionId })).rejects.toThrow("run.session_changed");

    const again = await waitFor(() => o.requests({ taskId: t.id }).find((q) => q.runId === target.id));
    await expect(o.answer(again.id, { kind: "question", answers: [{ selected: ["redis"] }] }, { runId: seen.id, sessionId: seen.nativeSessionId })).rejects.toThrow("run.session_changed");
    await o.answer(again.id, { kind: "question", answers: [{ selected: ["redis"] }] }, { runId: again.runId, sessionId: again.sessionId });
    await waitFor(() => o.get(t.id).status === "done");
  });

  it("F17: a denial carries your reason to the agent, trimmed; an approval carries none", async () => {
    const pick: Picker = () => [running, ...approval("a1", "npm install left-pad"), ...approval("a2", "npm test"), say("done")];
    const { o, project, adapter } = await setup({ pick });
    const t = await o.propose({ projectId: project.id, title: "Research A" });
    await o.approve({ taskId: t.id });
    const first = await waitFor(() => o.requests({ taskId: t.id })[0]);
    await o.answer(first.id, { kind: "approval", decision: "deny", message: "  Use pnpm; this repo has no npm lockfile.  " }, { runId: first.runId, sessionId: first.sessionId });
    const second = await waitFor(() => o.requests({ taskId: t.id })[0]);
    await o.answer(second.id, { kind: "approval", decision: "allow_once", message: "ignored" }, { runId: second.runId, sessionId: second.sessionId });
    await waitFor(() => o.get(t.id).status === "done");
    expect(adapter.inspect(adapter.started[0]!.runId).answers).toEqual([
      { kind: "approval", decision: "deny", message: "Use pnpm; this repo has no npm lockfile." },
      { kind: "approval", decision: "allow_once" },
    ]);
    expect(o.requests({ taskId: t.id, includeAnswered: true })[0]!.answer).toEqual({ kind: "approval", decision: "deny", message: "Use pnpm; this repo has no npm lockfile." });
  });
});

describe("schema-checked results", () => {
  it("asks planner and reviewer for JSON, hands the checked plan on and records the verdict", async () => {
    const plan = { summary: "Rate limit logins.", steps: [{ title: "Add a token bucket", detail: "five per minute" }], acceptanceCriteria: ["429 after five tries"], risks: [] };
    const verdict = { verdict: "changes", summary: "Missing test.", comments: [{ file: "src/login.ts", line: 12, severity: "major", body: "No test for the reset." }] };
    const pick: Picker = (role) =>
      role === "planner"
        ? [running, { emit: { type: "plan.update", steps: [{ title: "scratch todo", status: "in_progress" }] } }, { emit: { type: "run.ended", reason: "completed", output: { ok: true, value: plan } } }]
        : role === "reviewer"
          ? [running, { emit: { type: "run.ended", reason: "completed", output: { ok: true, value: verdict } } }]
          : role === "tester"
            ? [running, { emit: { type: "run.ended", reason: "completed", output: { ok: false, error: "never asked" } } }]
            : quick(role, {} as StartRequest, false);
    const { o, project, adapter, store } = await setup({ pick });
    const proposed = await o.propose({ projectId: project.id, ...CODE_M });
    await o.approve({ taskId: proposed.id });
    await waitFor(() => o.get(proposed.id).status === "review");

    const req = (role: string) => adapter.started.find((s) => s.role === role)!.req;
    expect(req("planner").outputSchema?.name).toBe("planner_plan");
    expect(req("reviewer").outputSchema?.name).toBe("review_verdict");
    expect(req("implementer").outputSchema).toBeUndefined();
    expect(req("tester").outputSchema).toBeUndefined();
    // The checked plan, not the planner's scratch todo list, is what the implementer works from.
    expect(req("implementer").prompt).toContain("1. Add a token bucket: five per minute");
    expect(req("implementer").prompt).not.toContain("scratch todo");

    const events = store.eventsSince(0, 5_000);
    expect(events.find((e) => e.kind === "review.verdict")?.payload).toEqual({ verdict: "changes", summary: "Missing test.", comments: verdict.comments });
    expect(events.find((e) => e.kind === "plan.result")?.payload).toEqual({ plan });
    // A role that asked for no result gets nothing recorded, whatever its adapter sent.
    expect(events.some((e) => e.kind === "result.invalid")).toBe(false);
  });
});
