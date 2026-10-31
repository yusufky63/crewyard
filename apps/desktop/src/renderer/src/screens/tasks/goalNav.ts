import { create } from "zustand";

/**
 * Which goal the Tasks slot shows (design §3.3). The Inbox's goal list, the goal rows and a goal
 * toast set it; the Tasks screen reads it to put the goal view above the list. Its own module, so
 * live.ts (which a toast's `app.navigate` reaches) can set it without importing the goal row.
 */
export const useGoalNav = create<{ goalId: string | null; open(goalId: string | null): void }>()((set) => ({
  goalId: null,
  open: (goalId) => set({ goalId }),
}));
