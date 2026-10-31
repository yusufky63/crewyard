import { create } from "zustand";
import { useInspector } from "../../../inspector.ts";
import { useNav } from "../../../nav.ts";
import { usePrefs } from "../../../prefs.ts";

// `Open task` from the assistant's drafts, a report's suggested tasks (the same DraftCard) and the
// Autopilot log. Selecting the task alone did nothing visible: after `Add as draft` it was already
// the selected task, and from the bottom panel on another screen, or from the inspector, nothing
// showed the selection. So it goes all the way: the project's Tasks screen on its task list, the
// task selected, the inspector expanded on Details, and the row scrolled into view with focus on it.

/** Frames to wait for the row: the Tasks screen mounts, reads its list, then the row reads its task. */
const ROW_WAIT_FRAMES = 180;

/**
 * A request for the Tasks screen to show a task it may be hiding: its Schedules view and its status
 * filter are the screen's own state, which only the screen can change (TasksScreen subscribes).
 */
export const useTaskReveal = create<{ taskId: string | null; n: number }>()(() => ({ taskId: null, n: 0 }));

export function openTask(taskId: string, projectId?: string | null): void {
  const nav = useNav.getState();
  if (projectId && nav.projectId !== projectId) nav.openProject(projectId);
  nav.go("tasks");
  nav.selectTask(taskId);
  useTaskReveal.setState((s) => ({ taskId, n: s.n + 1 }));
  // A collapsed inspector is a 24 px strip: the task would be "open" where nobody can read it.
  usePrefs.getState().setInspectorCollapsed(false);
  useInspector.getState().open({ taskId, tab: "details" });
  revealRow(taskId);
}

/** Moves to the task without taking focus, for `Add as draft`: its crew proposal opens at the top of Tasks. */
export function showTask(taskId: string): void {
  const nav = useNav.getState();
  nav.go("tasks");
  nav.selectTask(taskId);
}

function revealRow(taskId: string): void {
  let frames = 0;
  const step = () => {
    // Only the Tasks list's row: the Inbox and Crew graph use the same attribute for their lists.
    const row = document.querySelector<HTMLElement>(`.tk-list [data-list-id="${CSS.escape(taskId)}"]`);
    if (row) {
      row.scrollIntoView({ block: "nearest" });
      row.focus({ preventScroll: true });
      return;
    }
    if (++frames < ROW_WAIT_FRAMES) {
      requestAnimationFrame(step);
      return;
    }
    // No row to land on (the list failed to load): the inspector still shows the task, so focus
    // goes to its open tab, never to its first button, which is Collapse.
    document.querySelector<HTMLElement>('#app-inspector [role="tab"][aria-selected="true"]')?.focus();
  };
  requestAnimationFrame(step);
}
