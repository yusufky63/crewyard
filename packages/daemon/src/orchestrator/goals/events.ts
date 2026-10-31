import type { GoalChangeCause, GoalErrorCode, GoalStatus, GoalsTopics } from "@crewyard/core";
import type { Store } from "../../store.ts";

// Goal events and the goal topic (docs/adr/0019, design §4.1). The task audit helper in context.ts
// needs a task id, so goal facts are written here with the project set and task_id null; the goal
// id rides in the payload. `goals.changed` goes out through the daemon's own emit, because the
// context's emit is typed to the tasks topics.

/**
 * A refusal of a goal call. Like OrchestratorError, the message is the code itself so the IPC error
 * stays translatable; params ride along for the log and tests.
 */
export class GoalError extends Error {
  constructor(
    readonly code: GoalErrorCode,
    readonly params: Record<string, string | number> = {},
  ) {
    super(code);
    this.name = "GoalError";
  }
}

export type GoalEventKind =
  | "goal.approved"
  | "goal.task_released"
  | "goal.task_held"
  | "goal.task_failed"
  | "goal.report_accepted"
  | "goal.joined"
  | "goal.join_conflict"
  | "goal.decision"
  | "goal.decided"
  | "goal.decision_closed"
  | "goal.halt_lifted"
  | "goal.paused"
  | "goal.resumed"
  | "goal.paused_all"
  | "goal.halted"
  | "goal.stopped"
  | "goal.limits"
  | "goal.finished"
  | "goal.integration_created"
  | "goal.error";

export class GoalEvents {
  constructor(
    private readonly store: Store,
    private readonly emitFn: (topic: string, payload: unknown) => void,
  ) {}

  /** One audited goal fact. `goalId` is always in the payload, so the goal's log is one query. */
  append(projectId: string, goalId: string, kind: GoalEventKind, payload: Record<string, unknown> = {}): void {
    this.store.appendEvent({ kind, source: "orchestrator", payload: { goalId, ...payload }, projectId, taskId: null });
  }

  /** The renderer re-reads the goal with goals.get; this only says that and why. */
  changed(p: GoalsTopics["goals.changed"]): void {
    this.emitFn("goals.changed", p);
  }

  /** Every event of the goal of `kind`, oldest first; `seq` orders them against each other. */
  read(goalId: string, kind: GoalEventKind): Array<{ seq: number; payload: Record<string, unknown> }> {
    const rows = this.store.db.prepare("select seq, payload from events where kind = ? and task_id is null and json_extract(payload, '$.goalId') = ? order by seq").all(kind, goalId) as Array<{ seq: number; payload: string }>;
    return rows.map((r) => ({ seq: Number(r.seq), payload: JSON.parse(r.payload) as Record<string, unknown> }));
  }
}

export type { GoalChangeCause, GoalStatus };
