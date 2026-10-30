import { describe, expect, it } from "vitest";
import type { TaskPullView } from "@crewyard/core";
import { fixtureTaskPulls } from "./fixture.ts";
import { gateTextKey, gateTitleKey, nextStep, pullLabel } from "./pullModel.ts";

const [open, draft, merged] = fixtureTaskPulls("p") as [TaskPullView, TaskPullView, TaskPullView];

describe("next PR step", () => {
  it("asks for a push when only the push is missing, then for opening the PR", () => {
    expect(nextStep(draft)).toBe("push");
    const pushed = { ...draft, draft: { ...draft.draft!, gate: { items: draft.draft!.gate.items.map((i) => ({ ...i, status: "pass" as const })), ready: true } } };
    expect(nextStep(pushed)).toBe("open");
  });

  it("offers nothing before the review gate passes, even when only the push is missing too", () => {
    const items = draft.draft!.gate.items.map((i) => (i.id === "review" ? { ...i, status: "wait" as const } : i));
    expect(nextStep({ ...draft, draft: { ...draft.draft!, gate: { items, ready: false } } })).toBeNull();
  });

  it("offers merge only when every gate but your approval passes, and held feedback comes first", () => {
    // The fixture's PR conflicts with main (DIRTY), so merge is not offered until that clears.
    expect(nextStep(open)).toBeNull();
    const clean = { ...open, live: { ...open.live!, mergeState: "clean" as const, gate: { ...open.live!.gate!, readyForApproval: true } } };
    expect(nextStep(clean)).toBe("merge");
    expect(nextStep({ ...clean, live: { ...clean.live, gate: { ...clean.live.gate, readyForApproval: false } } })).toBeNull();
    expect(nextStep({ ...clean, feedback: [{ ...open.feedback[0]!, state: "held" }] })).toBe("feedback");
    expect(nextStep({ ...open, pull: { ...open.pull!, state: "draft" } })).toBeNull();
  });

  it("offers cleanup only for a merged PR whose worktree is safe to remove", () => {
    expect(nextStep(merged)).toBe("cleanup");
    expect(nextStep({ ...merged, cleanup: { ...merged.cleanup!, ok: false, blocks: ["dirty"] } })).toBeNull();
    expect(nextStep({ ...merged, cleanup: null })).toBeNull();
  });

  it("labels only a merged PR as merged", () => {
    expect([open, draft, merged].map(pullLabel)).toEqual(["open", "none", "merged"]);
    expect(pullLabel({ ...open, pull: { ...open.pull!, state: "closed" } })).toBe("closed");
  });
});

describe("merge gate chips", () => {
  it("names GitHub's merge state and says why it holds the merge", () => {
    const item = { id: "merge_state" as const, status: "fail" as const };
    expect(gateTextKey(item, "dirty")).toBe("pulls.mergeState.dirty");
    expect(gateTitleKey(item, "behind", false)).toBe("pulls.mergeStateTitle.behind");
    expect(gateTextKey({ id: "merge_state", status: "unknown" }, null)).toBe("pulls.mergeState.unknown");
    expect(gateTextKey({ id: "checks", status: "pass" }, "dirty")).toBe("pulls.gate.checks.pass");
    expect(gateTitleKey({ id: "approval", status: "wait" }, "clean", true)).toBe("pulls.gateTitle.draft");
  });
});
