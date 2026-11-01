import type { CandidateView, RunView, TaskDetail } from "@crewyard/core";
import { latestRun, type GraphNodeModel } from "./model.ts";

// Which actions a node's context menu offers, and why some are disabled. Each rule is one entry
// in ACTION_RULES; a new action (for example one that needs a new IPC method) is one more entry
// plus its label, icon and handler in CrewScreen. Groups are separated by a line in the menu.

export type ActionId =
  | "open"
  | "open_details"
  | "open_changes"
  | "open_files"
  | "message"
  | "pause"
  | "resume"
  | "retry"
  | "retry_failed_steps"
  | "change_ai"
  | "handoff_now"
  | "wait_reset"
  | "edit"
  | "approve_crew"
  | "change_ai_all"
  | "add_step"
  | "add_after"
  | "remove_step"
  | "skip"
  | "follow_up"
  | "follow_up_task"
  | "rerun_other"
  | "pause_all"
  | "resume_all"
  | "copy_run_id"
  | "stop"
  | "cancel_task";

/** Codes for why an action is disabled; translated as `menu.why.<code>`. */
export type DisabledCode =
  | "not_started"
  | "ended"
  | "completed"
  | "handing_off"
  | "task_cancelled"
  | "no_run"
  | "superseded"
  | "working"
  | "no_target"
  | "no_request"
  | "no_reset"
  | "last_step"
  | "skipped"
  | "nothing_live"
  | "nothing_paused"
  | "none_failed"
  | "nothing_finished"
  | "task_finished"
  | "crew_problem"
  | "no_worktree";

/** The open handoff question of a run (a limit in Ask or Manual mode), as the Inbox has it. */
export interface HandoffAsk {
  requestId: string;
  resetsAt: string | null;
  candidates: CandidateView[];
  proposed: CandidateView | null;
}

export interface ActionContext {
  /** Ended runs the daemon can resume (TaskSummary.resumableRunIds). */
  resumable: ReadonlySet<string>;
  taskCancelled: boolean;
  /** Runs a later run already continues (some run's resumedFrom points at them). */
  superseded?: ReadonlySet<string>;
  /** How many other profiles this member could hand off to (its chosen and standby candidates). */
  handoffTargets?: (memberId: string, currentProfileId: string) => number;
  /** The crew is still a proposal: edit actions replace run actions. */
  proposal?: boolean;
  /** Steps in the crew, so the last one cannot be removed. */
  crewSize?: number;
  /** The run's open handoff question, if one waits in the Inbox. */
  handoffAsk?: (runId: string) => HandoffAsk | null;
  /** Live and paused runs of the task, for Pause all and Resume all. */
  bulk?: { live: number; paused: number };
  /** Steps whose newest run failed, for the task's Retry failed steps. */
  failedSteps?: number;
  /** Steps whose newest run completed: a follow-up goes after one of them. */
  finishedSteps?: number;
  /** The task has a worktree, so its Changes tab has something to show. */
  hasChanges?: boolean;
  /** Ready for review, merged or done: nothing is left to cancel. */
  taskFinished?: boolean;
  /** The proposal has a problem that keeps it from being approved (the crew bar names it). */
  crewProblem?: boolean;
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
    // A proposal or a follow-up waiting for approval has no run yet; its menu is about editing.
    if (node.kind !== "member" || ctx.proposal || node.pending) return undefined;
    if (!node.run) return ctx.taskCancelled ? "task_cancelled" : "not_started";
    return inner(node.run, ctx);
  };

/** Like runRule, but hidden rather than disabled on a step with no run: the action is about that run. */
const ranRule =
  (inner: (run: NonNullable<GraphNodeModel["run"]>, ctx: ActionContext) => DisabledCode | null | undefined) =>
  (node: GraphNodeModel, ctx: ActionContext): DisabledCode | null | undefined =>
    node.run ? runRule(inner)(node, ctx) : undefined;

/** A run on a limit, or one the Inbox asks about, can be handed off or left to wait from here. */
const askRule = (inner: (ask: HandoffAsk) => DisabledCode | null) =>
  ranRule((run, ctx) => {
    const ask = ctx.handoffAsk?.(run.id) ?? null;
    if (!ask && !(run.state === "rate_limited" || (run.limitReached && run.state !== "ended"))) return undefined;
    if (ctx.taskCancelled) return "task_cancelled";
    return ask ? inner(ask) : "no_request";
  });

const isStep = (node: GraphNodeModel) => node.kind === "member";
const isTask = (node: GraphNodeModel) => node.kind === "task";

/** A task-node rule for a running (approved) crew: the task's own state comes first. */
const taskRule = (inner: (ctx: ActionContext) => DisabledCode | null) => (node: GraphNodeModel, ctx: ActionContext) =>
  !isTask(node) || ctx.proposal ? undefined : ctx.taskCancelled ? "task_cancelled" : inner(ctx);

export const ACTION_RULES: ActionRule[] = [
  { id: "open", group: 0, check: (node) => (isTask(node) ? undefined : null) },
  // The task node opens the task as a whole, on Details, rather than the last tab shown.
  { id: "open_details", group: 0, check: (node) => (isTask(node) ? null : undefined) },
  // The inspector's tabs, one step closer than opening it and switching.
  {
    id: "open_changes",
    group: 0,
    check: (node, ctx) => (ctx.proposal ? undefined : isStep(node) ? null : ctx.hasChanges === false ? "no_worktree" : null),
  },
  { id: "open_files", group: 0, check: (node, ctx) => (isStep(node) && !ctx.proposal ? null : undefined) },
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
  // Every failed step at once, each through the same runs.retry as its own Retry step.
  { id: "retry_failed_steps", group: 1, check: taskRule((ctx) => ((ctx.failedSteps ?? 0) > 0 ? null : "none_failed")) },
  {
    // "Change AI": a manual handoff to another of the member's candidates once the step runs;
    // before its run, another profile for the step (crew.changeProfile), which starts nothing.
    id: "change_ai",
    group: 1,
    check: (node, ctx) => {
      if (isStep(node) && !node.run && !ctx.proposal && !node.pending) {
        if (ctx.taskCancelled) return "task_cancelled";
        return node.status === "skipped" ? "skipped" : null;
      }
      return runRule((run) => {
        if (run.endReason === "completed") return "completed";
        if (ctx.superseded?.has(run.id)) return "superseded";
        if (ctx.taskCancelled) return "task_cancelled";
        if (run.state === "handing_off") return "handing_off";
        return node.memberId && (ctx.handoffTargets?.(node.memberId, run.profileId) ?? 0) > 0 ? null : "no_target";
      })(node, ctx);
    },
  },
  // Hand off now and Wait for reset answer the same Inbox question the limit opened.
  { id: "handoff_now", group: 1, check: askRule((ask) => (ask.candidates.length > 0 || ask.proposed ? null : "no_target")) },
  { id: "wait_reset", group: 1, check: askRule((ask) => (ask.resetsAt ? null : "no_reset")) },
  // Editing: every change is its own explicit action, never a side effect of moving a node.
  { id: "edit", group: 2, check: (node, ctx) => (isStep(node) && (ctx.proposal || node.pending) ? null : undefined) },
  // The crew bar's Approve and start, from the task node; off for the same problem the bar names.
  { id: "approve_crew", group: 2, check: (node, ctx) => (isTask(node) && ctx.proposal ? (ctx.crewProblem ? "crew_problem" : null) : undefined) },
  // One profile for every step it is scored for, each through crew.edit; the proposal still waits.
  { id: "change_ai_all", group: 2, check: (node, ctx) => (isTask(node) && ctx.proposal ? null : undefined) },
  { id: "add_step", group: 2, check: (node, ctx) => (node.kind === "task" && ctx.proposal ? null : undefined) },
  { id: "add_after", group: 2, check: (node, ctx) => (isStep(node) && ctx.proposal ? null : undefined) },
  {
    id: "remove_step",
    group: 2,
    danger: true,
    check: (node, ctx) => (isStep(node) && (ctx.proposal || node.pending) ? ((ctx.crewSize ?? 2) <= 1 ? "last_step" : null) : undefined),
  },
  {
    // Only a step of the approved crew that has not started; a follow-up is removed instead.
    id: "skip",
    group: 2,
    check: (node, ctx) => {
      if (!isStep(node) || ctx.proposal || node.pending || node.run) return undefined;
      if (node.status === "skipped") return "skipped";
      return ctx.taskCancelled ? "task_cancelled" : null;
    },
  },
  { id: "follow_up", group: 2, check: ranRule(finishedRule) },
  // The same follow-up, pinned to another profile: it waits for Approve new steps like any new step.
  { id: "rerun_other", group: 2, check: ranRule(finishedRule) },
  // From the task node the follow-up picks which finished step it goes after.
  { id: "follow_up_task", group: 2, check: taskRule((ctx) => ((ctx.finishedSteps ?? 0) > 0 ? null : "nothing_finished")) },
  { id: "pause_all", group: 2, check: taskRule((ctx) => ((ctx.bulk?.live ?? 0) > 0 ? null : "nothing_live")) },
  { id: "resume_all", group: 2, check: taskRule((ctx) => ((ctx.bulk?.paused ?? 0) > 0 ? null : "nothing_paused")) },
  {
    id: "copy_run_id",
    group: 3,
    check: (node, ctx) => (node.kind !== "member" || ctx.proposal || node.pending ? undefined : node.run ? null : "no_run"),
  },
  {
    id: "stop",
    group: 4,
    danger: true,
    check: runRule((run) => (run.state === "ended" ? "ended" : null)),
  },
  {
    // tasks.cancel with its confirm, as the task row has it; a proposal is cancelled the same way.
    id: "cancel_task",
    group: 4,
    danger: true,
    check: (node, ctx) => (!isTask(node) ? undefined : ctx.taskCancelled ? "task_cancelled" : ctx.taskFinished ? "task_finished" : null),
  },
];

function finishedRule(run: NonNullable<GraphNodeModel["run"]>, ctx: ActionContext): DisabledCode | null | undefined {
  if (run.endReason !== "completed") return undefined;
  if (ctx.superseded?.has(run.id)) return "superseded";
  return ctx.taskCancelled ? "task_cancelled" : null;
}

/** Each step's newest run when it failed: what Retry failed steps retries, one runs.retry each. */
export function failedRuns(task: TaskDetail): RunView[] {
  return (task.crew?.members ?? []).flatMap((m) => {
    const run = latestRun(task.runs, m.id);
    return run?.endReason === "failed" ? [run] : [];
  });
}

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
