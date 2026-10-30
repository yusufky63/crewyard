import type { QueryClient } from "@tanstack/react-query";
import type { LimitNoticePayload, ProjectSummary, RequestView } from "@crewyard/core";
import { useInspector } from "../../inspector.ts";
import { call } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import { FIXTURE } from "../../screens/tasks/fixture.ts";

// Where the title bar's switcher, search and notifications take the user. Project screens need an
// open project, so every target opens its project first.

/**
 * After a jump the old focus target is gone; give focus to the new screen's main area so the next
 * Tab starts there, unless the target already focused something (the composer for New task).
 */
export function focusMain(): void {
  requestAnimationFrame(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    const main = document.querySelector<HTMLElement>("main");
    if (!main) return;
    if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
    main.focus({ preventScroll: true });
  });
}

/** Marks the project opened (the Start screen sorts by it) and lands on the project home. */
export async function openProjectById(qc: QueryClient, projectId: string): Promise<void> {
  if (!FIXTURE) await call("projects.open", { projectId }).catch(() => undefined);
  void qc.invalidateQueries({ queryKey: ["projects.list"] });
  useNav.getState().openProject(projectId);
}

/** Opens `screen` in `projectId`, keeping the current project when it is the same one. */
export async function goInProject(qc: QueryClient, projectId: string, screen: string): Promise<void> {
  if (useNav.getState().projectId !== projectId) await openProjectById(qc, projectId);
  useNav.getState().go(screen);
}

/** The Inbox leads with the selected task's requests, so selecting it lands on this item. */
export async function openRequest(qc: QueryClient, r: RequestView): Promise<void> {
  await goInProject(qc, r.projectId, "inbox");
  useNav.getState().selectTask(r.taskId);
}

/**
 * A notice tied to a task opens that task's project on Limits; an account-wide one opens Limits
 * in the current project, or the most recently opened one when none is open.
 */
export async function openNotice(qc: QueryClient, n: LimitNoticePayload, projectOfTask: (taskId: string) => string | null, projects: ProjectSummary[]): Promise<void> {
  const projectId = (n.taskId ? projectOfTask(n.taskId) : null) ?? useNav.getState().projectId ?? projects[0]?.id ?? null;
  if (!projectId) return;
  await goInProject(qc, projectId, "limits");
  if (n.taskId) useNav.getState().selectTask(n.taskId);
}

export async function openTask(qc: QueryClient, projectId: string, taskId: string): Promise<void> {
  await goInProject(qc, projectId, "tasks");
  useNav.getState().selectTask(taskId);
  useInspector.getState().open({ taskId });
}

/** Opens Tasks and puts the cursor in the composer, which renders after the screen mounts. */
export async function startNewTask(qc: QueryClient, projectId: string): Promise<void> {
  await goInProject(qc, projectId, "tasks");
  let tries = 0;
  const focus = () => {
    const field = document.querySelector<HTMLTextAreaElement>(".tk-composer textarea");
    if (field) field.focus();
    else if (++tries < 20) setTimeout(focus, 50);
  };
  setTimeout(focus, 0);
}

/** Folder picker, then add (or find) the project and open it. */
export async function openFolder(qc: QueryClient): Promise<void> {
  const path = await window.crewyard.pickFolder();
  if (!path) return;
  const project = await call("projects.add", { path });
  await qc.invalidateQueries({ queryKey: ["projects.scan"] });
  await openProjectById(qc, project.id);
}
