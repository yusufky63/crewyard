import type { ProjectSummary, RequestView, TaskSummary } from "@crewyard/core";
import type { Translate } from "./i18n.ts";

// What the tray shows and what quitting would stop, across every project. Read from the daemon;
// the main process keeps no facts of its own.

export interface RunningTask {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string;
  runs: number;
}

export interface WorkSummary {
  /** Runs that have not ended, paused ones included: quitting interrupts them all. */
  running: number;
  needYou: number;
  runningTasks: RunningTask[];
  /** The oldest open request, where "Open the Inbox" lands. */
  firstRequest: { projectId: string; taskId: string; requestId: string } | null;
}

export const EMPTY_WORK: WorkSummary = { running: 0, needYou: 0, runningTasks: [], firstRequest: null };

export function summarize(tasks: TaskSummary[], requests: RequestView[], projects: ProjectSummary[]): WorkSummary {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const runningTasks = tasks
    .filter((t) => t.activeRuns > 0)
    .map((t) => ({ taskId: t.id, title: t.title, projectId: t.projectId, projectName: names.get(t.projectId) ?? t.projectId, runs: t.activeRuns }));
  const open = requests.filter((r) => r.answeredAt === null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const first = open[0];
  return {
    running: runningTasks.reduce((n, t) => n + t.runs, 0),
    needYou: open.length,
    runningTasks,
    firstRequest: first ? { projectId: first.projectId, taskId: first.taskId, requestId: first.id } : null,
  };
}

/** The confirm text names what quitting stops: one line per task, the rest counted. */
export function quitDetail(w: WorkSummary, t: Translate, max = 6, key = "quit.detail"): string {
  const lines = w.runningTasks.slice(0, max).map((x) => `· ${t("quit.taskLine", { task: x.title, project: x.projectName })}`);
  if (w.runningTasks.length > max) lines.push(`· ${t("quit.more", { count: w.runningTasks.length - max })}`);
  return t(key, { list: lines.join("\n") });
}
