import { useInspector } from "../../../inspector.ts";
import { useNav } from "../../../nav.ts";

// `Open task` from the assistant's drafts, a report's suggested tasks (the same DraftCard) and the
// Autopilot log. Selecting the task alone did nothing visible: after `Add as draft` it was already
// the selected task, and from the bottom panel on another screen, or from the inspector, nothing
// showed the selection. So it goes all the way: the project's Tasks screen, the task selected, the
// inspector on Details, and the row scrolled into view with focus on it.

/** Frames to wait for the row: the Tasks screen mounts and reads its list after the switch. */
const ROW_WAIT_FRAMES = 90;

export function openTask(taskId: string, projectId?: string | null): void {
  const nav = useNav.getState();
  if (projectId && nav.projectId !== projectId) nav.openProject(projectId);
  nav.go("tasks");
  nav.selectTask(taskId);
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
    // A filter hides the row: the inspector still shows the task, so focus goes there.
    document.querySelector<HTMLElement>("#app-inspector button")?.focus();
  };
  requestAnimationFrame(step);
}
