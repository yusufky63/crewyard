import { create } from "zustand";

// The right-hand inspector (DESIGN.md §4). Task rows, Inbox items and Crew graph nodes open it;
// the shell renders it. Closing it only hides the panel and never stops an agent.

export interface InspectorTarget {
  taskId: string;
  /** A crew step; omitted to show the task as a whole. */
  memberId?: string;
  /** A specific run of that step, e.g. the one before a handoff. */
  runId?: string;
  /** Opens this tab instead of the one shown last (the Crew graph's Open changes, Open files). */
  tab?: "details" | "changes" | "usage" | "files" | "preview";
}

interface Inspector {
  target: InspectorTarget | null;
  open(target: InspectorTarget): void;
  close(): void;
}

export const useInspector = create<Inspector>()((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
