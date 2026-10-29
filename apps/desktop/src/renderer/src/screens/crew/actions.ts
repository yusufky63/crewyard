import type { CandidateView, TaskDetail } from "@crewyard/core";
import type { GraphNodeModel } from "./model.ts";

// Which actions a node's context menu offers, and why some are disabled. Each rule is one entry
// in ACTION_RULES; a new action (for example one that needs a new IPC method) is one more entry
// plus its label, icon and handler in CrewScreen. Groups are separated by a line in the menu.

export type ActionId = "open" | "message" | "pause" | "resume" | "retry" | "change_ai" | "copy_run_id" | "stop";

/** Codes for why an action is disabled; translated as `menu.why.<code>`. */
export type DisabledCode = "not_started" | "ended" | "completed" | "handing_off" | "task_cancelled" | "no_run" | "superseded" | "working" | "no_target";

export interface ActionContext {
  /** Ended runs the daemon can resume (TaskSummary.resumableRunIds). */
  resumable: ReadonlySet<string>;
  taskCancelled: boolean;
  /** Runs a later run already continues (some run's resumedFrom points at them). */
  superseded?: ReadonlySet<string>;
  /** How many other profiles this member could hand off to (its chosen and standby candidates). */
  handoffTargets?: (memberId: string, currentProfileId: string) => number;
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
    // "Check again": restart a failed or stopped step, or re-check a limit or spend-cap pause now.
    // Same rule as the inspector's Retry button (shell/Inspector.tsx).
    id: "retry",
    group: 1,
    check: runRule((run, ctx) => {
      if (run.endReason === "completed") return "completed";
      if (ctx.superseded?.has(run.id)) return "superseded";
      if (ctx.taskCancelled) return "task_cancelled";
      return run.endedAt !== null || run.limitReached || run.resumeAt !== null ? null : "working";
    }),
  },
  {
    // "Change AI": a manual handoff to another of the member's candidates.
    id: "change_ai",
    group: 1,
    check: (node, ctx) =>
      runRule((run) => {
        if (run.endReason === "completed") return "completed";
        if (ctx.superseded?.has(run.id)) return "superseded";
        if (ctx.taskCancelled) return "task_cancelled";
        if (run.state === "handing_off") return "handing_off";
        return node.memberId && (ctx.handoffTargets?.(node.memberId, run.profileId) ?? 0) > 0 ? null : "no_target";
      })(node, ctx),
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

/** Profiles a member's run can be handed to: its chosen and standby candidates, minus the one it runs on. */
export function handoffCandidates(task: TaskDetail, memberId: string, currentProfileId: string): CandidateView[] {
  const member = task.crew?.members.find((m) => m.id === memberId);
  if (!member) return [];
  const seen = new Set([currentProfileId]);
  return [member.chosen, ...member.standby].filter((c): c is CandidateView => {
    if (!c || seen.has(c.profileId)) return false;
    seen.add(c.profileId);
    return true;
  });
}

/** Runs a later run already continues; acting on them would fork the step. */
export const supersededRuns = (task: TaskDetail): Set<string> => new Set(task.runs.flatMap((r) => (r.resumedFrom ? [r.resumedFrom] : [])));

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
