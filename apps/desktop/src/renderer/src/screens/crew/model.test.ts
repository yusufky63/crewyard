import { describe, expect, it } from "vitest";
import type { RunView } from "@crewyard/core";
import { crewFixture } from "./fixture.ts";
import { buildGraph, defaultLayout, latestRun, memberLoop, memberStatus, mergeLayout, NODE_H, NODE_H_LOOP, nodeHeight, nudge, selectedPath, snap, SNAP, TASK_NODE } from "./model.ts";

describe("buildGraph", () => {
  const model = buildGraph(crewFixture());

  it("draws the task, every member and the first standby of each member", () => {
    expect(model.nodes.map((n) => n.id)).toEqual([TASK_NODE, "m:m-plan", "s:m-plan", "m:m-impl", "s:m-impl", "m:m-test", "m:m-review", "s:m-review"]);
    const standby = model.nodes.find((n) => n.id === "s:m-impl")!;
    expect(standby).toMatchObject({ kind: "standby", runner: "claude-code", model: "claude-sonnet-5-5", fact: { code: "standby_for", step: "02", more: 1 } });
  });

  it("connects roots to the task, the first dependency as reports-to and the rest as depends-on", () => {
    const kinds = Object.fromEntries(model.edges.map((e) => [`${e.from}>${e.to}`, e.kind]));
    expect(kinds).toEqual({
      "task>m:m-plan": "reports",
      "m:m-plan>s:m-plan": "fallback",
      "m:m-plan>m:m-impl": "reports",
      "m:m-impl>s:m-impl": "fallback",
      "m:m-plan>m:m-test": "reports",
      "m:m-impl>m:m-review": "reports",
      "m:m-test>m:m-review": "depends",
      "m:m-review>s:m-review": "fallback",
    });
  });

  it("derives each step's status, fact line and limit annotation from its newest run", () => {
    const byId = Object.fromEntries(model.nodes.map((n) => [n.id, n]));
    expect(byId["m:m-plan"]).toMatchObject({ status: "done", step: "01", fact: { code: "usage", tokens: 19_100, usd: 0.31, provenance: "estimated" } });
    expect(byId["m:m-impl"]).toMatchObject({ status: "running", account: "codex-work", limit: null });
    expect(byId["m:m-test"]).toMatchObject({ status: "limited", limit: { resumeAt: expect.any(String) } });
    expect(byId["m:m-review"]).toMatchObject({ status: "queued", run: null, fact: { code: "after", steps: "02, 03" } });
    expect(byId[TASK_NODE]).toMatchObject({ taskStatus: "limited", fact: { code: "branch", base: "main", branch: "agent/terrain-seams" } });
  });

  it("shows a proposed crew as waiting for approval and an empty crew as the task alone", () => {
    const task = crewFixture();
    task.crew!.approvedAt = null;
    task.runs = [];
    const proposed = buildGraph(task);
    expect(proposed.nodes.find((n) => n.id === "m:m-plan")).toMatchObject({ status: "proposed", fact: { code: "estimate", usd: 0.42 } });
    task.crew = null;
    expect(buildGraph(task).nodes.map((n) => n.id)).toEqual([TASK_NODE]);
  });
});

describe("crew loop on the nodes", () => {
  it("shows the implementer's fix attempt and the reviewer's verdict, stale once the code moved on", () => {
    const byId = Object.fromEntries(buildGraph(crewFixture("loop")).nodes.map((n) => [n.id, n]));
    expect(byId["m:m-impl"]!.loop).toEqual({ code: "attempts", attempt: 2, max: 3, tone: "wait", last: { code: "loop.review_changes", params: { comments: 2, sha: "9c41e7a2d0f3" } } });
    expect(byId["m:m-review"]!.loop).toEqual({ code: "verdict", verdict: "changes", sha: "9c41e7a", stale: true });
    expect(byId["m:m-plan"]!.loop).toBeNull();
    expect(byId["s:m-impl"]!.loop).toBeNull();
    // The default fixture: one failed test run sent back to the running implementer.
    expect(buildGraph(crewFixture()).nodes.find((n) => n.id === "m:m-impl")!.loop).toMatchObject({ attempt: 1, tone: "wait", last: { code: "loop.tests_failed" } });
  });

  it("colors a stop red, a pass green, and takes the newest verdict", () => {
    const loop = crewFixture("loop").loop;
    const stop = { ...loop.decisions[2]!, id: "d-stop", kind: "stop_iteration_cap" as const, iteration: 3, reason: { code: "loop.iteration_cap" as const, params: { max: 3 } }, at: "2026-10-30T10:00:00.000Z" };
    expect(memberLoop({ ...loop, decisions: [...loop.decisions, stop] }, "m-impl")).toMatchObject({ attempt: 3, tone: "bad" });
    const passed = { ...loop.decisions[0]!, id: "d-ok", kind: "review_passed" as const, at: "2026-10-30T10:00:00.000Z" };
    expect(memberLoop({ ...loop, decisions: [...loop.decisions, passed] }, "m-impl")).toMatchObject({ tone: "ok" });
    const fresh = { ...loop.verdicts[0]!, verdict: "pass" as const, headSha: null, stale: false, at: "2026-10-30T10:00:00.000Z" };
    expect(memberLoop({ ...loop, verdicts: [...loop.verdicts, fresh] }, "m-review")).toEqual({ code: "verdict", verdict: "pass", sha: null, stale: false });
    expect(memberLoop({ maxIterations: 3, decisions: [], tests: [], verdicts: [] }, "m-impl")).toBeNull();
  });

  it("grows a node by one row only when it draws a loop line", () => {
    const byId = Object.fromEntries(buildGraph(crewFixture("loop")).nodes.map((n) => [n.id, n]));
    expect(nodeHeight(byId["m:m-impl"]!)).toBe(NODE_H_LOOP);
    expect(nodeHeight(byId["m:m-review"]!)).toBe(NODE_H_LOOP);
    expect(nodeHeight(byId["m:m-plan"]!)).toBe(NODE_H);
    // Tests passed on the first try: a reason on the fact line, no fix attempt to show.
    expect(nodeHeight({ loop: { code: "attempts", attempt: 0, max: 3, tone: "ok", last: { code: "loop.tests_passed" } } })).toBe(NODE_H);
    // The standby below still clears a grown node.
    const layout = defaultLayout(buildGraph(crewFixture("loop")));
    expect(layout["s:m-impl"]!.y).toBeGreaterThan(layout["m:m-impl"]!.y + NODE_H_LOOP);
  });
});

describe("member status", () => {
  const run = (patch: Partial<RunView>) => ({ ...crewFixture().runs[1]!, ...patch });
  it("maps run facts to the labels of DESIGN.md §5", () => {
    expect(memberStatus(null, false, false)).toBe("proposed");
    expect(memberStatus(null, true, false)).toBe("queued");
    expect(memberStatus(null, true, true)).toBe("cancelled");
    expect(memberStatus(run({ state: "waiting_input" }), true, false)).toBe("needs_answer");
    expect(memberStatus(run({ state: "waiting_approval" }), true, false)).toBe("needs_approval");
    expect(memberStatus(run({ state: "handing_off" }), true, false)).toBe("handing_off");
    expect(memberStatus(run({ state: "ended", endReason: "stopped" }), true, false)).toBe("stopped");
    expect(memberStatus(run({ state: "ended", endReason: "failed" }), true, false)).toBe("failed");
    expect(memberStatus(run({ state: "ended", endReason: "interrupted" }), true, false)).toBe("interrupted");
  });

  it("picks the newest run of a step after a resume or handoff", () => {
    const a = run({ id: "a", startedAt: "2026-10-30T09:00:00.000Z" });
    const b = run({ id: "b", startedAt: "2026-10-30T09:30:00.000Z" });
    expect(latestRun([b, a], a.memberId)?.id).toBe("b");
    expect(latestRun([a], "other")).toBeNull();
  });
});

describe("layout", () => {
  const model = buildGraph(crewFixture());
  const layout = defaultLayout(model);

  it("places columns by dependency depth on the 12 px grid, standby under its member", () => {
    expect(layout[TASK_NODE]!.x).toBeLessThan(layout["m:m-plan"]!.x);
    expect(layout["m:m-impl"]!.x).toBe(layout["m:m-test"]!.x);
    expect(layout["m:m-review"]!.x).toBeGreaterThan(layout["m:m-impl"]!.x);
    expect(layout["s:m-impl"]!.x).toBe(layout["m:m-impl"]!.x);
    expect(layout["s:m-impl"]!.y).toBeGreaterThan(layout["m:m-impl"]!.y + NODE_H);
    for (const p of Object.values(layout)) {
      expect(p.x % SNAP).toBe(0);
      expect(p.y % SNAP).toBe(0);
    }
  });

  it("keeps saved positions for nodes that still exist and drops the rest", () => {
    const merged = mergeLayout(layout, { [TASK_NODE]: { x: 600, y: 12 }, gone: { x: 1, y: 1 } });
    expect(merged[TASK_NODE]).toEqual({ x: 600, y: 12 });
    expect(merged["m:m-plan"]).toEqual(layout["m:m-plan"]);
    expect(merged).not.toHaveProperty("gone");
  });

  it("snaps and moves by keyboard only with Alt", () => {
    expect(snap(17)).toBe(12);
    expect(snap(18)).toBe(24);
    expect(nudge({ x: 24, y: 24 }, "ArrowRight", true)).toEqual({ x: 36, y: 24 });
    expect(nudge({ x: 24, y: 24 }, "ArrowUp", true)).toEqual({ x: 24, y: 12 });
    expect(nudge({ x: 25, y: 24 }, "ArrowLeft", true)).toEqual({ x: 12, y: 24 });
    expect(nudge({ x: 24, y: 24 }, "ArrowRight", false)).toBeNull();
    expect(nudge({ x: 24, y: 24 }, "Enter", true)).toBeNull();
  });

  it("highlights the path from the task to the selected node", () => {
    const path = selectedPath(model, "m:m-review");
    expect([...path.nodes].sort()).toEqual(["m:m-impl", "m:m-plan", "m:m-review", "m:m-test", TASK_NODE].sort());
    expect(path.edges.has("e:m:m-impl>s:m-impl")).toBe(false);
    const standby = selectedPath(model, "s:m-impl");
    expect(standby.edges.has("e:m:m-impl>s:m-impl")).toBe(true);
    expect(selectedPath(model, null).nodes.size).toBe(0);
  });
});
