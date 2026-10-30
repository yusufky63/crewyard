import type { Headroom } from "@crewyard/core";
import { describe, expect, it } from "vitest";
import { eligible, proposeCrew, rankForRole, scoreCandidate, type ScoringContext } from "./crew.ts";
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
