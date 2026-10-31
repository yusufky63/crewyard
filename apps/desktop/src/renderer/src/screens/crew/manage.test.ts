import { describe, expect, it } from "vitest";
import type { RequestView } from "@crewyard/core";
import { crewFixture, fixtureCandidates, fixtureRoles } from "./fixture.ts";
import { buildGraph } from "./model.ts";
import { bulkCounts, candidateRows, checkEnv, dependencyOptions, handoffAsks, insertInChain, moveInChain, pendingSteps, progress, rulesFromRoles, skipDependents } from "./manage.ts";

const rules = rulesFromRoles(fixtureRoles());

describe("graph of a managed crew", () => {
  it("marks a proposal editable and draws every dependency as removable", () => {
    const g = buildGraph(crewFixture("proposal"));
    expect(g.proposal).toBe(true);
    expect(g.edges.filter((e) => e.dep).map((e) => `${e.dep!.memberId}<${e.dep!.dependsOn}`)).toEqual(["m-impl<planner", "m-test<planner", "m-review<implementer", "m-review<tester"]);
    expect(g.nodes.find((n) => n.id === "m:m-review")?.status).toBe("proposed");
  });

  it("shows a skipped step and a follow-up waiting for approval", () => {
    const g = buildGraph(crewFixture("manage"));
    expect(g.proposal).toBe(false);
    const review = g.nodes.find((n) => n.id === "m:m-review")!;
    expect(review.status).toBe("skipped");
    expect(review.fact).toEqual({ code: "skipped" });
    const docs = g.nodes.find((n) => n.id === "m:m-docs")!;
    expect(docs).toMatchObject({ status: "proposed", pending: true, fact: { code: "pending_approval" } });
  });
});

describe("step editor rows", () => {
  it("lists the chosen candidate, then the chain, then the rest, and marks independence clashes", () => {
    const task = crewFixture("proposal");
    const members = task.crew!.members;
    const review = members.find((m) => m.id === "m-review")!;
    const rows = candidateRows(members, review, fixtureCandidates("reviewer"), rules);
    expect(rows[0]).toMatchObject({ chosen: true, conflict: null });
    expect(rows[1]).toMatchObject({ standby: 0 });
    // Codex runs the implementer, so the reviewer may not take it.
    expect(rows.find((r) => r.candidate.profileId === "p-codex")?.conflict).toBe("implementer");
    expect(rows.find((r) => r.candidate.profileId === "p-anthropic-2")?.conflict).toBeNull();
  });

  it("offers a dependency box per other step, off with the reason when it would loop", () => {
    const task = crewFixture("proposal");
    const members = task.crew!.members;
    const plan = members.find((m) => m.id === "m-plan")!;
    const options = dependencyOptions(members, plan, checkEnv(task, rules));
    expect(options.map((o) => [o.index, o.checked, o.refusal])).toEqual([
      ["02", false, "cycle"],
      ["03", false, "cycle"],
      ["04", false, "cycle"],
    ]);
    const test = members.find((m) => m.id === "m-test")!;
    expect(dependencyOptions(members, test, checkEnv(task, rules)).map((o) => [o.step, o.checked, o.refusal])).toEqual([
      ["planner", true, null],
      ["implementer", false, null],
      ["reviewer", false, "cycle"],
    ]);
  });

  it("locks the dependencies of a step that already ran", () => {
    const task = crewFixture();
    const impl = task.crew!.members.find((m) => m.id === "m-impl")!;
    expect(dependencyOptions(task.crew!.members, impl, checkEnv(task, rules)).every((o) => o.refusal === "started")).toBe(true);
  });

  it("moves and inserts in the standby chain within its limit", () => {
    expect(moveInChain(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveInChain(["a", "b", "c"], 0, 5)).toEqual(["b", "c", "a"]);
    expect(moveInChain(["a"], 3, 0)).toEqual(["a"]);
    expect(insertInChain(["a", "b"], "c", 1)).toEqual(["a", "c", "b"]);
    expect(insertInChain(["a", "b"], "a", 2)).toEqual(["b", "a"]);
    expect(insertInChain(["a", "b", "c", "d"], "e", 0)).toBe("standby_too_long");
  });
});

describe("running crew", () => {
  it("counts what Pause all and Resume all would act on", () => {
    // Implementer running, tester on a limit: both live; nothing paused.
    expect(bulkCounts(crewFixture())).toEqual({ live: 2, paused: 0 });
    // Implementer paused, tester failed.
    expect(bulkCounts(crewFixture("manage"))).toEqual({ live: 0, paused: 1 });
  });

  it("finds the follow-ups waiting for approval and what a skip leaves without a result", () => {
    expect(pendingSteps(crewFixture("manage")).map((m) => m.id)).toEqual(["m-docs"]);
    expect(pendingSteps(crewFixture("proposal"))).toEqual([]);
    expect(skipDependents(crewFixture(), "m-test").map((m) => m.step)).toEqual(["reviewer"]);
    expect(progress(crewFixture())).toEqual({ started: new Set(["m-plan", "m-impl", "m-test"]), finished: new Set(["planner"]) });
  });

  it("reads open limit questions for Hand off now and Wait for reset, not budget pauses", () => {
    const base = { taskId: "t", projectId: "p", sessionId: null, kind: "handoff", risk: null, createdAt: "2026-10-30T10:00:00Z", answeredAt: null, answer: null, answeredBy: null } as const;
    const payload = (trigger: "limit" | "budget") => ({ kind: "handoff" as const, trigger, window: "5h" as const, resetsAt: "2026-10-30T14:00:00Z", proposedTarget: null, candidates: [], detail: null });
    const requests: RequestView[] = [
      { ...base, id: "q1", runId: "r-test", payload: payload("limit") },
      { ...base, id: "q2", runId: "r-impl", payload: payload("budget") },
      { ...base, id: "q3", runId: "r-plan", payload: payload("limit"), answeredAt: "2026-10-30T11:00:00Z" },
    ];
    const asks = handoffAsks(requests);
    expect([...asks.keys()]).toEqual(["r-test"]);
    expect(asks.get("r-test")).toMatchObject({ requestId: "q1", resetsAt: "2026-10-30T14:00:00Z" });
  });
});
