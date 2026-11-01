import { afterEach, describe, expect, it } from "vitest";
import type { AssistantGoalDraftView } from "@crewyard/core";
import { useComposerFill } from "../composerPrefs.ts";
import { fillComposer, fillFrom, pendingGoalDraft, useShownGoalDrafts } from "./goalDraft.ts";

// Goal drafts reaching the composer (docs/adr/0022): only the newest open one, once, and only into
// the project it belongs to.

const draft = (id: string, status: AssistantGoalDraftView["status"] = "open", over: Partial<AssistantGoalDraftView> = {}): AssistantGoalDraftView => ({
  id,
  conversationId: "c",
  text: `Goal ${id}`,
  plannerProfileId: null,
  plannerAlias: null,
  budgetUsd: null,
  status,
  goalId: null,
  createdAt: "2026-11-01T10:00:00Z",
  ...over,
});

afterEach(() => {
  useShownGoalDrafts.setState({ ids: new Set() });
  useComposerFill.setState({ text: "", from: null, n: 0, pending: null });
});

describe("pendingGoalDraft", () => {
  it("offers the newest open draft the composer has not shown", () => {
    const view = { goalDrafts: [draft("a", "discarded"), draft("b", "planned"), draft("c")] };
    expect(pendingGoalDraft(view, new Set())?.id).toBe("c");
    expect(pendingGoalDraft(view, new Set(["c"]))).toBeNull();
    expect(pendingGoalDraft({ goalDrafts: [draft("a", "discarded")] }, new Set())).toBeNull();
    expect(pendingGoalDraft(undefined, new Set())).toBeNull();
  });
});

describe("fillComposer", () => {
  it("carries the planner and budget, marks the draft shown, and waits for its own project's composer", () => {
    const d = draft("g1", "open", { plannerProfileId: "p-strong", plannerAlias: "strong", budgetUsd: 3 });
    expect(fillFrom("proj", d)).toEqual({ draftId: "g1", projectId: "proj", plannerProfileId: "p-strong", plannerAlias: "strong", budgetUsd: 3 });
    fillComposer("proj", d);
    expect(useShownGoalDrafts.getState().ids.has("g1")).toBe(true);
    expect(useComposerFill.getState().take("other")).toBeNull();
    expect(useComposerFill.getState().take("proj")).toEqual({ text: "Goal g1", from: fillFrom("proj", d) });
    // Taken once: a composer that mounts later does not fill it again.
    expect(useComposerFill.getState().take("proj")).toBeNull();
  });

  it("lets any composer take a plain fill, such as Edit goal's", () => {
    useComposerFill.getState().fill("The goal's own words");
    expect(useComposerFill.getState().take("any")).toEqual({ text: "The goal's own words", from: null });
  });
});
