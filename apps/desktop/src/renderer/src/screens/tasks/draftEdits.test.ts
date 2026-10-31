import { afterEach, describe, expect, it } from "vitest";
import type { AssistantDraftView } from "@crewyard/core";
import { draftEdit, draftFields, sameFields, useDraftEdits, withEdits } from "./draftEdits.ts";

const draft = { id: "d1", status: "open", title: "Cap retries", description: "Five at most.", kind: "code", size: null, acceptance: ["Stops at five", "Logs once"] } as unknown as AssistantDraftView;

afterEach(() => useDraftEdits.setState({ edits: {} }));

describe("draft edits", () => {
  it("turns a draft into card fields and the fields back into addDraft's edit, trimmed", () => {
    const f = draftFields(draft);
    expect(f).toEqual({ title: "Cap retries", description: "Five at most.", kind: "code", size: "", criteria: "Stops at five\nLogs once" });
    expect(draftEdit({ ...f, title: "  Cap retries at five ", criteria: " Stops at five \n\n Logs once" })).toEqual({
      title: "Cap retries at five",
      description: "Five at most.",
      kind: "code",
      size: null,
      acceptance: ["Stops at five", "Logs once"],
    });
  });

  it("opens a remounted card with what was typed, blank criteria lines included", () => {
    const typed = { ...draftFields(draft), title: "Cap retries at three", size: "S" as const, criteria: "Stops at three\n\n" };
    const shown = withEdits(draft, typed);
    expect(draftFields(shown)).toEqual(typed);
    expect(shown.id).toBe("d1");
    // Nothing typed, or a draft that is no longer open: the draft as the daemon has it.
    expect(withEdits(draft, undefined)).toBe(draft);
    const added = { ...draft, status: "added" } as AssistantDraftView;
    expect(withEdits(added, typed)).toBe(added);
  });

  it("compares card fields one by one", () => {
    const f = draftFields(draft);
    expect(sameFields(f, { ...f })).toBe(true);
    expect(sameFields(f, { ...f, kind: "docs" })).toBe(false);
    expect(sameFields(f, { ...f, criteria: `${f.criteria}\n` })).toBe(false);
  });

  it("keeps what was typed per draft until it is cleared", () => {
    const f = { ...draftFields(draft), title: "Edited" };
    useDraftEdits.getState().set("d1", f);
    expect(useDraftEdits.getState().edits.d1).toEqual(f);
    expect(useDraftEdits.getState().edits.d2).toBeUndefined();
    useDraftEdits.getState().clear("d1");
    expect(useDraftEdits.getState().edits).toEqual({});
  });
});
