import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import type { ProjectSummary } from "@crewyard/core";
import type { FolderProblem, OpenFolderRequest } from "../../../shared/api.ts";
import { call } from "../ipc.ts";
import { useNav } from "../nav.ts";
import { openSetup, useDraft } from "../screens/setup/draft.ts";
import { findProject } from "./folderMatch.ts";

// Opening a folder from outside the app (PLAN.md §12): `Crewyard.exe <folder>`, Explorer's "Open in
// Crewyard", or a folder dropped on the Start screen or the title bar. The main process checks the
// path and sends `app.openFolder`; here it lands. A known project opens; a new folder opens the New
// project wizard at step 1 with the folder filled in, and nothing is written before Create project.

interface FolderOpenState {
  /** The last folder that could not be opened, shown on the Start screen until dismissed. */
  refused: OpenFolderRequest | null;
  /** Files are being dragged over the window: the drop targets show themselves. */
  dragging: boolean;
  dismiss(): void;
}

// Screenshot mode only (the main process sets the query): ?drop=1 shows the drop targets, and
// ?refused=wsl&refusedPath=... the refusal banner, so both can be captured.
const shot = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
const SHOT_PROBLEMS: FolderProblem[] = ["missing", "notFolder", "wsl", "unc", "invalid"];
const shotRefused = SHOT_PROBLEMS.find((p) => p === shot.get("refused"));

export const useFolderOpen = create<FolderOpenState>()((set) => ({
  refused: shotRefused ? { path: shot.get("refusedPath") ?? "", problem: shotRefused } : null,
  dragging: shot.get("drop") === "1",
  dismiss: () => set({ refused: null }),
}));

/** Reads the project list, waiting once for the daemon when the app was started with a folder. */
async function listProjects(): Promise<ProjectSummary[]> {
  try {
    return await call("projects.list", undefined);
  } catch {
    await new Promise<void>((resolve) => {
      const off = window.crewyard.on("daemon.ready", () => {
        off();
        resolve();
      });
    });
    return call("projects.list", undefined);
  }
}

export async function openFolderRequest(req: OpenFolderRequest, qc: QueryClient): Promise<void> {
  const nav = useNav.getState();
  if (req.problem) {
    useFolderOpen.setState({ refused: req });
    nav.go("start");
    return;
  }
  useFolderOpen.setState({ refused: null });
  const known = findProject(await listProjects(), req.path);
  if (known) {
    await call("projects.open", { projectId: known.id });
    void qc.invalidateQueries({ queryKey: ["projects.list"] });
    nav.openProject(known.id);
    return;
  }
  // The wizard reads the folder (setup.detect) but writes nothing until Create project.
  openSetup("local");
  useDraft.getState().set({ path: req.path, seededFor: null });
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * Mounted once by the shell: takes `app.openFolder` from the main process and tracks whether files
 * are being dragged over the window, so the Start screen and the title bar can show where to drop.
 */
export function useOpenFolderEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const off = window.crewyard.on("app.openFolder", (p) => void openFolderRequest(p as OpenFolderRequest, qc));
    // dragenter and dragleave fire for every child crossed, so the window keeps a depth count.
    let depth = 0;
    const set = (dragging: boolean) => {
      if (useFolderOpen.getState().dragging !== dragging) useFolderOpen.setState({ dragging });
    };
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      set(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) set(false);
    };
    const end = () => {
      depth = 0;
      set(false);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", end);
    window.addEventListener("dragend", end);
    return () => {
      off();
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", end);
      window.removeEventListener("dragend", end);
    };
  }, [qc]);
}

/** Props for an element that takes a dropped folder. Only the first item counts; main checks it. */
export const folderDropProps = {
  onDragOver: (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "link";
  },
  onDrop: (e: React.DragEvent) => {
    const file = e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    useFolderOpen.setState({ dragging: false });
    const path = window.crewyard.pathForFile(file);
    if (path) window.crewyard.openFolder(path);
  },
};
