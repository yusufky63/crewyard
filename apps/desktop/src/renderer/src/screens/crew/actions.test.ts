import { describe, expect, it } from "vitest";
import type { RunView } from "@crewyard/core";
import { actionsFor, failedRuns, handoffCandidates, supersededRuns, type ActionContext } from "./actions.ts";
import { crewFixture } from "./fixture.ts";
import { buildGraph, type GraphNodeModel } from "./model.ts";

const ctx: ActionContext = { resumable: new Set(), taskCancelled: false };
const withTargets: ActionContext = { ...ctx, handoffTargets: () => 2 };
const nodes = Object.fromEntries(buildGraph(crewFixture()).nodes.map((n) => [n.id, n]));
const withRun = (patch: Partial<RunView>): GraphNodeModel => ({ ...nodes["m:m-impl"]!, run: { ...nodes["m:m-impl"]!.run!, ...patch } });
// Steps of an approved crew open straight to the inspector's tabs.
const OPEN = ["open", "open_changes", "open_files"];
const flat = (node: GraphNodeModel, c = ctx) => actionsFor(node, c).map((g) => g.map((a) => (a.disabled ? `${a.id}:${a.disabled}` : a.id)));

describe("node menu rules", () => {
  it("offers a running step every run action, Stop last and on its own", () => {
    expect(flat(withRun({ state: "running" }), withTargets)).toEqual([OPEN, ["message", "pause", "retry:working", "change_ai"], ["copy_run_id"], ["stop"]]);
    expect(actionsFor(withRun({ state: "running" }), ctx).at(-1)![0]!.danger).toBe(true);
  });

  it("swaps Pause for Resume on a paused run", () => {
    expect(flat(withRun({ state: "paused" }), withTargets)).toEqual([OPEN, ["message", "resume", "retry:working", "change_ai"], ["copy_run_id"], ["stop"]]);
  });

  it("says why actions are disabled before a step starts, and lets its AI change", () => {
    expect(flat(nodes["m:m-review"]!)).toEqual([
      OPEN,
      // Change AI before the run picks another profile (crew.changeProfile); nothing is handed off.
      ["message:not_started", "pause:not_started", "retry:not_started", "change_ai"],
      ["skip"],
      ["copy_run_id:no_run"],
      ["stop:not_started"],
    ]);
  });

  it("disables Pause and Change AI during a handoff", () => {
    expect(flat(withRun({ state: "handing_off" }), withTargets)[1]).toEqual(["message", "pause:handing_off", "retry:working", "change_ai:handing_off"]);
  });

  it("offers Resume on an ended run only when the daemon can resume it", () => {
    const ended = withRun({ state: "ended", endReason: "interrupted", endedAt: "2026-10-30T10:00:00Z" });
    expect(flat(ended)).toEqual([OPEN, ["message", "retry", "change_ai:no_target"], ["copy_run_id"], ["stop:ended"]]);
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

  it("gives the task node the task's own actions, each with why it is off", () => {
    expect(flat(nodes.task!)).toEqual([
      ["open_details", "open_changes"],
      ["retry_failed_steps:none_failed"],
      ["follow_up_task:nothing_finished", "pause_all:nothing_live", "resume_all:nothing_paused"],
      ["cancel_task"],
    ]);
    const running = { ...ctx, bulk: { live: 2, paused: 0 }, failedSteps: 1, finishedSteps: 1, hasChanges: true };
    expect(flat(nodes.task!, running)).toEqual([["open_details", "open_changes"], ["retry_failed_steps"], ["follow_up_task", "pause_all", "resume_all:nothing_paused"], ["cancel_task"]]);
    expect(flat(nodes.task!, { ...ctx, hasChanges: false })[0]).toEqual(["open_details", "open_changes:no_worktree"]);
    expect(actionsFor(nodes.task!, ctx).at(-1)![0]).toMatchObject({ id: "cancel_task", danger: true });
  });

  it("keeps a finished or stopped task from being cancelled again, and says why", () => {
    expect(flat(nodes.task!, { ...ctx, taskFinished: true }).at(-1)).toEqual(["cancel_task:task_finished"]);
    const stopped = flat(nodes.task!, { ...ctx, taskCancelled: true, failedSteps: 1, finishedSteps: 1 });
    expect(stopped.slice(1)).toEqual([["retry_failed_steps:task_cancelled"], ["follow_up_task:task_cancelled", "pause_all:task_cancelled", "resume_all:task_cancelled"], ["cancel_task:task_cancelled"]]);
  });

  it("disables run actions once the task is stopped", () => {
    const c = { ...ctx, taskCancelled: true };
    expect(flat(nodes["m:m-review"]!, c)[1]).toEqual(["message:task_cancelled", "pause:task_cancelled", "retry:task_cancelled", "change_ai:task_cancelled"]);
  });
});

describe("managing the crew from the menu", () => {
  const proposal = Object.fromEntries(buildGraph(crewFixture("proposal")).nodes.map((n) => [n.id, n]));
  const manage = Object.fromEntries(buildGraph(crewFixture("manage")).nodes.map((n) => [n.id, n]));
  const p = { ...ctx, proposal: true, crewSize: 4 };

  it("offers editing, not run actions, while the crew is a proposal", () => {
    expect(flat(proposal["m:m-impl"]!, p)).toEqual([["open"], ["edit", "add_after", "remove_step"]]);
    expect(flat(proposal.task!, p)).toEqual([["open_details"], ["approve_crew", "change_ai_all", "add_step"], ["cancel_task"]]);
    // Approve is off for the same problem the crew bar names.
    expect(flat(proposal.task!, { ...p, crewProblem: true })[1]).toEqual(["approve_crew:crew_problem", "change_ai_all", "add_step"]);
    expect(flat(proposal["m:m-impl"]!, { ...p, crewSize: 1 })[1]).toContain("remove_step:last_step");
    expect(actionsFor(proposal["m:m-impl"]!, p)[1]!.find((a) => a.id === "remove_step")!.danger).toBe(true);
  });

  it("edits a follow-up that waits for approval instead of running it", () => {
    expect(flat(manage["m:m-docs"]!, ctx)).toEqual([OPEN, ["edit", "remove_step"]]);
  });

  it("offers Skip only before a step starts, and says when it already is", () => {
    expect(flat(nodes["m:m-review"]!)[2]).toEqual(["skip"]);
    expect(flat(manage["m:m-review"]!)[2]).toEqual(["skip:skipped"]);
    expect(flat(withRun({ state: "running" })).flat()).not.toContain("skip");
    expect(flat(nodes["m:m-review"]!, { ...ctx, taskCancelled: true })[2]).toEqual(["skip:task_cancelled"]);
  });

  it("offers a follow-up, and a run again on another AI, after a finished step only", () => {
    expect(flat(nodes["m:m-plan"]!)[2]).toEqual(["follow_up", "rerun_other"]);
    expect(flat(withRun({ state: "running" })).flat()).not.toContain("follow_up");
    expect(flat(withRun({ state: "running" })).flat()).not.toContain("rerun_other");
    expect(flat(nodes["m:m-review"]!).flat()).not.toContain("rerun_other");
    expect(flat(nodes["m:m-plan"]!, { ...ctx, taskCancelled: true })[2]).toEqual(["follow_up:task_cancelled", "rerun_other:task_cancelled"]);
    expect(flat(nodes["m:m-plan"]!, { ...ctx, superseded: new Set(["r-plan"]) })[2]).toEqual(["follow_up:superseded", "rerun_other:superseded"]);
  });

  it("changes the AI of a step before its run, but not of a skipped one", () => {
    expect(flat(manage["m:m-review"]!)[1]).toContain("change_ai:skipped");
    expect(flat(nodes["m:m-review"]!, { ...ctx, taskCancelled: true })[1]).toContain("change_ai:task_cancelled");
  });

  it("acts on the run that took over, and treats the run it replaced as continued", () => {
    const handoff = Object.fromEntries(buildGraph(crewFixture("handoff")).nodes.map((n) => [n.id, n]));
    const c = { ...withTargets, superseded: supersededRuns(crewFixture("handoff")) };
    expect(flat(handoff["h:m-impl"]!, c)[1]).toEqual(["message", "pause", "retry:working", "change_ai"]);
    expect(flat(handoff["m:m-impl"]!, c)[1]).toEqual(expect.arrayContaining(["retry:superseded", "change_ai:superseded"]));
  });

  it("counts each step's failed newest run for Retry failed steps", () => {
    expect(failedRuns(crewFixture("manage")).map((r) => r.id)).toEqual(["r-test"]);
    expect(failedRuns(crewFixture())).toEqual([]);
  });

  it("offers Hand off now and Wait for reset on a limit, with why they are off", () => {
    const limited = nodes["m:m-test"]!;
    expect(flat(limited)[1]).toEqual(expect.arrayContaining(["handoff_now:no_request", "wait_reset:no_request"]));
    const ask = { requestId: "q1", resetsAt: null, candidates: [], proposed: null };
    expect(flat(limited, { ...ctx, handoffAsk: () => ask })[1]).toEqual(expect.arrayContaining(["handoff_now:no_target", "wait_reset:no_reset"]));
    const ready = { ...ask, resetsAt: "2026-10-30T14:00:00Z", candidates: [crewFixture().crew!.members[0]!.chosen!] };
    expect(flat(limited, { ...ctx, handoffAsk: () => ready })[1]).toEqual(expect.arrayContaining(["handoff_now", "wait_reset"]));
    expect(flat(withRun({ state: "running" })).flat()).not.toContain("handoff_now");
  });

  it("names a failed step's Check again as Retry in the same slot", () => {
    const failed = manage["m:m-test"]!;
    expect(failed.status).toBe("failed");
    expect(flat(failed)[1]).toContain("retry");
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
