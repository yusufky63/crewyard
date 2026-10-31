import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { Language } from "./i18n.ts";
import { DEFAULT_LAYOUT, sanitizeLayout, type LayoutPrefs } from "./shell/layout.ts";

// Per-viewer UI preferences only. Anything that must survive a reinstall or be shared lives in the daemon.

export type ThemePref = "system" | "dark" | "light";
export type Density = "comfortable" | "compact";

interface Prefs extends LayoutPrefs {
  theme: ThemePref;
  density: Density;
  /** null follows the Windows display language. */
  language: Language | null;
  scanRoot: string;
  setTheme(theme: ThemePref): void;
  setDensity(density: Density): void;
  setLanguage(language: Language | null): void;
  setScanRoot(scanRoot: string): void;
  setSidebarWidth(px: number): void;
  setSidebarCollapsed(collapsed: boolean): void;
  toggleSidebar(): void;
  setInspectorWidth(px: number): void;
  setInspectorCollapsed(collapsed: boolean): void;
  setInboxListWidth(px: number): void;
  setDrawerHeight(px: number): void;
  setDrawerOpen(open: boolean): void;
  toggleDrawer(): void;
  drawerTab: DrawerTab;
  setDrawerTab(tab: DrawerTab): void;
}

/** The Activity drawer's tabs; the terminal view is not built (DESIGN.md §4). */
export type DrawerTab = "events" | "logs";

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
      setScanRoot: (scanRoot) => set({ scanRoot }),
      // Pane sizes (DESIGN.md §5 `Splitter`): per window, so they stay here and not in the daemon.
      ...DEFAULT_LAYOUT,
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setInspectorWidth: (inspectorWidth) => set({ inspectorWidth }),
      setInspectorCollapsed: (inspectorCollapsed) => set({ inspectorCollapsed }),
      setInboxListWidth: (inboxListWidth) => set({ inboxListWidth }),
      setDrawerHeight: (drawerHeight) => set({ drawerHeight }),
      setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
      toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
      drawerTab: "events",
      setDrawerTab: (drawerTab) => set({ drawerTab }),
    }),
    {
      name: "crewyard:prefs",
      storage: createJSONStorage(() => safeStorage),
      version: 1,
      // Stored sizes are clamped on load, so a hand-edited or out-of-range value never breaks the layout.
      merge: (persisted, current) => ({ ...current, ...(persisted as Partial<Prefs>), ...sanitizeLayout(persisted) }),
    },
  ),
);

export const nextTheme = (t: ThemePref): ThemePref => (t === "system" ? "dark" : t === "dark" ? "light" : "system");
