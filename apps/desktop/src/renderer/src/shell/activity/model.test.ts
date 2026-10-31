import { describe, expect, it } from "vitest";
import type { LogLine } from "@crewyard/core";
import {
  ALL_LOGS,
  batcher,
  concerns,
  cursorOf,
  eventParams,
  filterLogs,
  FIRST_PAGE,
  isNewest,
  kindOptions,
  liveHint,
  newer,
  NO_FILTER,
  older,
  pageNumber,
  rowText,
  runsFor,
  withRun,
  withTask,
  type Timers,
} from "./model.ts";

const runs = [
  { runId: "r3", taskId: "t2", role: "tester", runner: "codex", startedAt: "2026-10-31T09:03:00Z" },
  { runId: "r2", taskId: "t2", role: "reviewer", runner: "codex", startedAt: "2026-10-31T09:02:00Z" },
  { runId: "r1", taskId: "t1", role: "implementer", runner: "claude", startedAt: "2026-10-31T09:01:00Z" },
];

describe("task and run filters", () => {
  it("keeps the run only while it belongs to the chosen task", () => {
    const f = { ...NO_FILTER, taskId: "t2", runId: "r2" };
    expect(withTask(f, "t2", runs).runId).toBe("r2");
    expect(withTask(f, "t1", runs)).toEqual({ ...NO_FILTER, taskId: "t1", runId: null });
    expect(withTask(f, null, runs)).toEqual(NO_FILTER);
  });

  it("selects the run's task with the run, and offers only that task's runs", () => {
    expect(withRun(NO_FILTER, "r1", runs)).toEqual({ ...NO_FILTER, taskId: "t1", runId: "r1" });
    expect(withRun({ ...NO_FILTER, taskId: "t1", runId: "r1" }, null, runs)).toEqual({ ...NO_FILTER, taskId: "t1" });
    expect(withRun(NO_FILTER, "gone", runs).runId).toBeNull();
    expect(runsFor(runs, "t2").map((r) => r.runId)).toEqual(["r3", "r2"]);
    expect(runsFor(runs, null)).toHaveLength(3);
  });

  it("sends the filter to the daemon as it is", () => {
    expect(eventParams("p1", { taskId: "t1", runId: null, kind: "run.", stream: true }, 42)).toEqual({ projectId: "p1", taskId: "t1", runId: null, kind: "run.", stream: true, before: 42 });
  });
});

describe("kindOptions", () => {
  const kinds = [
    { kind: "run.tool.call", count: 30 },
    { kind: "run.message.delta", count: 900 },
    { kind: "run.run.state", count: 5 },
    { kind: "github.pull_opened", count: 1 },
    { kind: "project.added", count: 1 },
    { kind: "stall.alert", count: 2 },
  ];

  it("groups kinds under their family, busiest first, and hides streamed text unless it is on", () => {
    expect(kindOptions(kinds, false).map((o) => `${o.family ? "*" : ""}${o.value} ${o.count}`)).toEqual(["*run. 35", "run.tool.call 30", "run.run.state 5", "stall.alert 2", "github.pull_opened 1", "project.added 1"]);
    expect(kindOptions(kinds, true)[0]).toEqual({ value: "run.", count: 935, family: true });
  });
});

describe("paging", () => {
  it("walks older pages by cursor and back to the newest", () => {
    let p = FIRST_PAGE;
    expect(cursorOf(p)).toBeNull();
    expect(isNewest(p)).toBe(true);
    p = older(p, 120);
    p = older(p, 70);
    expect(cursorOf(p)).toBe(70);
    expect(pageNumber(p)).toBe(3);
    p = newer(p);
    expect(cursorOf(p)).toBe(120);
    expect(isNewest(newer(newer(p)))).toBe(true);
    // The oldest page has no cursor to go on with.
    expect(older(p, null)).toBe(p);
  });
});

describe("live updates", () => {
  const taskProject = (id: string) => ({ t1: "p1", t2: "p1", t9: "p2" })[id];
  const delta = liveHint("runs.event", { taskId: "t1", runId: "r1", event: { type: "message.delta", text: "Hel" } });
  const tool = liveHint("runs.event", { taskId: "t1", runId: "r1", event: { type: "tool.call" } });
  const change = liveHint("tasks.changed", { taskId: "t2", projectId: "p1", status: "running", cause: "run_started" });

  it("reads what a topic says about project, task, run and kind", () => {
    expect(tool).toEqual({ projectId: undefined, taskId: "t1", runId: "r1", kind: "run.tool.call" });
    expect(change).toEqual({ projectId: "p1", taskId: "t2", runId: undefined, kind: undefined });
    expect(liveHint("runs.event", null)).toEqual({});
  });

  it("only counts what can appear under the filter of the open project", () => {
    expect(concerns(tool, "p1", NO_FILTER, taskProject)).toBe(true);
    expect(concerns(tool, "p2", NO_FILTER, taskProject)).toBe(false);
    expect(concerns(liveHint("runs.event", { taskId: "unknown", runId: "x", event: { type: "tool.call" } }), "p1", NO_FILTER, taskProject)).toBe(false);
    expect(concerns(delta, "p1", NO_FILTER, taskProject)).toBe(false);
    expect(concerns(delta, "p1", { ...NO_FILTER, stream: true }, taskProject)).toBe(true);
    expect(concerns(delta, "p1", { ...NO_FILTER, kind: "run.message.delta" }, taskProject)).toBe(true);
    expect(concerns(tool, "p1", { ...NO_FILTER, taskId: "t2" }, taskProject)).toBe(false);
    expect(concerns(tool, "p1", { ...NO_FILTER, runId: "r2" }, taskProject)).toBe(false);
    expect(concerns(tool, "p1", { ...NO_FILTER, kind: "run." }, taskProject)).toBe(true);
    expect(concerns(tool, "p1", { ...NO_FILTER, kind: "github." }, taskProject)).toBe(false);
    // A task change may write any audit kind, so it counts under a kind filter too.
    expect(concerns(change, "p1", { ...NO_FILTER, kind: "github." }, taskProject)).toBe(true);
  });

  it("flushes once per window however many updates arrive", () => {
    const pending: Array<() => void> = [];
    const timers: Timers = { set: (fn) => pending.push(fn), clear: () => pending.splice(0) };
    const flushed: number[] = [];
    const b = batcher((n) => flushed.push(n), 1000, timers);
    for (let i = 0; i < 250; i++) b.push();
    expect(pending).toHaveLength(1);
    pending.shift()!();
    expect(flushed).toEqual([250]);
    b.push();
    b.cancel();
    expect(pending).toHaveLength(0);
    b.push();
    pending.shift()!();
    expect(flushed).toEqual([250, 1]);
  });
});

describe("rowText", () => {
  it("shows the first line, cut, and says when there is more to read", () => {
    expect(rowText({ preview: "pnpm test", size: 11 })).toEqual({ text: "pnpm test", more: false });
    expect(rowText({ preview: "line one\nline two", size: 20 })).toEqual({ text: "line one line two", more: true });
    const long = rowText({ preview: "x".repeat(400), size: 402 });
    expect(long.text).toHaveLength(161);
    expect(long.more).toBe(true);
    expect(rowText({ preview: "pnpm test", size: 300 }).more).toBe(true);
  });

  it("keeps untrusted markup as plain text", () => {
    expect(rowText({ preview: "<img src=x onerror=alert(1)>", size: 30 }).text).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("filterLogs", () => {
  const line = (id: string, source: LogLine["source"], level: LogLine["level"]): LogLine => ({ id, source, level, at: null, text: id });
  const lines = [line("a", "main", "info"), line("b", "daemon", "error"), line("c", "updater", "warn"), line("d", "daemon", "debug")];

  it("filters by source and by lowest level", () => {
    expect(filterLogs(lines, ALL_LOGS).map((l) => l.id)).toEqual(["a", "b", "c", "d"]);
    expect(filterLogs(lines, { source: "daemon", level: "all" }).map((l) => l.id)).toEqual(["b", "d"]);
    expect(filterLogs(lines, { source: "all", level: "warn" }).map((l) => l.id)).toEqual(["b", "c"]);
    expect(filterLogs(lines, { source: "all", level: "error" }).map((l) => l.id)).toEqual(["b"]);
  });
});
