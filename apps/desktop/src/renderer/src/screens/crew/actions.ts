import type { GraphNodeModel } from "./model.ts";

// Which actions a node's context menu offers, and why some are disabled. Each rule is one entry
// in ACTION_RULES; a new action (for example one that needs a new IPC method) is one more entry
// plus its label, icon and handler in CrewScreen. Groups are separated by a line in the menu.

export type ActionId = "open" | "message" | "pause" | "resume" | "copy_run_id" | "stop";

/** Codes for why an action is disabled; translated as `menu.why.<code>`. */
export type DisabledCode = "not_started" | "ended" | "completed" | "handing_off" | "task_cancelled" | "no_run";

export interface ActionContext {
  /** Ended runs the daemon can resume (TaskSummary.resumableRunIds). */
  resumable: ReadonlySet<string>;
  taskCancelled: boolean;
}

interface ActionRule {
  id: ActionId;
  group: number;
  danger?: boolean;
  /** Undefined hides the action for this node; null shows it enabled. */
  check(node: GraphNodeModel, ctx: ActionContext): DisabledCode | null | undefined;
}

const runRule =
  (inner: (run: NonNullable<GraphNodeModel["run"]>, ctx: ActionContext) => DisabledCode | null | undefined) =>
  (node: GraphNodeModel, ctx: ActionContext): DisabledCode | null | undefined => {
    if (node.kind !== "member") return undefined;
    if (!node.run) return ctx.taskCancelled ? "task_cancelled" : "not_started";
    return inner(node.run, ctx);
  };

export const ACTION_RULES: ActionRule[] = [
  { id: "open", group: 0, check: () => null },
  {
    id: "message",
    group: 1,
    // Messages to a run without a live process wait for whichever run continues the step.
    check: runRule((run, ctx) => (run.endReason === "completed" ? "completed" : ctx.taskCancelled ? "task_cancelled" : null)),
  },
  {
    id: "pause",
    group: 1,
    check: runRule((run, ctx) => {
      if (run.state === "paused" || run.state === "ended") return undefined;
      if (ctx.taskCancelled) return "task_cancelled";
      return run.state === "handing_off" ? "handing_off" : null;
    }),
  },
  {
    id: "resume",
    group: 1,
    // A step that has not started shows Pause as disabled; Resume would only repeat the reason.
    check: (node, ctx) => (node.run ? resumeCheck(node.run, ctx) : undefined),
  },
  {
    id: "copy_run_id",
    group: 2,
    check: (node) => (node.kind !== "member" ? undefined : node.run ? null : "no_run"),
  },
  {
    id: "stop",
    group: 3,
    danger: true,
    check: runRule((run) => (run.state === "ended" ? "ended" : null)),
  },
];

function resumeCheck(run: NonNullable<GraphNodeModel["run"]>, ctx: ActionContext): DisabledCode | null | undefined {
  if (run.state === "paused") return ctx.taskCancelled ? "task_cancelled" : null;
  if (run.state === "ended" && ctx.resumable.has(run.id)) return ctx.taskCancelled ? "task_cancelled" : null;
  return undefined;
}

export interface ActionEntry {
  id: ActionId;
  disabled: DisabledCode | null;
  danger: boolean;
}

/** The node's menu as groups of entries; empty groups are dropped. */
export function actionsFor(node: GraphNodeModel, ctx: ActionContext): ActionEntry[][] {
  const groups: ActionEntry[][] = [];
  for (const rule of ACTION_RULES) {
    const disabled = rule.check(node, ctx);
    if (disabled === undefined) continue;
    (groups[rule.group] ??= []).push({ id: rule.id, disabled, danger: !!rule.danger });
  }
  return groups.filter((g) => g && g.length > 0);
}
