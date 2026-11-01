import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { ComposerMode, RememberedMode } from "./goalsModel.ts";

// The composer's per-project memory (design §1.2, §3.1): the mode you last submitted with
// (Orchestra or Crew, never Solo) and the profile you picked on Solo's who chip. Per viewer, so it
// lives in the renderer's storage; the planner you pick is remembered by the daemon instead,
// because goals.create pins it there (GOAL_SETTINGS.planner).

interface ComposerPrefs {
  modes: Record<string, RememberedMode>;
  soloWho: Record<string, string>;
  rememberMode(projectId: string, mode: RememberedMode | null): void;
  rememberSoloWho(projectId: string, profileId: string | null): void;
}

// localStorage can be missing or throw (private profiles, blocked storage); fall back to memory.
const memory = new Map<string, string>();
const storage: StateStorage = {
  getItem: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return memory.get(k) ?? null;
    }
  },
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      memory.set(k, v);
    }
  },
  removeItem: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      memory.delete(k);
    }
  },
};

const without = <T>(rec: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...rec };
  delete next[key];
  return next;
};

export const useComposerPrefs = create<ComposerPrefs>()(
  persist(
    (set) => ({
      modes: {},
      soloWho: {},
      // Solo is passed as null and leaves the stored mode as it was (design §1.2).
      rememberMode: (projectId, mode) => set((s) => (mode ? { modes: { ...s.modes, [projectId]: mode } } : s)),
      rememberSoloWho: (projectId, profileId) => set((s) => ({ soloWho: profileId ? { ...s.soloWho, [projectId]: profileId } : without(s.soloWho, projectId) })),
    }),
    {
      name: "crewyard:composer",
      storage: createJSONStorage(() => storage),
      version: 1,
      // Only the two known modes survive a hand-edited store; anything else reads as nothing kept.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ComposerPrefs>;
        const modes = Object.fromEntries(Object.entries(p.modes ?? {}).filter(([, v]) => v === "orchestra" || v === "crew"));
        const soloWho = Object.fromEntries(Object.entries(p.soloWho ?? {}).filter(([, v]) => typeof v === "string" && v.length > 0));
        return { ...current, modes, soloWho };
      },
    },
  ),
);

/**
 * A mode picked outside the composer for its next request only: the Guide's mode tiles open the
 * composer on the mode they describe. The composer takes it once, when it mounts or when a new
 * pick arrives. Never persisted, so a Solo pick is still never remembered (design §1.2).
 */
export const useComposerPick = create<{ mode: ComposerMode | null; n: number; pick(mode: ComposerMode): void; take(): ComposerMode | null }>()((set, get) => ({
  mode: null,
  n: 0,
  pick: (mode) => set((s) => ({ mode, n: s.n + 1 })),
  take: () => {
    const { mode } = get();
    if (mode) set({ mode: null });
    return mode;
  },
}));

/** A goal the assistant drafted (draft_goal, docs/adr/0022), carried with its text into the composer. */
export interface ComposerFillFrom {
  draftId: string;
  projectId: string;
  plannerProfileId: string | null;
  plannerAlias: string | null;
  budgetUsd: number | null;
}

export interface ComposerFill {
  text: string;
  /** Set when the text is an assistant's goal draft; the composer says so and links the goal to it. */
  from: ComposerFillFrom | null;
}

/**
 * Text handed to the composer from elsewhere: `Edit goal` puts the goal's own words back so you can
 * change them and plan again, and a goal draft's `Open in composer` puts the assistant's goal there
 * in Orchestra mode. Not persisted; `n` makes the same text twice still arrive. A fill made while
 * no composer is mounted (the drafts card on another screen) waits in `pending` until one takes it.
 */
export const useComposerFill = create<{
  text: string;
  from: ComposerFillFrom | null;
  n: number;
  pending: ComposerFill | null;
  fill(text: string, from?: ComposerFillFrom | null): void;
  peek(projectId: string): ComposerFill | null;
  take(projectId: string): ComposerFill | null;
}>()((set, get) => ({
  text: "",
  from: null,
  n: 0,
  pending: null,
  fill: (text, from = null) => set((s) => ({ text, from, n: s.n + 1, pending: { text, from } })),
  // A goal draft belongs to its project; another project's composer leaves it waiting.
  peek: (projectId) => {
    const p = get().pending;
    return p && (!p.from || p.from.projectId === projectId) ? p : null;
  },
  take: (projectId) => {
    const p = get().peek(projectId);
    if (p) set({ pending: null });
    return p;
  },
}));
