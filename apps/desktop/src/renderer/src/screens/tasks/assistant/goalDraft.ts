import { create } from "zustand";
import type { AssistantGoalDraftView, AssistantView } from "@crewyard/core";
import { useComposerFill, type ComposerFillFrom } from "../composerPrefs.ts";

// Goal drafts from the assistant's draft_goal (docs/adr/0022). The assistant only fills the
// composer; Plan goal stays the person's click, which shows the planning estimate first.

/** What a goal draft carries into the composer next to its text. */
export function fillFrom(projectId: string, d: AssistantGoalDraftView): ComposerFillFrom {
  return { draftId: d.id, projectId, plannerProfileId: d.plannerProfileId, plannerAlias: d.plannerAlias, budgetUsd: d.budgetUsd };
}

/**
 * The goal draft the composer should pick up by itself: the newest open one it has not shown yet.
 * A draft only lands in an empty composer (the caller checks), so nothing you typed is replaced
 * without your click; the drafts card's `Open in composer` is that click.
 */
export function pendingGoalDraft(view: Pick<AssistantView, "goalDrafts"> | null | undefined, shown: ReadonlySet<string>): AssistantGoalDraftView | null {
  const open = (view?.goalDrafts ?? []).filter((d) => d.status === "open");
  const newest = open.at(-1);
  return newest && !shown.has(newest.id) ? newest : null;
}

/** Goal drafts the composer already showed in this session, so a draft you cleared stays cleared. */
export const useShownGoalDrafts = create<{ ids: ReadonlySet<string>; mark(id: string): void }>()((set) => ({
  ids: new Set<string>(),
  mark: (id) => set((s) => (s.ids.has(id) ? s : { ids: new Set([...s.ids, id]) })),
}));

/**
 * A goal budget the assistant suggested, kept per goal once you planned its draft, so the plan
 * review prefills it. You still read and approve the budget there; not persisted.
 */
export const useGoalBudgetHints = create<{ hints: Record<string, number>; set(goalId: string, usd: number): void }>()((set) => ({
  hints: {},
  set: (goalId, usd) => set((s) => ({ hints: { ...s.hints, [goalId]: usd } })),
}));

/** Hands a goal draft to the project's composer, now or when it mounts, and marks it shown. */
export function fillComposer(projectId: string, d: AssistantGoalDraftView): void {
  useShownGoalDrafts.getState().mark(d.id);
  useComposerFill.getState().fill(d.text, fillFrom(projectId, d));
}
