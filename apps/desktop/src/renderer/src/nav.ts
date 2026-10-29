import { create } from "zustand";
import { projectScreens } from "./registry.ts";

// Which screen is showing and which project is open. Not persisted: the app always opens on Start.

interface Nav {
  screen: string;
  projectId: string | null;
  go(screen: string): void;
  openProject(id: string): void;
  closeProject(): void;
}

export const useNav = create<Nav>()((set) => ({
  screen: "start",
  projectId: null,
  go: (screen) => set({ screen }),
  openProject: (id) => set({ projectId: id, screen: projectScreens[0]?.id ?? "start" }),
  closeProject: () => set({ projectId: null, screen: "start" }),
}));

/** Project screens exist only once a project home (Tasks) is registered. */
export const canOpenProjects = projectScreens.length > 0;
