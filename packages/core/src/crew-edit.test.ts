import { describe, expect, it } from "vitest";
import {
  applyCrewEdit,
  candidateConflict,
  crewEstimate,
  crewProblems,
  CrewEditError,
  cyclePath,
  dependencyRefusal,
  dependentsOf,
  MAX_STANDBY,
  nextStepId,
  skipRefusal,
  type CrewProposalEdit,
  type EditEnv,
  type RoleRules,
} from "./crew-edit.ts";
import type { CandidateView, CrewMemberView, RoleId } from "./ipc/tasks.ts";

const cand = (profileId: string, model: string, usd: number | null = 0.1): CandidateView => ({
  profileId,
  alias: profileId,
  runner: "codex",
  providerId: profileId.split("-")[0]!,
  model,
  score: 50,
  headroom: { pct: 60, window: "5h", provenance: "estimated" },
  estimate: { usd, provenance: usd === null ? "unknown" : "estimated" },
  reasons: [],
});

const A = cand("a-1", "model-a", 0.3);
const B = cand("b-1", "model-b", 0.2);
const C = cand("c-1", "model-c", 0.05);

const member = (step: string, role: RoleId, dependsOn: string[], chosen: CandidateView | null, over: Partial<CrewMemberView> = {}): CrewMemberView => ({
  id: `m-${step}`,
  step,
  role,
  dependsOn,
  required: true,
  writesCode: role === "implementer" || role === "docs",
  chosen,
  standby: [],
  reasons: [],
  edited: false,
  blockedBy: null,
  ...over,
});

const RULES: Record<string, RoleRules> = {
  planner: { writes: "none", independentOf: [] },
  implementer: { writes: "worktree", independentOf: [] },
  reviewer: { writes: "none", independentOf: ["implementer"] },
  tester: { writes: "none", independentOf: [] },
  docs: { writes: "docs", independentOf: [] },
  "perf-check": { writes: "none", independentOf: ["implementer"] },
};

let ids = 0;
const env = (over: Partial<EditEnv> = {}): EditEnv => ({
  rules: (r) => RULES[r] ?? null,
  rank: () => [A, B, C],
  newId: () => `new-${++ids}`,
  started: new Set(),
  finished: new Set(),
  approved: false,
  ...over,
});

// Plan -> Implement -> Review, with Test after Plan.
const crew = (): CrewMemberView[] => [member("planner", "planner", [], C), member("implementer", "implementer", ["planner"], A), member("tester", "tester", ["planner"], C), member("reviewer", "reviewer", ["implementer", "tester"], B)];

const refusal = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof CrewEditError ? e.refusal : String(e);
  }
};

describe("cycle check", () => {
  it("finds the loop a new dependency would close", () => {
    // planner -> implementer -> reviewer; making planner wait for reviewer closes the loop.
    expect(cyclePath(crew(), "planner", "reviewer")).toEqual(["reviewer", "implementer", "planner"]);
    expect(cyclePath(crew(), "tester", "implementer")).toBeNull();
    expect(cyclePath(crew(), "tester", "tester")).toEqual(["tester"]);
  });

  it("refuses self, duplicate, unknown and looping dependencies with the reason", () => {
    const m = crew();
    const planner = m[0]!;
    expect(dependencyRefusal(m, planner, "planner", env())?.code).toBe("self");
    expect(dependencyRefusal(m, m[1]!, "planner", env())?.code).toBe("exists");
    expect(dependencyRefusal(m, planner, "nope", env())?.code).toBe("unknown_step");
    expect(dependencyRefusal(m, planner, "reviewer", env())).toEqual({ code: "cycle", params: { path: "planner → reviewer → implementer → planner" } });
    expect(dependencyRefusal(m, m[2]!, "implementer", env())).toBeNull();
    expect(refusal(() => applyCrewEdit(m, { kind: "add_dependency", memberId: planner.id, dependsOn: "reviewer" }, env()))).toBe("cycle");
  });

  it("adds and removes a dependency without touching other steps", () => {
    const next = applyCrewEdit(crew(), { kind: "add_dependency", memberId: "m-tester", dependsOn: "implementer" }, env());
    expect(next.find((x) => x.step === "tester")?.dependsOn).toEqual(["planner", "implementer"]);
    expect(next.find((x) => x.step === "tester")?.edited).toBe(true);
    const back = applyCrewEdit(next, { kind: "remove_dependency", memberId: "m-tester", dependsOn: "implementer" }, env());
    expect(back.find((x) => x.step === "tester")?.dependsOn).toEqual(["planner"]);
    expect(refusal(() => applyCrewEdit(back, { kind: "remove_dependency", memberId: "m-tester", dependsOn: "implementer" }, env()))).toBe("missing");
  });

  it("flags a stored loop as a crew problem", () => {
    const looped = crew().map((m) => (m.step === "planner" ? { ...m, dependsOn: ["reviewer"] } : m));
    expect(crewProblems(looped, env().rules).map((p) => p.code)).toContain("cycle");
    expect(crewProblems(crew(), env().rules)).toEqual([]);
  });
});

describe("independence", () => {
  it("keeps a reviewer off the implementer's model in both directions", () => {
    const m = crew();
    const reviewer = m[3]!;
    const implementer = m[1]!;
    expect(candidateConflict(m, reviewer, A, env().rules)).toBe("implementer");
    expect(candidateConflict(m, reviewer, C, env().rules)).toBeNull();
    // Moving the implementer onto the reviewer's model breaks the same rule from the other side.
    expect(candidateConflict(m, implementer, B, env().rules)).toBe("reviewer");
    expect(refusal(() => applyCrewEdit(m, { kind: "set_candidate", memberId: reviewer.id, profileId: "a-1" }, env()))).toBe("independence");
    expect(refusal(() => applyCrewEdit(m, { kind: "set_candidate", memberId: implementer.id, profileId: "b-1" }, env()))).toBe("independence");
  });

  it("picks an independent profile for a new or re-roled step", () => {
    const added = applyCrewEdit(crew(), { kind: "add_step", role: "perf-check", after: ["implementer"] }, env());
    const perf = added.at(-1)!;
    expect(perf.chosen?.profileId).toBe("b-1");
    expect(perf.standby.map((s) => s.profileId)).toEqual(["c-1"]);
    // Planner becomes a second reviewer: never on the implementer's model A.
    const reroled = applyCrewEdit(crew(), { kind: "set_role", memberId: "m-planner", role: "reviewer" }, env());
    expect(reroled[0]?.chosen?.profileId).toBe("b-1");
  });

  it("says why no one fits when every candidate shares the implementer's model", () => {
    const added = applyCrewEdit(crew(), { kind: "add_step", role: "reviewer", after: [] }, env({ rank: () => [A] }));
    expect(added.at(-1)?.chosen).toBeNull();
    expect(added.at(-1)?.reasons).toEqual([{ code: "no_independent_candidate" }]);
    expect(crewProblems(added, env().rules).map((p) => p.code)).toContain("no_candidate");
  });

  it("keeps the standby chain independent too", () => {
    expect(refusal(() => applyCrewEdit(crew(), { kind: "set_standby", memberId: "m-reviewer", profileIds: ["c-1", "a-1"] }, env()))).toBe("independence");
  });
});

describe("read-only lease", () => {
  it("gives the worktree lease only to roles that write", () => {
    const added = applyCrewEdit(crew(), { kind: "add_step", role: "tester", after: ["implementer"] }, env());
    expect(added.at(-1)?.writesCode).toBe(false);
    const docs = applyCrewEdit(crew(), { kind: "add_step", role: "docs", after: [] }, env());
    expect(docs.at(-1)?.writesCode).toBe(true);
  });

  it("drops the lease when a writer becomes a read-only role", () => {
    const reroled = applyCrewEdit(crew(), { kind: "set_role", memberId: "m-implementer", role: "reviewer" }, env());
    expect(reroled[1]?.writesCode).toBe(false);
    expect(reroled[1]?.role).toBe("reviewer");
  });

  it("flags a read-only step that holds the lease", () => {
    const bad = crew().map((m) => (m.step === "tester" ? { ...m, writesCode: true } : m));
    expect(crewProblems(bad, env().rules)).toContainEqual({ code: "read_only_lease", params: { step: "tester" } });
  });

  it("refuses an unknown role", () => {
    expect(refusal(() => applyCrewEdit(crew(), { kind: "add_step", role: "ghost", after: [] }, env()))).toBe("unknown_role");
  });
});

describe("steps", () => {
  it("names a second step of a role apart from the first", () => {
    expect(nextStepId(crew(), "docs")).toBe("docs");
    expect(nextStepId(crew(), "reviewer")).toBe("reviewer-2");
    expect(nextStepId([...crew(), member("reviewer-2", "reviewer", [], B)], "reviewer")).toBe("reviewer-3");
  });

  it("rewires what depended on a removed step to its own dependencies", () => {
    const next = applyCrewEdit(crew(), { kind: "remove_step", memberId: "m-implementer" }, env());
    expect(next.map((m) => m.step)).toEqual(["planner", "tester", "reviewer"]);
    expect(next.find((m) => m.step === "reviewer")?.dependsOn).toEqual(["planner", "tester"]);
    expect(refusal(() => applyCrewEdit([member("planner", "planner", [], C)], { kind: "remove_step", memberId: "m-planner" }, env()))).toBe("last_step");
  });

  it("keeps the replaced profile at the front of the standby chain", () => {
    const next = applyCrewEdit(crew(), { kind: "set_candidate", memberId: "m-implementer", profileId: "c-1" }, env());
    expect(next[1]?.chosen?.profileId).toBe("c-1");
    expect(next[1]?.standby.map((s) => s.profileId)).toEqual(["a-1"]);
  });

  it("orders the standby chain as given and checks it", () => {
    const next = applyCrewEdit(crew(), { kind: "set_standby", memberId: "m-implementer", profileIds: ["c-1", "b-1"] }, env());
    expect(next[1]?.standby.map((s) => s.profileId)).toEqual(["c-1", "b-1"]);
    const bad: Array<[CrewProposalEdit, string]> = [
      [{ kind: "set_standby", memberId: "m-implementer", profileIds: ["a-1"] }, "standby_chosen"],
      [{ kind: "set_standby", memberId: "m-implementer", profileIds: ["b-1", "b-1"] }, "standby_duplicate"],
      [{ kind: "set_standby", memberId: "m-implementer", profileIds: ["x-1"] }, "unknown_candidate"],
      [{ kind: "set_standby", memberId: "m-implementer", profileIds: Array.from({ length: MAX_STANDBY + 1 }, (_, i) => `p-${i}`) }, "standby_too_long"],
    ];
    for (const [edit, code] of bad) expect(refusal(() => applyCrewEdit(crew(), edit, env()))).toBe(code);
  });

  it("never changes its input", () => {
    const before = crew();
    const copy = JSON.stringify(before);
    applyCrewEdit(before, { kind: "remove_step", memberId: "m-implementer" }, env());
    applyCrewEdit(before, { kind: "set_role", memberId: "m-tester", role: "docs" }, env());
    expect(JSON.stringify(before)).toBe(copy);
  });
});

describe("approved crews", () => {
  const running = (over: Partial<EditEnv> = {}) => env({ approved: true, started: new Set(["m-planner", "m-implementer"]), finished: new Set(["planner"]), ...over });

  it("adds a follow-up after a finished step as a step waiting for approval", () => {
    const next = applyCrewEdit(crew(), { kind: "add_step", role: "docs", after: ["planner"] }, running());
    expect(next.at(-1)).toMatchObject({ step: "docs", dependsOn: ["planner"], pendingApproval: true });
    expect(refusal(() => applyCrewEdit(crew(), { kind: "add_step", role: "docs", after: ["reviewer"] }, running()))).toBe("not_finished");
    expect(refusal(() => applyCrewEdit(crew(), { kind: "add_step", role: "docs", after: [] }, running()))).toBe("not_finished");
  });

  it("leaves approved steps alone and lets the follow-up change", () => {
    expect(refusal(() => applyCrewEdit(crew(), { kind: "set_candidate", memberId: "m-tester", profileId: "b-1" }, running()))).toBe("approved");
    expect(refusal(() => applyCrewEdit(crew(), { kind: "remove_step", memberId: "m-implementer" }, running()))).toBe("started");
    const added = applyCrewEdit(crew(), { kind: "add_step", role: "docs", after: ["planner"] }, running());
    const docs = added.at(-1)!;
    const changed = applyCrewEdit(added, { kind: "set_candidate", memberId: docs.id, profileId: "b-1" }, running());
    expect(changed.at(-1)?.chosen?.profileId).toBe("b-1");
    expect(applyCrewEdit(added, { kind: "remove_step", memberId: docs.id }, running())).toHaveLength(4);
  });

  it("lets the standby chain of a step that has not started change", () => {
    expect(applyCrewEdit(crew(), { kind: "set_standby", memberId: "m-tester", profileIds: ["a-1"] }, running())[2]?.standby).toEqual([A]);
    expect(refusal(() => applyCrewEdit(crew(), { kind: "set_standby", memberId: "m-implementer", profileIds: ["c-1"] }, running()))).toBe("started");
  });
});

describe("skip", () => {
  it("names every step that waits for the skipped one", () => {
    expect(dependentsOf(crew(), "planner").map((m) => m.step)).toEqual(["implementer", "tester", "reviewer"]);
    expect(dependentsOf(crew(), "tester").map((m) => m.step)).toEqual(["reviewer"]);
    expect(dependentsOf(crew(), "reviewer")).toEqual([]);
  });

  it("only skips a step that has not started and is not skipped yet", () => {
    const [planner, , tester] = crew();
    expect(skipRefusal(planner!, new Set(["m-planner"]))).toBe("started");
    expect(skipRefusal(tester!, new Set(["m-planner"]))).toBeNull();
    expect(skipRefusal({ ...tester!, skippedAt: "2026-10-31T10:00:00Z" }, new Set())).toBe("skipped");
  });
});

describe("proposal-edit estimate", () => {
  it("follows the chosen candidates through edits", () => {
    // C 0.05 + A 0.3 + C 0.05 + B 0.2
    expect(crewEstimate(crew())).toEqual({ usd: 0.6, provenance: "estimated" });
    const cheaper = applyCrewEdit(crew(), { kind: "set_candidate", memberId: "m-implementer", profileId: "c-1" }, env());
    expect(crewEstimate(cheaper)).toEqual({ usd: 0.35, provenance: "estimated" });
    const fewer = applyCrewEdit(crew(), { kind: "remove_step", memberId: "m-tester" }, env());
    expect(crewEstimate(fewer)).toEqual({ usd: 0.55, provenance: "estimated" });
  });

  it("is Unknown when a step has no price or no profile, and leaves skipped steps out", () => {
    expect(crewEstimate([...crew(), member("docs", "docs", [], cand("d-1", "model-d", null))]).provenance).toBe("unknown");
    expect(crewEstimate([...crew(), member("docs", "docs", [], null)])).toEqual({ usd: null, provenance: "unknown" });
    expect(crewEstimate([...crew(), member("docs", "docs", [], null, { skippedAt: "2026-10-31T10:00:00Z" })])).toEqual({ usd: 0.6, provenance: "estimated" });
  });
});
