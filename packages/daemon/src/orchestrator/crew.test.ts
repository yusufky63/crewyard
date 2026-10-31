import type { Headroom } from "@crewyard/core";
import { describe, expect, it } from "vitest";
import { applyCrewEdits, eligible, proposeCrew, rankForRole, scoreCandidate, validateCrew, type CrewCheckMember, type ScoringContext } from "./crew.ts";
import { planFor, ROLES, SOLO_ROLE } from "./roles.ts";
import { CANDIDATES } from "./testing.ts";

// Profile presets in the crew proposal (feature scan A16): the note and the read-only preset.

const ctx = (over: Partial<ScoringContext> = {}): ScoringContext => ({
  size: "M",
  budgetUsd: null,
  hasAdapter: () => true,
  headroom: (): Headroom => ({ pct: null, window: null, provenance: "unknown" }),
  history: () => ({ accepted: 0, total: 0 }),
  preference: () => 0,
  ...over,
});

describe("profile presets in the crew proposal", () => {
  it("leads the one-line reason with the profile's note and leaves the score alone", () => {
    const c = CANDIDATES()[0]!;
    const plain = scoreCandidate(c, "docs", ctx());
    const noted = scoreCandidate({ ...c, note: "fast and cheap, good for docs" }, "docs", ctx());
    expect(noted.reasons[0]).toEqual({ code: "profile.note", params: { note: "fast and cheap, good for docs" } });
    expect(noted.score).toBe(plain.score);
  });

  it("keeps pinning and the independence reasons ahead of the note", () => {
    const noted = CANDIDATES().map((c) => ({ ...c, note: "second opinion" }));
    const rev = proposeCrew("code", false, noted, ctx()).members.find((m) => m.role === "reviewer")!.chosen!;
    const codes = rev.reasons.map((r) => r.code);
    expect(codes[0]).toBe("independence.model");
    expect(codes).toContain("profile.note");
    const pin = noted[2]!.profile.id;
    const pinned = rankForRole(noted, "tester", ctx({ pins: { tester: pin } }), { models: new Set(), providers: new Set() })[0]!;
    expect(pinned.reasons.map((r) => r.code).slice(0, 2)).toEqual(["pinned", "profile.note"]);
  });

  it("offers a read-only profile only for roles that never write", () => {
    const c = { ...CANDIDATES()[0]!, readOnly: true };
    expect(eligible(c, "implementer", ctx())).toBe(false);
    expect(eligible(c, "docs", ctx())).toBe(false);
    expect(eligible(c, "reviewer", ctx())).toBe(true);
    expect(eligible({ ...c, readOnly: false }, "implementer", ctx())).toBe(true);
  });
});

describe("pins the proposal could not keep", () => {
  const roleOf = (members: ReturnType<typeof proposeCrew>["members"], role: string) => members.find((m) => m.role === role)!;

  it("says why a reviewer pin on the implementer's model was replaced", () => {
    const cands = CANDIDATES();
    const { members } = proposeCrew("code", false, cands, ctx({ size: "S", pins: { implementer: "anthropic-key", reviewer: "anthropic-key" } }));
    const rev = roleOf(members, "reviewer");
    expect(rev.chosen!.profileId).not.toBe("anthropic-key");
    expect(rev.reasons).toEqual([{ code: "pin.dropped", params: { alias: "anthropic-key", cause: "independence" } }]);
    // A pin that was kept says nothing extra.
    expect(roleOf(members, "implementer").reasons.map((r) => r.code)).not.toContain("pin.dropped");
  });

  it("names a read-only or missing pinned profile", () => {
    const cands = CANDIDATES().map((c) => (c.profile.id === "openai-key" ? { ...c, readOnly: true } : c));
    const ro = proposeCrew("code", false, cands, ctx({ size: "S", pins: { implementer: "openai-key" } }));
    expect(roleOf(ro.members, "implementer").reasons[0]).toEqual({ code: "pin.dropped", params: { alias: "openai-key", cause: "read_only" } });
    const gone = proposeCrew("research", false, CANDIDATES(), ctx({ pins: { researcher: "deleted-profile" } }));
    expect(roleOf(gone.members, "researcher").reasons[0]).toEqual({ code: "pin.dropped", params: { alias: "deleted-profile", cause: "unavailable" } });
  });
});

describe("Solo mode (docs/adr/0019)", () => {
  it("drafts one step of the kind's main role, whatever the size or the security flag", () => {
    for (const kind of ["code", "research", "review", "docs"] as const) {
      for (const size of ["S", "M", "L"] as const) {
        for (const security of [false, true]) {
          expect(planFor(kind, size, security, "solo")).toEqual([{ step: SOLO_ROLE[kind], role: SOLO_ROLE[kind], dependsOn: [], required: true }]);
        }
      }
    }
    expect(SOLO_ROLE).toEqual({ code: "implementer", research: "researcher", review: "reviewer", docs: "docs" });
  });

  it("leaves Crew exactly as it was, with or without the mode argument", () => {
    for (const kind of ["code", "research", "review", "docs"] as const) {
      for (const size of ["S", "M", "L"] as const) {
        expect(planFor(kind, size, true, "crew")).toEqual(planFor(kind, size, true));
      }
    }
    expect(planFor("code", "M", false).map((s) => s.role)).toEqual(["planner", "implementer", "tester", "reviewer"]);
  });

  it("adds no custom steps from project.json to a Solo crew", () => {
    const linter = { ...ROLES.tester, id: "linter", title: "Linter" };
    const roles = { templates: new Map([["linter", linter]]), steps: [{ role: "linter", kinds: ["code" as const], after: ["implementer"] }] };
    const crew = proposeCrew("code", false, CANDIDATES(), ctx({ size: "S" }), roles, "crew");
    expect(crew.members.map((m) => m.role)).toEqual(["implementer", "reviewer", "linter"]);
    const solo = proposeCrew("code", false, CANDIDATES(), ctx({ size: "S" }), roles, "solo");
    expect(solo.members.map((m) => [m.role, m.writesCode])).toEqual([["implementer", true]]);
    expect(solo.estimate).toEqual(solo.members[0]!.chosen!.estimate);
  });
});

describe("validateCrew and applyCrewEdits", () => {
  const cands = CANDIDATES();
  const view = (i: number, role: "implementer" | "reviewer" = "implementer") => scoreCandidate(cands[i]!, role, ctx());
  const members: CrewCheckMember[] = [
    { id: "m-impl", role: "implementer", template: ROLES.implementer },
    { id: "m-rev", role: "reviewer", template: ROLES.reviewer },
  ];
  const views = () => new Map([["m-impl", view(0)], ["m-rev", view(1, "reviewer")]]);

  it("passes a crew with a profile per member, no read-only writer and independent models", () => {
    expect(validateCrew({ members, views: views(), candidates: cands })).toBeNull();
  });

  it("names the first member without a profile", () => {
    const v = views();
    v.set("m-rev", null as never);
    expect(validateCrew({ members, views: v, candidates: cands })).toEqual({ code: "crew.missing_profile", params: { role: "reviewer" } });
  });

  it("refuses a profile marked read-only after the proposal, in a writing role only", () => {
    const ro = cands.map((c, i) => (i === 0 || i === 1 ? { ...c, readOnly: true } : c));
    expect(validateCrew({ members, views: views(), candidates: ro })).toEqual({ code: "crew.read_only_profile", params: { profileId: "anthropic-key", role: "implementer" } });
    // The reviewer never writes, so its read-only profile is fine.
    expect(validateCrew({ members, views: views(), candidates: cands.map((c, i) => (i === 1 ? { ...c, readOnly: true } : c)) })).toBeNull();
  });

  it("refuses a reviewer on the implementer's model, and on any Best of N variant's model", () => {
    const same = views();
    same.set("m-rev", view(0, "reviewer"));
    expect(validateCrew({ members, views: same, candidates: cands })).toEqual({ code: "crew.independence", params: { role: "reviewer" } });
    expect(validateCrew({ members, views: views(), candidates: cands, group: { memberId: "m-impl", candidates: [view(0), view(1)] } })).toEqual({ code: "crew.independence", params: { role: "reviewer" } });
    expect(validateCrew({ members, views: views(), candidates: cands, group: { memberId: "m-impl", candidates: [view(0), view(2)] } })).toBeNull();
  });

  it("keeps approve's old leniency for a vanished profile unless `available` is given", () => {
    const left = cands.slice(1);
    expect(validateCrew({ members, views: views(), candidates: left })).toBeNull();
    expect(validateCrew({ members, views: views(), candidates: left, available: (c, tpl) => eligible(c, tpl, ctx()) })).toEqual({ code: "crew.unknown_profile", params: { profileId: "anthropic-key" } });
    // A profile that is still there but can no longer take its role counts as gone too.
    const notReady = cands.map((c, i) => (i === 1 ? { ...c, ready: false } : c));
    expect(validateCrew({ members, views: views(), candidates: notReady, available: (c, tpl) => eligible(c, tpl, ctx()) })).toEqual({ code: "crew.unknown_profile", params: { profileId: "openai-key" } });
  });

  it("applies edits, or names the member, the read-only profile or the unknown profile", () => {
    const scoring = ctx();
    const ok = applyCrewEdits({ members, views: views(), candidates: cands, edits: [{ memberId: "m-rev", profileId: "deepseek-key", model: "deepseek-reasoner" }], scoring });
    expect(ok.ok && ok.views.get("m-rev")).toMatchObject({ profileId: "deepseek-key", model: "deepseek-reasoner" });
    // The input map is never changed: the function writes nothing.
    expect(views().get("m-rev")!.profileId).toBe("openai-key");
    expect(applyCrewEdits({ members, views: views(), candidates: cands, edits: [{ memberId: "nope", profileId: "deepseek-key" }], scoring })).toEqual({ ok: false, problem: { code: "crew.member_not_found", params: { memberId: "nope" } } });
    const ro = cands.map((c, i) => (i === 2 ? { ...c, readOnly: true } : c));
    expect(applyCrewEdits({ members, views: views(), candidates: ro, edits: [{ memberId: "m-impl", profileId: "deepseek-key" }], scoring })).toEqual({ ok: false, problem: { code: "crew.read_only_profile", params: { profileId: "deepseek-key", role: "implementer" } } });
    expect(applyCrewEdits({ members, views: views(), candidates: cands, edits: [{ memberId: "m-impl", profileId: "gone" }], scoring })).toEqual({ ok: false, problem: { code: "crew.unknown_profile", params: { profileId: "gone" } } });
    expect(applyCrewEdits({ members, views: views(), candidates: cands, edits: [{ memberId: "m-impl", profileId: "deepseek-key" }], scoring: ctx({ exclude: ["deepseek-key"] }) })).toEqual({ ok: false, problem: { code: "crew.unknown_profile", params: { profileId: "deepseek-key" } } });
  });
});
