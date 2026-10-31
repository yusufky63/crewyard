import { create } from "zustand";
import type { AssistantDraftEdit, AssistantDraftView, TaskKind, TaskSize } from "@crewyard/core";

// What you typed into a report's draft card, kept outside the card. A report's suggested drafts
// show in two places (the bottom of Details and the Suggested tab) and only one is mounted at a
// time, so edits held in the card were lost on every tab switch; and `Add all as drafts` must add
// each card as it reads now, not as the agent wrote it.

/** A card's fields as typed: criteria are one per line, size "" means none. */
export interface DraftFields {
  title: string;
  description: string;
  kind: TaskKind;
  size: TaskSize | "";
  criteria: string;
}

export const draftFields = (d: Pick<AssistantDraftView, "title" | "description" | "kind" | "size" | "acceptance">): DraftFields => ({
  title: d.title,
  description: d.description,
  kind: d.kind,
  size: d.size ?? "",
  criteria: d.acceptance.join("\n"),
});

export const sameFields = (a: DraftFields, b: DraftFields): boolean =>
  a.title === b.title && a.description === b.description && a.kind === b.kind && a.size === b.size && a.criteria === b.criteria;

/**
 * The draft as a freshly mounted card should open it: with what you typed, when you typed
 * something. Criteria split on every line break, blank ones included, so the card's text comes
 * back exactly as you left it.
 */
export function withEdits(d: AssistantDraftView, f: DraftFields | undefined): AssistantDraftView {
  if (!f || d.status !== "open") return d;
  return { ...d, title: f.title, description: f.description, kind: f.kind, size: f.size || null, acceptance: f.criteria.split("\n") };
}

/** The fields as assistant.addDraft's `edit`, trimmed the way a card's own Add sends them. */
export function draftEdit(f: DraftFields): AssistantDraftEdit {
  return {
    title: f.title.trim(),
    description: f.description.trim(),
    kind: f.kind,
    size: f.size || null,
    acceptance: f.criteria
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean),
  };
}

interface DraftEdits {
  /** Keyed by draft id; a draft nobody touched has no entry. */
  edits: Readonly<Record<string, DraftFields>>;
  set(draftId: string, fields: DraftFields): void;
  clear(draftId: string): void;
}

export const useDraftEdits = create<DraftEdits>((set) => ({
  edits: {},
  set: (draftId, fields) => set((s) => ({ edits: { ...s.edits, [draftId]: fields } })),
  clear: (draftId) =>
    set((s) => {
      if (!(draftId in s.edits)) return s;
      const { [draftId]: _gone, ...rest } = s.edits;
      return { edits: rest };
    }),
}));
