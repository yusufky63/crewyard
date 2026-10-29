import type { EndReason } from "./events.ts";

// Facts are stored; status is derived when read (PLAN.md §13, after agent-orchestrator's design).

export interface RunFacts {
  id: string;
  role: string;
  required: boolean;
  startedAt: string | null;
  endedAt: string | null;
  endReason: EndReason | null;
  pendingRequestId: string | null;
  limitReached: boolean;
  retryPending: boolean;
}

export interface TaskFacts {
  kind: "code" | "research" | "review" | "docs";
  crewApprovedAt: string | null;
  cancelledAt: string | null;
  openHandoffId: string | null;
  implementationDone: boolean;
  /** The task's pull request as GitHub last reported it; null until one is opened or linked. */
  pullRequest: { state: "open" | "merged" | "closed" } | null;
  runs: RunFacts[];
}

export type TaskStatus =
  | "proposed"
  | "failed"
  | "needs_input"
  | "limited"
  | "handing_off"
  | "running"
  | "queued"
  | "review"
  | "merged"
  | "done"
  | "cancelled";

const isActive = (r: RunFacts) => r.startedAt !== null && r.endedAt === null;

/**
 * First matching rule wins; order mirrors the table in PLAN.md §13. Only a pull request GitHub
 * reported as merged makes a code task `merged`: an open, draft or closed one leaves it in
 * `review`, so "Ready for review" never reads as merged.
 */
export function deriveTaskStatus(t: TaskFacts): TaskStatus {
  if (t.cancelledAt) return "cancelled";
  if (!t.crewApprovedAt) return "proposed";
  if (t.runs.some((r) => r.required && r.endReason === "failed" && !r.retryPending) && !t.openHandoffId) return "failed";
  if (t.runs.some((r) => r.pendingRequestId !== null)) return "needs_input";
  if (t.runs.some((r) => isActive(r) && r.limitReached) && !t.openHandoffId) return "limited";
  if (t.openHandoffId) return "handing_off";
  if (t.runs.some(isActive)) return "running";
  if (t.kind === "code" && t.pullRequest?.state === "merged") return "merged";
  if (t.kind === "code" && t.implementationDone) return "review";
  const allEnded = t.runs.length > 0 && t.runs.every((r) => r.endedAt !== null);
  if (t.kind !== "code" && allEnded && t.runs.every((r) => r.endReason === "completed" || !r.required)) return "done";
  return "queued";
}

/** Filter groups used by the Tasks screen tabs. "Ready for review" and "Merged" are never merged into "Done". */
export const STATUS_FILTER: Record<TaskStatus, "running" | "needs_you" | "review" | "merged" | "done" | "other"> = {
  proposed: "needs_you",
  failed: "needs_you",
  needs_input: "needs_you",
  limited: "needs_you",
  handing_off: "running",
  running: "running",
  queued: "running",
  review: "review",
  merged: "merged",
  done: "done",
  cancelled: "other",
};
