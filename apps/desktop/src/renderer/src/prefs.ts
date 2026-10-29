import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { Language } from "./i18n.ts";

// Per-viewer UI preferences only. Anything that must survive a reinstall or be shared lives in the daemon.

export type ThemePref = "system" | "dark" | "light";
export type Density = "comfortable" | "compact";

interface Prefs {
  theme: ThemePref;
  density: Density;
  /** null follows the Windows display language. */
  language: Language | null;
  scanRoot: string;
  setTheme(theme: ThemePref): void;
  setDensity(density: Density): void;
  setLanguage(language: Language | null): void;
}

// localStorage can be missing or throw (private profiles, blocked storage); fall back to memory.
const memory = new Map<string, string>();
const safeStorage: StateStorage = {
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

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      theme: "system",
      density: "comfortable",
      language: null,
      scanRoot: "C:\\Projeler",
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setLanguage: (language) => set({ language }),
    }),
    { name: "crewyard:prefs", storage: createJSONStorage(() => safeStorage), version: 1 },
  ),
);

export const nextTheme = (t: ThemePref): ThemePref => (t === "system" ? "dark" : t === "dark" ? "light" : "system");
