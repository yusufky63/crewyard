import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { RememberedMode } from "./goalsModel.ts";

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
 * Text handed to the composer from elsewhere in the Tasks screen: `Edit goal` puts the goal's own
 * words back so you can change them and plan again. Not persisted; `n` makes the same text twice
 * still arrive.
 */
export const useComposerFill = create<{ text: string; n: number; fill(text: string): void }>()((set) => ({
  text: "",
  n: 0,
  fill: (text) => set((s) => ({ text, n: s.n + 1 })),
}));
