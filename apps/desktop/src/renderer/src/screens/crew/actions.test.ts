import { describe, expect, it } from "vitest";
import type { RunView } from "@crewyard/core";
import { actionsFor, type ActionContext } from "./actions.ts";
import { crewFixture } from "./fixture.ts";
import { buildGraph, type GraphNodeModel } from "./model.ts";

const ctx: ActionContext = { resumable: new Set(), taskCancelled: false };
const nodes = Object.fromEntries(buildGraph(crewFixture()).nodes.map((n) => [n.id, n]));
const withRun = (patch: Partial<RunView>): GraphNodeModel => ({ ...nodes["m:m-impl"]!, run: { ...nodes["m:m-impl"]!.run!, ...patch } });
const flat = (node: GraphNodeModel, c = ctx) => actionsFor(node, c).map((g) => g.map((a) => (a.disabled ? `${a.id}:${a.disabled}` : a.id)));

describe("node menu rules", () => {
  it("offers a running step every run action, Stop last and on its own", () => {
    expect(flat(withRun({ state: "running" }))).toEqual([["open"], ["message", "pause"], ["copy_run_id"], ["stop"]]);
    expect(actionsFor(withRun({ state: "running" }), ctx).at(-1)![0]!.danger).toBe(true);
  });

  it("swaps Pause for Resume on a paused run", () => {
    expect(flat(withRun({ state: "paused" }))).toEqual([["open"], ["message", "resume"], ["copy_run_id"], ["stop"]]);
  });

  it("says why actions are disabled before a step starts", () => {
    expect(flat(nodes["m:m-review"]!)).toEqual([["open"], ["message:not_started", "pause:not_started"], ["copy_run_id:no_run"], ["stop:not_started"]]);
  });

  it("disables Pause during a handoff", () => {
    expect(flat(withRun({ state: "handing_off" }))[1]).toEqual(["message", "pause:handing_off"]);
  });

  it("offers Resume on an ended run only when the daemon can resume it", () => {
    const ended = withRun({ state: "ended", endReason: "interrupted" });
    expect(flat(ended)).toEqual([["open"], ["message"], ["copy_run_id"], ["stop:ended"]]);
    expect(flat(ended, { ...ctx, resumable: new Set([ended.run!.id]) })[1]).toEqual(["message", "resume"]);
    expect(flat(withRun({ state: "ended", endReason: "completed" }))[1]).toEqual(["message:completed"]);
  });

  it("keeps the task and standby menus to what they can do", () => {
    expect(flat(nodes.task!)).toEqual([["open"]]);
    expect(flat(nodes["s:m-impl"]!)).toEqual([["open"]]);
  });

  it("disables run actions once the task is stopped", () => {
    const c = { ...ctx, taskCancelled: true };
    expect(flat(nodes["m:m-review"]!, c)[1]).toEqual(["message:task_cancelled", "pause:task_cancelled"]);
  });
});
