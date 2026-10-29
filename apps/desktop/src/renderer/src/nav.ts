import { create } from "zustand";
import { projectScreens } from "./registry.ts";

// Which screen is showing, which project is open and which task is selected. Not persisted: the
// app always opens on Start. The selected task is shared by Tasks, Inbox and Crew graph, so
// moving between them keeps the same task in view.

interface Nav {
  screen: string;
  projectId: string | null;
  taskId: string | null;
  go(screen: string): void;
  openProject(id: string): void;
  closeProject(): void;
  selectTask(id: string | null): void;
}

export const useNav = create<Nav>()((set) => ({
  screen: "start",
  projectId: null,
  taskId: null,
  go: (screen) => set({ screen }),
  openProject: (id) => set({ projectId: id, taskId: null, screen: projectScreens[0]?.id ?? "start" }),
  closeProject: () => set({ projectId: null, taskId: null, screen: "start" }),
  selectTask: (id) => set({ taskId: id }),
}));

/** Project screens exist only once a project home (Tasks) is registered. */
export const canOpenProjects = projectScreens.length > 0;
