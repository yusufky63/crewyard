import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentCapabilities, RewindRequest, RewindResult, RunHandle, StartRequest, TranscriptRequest, TranscriptSource } from "@crewyard/core";
import { capabilities, type FakeStep } from "@crewyard/adapter-fake";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store.ts";
import { AdapterRegistry } from "./adapters.ts";
import { Orchestrator, type OrchestratorOptions } from "./orchestrator.ts";
import { failureKey } from "./stall.ts";
import { CANDIDATES, cleanTemps, ScriptedAdapter, tempDir, tempRepo, waitFor } from "./testing.ts";
import { snapshotTranscript } from "./transcripts.ts";
import { UNDO_NOTE } from "./turns.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

type Picker = (role: string, req: StartRequest, resumed: boolean) => FakeStep[];

/** A runner that claims Steer, Undo and transcripts, so the orchestrator's side can be tested without a CLI. */
class TurnAdapter extends ScriptedAdapter {
  override readonly capabilities: AgentCapabilities;
  readonly rewinds: RewindRequest[] = [];
  transcriptText = '{"line":1}\n';

  constructor(pick: Picker, extra: Partial<AgentCapabilities> = { steer: true, undo: { files: false, history: false }, transcript: true }) {
    super(pick);
    this.capabilities = { ...capabilities, ...extra };
  }

  async rewind(req: RewindRequest): Promise<RewindResult> {
    this.rewinds.push(req);
    return { files: false, history: false, detail: null };
  }

  async transcript(_req: TranscriptRequest): Promise<TranscriptSource | null> {
    return { kind: "text", text: this.transcriptText, ext: "jsonl" };
  }
}

const open: Array<{ o: Orchestrator; store: Store }> = [];
afterEach(async () => {
  const all = open.splice(0);
  all.forEach(({ o }) => o.shutdown());
  for (const { o } of all) await o.settle();
  all.forEach(({ store }) => store.close());
  cleanTemps();
});

const running: FakeStep = { emit: { type: "run.state", state: "running" } };
const say = (text: string): FakeStep => ({ emit: { type: "message.delta", text } });

async function setup(pick: Picker, options: Partial<OrchestratorOptions> = {}, adapter = new TurnAdapter(pick)) {
  const root = tempDir("crewyard turns-");
  const repo = await tempRepo(root);
  const store = new Store(join(root, "t.db"));
  const project = store.addProject(repo, "demo repo");
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const topics: Array<{ topic: string; payload: unknown }> = [];
  const cands = CANDIDATES();
  const o = new Orchestrator({
    store,
    dataDir: join(root, "data"),
    emit: (topic, payload) => topics.push({ topic, payload }),
    adapters,
    directory: { candidates: () => cands, envFor: () => ({}) },
    tickMs: 0,
    stallCheckMs: 0,
    freeMemoryMb: () => 64_000,
    stopTimeoutMs: 2_000,
    ...options,
  });
  o.start();
  open.push({ o, store });
  return { o, store, project, adapter, topics, root };
}

/** Lets a script waiting on `awaitAnswer: id` go on, as an agent finishing its work would. */
const release = (adapter: ScriptedAdapter, scriptedRunId: string, id: string) => adapter.answer({ runId: scriptedRunId } as RunHandle, id, { kind: "cancel" });

describe("follow-up queue and steer now", () => {
  it("keeps messages typed during a turn queued and editable, steers one in, and flushes the rest at the boundary as one turn", async () => {
    const pick: Picker = (role) => (role === "implementer" ? [running, { awaitAnswer: "work" }, say("done")] : [running, say("pass")]);
    const { o, project, adapter } = await setup(pick);
    const t = await o.propose({ projectId: project.id, title: "Fix typo in the login error message" });
    await o.approve({ taskId: t.id });
    const run = await waitFor(() => o.get(t.id).runs.find((r) => r.role === "implementer" && r.controls.steer.ok));
    const scripted = adapter.started.find((s) => s.role === "implementer")!.runId;

    await o.message(run.id, "Keep the old message as a fallback.");
    await o.message(run.id, "Also add a test.");
    let view = await o.message(run.id, "Never mind this one.");
    expect(view.queue.map((m) => m.text)).toEqual(["Keep the old message as a fallback.", "Also add a test.", "Never mind this one."]);
    // Queued, not sent: the runner has nothing yet.
    expect(adapter.inspect(scripted).inputs).toEqual([]);

    view = o.queueEdit(run.id, view.queue[0]!.id, "Keep the old message as a fallback, in en and tr.");
    expect(view.queue[0]!.editedAt).not.toBeNull();
    view = o.queueDelete(run.id, view.queue[2]!.id);
    view = o.queueMove(run.id, view.queue[1]!.id, 0);
    expect(view.queue.map((m) => m.text)).toEqual(["Also add a test.", "Keep the old message as a fallback, in en and tr."]);
    expect(() => o.queueEdit(run.id, view.queue[0]!.id, "  ")).toThrow("queue.empty_text");

    view = await o.queueSteer(run.id, view.queue[0]!.id, { sessionId: run.nativeSessionId });
    expect(adapter.inspect(scripted).steered.map((i) => i.text)).toEqual(["Also add a test."]);
    expect(view.queue.map((m) => m.text)).toEqual(["Keep the old message as a fallback, in en and tr."]);
    const left = view.queue[0]!.id;

    await release(adapter, scripted, "work");
    await waitFor(() => o.get(t.id).status === "review");
    expect(adapter.inspect(scripted).inputs.map((i) => i.text)).toEqual(["Keep the old message as a fallback, in en and tr."]);
    const ended = o.get(t.id).runs.find((r) => r.id === run.id)!;
    expect(ended.queue).toEqual([]);
    expect(ended.endReason).toBe("completed");
    // Delivered is history: it can no longer change.
    expect(() => o.queueEdit(run.id, left, "too late")).toThrow("queue.delivered");
  });

  it("disables steer with the reason where the runner has none, and keeps the message queued", async () => {
    const pick: Picker = () => [running, { awaitAnswer: "work" }, say("done")];
    const adapter = new TurnAdapter(pick, {});
    const { o, project } = await setup(pick, {}, adapter);
    const t = await o.propose({ projectId: project.id, title: "Research A" });
    await o.approve({ taskId: t.id });
    const run = await waitFor(() => o.get(t.id).runs[0]);
    expect(run.controls.steer).toEqual({ ok: false, reason: "steer.unsupported" });
    expect(run.controls.undo.reason).toBe("undo.unsupported");
    const view = await o.message(run.id, "hello");
    await expect(o.queueSteer(run.id, view.queue[0]!.id)).rejects.toMatchObject({ message: "run.not_steerable", params: { reason: "steer.unsupported" } });
    expect(o.get(t.id).runs[0]!.queue).toHaveLength(1);
  });
});

describe("undo last turn", () => {
  it("previews and undoes turns one at a time from git checkpoints, never while one runs, and leaves a note for the agent", async () => {
    const pick: Picker = (role) =>
      role === "implementer" ? [running, { emit: { type: "turn.started", turnRef: "msg-1" } }, { awaitAnswer: "work" }, say("done")] : [running, say("pass")];
    const { o, project, adapter } = await setup(pick);
    const t = await o.propose({ projectId: project.id, title: "Fix typo in the login error message" });
    await o.approve({ taskId: t.id });
    const run = await waitFor(() => o.get(t.id).runs.find((r) => r.role === "implementer"));
    const wt = await waitFor(() => o.get(t.id).worktree);
    await waitFor(() => adapter.started.find((s) => s.role === "implementer"));
    const scripted = adapter.started.find((s) => s.role === "implementer")!.runId;

    // The agent's first turn writes a file; a follow-up typed meanwhile becomes a second turn.
    writeFileSync(join(wt.path, "login error.ts"), "export const msg = 'Wrong password';\n");
    expect(o.get(t.id).runs.find((r) => r.id === run.id)!.controls.undo).toEqual({ ok: false, reason: "undo.turn_running", turnId: null });
    await expect(o.undoPreview(run.id)).rejects.toMatchObject({ message: "undo.unavailable", params: { reason: "undo.turn_running" } });
    await o.message(run.id, "Use the shared strings file.");
    await release(adapter, scripted, "work");
    await waitFor(() => o.get(t.id).status === "review");

    const second = await o.undoPreview(run.id);
    expect(second.files).toEqual([]);
    expect(second.noteQueued).toBe(true);
    await o.undo(run.id, second.turnId);
    expect(adapter.rewinds.at(-1)!.turnRef).toBeNull();

    const first = await o.undoPreview(run.id);
    expect(first.turnId).not.toBe(second.turnId);
    expect(first.files).toEqual([{ path: "login error.ts", change: "delete", added: 0, removed: 1 }]);
    // A preview of a turn that is no longer the last one is refused.
    await expect(o.undo(run.id, second.turnId)).rejects.toThrow("undo.changed");
    await o.undo(run.id, first.turnId);
    expect(existsSync(join(wt.path, "login error.ts"))).toBe(false);
    expect(adapter.rewinds.at(-1)).toMatchObject({ turnRef: "msg-1", session: { runner: "fake" }, cwd: wt.path });

    const after = o.get(t.id).runs.find((r) => r.id === run.id)!;
    expect(after.controls.undo).toEqual({ ok: false, reason: "undo.no_turn", turnId: null });
    // The runner kept the history, so one note waits for the agent's next message.
    expect(after.queue.map((m) => m.text)).toEqual([UNDO_NOTE]);
  });
});

describe("transcript snapshots", () => {
  it("copies the runner's transcript into the task folder when a run ends and never shrinks it", async () => {
    const { o, project, adapter, store, root } = await setup(() => [running, say("done")]);
    const t = await o.propose({ projectId: project.id, title: "Research A" });
    await o.approve({ taskId: t.id });
    await waitFor(() => o.get(t.id).status === "done");
    await o.settle();
    const run = o.get(t.id).runs[0]!;
    expect(run.transcriptPath).toBe(join(root, "data", "tasks", t.id, "transcripts", `fake-${run.nativeSessionId}.jsonl`));
    expect(readFileSync(run.transcriptPath!, "utf8")).toBe('{"line":1}\n');

    const req = { profile: CANDIDATES()[0]!.profile, cwd: root, env: {}, session: { runner: "fake" as const, sessionId: run.nativeSessionId! } };
    adapter.transcriptText = '{"line":1}\n{"line":2}\n';
    const grown = await snapshotTranscript({ store, dataDir: join(root, "data"), taskId: t.id, runId: run.id, adapter, req, now: new Date() });
    expect(grown).toMatchObject({ kept: false, truncated: false });
    adapter.transcriptText = '{"line":2}\n';
    const pruned = await snapshotTranscript({ store, dataDir: join(root, "data"), taskId: t.id, runId: run.id, adapter, req, now: new Date() });
    expect(pruned).toMatchObject({ kept: true });
    expect(readFileSync(run.transcriptPath!, "utf8")).toBe('{"line":1}\n{"line":2}\n');

    adapter.transcriptText = `${"a".repeat(30)}\n${"b".repeat(30)}\n${"c".repeat(30)}\n`;
    const capped = await snapshotTranscript({ store, dataDir: join(root, "data"), taskId: t.id, runId: run.id, adapter, req, now: new Date(), cap: 50 });
    expect(capped).toMatchObject({ truncated: true, kept: false });
    // The newest part, from a line start, so JSONL stays readable.
    expect(readFileSync(run.transcriptPath!, "utf8")).toBe(`${"c".repeat(30)}\n`);
  });
});

describe("stall alerts", () => {
  it("raises no-events and unanswered-request items once, with a cooldown, and clears them when the run moves", async () => {
    let offset = 0;
    const question: FakeStep[] = [
      { emit: { type: "request.question", requestId: "q1", questions: [{ prompt: "Which store?", options: [{ label: "redis" }], allowFreeText: false }] } },
      { awaitAnswer: "q1" },
    ];
    const pick: Picker = () => [running, { awaitAnswer: "quiet" }, ...question, say("done")];
    const { o, project, adapter, topics } = await setup(pick, { now: () => new Date(Date.now() + offset) });
    const t = await o.propose({ projectId: project.id, title: "Research A" });
    await o.approve({ taskId: t.id });
    const run = await waitFor(() => o.get(t.id).runs[0]?.state === "running" && o.get(t.id).runs[0]);
    const scripted = adapter.started[0]!.runId;

    o.checkStalls();
    expect(o.stalls.list({ taskId: t.id })).toEqual([]);
    offset = 11 * 60_000;
    o.checkStalls();
    o.checkStalls();
    const alerts = o.stalls.list({ taskId: t.id });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ rule: "no_events", runId: run.id, minutes: 11 });
    expect(topics.filter((x) => x.topic === "stall.notice")).toHaveLength(1);

    o.stalls.dismiss(alerts[0]!.alertId);
    offset = 12 * 60_000;
    o.checkStalls();
    expect(o.stalls.list({ taskId: t.id })).toEqual([]);

    // The question arrives: the run is waiting on you now, which is the request rule's business.
    await release(adapter, scripted, "quiet");
    const q = await waitFor(() => o.requests({ taskId: t.id })[0]);
    offset = 12 * 60_000 + 31 * 60_000;
    o.checkStalls();
    expect(o.stalls.list({ taskId: t.id }).map((a) => [a.rule, a.requestId])).toEqual([["request_unanswered", q.id]]);
    await o.answer(q.id, { kind: "question", answers: [{ selected: ["redis"] }] });
    o.checkStalls();
    expect(o.stalls.list({ taskId: t.id })).toEqual([]);
    expect(o.stalls.list({ taskId: t.id, includeClosed: true }).find((a) => a.rule === "request_unanswered")!.clearedAt).not.toBeNull();
  });

  it("raises one item when a step ends with the same failure several times in a row", async () => {
    const fail: FakeStep = { emit: { type: "run.ended", reason: "failed", detail: "API Error: 400 messages.0: invalid content" } };
    const { o, project } = await setup(() => [running, fail]);
    const t = await o.propose({ projectId: project.id, title: "Research A" });
    await o.approve({ taskId: t.id });
    for (let i = 1; i <= 3; i++) {
      const last = await waitFor(() => o.get(t.id).runs.length === i && o.get(t.id).runs.every((r) => r.endedAt) && o.get(t.id).runs.at(-1));
      o.checkStalls();
      if (i < 3) await o.retry(last.id);
    }
    const alerts = o.stalls.list({ taskId: t.id });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ rule: "same_failure", count: 3, detail: "request_invalid 400" });
    // A new attempt clears it; the rule watches the step again from there.
    await o.retry(o.get(t.id).runs.at(-1)!.id);
    o.checkStalls();
    expect(o.stalls.list({ taskId: t.id })).toEqual([]);
  });

  it("tells failures apart by class and status, and unreadable ones by their text without ids", () => {
    expect(failureKey("API Error: 429 Too Many Requests").key).toBe(failureKey("status: 429 retry later").key);
    expect(failureKey("boom at 12:30 id 9f8e7d6c5b4a").key).toBe(failureKey("boom at 13:45 id 0a1b2c3d4e5f").key);
    expect(failureKey("boom").key).not.toBe(failureKey("crash").key);
  });
});
