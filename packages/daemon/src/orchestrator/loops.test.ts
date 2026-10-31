import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultProjectConfig, sessionError, type ProjectConfig, type RunOutput, type StartRequest } from "@crewyard/core";
import type { FakeStep } from "@crewyard/adapter-fake";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store.ts";
import { AdapterRegistry } from "./adapters.ts";
import type { Candidate } from "./directory.ts";
import { LoopStore, reviewChangesMessage, testFailureMessage } from "./loops.ts";
import type { OrchestratorContext } from "./context.ts";
import { Orchestrator, type OrchestratorOptions } from "./orchestrator.ts";
import type { RoleResult } from "./results.ts";
import { CANDIDATES, candidate, cleanTemps, git, model, ScriptedAdapter, tempDir, tempRepo, waitFor, type ScriptedOptions } from "./testing.ts";

// Crew loops (feature scan A9, A11, A12) and handoff hardening, end to end over a real git repo
// with scripted runners. The project's "test command" is a small node script, so pass and fail
// are decided by files the test controls.

vi.setConfig({ testTimeout: 40_000, hookTimeout: 30_000 });

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
const quick: Picker = (role) => [running, say(`${role} done`)];

const verdict = (v: "pass" | "changes", body = "Handle the empty input."): RunOutput => ({
  ok: true,
  value: { verdict: v, summary: v === "pass" ? "Looks right." : "One bug.", comments: v === "pass" ? [] : [{ file: "src/a.ts", line: 3, severity: "major", body }] },
});

/**
 * A test command that fails until `pass.flag` exists next to it, and counts its runs. With
 * `touch`, every run also writes a new file into the worktree, so the tree changes between tries.
 */
function testScript(dir: string, opts: { passOnRun?: number; touch?: boolean } = {}): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "check tests.mjs");
  writeFileSync(
    script,
    [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      `const counter = ${JSON.stringify(join(dir, "runs.txt"))};`,
      'const n = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;',
      'writeFileSync(counter, String(n));',
      opts.touch ? 'writeFileSync(join(process.cwd(), `try-${n}.txt`), String(n));' : "",
      `if (n >= ${opts.passOnRun ?? 1_000_000}) { console.log("all green"); process.exit(0); }`,
      'console.error(`FAIL limiter.test.ts: expected 429, got 200 (run ${n})`);',
      "process.exit(1);",
    ].join("\n"),
  );
  return `node "${script}"`;
}

async function setup(opts: { pick?: Picker; candidates?: Candidate[]; config?: (c: ProjectConfig) => void; scripted?: ScriptedOptions; options?: Partial<OrchestratorOptions> }) {
  const root = tempDir("crewyard loops-");
  const repo = await tempRepo(root);
  const cfg = defaultProjectConfig("demo repo", join(root, ".mc", "worktrees", "demo repo"));
  opts.config?.(cfg);
  mkdirSync(join(repo, ".crewyard"), { recursive: true });
  writeFileSync(join(repo, ".crewyard", "project.json"), JSON.stringify(cfg));
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "project config");
  const store = new Store(join(root, "t.db"));
  const project = store.addProject(repo, "demo repo");
  const adapter = new ScriptedAdapter(opts.pick ?? quick, opts.scripted);
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const cands = opts.candidates ?? CANDIDATES();
  const options: OrchestratorOptions = {
    store,
    dataDir: join(root, "data"),
    emit: () => undefined,
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
  return { o, store, project, adapter, root, repo, options };
}

const CODE_S = { title: "Fix the limiter for empty input", description: "" };
const kinds = (o: Orchestrator, taskId: string) => o.get(taskId).loop.decisions.map((d) => d.kind);

describe("run until green", () => {
  it("sends a test failure back to the same session, and finishes once the tests pass", async () => {
    let command = "";
    const { o, project, adapter } = await setup({
      config: (c) => {
        command = testScript(join(c.worktreeRoot, ".."), { passOnRun: 2 });
        c.commands.test = command;
      },
      scripted: { result: (role) => (role === "reviewer" ? verdict("pass") : undefined) },
    });
    const t = await o.propose({ projectId: project.id, ...CODE_S, kind: "code", size: "S" });
    await o.approve({ taskId: t.id });
    const done = await waitFor(() => (o.get(t.id).status === "review" ? o.get(t.id) : null), 30_000);
    expect(kinds(o, t.id)).toEqual(["tests_failed", "tests_passed", "review_passed"]);
    const impl = adapter.started.find((s) => s.role === "implementer")!;
    // The failure became the next turn of the same run, not a new run.
    expect(done.runs.filter((r) => r.role === "implementer")).toHaveLength(1);
    const turn2 = adapter.inspect(impl.runId).inputs[0]!.text;
    expect(turn2).toContain("fix attempt 1 of 3");
    expect(turn2).toContain("expected 429, got 200 (run 1)");
    expect(done.loop.tests.map((x) => x.passed)).toEqual([false, true]);
    expect(done.loop.tests[0]!.command).toBe(command);
    // The verdict is pinned to the commit the reviewer read.
    const head = (await git(done.worktree!.path, "rev-parse", "HEAD")).trim();
    expect(done.loop.verdicts).toMatchObject([{ verdict: "pass", headSha: head, stale: false }]);
  });

  it("stops early when the worktree did not change between two failing tries", async () => {
    const { o, project } = await setup({ config: (c) => (c.commands.test = testScript(join(c.worktreeRoot, ".."))) });
    const t = await o.propose({ projectId: project.id, ...CODE_S, kind: "code", size: "S" });
    await o.approve({ taskId: t.id });
    const done = await waitFor(() => (o.get(t.id).status === "failed" ? o.get(t.id) : null), 30_000);
    expect(kinds(o, t.id)).toEqual(["tests_failed", "stop_no_change"]);
    const impl = done.runs.find((r) => r.role === "implementer")!;
    expect([impl.endReason, impl.endDetail]).toEqual(["failed", "loop.no_change"]);
    // A failed loop is no crash: no handoff or retry is offered on its own, and the reviewer never ran.
    expect(o.requests({ taskId: t.id })).toEqual([]);
    expect(done.runs.some((r) => r.role === "reviewer")).toBe(false);
  });

  it("stops at the iteration cap", async () => {
    const { o, project } = await setup({
      config: (c) => {
        c.commands.test = testScript(join(c.worktreeRoot, ".."), { touch: true });
        c.loop.maxIterations = 2;
      },
    });
    const t = await o.propose({ projectId: project.id, ...CODE_S, kind: "code", size: "S" });
    await o.approve({ taskId: t.id });
    const done = await waitFor(() => (o.get(t.id).status === "failed" ? o.get(t.id) : null), 30_000);
    expect(kinds(o, t.id)).toEqual(["tests_failed", "tests_failed", "stop_iteration_cap"]);
    expect(done.loop.decisions.map((d) => d.iteration)).toEqual([1, 2, 2]);
    expect(done.loop.decisions.at(-1)!.reason).toEqual({ code: "loop.iteration_cap", params: { max: 2 } });
    expect(done.runs.find((r) => r.role === "implementer")!.endDetail).toBe("loop.iteration_cap");
  });

  it("records a skip when the project has no test command", async () => {
    const { o, project } = await setup({ scripted: { result: (role) => (role === "reviewer" ? verdict("pass") : undefined) } });
    const t = await o.propose({ projectId: project.id, ...CODE_S, kind: "code", size: "S" });
    await o.approve({ taskId: t.id });
    await waitFor(() => o.get(t.id).status === "review", 30_000);
    expect(kinds(o, t.id)).toEqual(["tests_skipped", "review_passed"]);
  });
});

describe("loop notes in memory", () => {
  // The loop's stop rule and a reviewer's verdict wait in memory until the run's stream ends. A run
  // that ends any other way (stopped while paused, handed off) must not leave them behind.
  const hold: Picker = (role) => (role === "implementer" ? [running, say("working"), { awaitAnswer: "never" }] : [running, say(`${role} done`)]);
  const notes = (o: Orchestrator) => (o as unknown as { ctx: OrchestratorContext }).ctx;
  const note = (o: Orchestrator, runId: string) => {
    notes(o).loopFailed.set(runId, "loop.iteration_cap");
    notes(o).verdicts.set(runId, { kind: "review", verdict: "pass", summary: "ok", comments: [] } as unknown as RoleResult);
  };
  const kept = (o: Orchestrator, runId: string) => [notes(o).loopFailed.has(runId), notes(o).verdicts.has(runId)];

  it("keeps them while a paused run may still go on, and forgets them once it is stopped", async () => {
    const { o, project } = await setup({ pick: hold });
    const t = await o.propose({ projectId: project.id, ...CODE_S, kind: "code", size: "S" });
    await o.approve({ taskId: t.id });
    const run = await waitFor(() => o.get(t.id).runs.find((r) => r.role === "implementer" && r.state === "running"), 30_000);
    note(o, run.id);
    await o.pause(run.id);
    await waitFor(() => o.get(t.id).runs.find((r) => r.id === run.id)!.state === "paused");
    expect(kept(o, run.id)).toEqual([true, true]);
    await o.stop(run.id);
    expect(o.get(t.id).runs.find((r) => r.id === run.id)!.endReason).toBe("stopped");
    expect(kept(o, run.id)).toEqual([false, false]);
  });

  it("forgets them for a source run that handed its step off", async () => {
    const { o, project } = await setup({ pick: hold, candidates: [...CANDIDATES(), candidate("ds-b", "deepseek", model("deepseek-chat", { reasoning: false }))] });
    const t = await o.propose({ projectId: project.id, ...CODE_S, kind: "code", size: "S", pins: { implementer: "deepseek-key", reviewer: "openai-key" } });
    await o.approve({ taskId: t.id });
    const run = await waitFor(() => o.get(t.id).runs.find((r) => r.role === "implementer" && r.state === "running"), 30_000);
    note(o, run.id);
    await o.handoff(run.id, "ds-b");
    await waitFor(() => o.get(t.id).handoffs[0]?.outcome === "completed", 20_000);
    expect(o.get(t.id).runs.find((r) => r.id === run.id)!.endDetail).toBe("handed_off");
    expect(kept(o, run.id)).toEqual([false, false]);
  });
});

describe("review loop", () => {
  it("returns a changes verdict to the same implementer session, then re-runs Test and Review on the new head", async () => {
    const { o, project, adapter } = await setup({
      config: (c) => (c.commands.test = testScript(join(c.worktreeRoot, ".."), { passOnRun: 1 })),
      scripted: { result: (role, nth) => (role === "reviewer" ? verdict(nth === 0 ? "changes" : "pass") : undefined) },
    });
    const t = await o.propose({ projectId: project.id, ...CODE_S, kind: "code", size: "S" });
    await o.approve({ taskId: t.id });
    const done = await waitFor(() => {
      const d = o.get(t.id);
      return d.status === "review" && d.loop.verdicts.length === 2 ? d : null;
    }, 30_000);
    expect(kinds(o, t.id)).toEqual(["tests_passed", "review_changes", "tests_passed", "review_passed"]);
    const impls = done.runs.filter((r) => r.role === "implementer");
    expect(impls).toHaveLength(2);
    // Same session, resumed with the reviewer's comments.
    const second = adapter.started.filter((s) => s.resumed)[0]!;
    expect(second.ref?.sessionId).toBe(impls[0]!.nativeSessionId);
    expect(second.req.prompt).toContain("[major] src/a.ts:3: Handle the empty input.");
    expect(impls[1]!.resumedFrom).toBe(impls[0]!.id);
    // The re-review got the earlier comments to check, and replaced the first review run.
    const reviews = adapter.started.filter((s) => s.role === "reviewer");
    expect(reviews).toHaveLength(2);
    expect(reviews[1]!.req.prompt).toContain("asked for changes; check each one was addressed");
    const [first, last] = done.loop.verdicts;
    expect(first).toMatchObject({ verdict: "changes", stale: true });
    expect(last).toMatchObject({ verdict: "pass", stale: false });
    expect(o.loops.verdictFor(t.id, last!.headSha!)?.verdict).toBe("pass");
  });

  it("stops when the review keeps asking for changes past the cap", async () => {
    const { o, project } = await setup({
      config: (c) => (c.loop.maxIterations = 1),
      scripted: { result: (role) => (role === "reviewer" ? verdict("changes") : undefined) },
    });
    const t = await o.propose({ projectId: project.id, ...CODE_S, kind: "code", size: "S" });
    await o.approve({ taskId: t.id });
    await waitFor(() => kinds(o, t.id).includes("stop_iteration_cap"), 30_000);
    await o.settle();
    expect(kinds(o, t.id)).toEqual(["tests_skipped", "review_changes", "tests_skipped", "stop_iteration_cap"]);
    // The task waits for you with a changes verdict; the gates never pass it.
    const d = o.get(t.id);
    expect(d.loop.verdicts.at(-1)!.verdict).toBe("changes");
  });

  it("records a reviewer result that failed its check, and does not guess", async () => {
    const { o, project } = await setup({ scripted: { result: (role) => (role === "reviewer" ? { ok: false, error: "verdict: invalid option" } : undefined) } });
    const t = await o.propose({ projectId: project.id, ...CODE_S, kind: "code", size: "S" });
    await o.approve({ taskId: t.id });
    await waitFor(() => kinds(o, t.id).includes("review_invalid"), 30_000);
    expect(o.get(t.id).loop.verdicts).toEqual([]);
  });

  it("asks the runner's own review when it has one, against the task base", async () => {
    const { o, project, adapter } = await setup({ scripted: { capabilities: { nativeReview: true }, result: (role) => (role === "reviewer" ? verdict("pass") : undefined) } });
    const t = await o.propose({ projectId: project.id, ...CODE_S, kind: "code", size: "S" });
    await o.approve({ taskId: t.id });
    const done = await waitFor(() => (o.get(t.id).status === "review" ? o.get(t.id) : null), 30_000);
    const review = adapter.started.find((s) => s.role === "reviewer")!;
    expect(review.req.review).toEqual({ target: { kind: "base_branch", branch: done.worktree!.baseSha } });
    expect(review.req.outputSchema?.name).toBe("review_verdict");
    expect(done.loop.verdicts[0]).toMatchObject({ native: true });
    // The implementer never gets a review target.
    expect(adapter.started.find((s) => s.role === "implementer")!.req.review).toBeUndefined();
  });
});

describe("handoff hardening", () => {
  const sameProvider = (): Candidate[] => [
    candidate("ds-a", "deepseek", model("deepseek-flash")),
    candidate("ds-b", "deepseek", model("deepseek-pro")),
    candidate("openai-key", "openai", model("gpt-5")),
  ];
  const slowImpl: Picker = (role, _req, resumed) => (role === "implementer" && !resumed ? [running, { wait: 400 }, say("halfway"), { wait: 400 }, say("turn finished")] : [running, say(`${role} done`)]);

  it("forks the session into a profile on the same runner and provider, and records the compaction's spend", async () => {
    const { o, project, adapter, store } = await setup({
      pick: slowImpl,
      candidates: sameProvider(),
      scripted: {
        capabilities: { fork: { compact: true } },
        // The copied history searched three times and opened a page before the fork.
        fork: async () => ({ session: { runner: "fake", sessionId: "forked-1" }, compacted: true, summary: "short", usage: { tokensIn: 1000, tokensOut: 100, cacheRead: 0, costUsd: null }, totals: { tokensIn: 1000, tokensOut: 100, cacheRead: 0, costUsd: null, webSearchRequests: 3, webFetchRequests: 1 } }),
        result: (role) => (role === "reviewer" ? verdict("pass") : undefined),
      },
    });
    const t = await o.propose({ projectId: project.id, ...CODE_S, kind: "code", size: "S", pins: { implementer: "ds-a", reviewer: "openai-key" } });
    await o.approve({ taskId: t.id });
    const src = await waitFor(() => o.get(t.id).runs.find((r) => r.role === "implementer" && r.state === "running"));
    await o.handoff(src.id, "ds-b");
    const done = await waitFor(() => (o.get(t.id).handoffs[0]?.outcome === "completed" ? o.get(t.id) : null), 20_000);
    expect(done.handoffs[0]).toMatchObject({ kind: "fork", stop: "interrupt" });
    expect(adapter.forks[0]).toMatchObject({ source: { profile: { id: "ds-a" }, session: { sessionId: src.nativeSessionId } }, target: { profile: { id: "ds-b" } }, compact: true });
    const target = adapter.started.find((s) => s.ref?.sessionId === "forked-1")!;
    expect(target.req.prompt).toContain("The conversation above was continued by another agent");
    const tr = done.runs.find((r) => r.profileId === "ds-b")!;
    expect(tr.tokensIn).toBe(1000);
    expect(tr.cost.provenance).toBe("estimated");
    // Those requests are the fork session's baseline: its later totals add only what is new.
    expect(store.db.prepare("select web_search, web_fetch from native_usage_requests where session_id = ?").get("forked-1")).toEqual({ web_search: 3, web_fetch: 1 });
  });

  it("never forks into a reviewer: an independent role gets the written package", async () => {
    const reviewerSlow: Picker = (role) => (role === "reviewer" ? [running, { wait: 1_500 }, say("reviewed")] : [running, say(`${role} done`)]);
    const { o, project, adapter } = await setup({
      pick: reviewerSlow,
      candidates: [candidate("anthropic-key", "anthropic", model("claude-sonnet")), ...sameProvider()],
      scripted: { capabilities: { fork: { compact: true } }, fork: async () => ({ session: { runner: "fake", sessionId: "nope" }, compacted: false, summary: null, usage: null }) },
    });
    const t = await o.propose({ projectId: project.id, ...CODE_S, kind: "code", size: "S", pins: { implementer: "anthropic-key", reviewer: "ds-a" } });
    await o.approve({ taskId: t.id });
    const rv = await waitFor(() => o.get(t.id).runs.find((r) => r.role === "reviewer" && r.state === "running"), 20_000);
    await o.handoff(rv.id, "ds-b");
    await waitFor(() => o.get(t.id).handoffs[0]?.closedAt);
    expect(adapter.forks).toEqual([]);
    expect(o.get(t.id).handoffs[0]!.kind).toBe("new_session");
  });

  it("drain lets the turn in flight finish before the source stops", async () => {
    const { o, project, adapter, store } = await setup({ pick: slowImpl, candidates: sameProvider() });
    const t = await o.propose({ projectId: project.id, ...CODE_S, kind: "code", size: "S", pins: { implementer: "ds-a", reviewer: "openai-key" } });
    await o.approve({ taskId: t.id });
    const src = await waitFor(() => o.get(t.id).runs.find((r) => r.role === "implementer" && r.state === "running"));
    await o.handoff(src.id, "ds-b", "drain");
    const d = await waitFor(() => (o.get(t.id).handoffs[0]?.outcome === "completed" ? o.get(t.id) : null), 20_000);
    expect(d.handoffs[0]!.stop).toBe("drain");
    const source = d.runs.find((r) => r.id === src.id)!;
    // Stopped for the target, never ended as completed, and its whole turn ran first.
    expect([source.endReason, source.endDetail]).toEqual(["stopped", "handed_off"]);
    const said = (store.db.prepare("select payload from events where run_id = ? and kind = 'run.message.delta'").all(src.id) as Array<{ payload: string }>).map((r) => r.payload).join(" ");
    expect(said).toContain("turn finished");
    expect(adapter.started.filter((s) => s.req.profile.id === "ds-b")).toHaveLength(1);
  });

  it("fences a source after the swap: its late answers are refused", async () => {
    const root = tempDir("crewyard epochs-");
    const store = new Store(join(root, "t.db"));
    const loops = new LoopStore(store.db, () => new Date());
    loops.enlist("src", "m1");
    expect(loops.fenced("src", "m1")).toBe(false);
    loops.bump("m1", "dst");
    expect(loops.fenced("src", "m1")).toBe(true);
    expect(loops.fenced("dst", "m1")).toBe(false);
    // Runs from before epochs existed are never fenced.
    expect(loops.fenced("old", "m1")).toBe(false);
    store.close();
  });

  it("reconciles an open handoff on daemon start: the source keeps the step and you are asked", async () => {
    const env = await setup({ pick: slowImpl, candidates: sameProvider() });
    const t = await env.o.propose({ projectId: env.project.id, ...CODE_S, kind: "code", size: "S", pins: { implementer: "ds-a", reviewer: "openai-key" } });
    await env.o.approve({ taskId: t.id });
    const src = await waitFor(() => env.o.get(t.id).runs.find((r) => r.role === "implementer" && r.state === "running"));
    // The daemon dies with a handoff open.
    env.store.db.prepare("insert into handoffs (id, task_id, from_run_id, target_profile_id, mode, trigger_kind, phase, opened_at) values ('h1', ?, ?, 'ds-b', 'manual', 'manual', 'checkpoint', ?)").run(t.id, src.id, new Date().toISOString());
    env.o.shutdown();
    await env.o.settle();
    const o2 = new Orchestrator(env.options);
    o2.start();
    open.push({ o: o2, store: env.store });
    const q = await waitFor(() => o2.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    expect(q.payload).toMatchObject({ kind: "handoff", trigger: "handoff_failed", detail: "handoff_interrupted" });
    expect(o2.get(t.id).handoffs[0]).toMatchObject({ outcome: "interrupted", detail: "checkpoint" });
  });

  it("replaces a session only when the runner says it is gone, with the handoff package", async () => {
    const env = await setup({ pick: slowImpl, scripted: { resumeError: () => sessionError("gone", "no rollout found for thread id x") } });
    const t = await env.o.propose({ projectId: env.project.id, ...CODE_S, kind: "code", size: "S" });
    await env.o.approve({ taskId: t.id });
    const src = await waitFor(() => env.o.get(t.id).runs.find((r) => r.role === "implementer" && r.state === "running"));
    await env.o.stop(src.id);
    await env.o.resume(src.id);
    const fresh = await waitFor(() => env.o.get(t.id).runs.find((r) => r.role === "implementer" && r.endDetail !== "user_stop" && r.endDetail !== "session.gone" && r.id !== src.id));
    const failed = env.o.get(t.id).runs.find((r) => r.endDetail === "session.gone")!;
    expect(failed.resumedFrom).toBe(src.id);
    expect(fresh.resumedFrom).toBe(failed.id);
    const start = env.adapter.started.find((s) => !s.resumed && s.req.prompt.includes("# Handoff package"))!;
    expect(start.req.prompt).toContain("the previous session is gone");
  });

  it("keeps a session with history when resume fails for any other reason", async () => {
    const env = await setup({ pick: slowImpl, scripted: { resumeError: () => new Error("network is down") } });
    const t = await env.o.propose({ projectId: env.project.id, ...CODE_S, kind: "code", size: "S" });
    await env.o.approve({ taskId: t.id });
    const src = await waitFor(() => env.o.get(t.id).runs.find((r) => r.role === "implementer" && r.state === "running"));
    await env.o.stop(src.id);
    await env.o.resume(src.id);
    await env.o.settle();
    expect(env.adapter.started.filter((s) => s.req.prompt.includes("# Handoff package"))).toEqual([]);
  });
});

describe("agent-facing loop text", () => {
  it("bounds the test output and names the attempt", () => {
    const text = testFailureMessage({ command: "npm test", exitCode: 1, timedOut: false, tail: "x".repeat(10_000), attempt: 2, max: 3 });
    expect(text).toContain("fix attempt 2 of 3");
    expect(text.length).toBeLessThan(6_600);
  });

  it("lists every comment with its place", () => {
    const text = reviewChangesMessage({
      verdict: { runId: "r", memberId: "m", verdict: "changes", summary: "S", comments: [{ file: "a.ts", line: null, severity: "blocker", body: "B" }], headSha: "abc", native: false, stale: false, at: "" },
      attempt: 1,
      max: 3,
    });
    expect(text).toContain("1. [blocker] a.ts: B");
    expect(text).toContain("commit abc");
  });

});
