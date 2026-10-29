import { describe, expect, it } from "vitest";
import type { RunView } from "@crewyard/core";
import { crewFixture } from "./fixture.ts";
import { buildGraph, defaultLayout, latestRun, memberStatus, mergeLayout, NODE_H, nudge, selectedPath, snap, SNAP, TASK_NODE } from "./model.ts";

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
