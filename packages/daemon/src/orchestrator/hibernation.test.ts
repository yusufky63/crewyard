import { join } from "node:path";
import type { StartRequest } from "@crewyard/core";
import type { FakeStep } from "@crewyard/adapter-fake";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store.ts";
import { AdapterRegistry } from "./adapters.ts";
import { answerAfterSleep, idleSince, type IdleFacts } from "./hibernation.ts";
import { Orchestrator, type OrchestratorOptions } from "./orchestrator.ts";
import { CANDIDATES, cleanTemps, ScriptedAdapter, tempDir, tempRepo, waitFor } from "./testing.ts";

// Hibernation: a run that waits on you with its process idle gets the process stopped; it stays
// open, and wakes by session id with your answer or message.

vi.setConfig({ testTimeout: 30_000 });

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
const done = (text = "done"): FakeStep => ({ emit: { type: "message.delta", text } });
const asks: FakeStep[] = [running, { emit: { type: "request.question", requestId: "q1", questions: [{ prompt: "Which store?", options: [{ label: "redis" }, { label: "memory" }], allowFreeText: false }] } }, { awaitAnswer: "q1" }];
const wantsInstall: FakeStep[] = [running, { emit: { type: "request.approval", requestId: "a1", toolCallId: "t1", command: "pnpm add left-pad", cwd: null, paths: [], network: true } }, { awaitAnswer: "a1" }];

const MIN = 60_000;

async function setup(pick: Picker, over: Partial<OrchestratorOptions> = {}, existing?: { store: Store; root: string; repo: string; projectId: string }) {
  const root = existing?.root ?? tempDir("crewyard hib-");
  const repo = existing?.repo ?? (await tempRepo(root));
  const store = existing?.store ?? new Store(join(root, "t.db"));
  const projectId = existing?.projectId ?? store.addProject(repo, "demo repo").id;
  const adapter = new ScriptedAdapter(pick);
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const cands = CANDIDATES();
  const clock = { shift: 0 };
  const o = new Orchestrator({
    store,
    dataDir: join(root, "data"),
    emit: () => undefined,
    adapters,
    directory: { candidates: () => cands, envFor: () => ({}) },
    tickMs: 0,
    hibernateCheckMs: 0,
    scheduleCheckMs: 0,
    freeMemoryMb: () => 64_000,
    stopTimeoutMs: 2_000,
    now: () => new Date(Date.now() + clock.shift),
    ...over,
  });
  o.start();
  open.push({ o, store });
  return { o, store, adapter, clock, root, repo, projectId };
}

const RESEARCH = { title: "Compare cache stores", description: "", kind: "research" as const, size: "S" as const };

describe("idle rules", () => {
  const facts = (over: Partial<IdleFacts> = {}): IdleFacts => ({ inTurn: false, busy: false, paused: false, limited: false, resumable: true, lastActivityAt: "2026-11-02T08:00:00Z", startedAt: "2026-11-02T07:00:00Z", request: null, ...over });
  const at = new Date("2026-11-02T08:31:00Z");

  it("counts idle time from the later of the request and the last event", () => {
    expect(idleSince(facts(), at, 30)).toBe("2026-11-02T08:00:00Z");
    expect(idleSince(facts(), at, 45)).toBeNull();
    expect(idleSince(facts({ request: { id: "q", createdAt: "2026-11-02T08:10:00Z", hibernatable: true } }), at, 30)).toBeNull();
    expect(idleSince(facts({ request: { id: "q", createdAt: "2026-11-02T07:50:00Z", hibernatable: true } }), at, 30)).toBe("2026-11-02T08:00:00Z");
  });

  it("never hibernates a working, paused, limited or unresumable run, or one our own work holds", () => {
    expect(idleSince(facts({ inTurn: true }), at, 30)).toBeNull();
    expect(idleSince(facts({ paused: true }), at, 30)).toBeNull();
    expect(idleSince(facts({ limited: true }), at, 30)).toBeNull();
    expect(idleSince(facts({ resumable: false }), at, 30)).toBeNull();
    expect(idleSince(facts({ busy: true }), at, 30)).toBeNull();
    expect(idleSince(facts({ request: { id: "b", createdAt: "2026-11-02T07:00:00Z", hibernatable: false } }), at, 30)).toBeNull();
  });

  it("gives the woken session the question and your answer as data", () => {
    const text = answerAfterSleep({ kind: "question", questions: [{ prompt: "Which store?", options: [{ label: "redis" }], allowFreeText: true }] }, { kind: "question", answers: [{ selected: ["redis"], text: "with TTL" }] });
    expect(text).toContain("Which store?");
    expect(text).toContain("Answer: redis; with TTL");
    const denied = answerAfterSleep({ kind: "approval", toolCallId: null, command: "rm -rf dist", cwd: null, paths: [], network: false, policy: null }, { kind: "approval", decision: "deny", message: "not now" });
    expect(denied).toContain("was denied: not now");
  });
});

describe("hibernation", () => {
  it("stops the process of a run idle on a question, keeps it open, and wakes it with the answer", async () => {
    const { o, adapter, clock, projectId } = await setup((_role, _req, resumed) => (resumed ? [running, done("used redis")] : asks));
    const t = await o.propose({ projectId, ...RESEARCH });
    await o.approve({ taskId: t.id });
    const q = await waitFor(() => o.requests({ taskId: t.id })[0]);
    // Not idle long enough yet.
    clock.shift = 29 * MIN;
    await o.checkHibernation();
    expect(o.get(t.id).runs[0]!.state).toBe("waiting_input");

    clock.shift = 31 * MIN;
    await o.checkHibernation();
    const asleep = o.get(t.id);
    const run = asleep.runs[0]!;
    // Its own state: open, not stopped, its question still waiting for you, its slot free.
    expect(run.endedAt).toBeNull();
    expect(run.endReason).toBeNull();
    expect(run.hibernatedAt).not.toBeNull();
    expect(asleep.status).toBe("needs_input");
    expect(o.requests({ taskId: t.id }).map((r) => r.id)).toEqual([q.id]);
    expect(o.db.activeCounts().total).toBe(0);
    expect(run.state).toBe("waiting_input");

    await o.answer(q.id, { kind: "question", answers: [{ selected: ["redis"] }] });
    const woke = await waitFor(() => adapter.started.find((s) => s.resumed));
    expect(woke.ref).toEqual({ runner: "fake", sessionId: adapter.started[0]!.runId });
    expect(woke.req.prompt).toContain("Which store?");
    expect(woke.req.prompt).toContain("Answer: redis");
    const finished = await waitFor(() => (o.get(t.id).status === "done" ? o.get(t.id) : null));
    // The same run woke; no new run, never "stopped".
    expect(finished.runs).toHaveLength(1);
    expect(finished.runs[0]).toMatchObject({ endReason: "completed", hibernatedAt: null });
  });

  it("wakes on a message, and is off when the setting says so", async () => {
    const { o, store, adapter, clock, projectId } = await setup((_role, _req, resumed) => (resumed ? [running, done()] : asks));
    store.db.prepare("insert into settings (key, value) values ('app.hibernation', ?)").run(JSON.stringify({ enabled: false, idleMinutes: 30 }));
    const t = await o.propose({ projectId, ...RESEARCH });
    await o.approve({ taskId: t.id });
    await waitFor(() => o.requests({ taskId: t.id })[0]);
    clock.shift = 120 * MIN;
    await o.checkHibernation();
    expect(o.get(t.id).runs[0]!.hibernatedAt).toBeNull();

    store.db.prepare("update settings set value = ? where key = 'app.hibernation'").run(JSON.stringify({ enabled: true, idleMinutes: 60 }));
    await o.checkHibernation();
    const run = o.get(t.id).runs[0]!;
    expect(run.hibernatedAt).not.toBeNull();
    await o.message(run.id, "Use memory for now.");
    const woke = await waitFor(() => adapter.started.find((s) => s.resumed));
    expect(woke.req.prompt).toContain("Use memory for now.");
    expect(o.get(t.id).runs[0]!.hibernatedAt).toBeNull();
  });

  it("stays hibernated across a daemon restart instead of reading as interrupted", async () => {
    const first = await setup((_role, _req, resumed) => (resumed ? [running, done()] : asks));
    const t = await first.o.propose({ projectId: first.projectId, ...RESEARCH });
    await first.o.approve({ taskId: t.id });
    const q = await waitFor(() => first.o.requests({ taskId: t.id })[0]);
    first.clock.shift = 31 * MIN;
    await first.o.checkHibernation();
    first.o.shutdown();
    await first.o.settle();

    const second = await setup((_role, _req, resumed) => (resumed ? [running, done()] : asks), {}, { store: first.store, root: first.root, repo: first.repo, projectId: first.projectId });
    const run = second.o.get(t.id).runs[0]!;
    expect(run.endedAt).toBeNull();
    expect(run.hibernatedAt).not.toBeNull();
    expect(second.o.requests({ taskId: t.id }).map((r) => r.id)).toEqual([q.id]);
    await second.o.answer(q.id, { kind: "question", answers: [{ selected: ["memory"] }] });
    await waitFor(() => second.o.get(t.id).status === "done");
  });

  it("allows an approved command once when the woken session asks for it again", async () => {
    const { o, clock, projectId } = await setup((_role, _req, resumed) => (resumed ? [...wantsInstall.slice(0, 2), done("installed")] : wantsInstall));
    const t = await o.propose({ projectId, ...RESEARCH });
    await o.approve({ taskId: t.id });
    const q = await waitFor(() => o.requests({ taskId: t.id })[0]);
    expect(q.risk).toBe("high");
    clock.shift = 31 * MIN;
    await o.checkHibernation();
    await o.answer(q.id, { kind: "approval", decision: "allow_once" });
    await waitFor(() => o.get(t.id).status === "done");
    const all = o.requests({ taskId: t.id, includeAnswered: true });
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ answeredBy: "policy", payload: { policy: "policy.approved_while_hibernated" }, answer: { decision: "allow_once" } });
  });
});
