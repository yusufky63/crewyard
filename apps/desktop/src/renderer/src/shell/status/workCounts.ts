import type { TaskSummary } from "@crewyard/core";

// The status bar counts two different things and says so: agents (runs) that are running, since
// one task can run several steps at once, and tasks waiting in the queue. The Tasks filter counts
// running tasks, so the two numbers can differ and the label names its unit.
export interface WorkCounts {
  agents: number;
  queued: number;
}

export function workCounts(tasks: Array<Pick<TaskSummary, "activeRuns" | "status">>): WorkCounts {
  return {
    agents: tasks.reduce((n, x) => n + x.activeRuns, 0),
    queued: tasks.filter((x) => x.status === "queued").length,
  };
}
