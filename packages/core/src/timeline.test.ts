import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "./ipc/usage.ts";
import { buildTimeline, timeIn, trackPct, visibleSegments, type TimelineRun } from "./timeline.ts";

const T = (min: number) => new Date(Date.UTC(2026, 9, 30, 10, min)).toISOString();
const ms = (min: number) => Date.parse(T(min));

const run = (id: string, start: number, end: number | null, over: Partial<TimelineRun> = {}): TimelineRun => ({
  id,
  memberId: "m1",
  role: "implementer",
  runner: "codex",
  profileId: "p1",
  startedAt: T(start),
  endedAt: end === null ? null : T(end),
  endReason: end === null ? null : "completed",
  ...over,
});

let seq = 0;
const ev = (min: number, runId: string | null, e: Record<string, unknown>): TimelineEvent => ({ seq: ++seq, at: T(min), runId, ...e }) as TimelineEvent;
const call = (min: number, runId: string, id: string, toolKind = "read") => ev(min, runId, { kind: "tool.call", toolCallId: id, title: `tool ${id}`, toolKind });
const done = (min: number, runId: string, id: string, over: Record<string, unknown> = {}) =>
  ev(min, runId, { kind: "tool.update", toolCallId: id, status: "completed", preview: null, truncatedBytes: null, keptAt: null, binary: false, ...over });

describe("buildTimeline", () => {
  it("marks where a run hibernated and where it woke, in order", () => {
    const events = [
      ev(5, "r1", { kind: "run.state", state: "waiting_input", detail: null }),
      ev(40, "r1", { kind: "hibernation", phase: "hibernated", by: null }),
      ev(90, "r1", { kind: "hibernation", phase: "woke", by: "answer" }),
    ];
    const tl = buildTimeline([run("r1", 0, null)], events, ms(100));
    expect(tl.entries.filter((e) => e.kind === "hibernation").map((e) => (e.kind === "hibernation" ? [e.phase, e.by, (e.at - ms(0)) / 60_000] : null))).toEqual([
      ["hibernated", null, 40],
      ["woke", "answer", 90],
    ]);
  });

  it("draws a lane per run with its waits, merged and clipped to the run", () => {
    const events = [
      ev(5, "r1", { kind: "run.state", state: "waiting_approval", detail: null }),
      ev(8, "r1", { kind: "run.state", state: "running", detail: null }),
      ev(9, "r1", { kind: "run.state", state: "running", detail: null }),
      ev(12, "r1", { kind: "run.state", state: "rate_limited", detail: null }),
      ev(40, "r1", { kind: "run.state", state: "running", detail: null }),
    ];
    const tl = buildTimeline([run("r1", 0, 30)], events, ms(60));
    expect(tl.lanes[0]!.segments.map((s) => [s.state, (s.end - s.start) / 60_000])).toEqual([
      ["work", 5],
      ["approval", 3],
      ["work", 4],
      ["limited", 18],
    ]);
    expect(timeIn(tl.lanes[0]!)).toEqual({ work: 9 * 60_000, approval: 3 * 60_000, limited: 18 * 60_000 });
    const wait = tl.entries.find((e) => e.kind === "wait");
    expect(wait).toMatchObject({ state: "limited", open: false });
  });

  it("matches an answer to the runner's request id per run and stops counting a wait the log never closed", () => {
    const events = [
      // The live run: the request event names the runner's id "0", the answer our own id plus that native id.
      ev(4, "r1", { kind: "request", requestId: "0", request: "approval" }),
      ev(4, "r1", { kind: "answered", requestId: "a7f3-uuid", by: "user", nativeId: "0" }),
      // A second process numbers its requests from 0 again; that answer must not close r1's.
      ev(20, "r2", { kind: "request", requestId: "0", request: "approval" }),
      ev(25, "r2", { kind: "answered", requestId: "b9c1-uuid", by: "policy", nativeId: "0" }),
      // An older log without any answer event: the run going back to work ends the wait.
      ev(30, "r2", { kind: "request", requestId: "1", request: "question" }),
      ev(31, "r2", { kind: "run.state", state: "waiting_input", detail: null }),
      ev(33, "r2", { kind: "run.state", state: "running", detail: null }),
      ev(40, "r3", { kind: "request", requestId: "9", request: "approval" }),
    ];
    const tl = buildTimeline([run("r1", 0, 10), run("r2", 15, null), run("r3", 38, 45)], events, ms(60));
    const asked = tl.entries.filter((e) => e.kind === "request").map((e) => (e.kind === "request" ? [e.runId, e.answeredAt] : null));
    expect(asked).toEqual([
      ["r1", ms(4)],
      ["r2", ms(25)],
      ["r2", ms(33)],
      // Never answered on record and the run ended: the wait stops at the run's end, not at now.
      ["r3", ms(45)],
    ]);
  });

  it("keeps an open run running until now", () => {
    const tl = buildTimeline([run("r1", 0, null)], [ev(10, "r1", { kind: "run.state", state: "paused", detail: null })], ms(20));
    expect(tl.lanes[0]!.open).toBe(true);
    expect(tl.end).toBe(ms(20));
    expect(tl.entries.find((e) => e.kind === "wait")).toMatchObject({ state: "paused", open: true });
  });

  it("folds consecutive tool calls and splits them at a request", () => {
    const events = [
      call(1, "r1", "a"),
      done(2, "r1", "a"),
      call(2, "r1", "b", "edit"),
      done(3, "r1", "b", { truncatedBytes: 900_000, keptAt: "C:\\data\\out.txt", preview: "head" }),
      call(3, "r1", "c"),
      ev(4, "r1", { kind: "request", requestId: "q1", request: "approval" }),
      ev(6, null, { kind: "answered", requestId: "q1", by: null }),
      call(7, "r1", "d", "execute"),
    ];
    const tl = buildTimeline([run("r1", 0, 10)], events, ms(30));
    const kinds = tl.entries.map((e) => e.kind);
    expect(kinds).toEqual(["started", "tools", "request", "tools", "ended"]);
    const first = tl.entries[1]!;
    if (first.kind !== "tools") throw new Error("expected tools");
    expect(first.steps.map((s) => s.toolCallId)).toEqual(["a", "b", "c"]);
    expect(first.counts).toEqual([
      ["read", 2],
      ["edit", 1],
    ]);
    expect(first.steps[1]).toMatchObject({ status: "completed", truncatedBytes: 900_000, keptAt: "C:\\data\\out.txt", preview: "head" });
    expect(first.steps[2]!.end).toBeNull();
    expect(tl.entries[2]).toMatchObject({ kind: "request", answeredAt: ms(6) });
  });

  it("orders handoffs between the two runs they join", () => {
    const events = [ev(20, "r1", { kind: "handoff", phase: "opened", handoffId: "h", trigger: "limit" }), ev(22, "r2", { kind: "handoff", phase: "completed", handoffId: "h", trigger: null })];
    const tl = buildTimeline([run("r2", 22, null, { runner: "claude-code" }), run("r1", 0, 21, { endReason: "limit" })], events, ms(25));
    expect(tl.lanes.map((l) => l.run.id)).toEqual(["r1", "r2"]);
    expect(tl.entries.map((e) => `${e.kind}:${e.runId}`)).toEqual(["started:r1", "handoff:r1", "ended:r1", "started:r2", "handoff:r2"]);
  });

  it("ends a burst at a loop decision and lists the decision after the run it judged", () => {
    const failed = { code: "loop.tests_failed", params: { command: "pnpm test", exitCode: 1 } } as const;
    const events = [
      call(2, "r1", "a"),
      ev(10, "r1", { kind: "loop", decision: "tests_failed", memberId: "m1", iteration: 1, max: 3, reason: failed }),
      call(11, "r1", "b"),
      ev(20, "r1", { kind: "loop", decision: "stop_iteration_cap", memberId: "m1", iteration: 3, max: 3, reason: { code: "loop.iteration_cap", params: { max: 3 } } }),
    ];
    const tl = buildTimeline([run("r1", 0, 20, { endReason: "failed" })], events, ms(30));
    expect(tl.entries.map((e) => e.kind)).toEqual(["started", "tools", "loop", "tools", "ended", "loop"]);
    expect(tl.entries[2]).toEqual({ kind: "loop", at: ms(10), runId: "r1", memberId: "m1", decision: "tests_failed", iteration: 1, max: 3, reason: failed });
    expect(tl.entries.at(-1)).toMatchObject({ decision: "stop_iteration_cap", iteration: 3 });
  });

  it("stays readable for thousands of tool calls", () => {
    const events: TimelineEvent[] = [];
    for (let i = 0; i < 3000; i++) events.push(call(1 + (i % 50), "r1", `t${i}`));
    const tl = buildTimeline([run("r1", 0, 60)], events, ms(60));
    expect(tl.entries.filter((e) => e.kind === "tools")).toHaveLength(1);
  });

  it("handles a task without runs", () => {
    const tl = buildTimeline([], [], ms(0));
    expect(tl.lanes).toEqual([]);
    expect(tl.end).toBeGreaterThan(tl.start);
  });
});

describe("track geometry", () => {
  it("gives a tiny segment a visible width without leaving the track", () => {
    const tl = buildTimeline([run("r1", 0, 100)], [ev(99.9, "r1", { kind: "run.state", state: "paused", detail: null })], ms(100));
    const segs = visibleSegments(tl.lanes[0]!, tl);
    const last = segs.at(-1)!;
    expect(last.width).toBeGreaterThanOrEqual(1.5);
    expect(last.left + last.width).toBeLessThanOrEqual(100);
    expect(trackPct(ms(50), tl)).toBeCloseTo(50);
    expect(trackPct(ms(500), tl)).toBe(100);
  });
});
