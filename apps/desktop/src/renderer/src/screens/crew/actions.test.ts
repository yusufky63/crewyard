import { describe, expect, it } from "vitest";
import type { RunView } from "@crewyard/core";
import { actionsFor, handoffCandidates, supersededRuns, type ActionContext } from "./actions.ts";
import { crewFixture } from "./fixture.ts";
import { buildGraph, type GraphNodeModel } from "./model.ts";

const ctx: ActionContext = { resumable: new Set(), taskCancelled: false };
const withTargets: ActionContext = { ...ctx, handoffTargets: () => 2 };
const nodes = Object.fromEntries(buildGraph(crewFixture()).nodes.map((n) => [n.id, n]));
const withRun = (patch: Partial<RunView>): GraphNodeModel => ({ ...nodes["m:m-impl"]!, run: { ...nodes["m:m-impl"]!.run!, ...patch } });
const flat = (node: GraphNodeModel, c = ctx) => actionsFor(node, c).map((g) => g.map((a) => (a.disabled ? `${a.id}:${a.disabled}` : a.id)));

describe("node menu rules", () => {
  it("offers a running step every run action, Stop last and on its own", () => {
    expect(flat(withRun({ state: "running" }), withTargets)).toEqual([["open"], ["message", "pause", "retry:working", "change_ai"], ["copy_run_id"], ["stop"]]);
    expect(actionsFor(withRun({ state: "running" }), ctx).at(-1)![0]!.danger).toBe(true);
  });

  it("swaps Pause for Resume on a paused run", () => {
    expect(flat(withRun({ state: "paused" }), withTargets)).toEqual([["open"], ["message", "resume", "retry:working", "change_ai"], ["copy_run_id"], ["stop"]]);
  });

  it("says why actions are disabled before a step starts", () => {
    expect(flat(nodes["m:m-review"]!)).toEqual([
      ["open"],
      ["message:not_started", "pause:not_started", "retry:not_started", "change_ai:not_started"],
      ["copy_run_id:no_run"],
      ["stop:not_started"],
    ]);
  });

  it("disables Pause and Change AI during a handoff", () => {
    expect(flat(withRun({ state: "handing_off" }), withTargets)[1]).toEqual(["message", "pause:handing_off", "retry:working", "change_ai:handing_off"]);
  });

  it("offers Resume on an ended run only when the daemon can resume it", () => {
    const ended = withRun({ state: "ended", endReason: "interrupted", endedAt: "2026-10-30T10:00:00Z" });
    expect(flat(ended)).toEqual([["open"], ["message", "retry", "change_ai:no_target"], ["copy_run_id"], ["stop:ended"]]);
    expect(flat(ended, { ...ctx, resumable: new Set([ended.run!.id]) })[1]).toEqual(["message", "resume", "retry", "change_ai:no_target"]);
    expect(flat(withRun({ state: "ended", endReason: "completed", endedAt: "2026-10-30T10:00:00Z" }))[1]).toEqual(["message:completed", "retry:completed", "change_ai:completed"]);
  });

  it("checks a limit pause again but not a run that is still working", () => {
    expect(flat(withRun({ state: "paused", limitReached: true }))[1]).toContain("retry");
    expect(flat(withRun({ state: "paused", resumeAt: "2026-10-30T14:00:00Z" }))[1]).toContain("retry");
    expect(flat(withRun({ state: "running" }))[1]).toContain("retry:working");
  });

  it("never acts on a run a later run already continues", () => {
    const ended = withRun({ state: "ended", endReason: "interrupted", endedAt: "2026-10-30T10:00:00Z" });
    const c = { ...withTargets, superseded: new Set([ended.run!.id]) };
    expect(flat(ended, c)[1]).toEqual(["message", "retry:superseded", "change_ai:superseded"]);
  });

  it("offers Change AI only when the step has another candidate", () => {
    const running = withRun({ state: "running" });
    expect(flat(running)[1]).toContain("change_ai:no_target");
    expect(flat(running, { ...ctx, handoffTargets: (memberId, profileId) => (memberId === "m-impl" && profileId === running.run!.profileId ? 1 : 0) })[1]).toContain("change_ai");
  });

  it("keeps the task and standby menus to what they can do", () => {
    expect(flat(nodes.task!)).toEqual([["open"]]);
    expect(flat(nodes["s:m-impl"]!)).toEqual([["open"]]);
  });

  it("disables run actions once the task is stopped", () => {
    const c = { ...ctx, taskCancelled: true };
    expect(flat(nodes["m:m-review"]!, c)[1]).toEqual(["message:task_cancelled", "pause:task_cancelled", "retry:task_cancelled", "change_ai:task_cancelled"]);
  });
});

describe("handoff candidates", () => {
  const task = crewFixture();
  const impl = task.crew!.members.find((m) => m.id === "m-impl")!;

  it("lists the chosen and standby profiles except the one the run is on", () => {
    const list = handoffCandidates(task, "m-impl", impl.chosen!.profileId);
    expect(list.map((c) => c.profileId)).toEqual(impl.standby.map((c) => c.profileId).filter((id) => id !== impl.chosen!.profileId));
    expect(handoffCandidates(task, "m-impl", "some-other-profile")[0]?.profileId).toBe(impl.chosen!.profileId);
    expect(handoffCandidates(task, "missing", "x")).toEqual([]);
  });

  it("marks runs that a later run continues", () => {
    const later = { ...task.runs[0]!, id: "r-next", resumedFrom: task.runs[0]!.id };
    expect(supersededRuns({ ...task, runs: [...task.runs, later] }).has(task.runs[0]!.id)).toBe(true);
    expect(supersededRuns(task).size).toBe(0);
  });
});
