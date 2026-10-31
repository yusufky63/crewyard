import type {
  FrozenBecause,
  GoalDecisionAction,
  GoalDecisionKind,
  GoalDepSource,
  GoalNeedsReason,
  GoalOutcome,
  GoalPlanCause,
  GoalPlanTask,
  GoalPriority,
  GoalStatus,
  GoalUnmet,
  OverlapEdge,
  PlanDiff,
  PlanState,
} from "../goals.ts";
import type { TaskStatus } from "../state.ts";
import type { CandidateView, CostEstimate, Reason, TaskKind, TaskMode, TaskSize } from "./tasks.ts";

// IPC methods for Orchestra goals (docs/adr/0019). Implemented in
// packages/daemon/src/handlers/goals.ts. A goal is your text, a plan written by one read-only
// planning run, and ordinary tasks released by the daemon in dependency order after one approval.
//
// Errors carry a code as their message ("goal.not_found", "goal.cycle"), with params in the daemon
// log; see GoalErrorCode. Every cost carries its provenance (Reported, Estimated or Unknown).
// Goal, plan and report text is untrusted: the renderer shows it as plain text.

export type GoalErrorCode =
  | "goal.disabled" // Orchestra is turned off in Settings: no new goals
  | "goal.not_found"
  | "goal.task_not_found" // { key } or { taskId }: not a task of this goal
  | "goal.text" // { error }: the goal text is empty or too long
  | "goal.no_planner" // no profile can plan read-only with structured output here
  | "goal.planner_unknown" // { profileId }: not a scored planner candidate
  | "goal.stopped" // the goal is stopped; nothing more changes
  | "goal.stale_revision" // { revision, latest }: a newer revision exists; re-read the goal
  | "goal.not_ready" // the revision has no plan to approve (still planning, or failed)
  | "goal.approved" // the revision is approved; changes go through Replan or Add task
  | "goal.not_approved" // the goal has no approved plan yet
  | "goal.revisions_used" // { max }: Revise is used up before approval
  | "goal.replans_used" // { max }: Replan is used up
  | "goal.too_many" // { max }: the goal has the most tasks it may have
  | "goal.invalid_task" // { error }: an edited or added task failed the plan checks
  | "goal.frozen" // { key, because }: done, running, released, joined or edited tasks cannot change
  | "goal.cycle" // { path }: the dependency would make a loop ("01 → 03 → 01")
  | "goal.no_accepted" // approve with no task accepted
  | "goal.skipped_dependency" // { task, dependsOn }: an accepted task waits for a skipped one
  | "goal.crew" // { task, code }: a task's crew fails validateCrew (code is a crew.* refusal)
  | "goal.bad_budget" // { field }: the goal budget, a typed task budget, or At once is out of bounds
  | "goal.needs_budget" // { task }: an Unknown estimate needs a budget typed on its tile
  | "goal.typed_over" // { typedTotalUsd, budgetUsd }: typed task budgets alone pass the goal budget
  | "goal.over_budget" // { totalUsd, budgetUsd }: the known total does not fit the goal budget
  | "goal.under_spent" // { spentUsd }: a lower goal budget than finished tasks already hold
  | "goal.decision_not_found"
  | "goal.decision_answered"
  | "goal.action" // { action, kind }: not an answer this decision offers
  | "goal.not_report" // the task writes something, or nothing writing waits for it
  | "goal.report_not_done" // the task has not finished; there is no report to accept yet
  | "goal.paused" // the goal is paused; resume it first
  | "goal.not_paused"
  | "goal.no_integration" // the goal has no branch (no writing task)
  | "goal.collapse_after_approval"; // Run as one task is only before approval

/** One plan task as the goal shows it: the plan's fields, its task, its share and why it waits. */
export interface GoalTaskView {
  taskId: string;
  key: string;
  /** 1-based place in the plan, shown as "01". */
  number: number;
  revision: number;
  title: string;
  kind: TaskKind;
  mode: TaskMode;
  size: TaskSize;
  priority: GoalPriority;
  description: string;
  acceptance: string[];
  basis: string;
  /** False shows "Not tied to your words" in amber; the plan is accepted either way. */
  basisMatched: boolean;
  reason: string;
  paths: string[];
  writes: boolean;
  edited: boolean;
  /** null until decided; false when you skipped it. */
  accepted: boolean | null;
  discarded: boolean;
  released: boolean;
  joined: { sha: string; at: string } | null;
  reportAcceptedAt: string | null;
  /** The task's derived status (deriveTaskStatus). */
  status: TaskStatus;
  dependsOn: Array<{ taskId: string; key: string; source: GoalDepSource }>;
  /** Unmet prerequisites with why, for "Waits for 01 to finish" and the stuck chain. */
  unmet: Array<{ taskId: string; why: GoalUnmet }>;
  /** Why it has not started, or null; a translatable `goal.*` reason. */
  hold: Reason | null;
  frozen: FrozenBecause | null;
  crewSteps: number;
  estimate: CostEstimate;
  /** Its share of the goal budget (its task budget); null before approval. */
  shareUsd: number | null;
  /** A budget you typed on the tile, for an Unknown estimate. */
  typedBudgetUsd: number | null;
  spend: CostEstimate;
}

export interface GoalRevisionView {
  id: string;
  revision: number;
  cause: GoalPlanCause;
  /** Your note to the planner (Revise, Replan), as you wrote it. */
  note: string | null;
  state: PlanState;
  /** Why planning failed: the parser's words or the provider's message, as plain text. */
  error: string | null;
  /** The planner's summary and assumptions; null until the plan arrives. */
  summary: string | null;
  planTaskId: string | null;
  /** Against the revision it replaces; null for the first. */
  diff: PlanDiff | null;
  /** Orderings the overlap check added, for the review's info lines. */
  overlaps: OverlapEdge[];
  planningSpend: CostEstimate;
  createdAt: string;
  approvedAt: string | null;
  supersededAt: string | null;
}

/** Facts a decision carries; every field is optional and shown as plain text. */
export interface GoalDecisionPayload {
  /** Conflicted files of a merge into the goal branch. */
  paths?: string[];
  /** A failure, the stop rule's failure key, or the provider's message. */
  detail?: string;
  /** Tasks that wait (prerequisite, stuck). */
  waiting?: string[];
  /** The last review's findings as text (changes). */
  findings?: string;
  /** The profile that went away since approval (profile_gone). */
  profileId?: string;
  /** Which part of the stop rule fired. */
  rule?: "same_failure" | "failed_tasks";
}

export interface GoalDecisionView {
  id: string;
  kind: GoalDecisionKind;
  taskId: string | null;
  payload: GoalDecisionPayload;
  /** The answers it offers, suggested first (GOAL_DECISION_ACTIONS). */
  actions: GoalDecisionAction[];
  createdAt: string;
  answeredAt: string | null;
  answer: GoalDecisionAction | null;
}

export interface GoalJoinView {
  id: string;
  taskId: string;
  beforeSha: string;
  afterSha: string | null;
  outcome: "joined" | "conflict";
  conflictPaths: string[];
  at: string;
}

export interface GoalSummary {
  id: string;
  projectId: string;
  title: string;
  status: GoalStatus;
  /** For `needs_you`: what needs you. */
  reason: GoalNeedsReason | null;
  /** For `finished`: Merged, Done, or collapsed into one task. */
  outcome: GoalOutcome | null;
  /** Finished accepted tasks of all accepted ones ("2 of 4"). */
  done: number;
  total: number;
  budgetUsd: number | null;
  /** Spend of the goal's tasks, planning included. */
  spend: CostEstimate;
  planningSpend: CostEstimate;
  /** `crewyard/goal/<words>-<id6>`; null for a goal with no writing task. */
  branch: string | null;
  paused: boolean;
  halted: { reason: string; at: string } | null;
  latestRevision: number;
  approvedRevision: number | null;
  integrationTaskId: string | null;
  collapsedTaskId: string | null;
  createdAt: string;
}

export interface GoalDetail extends GoalSummary {
  /** Your goal as you wrote it. */
  text: string;
  baseBranch: string | null;
  baseSha: string | null;
  maxParallel: number;
  maxTasks: number;
  plannerProfileId: string | null;
  revisions: GoalRevisionView[];
  /** Tasks of the latest revision and every task an approved revision released, in plan order. */
  tasks: GoalTaskView[];
  decisions: GoalDecisionView[];
  /** In the order they were merged into the goal branch. */
  joins: GoalJoinView[];
  revisionsLeft: number;
  replansLeft: number;
  /** The last review of all changes; null for a goal with no writing task. */
  integration: { taskId: string; status: TaskStatus; reviewPassed: boolean; estimate: CostEstimate; shareUsd: number | null } | null;
  /** For a stuck goal: the task that cannot start and the one it waits for. */
  stuck: { taskId: string; waitsFor: string; why: GoalUnmet } | null;
  /** The plan review's prefilled goal budget: max(project default, known total rounded up x 1.5). */
  suggestedBudgetUsd: number | null;
}

/** What `Plan goal` will cost and whether it can run, before any click (writes nothing). */
export interface GoalPreview {
  /** False when Orchestra is off or no profile can plan; `reason` says which. */
  canPlan: boolean;
  reason: Reason | null;
  planner: CandidateView | null;
  /** Every scored planner candidate, best first, for the planner chip. */
  candidates: CandidateView[];
  /** The planning run's estimate: `plan` for a sign-in, Unknown without a price. */
  estimate: CostEstimate;
  /** The planning run's own budget, the ceiling the composer states. */
  ceilingUsd: number | null;
  /** The classifier found a small-change keyword: the composer offers `Use Crew`. */
  smallHint: boolean;
  /** The first-goal card is due in this project. */
  introDue: boolean;
  /** The project's default goal budget, when set. */
  defaultBudgetUsd: number | null;
}

export interface GoalStopPreview {
  /** Tasks the stop cancels (released and unreleased, unfinished). */
  cancelTasks: number;
  runningRuns: number;
  spend: CostEstimate;
}

/** A task you add to a running goal, or the edits you make to a plan tile. Checked like a planned task. */
export interface GoalTaskDraft {
  title: string;
  kind: TaskKind;
  mode: TaskMode;
  size?: TaskSize;
  description?: string;
  acceptance?: string[];
  paths?: string[];
  priority?: GoalPriority;
}

export type GoalTaskPatch = Partial<Pick<GoalPlanTask, "title" | "kind" | "mode" | "size" | "description" | "acceptance" | "paths" | "priority">>;

export interface GoalsIpc {
  /** Newest first. Status is derived on read with deriveGoalStatus. */
  "goals.list": { params: { projectId: string }; result: GoalSummary[] };
  "goals.get": { params: { goalId: string }; result: GoalDetail };
  /** Orchestra's switches: `orchestra.enabled` and `Pause all goals`. */
  "goals.state": { params: void; result: { enabled: boolean; pausedAll: boolean } };
  /** The planner, its estimate and ceiling, the small-change hint and whether the first-goal card is due. Writes nothing. */
  "goals.preview": { params: { projectId: string; text: string; plannerProfileId?: string }; result: GoalPreview };
  /** The `Plan goal` click: stores the goal and starts its one read-only planning run. */
  "goals.create": {
    params: { projectId: string; text: string; plannerProfileId?: string; baseBranch?: string; attachments?: string[]; defaultBudgetUsd?: number };
    result: GoalDetail;
  };
  /** A new planning run with your note; edited tasks are frozen. Before approval, at most 5. */
  "goals.revise": { params: { goalId: string; revision: number; note: string }; result: GoalDetail };
  /** A new planning run after approval; done, running, released and joined tasks are frozen. At most 3. */
  "goals.replan": { params: { goalId: string; note?: string }; result: GoalDetail };
  /** A one-task revision you write, with no planner call; approved like a plan. `dependsOn` are task ids. */
  "goals.addTask": { params: { goalId: string; draft: GoalTaskDraft; dependsOn: string[] }; result: GoalDetail };
  /** Edits a tile of an unapproved revision; the task is then kept on Revise. */
  "goals.editTask": { params: { goalId: string; revision: number; key: string; patch: GoalTaskPatch }; result: GoalDetail };
  /** Adds or removes `taskKey` waiting for `dependsOnKey`. Removing an overlap ordering is "Run side by side anyway". */
  "goals.setDependency": { params: { goalId: string; revision: number; taskKey: string; dependsOnKey: string; on: boolean }; result: GoalDetail };
  /** `Approve and start`: idempotent per revision. `accept` are plan keys; `taskBudgets` are typed budgets by key. */
  "goals.approve": {
    params: { goalId: string; revision: number; accept: string[]; budgetUsd: number; maxParallel: number; taskBudgets?: Record<string, number> };
    result: GoalDetail;
  };
  /** `Run as one task`: the goal becomes one ordinary Crew task; only before approval. */
  "goals.collapse": { params: { goalId: string }; result: GoalDetail };
  /** You read a report a writing task builds on and pass it on. */
  "goals.acceptReport": { params: { goalId: string; taskId: string }; result: GoalDetail };
  /** Pauses running steps at their next turn boundary; no new goal task run starts. */
  "goals.pause": { params: { goalId: string }; result: GoalDetail };
  "goals.resume": { params: { goalId: string }; result: GoalDetail };
  "goals.stopPreview": { params: { goalId: string }; result: GoalStopPreview };
  /** Cancels every unfinished task of the goal. Worktrees and branches are kept. */
  "goals.stop": { params: { goalId: string }; result: GoalDetail };
  /** Raising the budget scales unfinished tasks' shares in the same proportion. */
  "goals.setLimits": { params: { goalId: string; budgetUsd?: number; maxParallel?: number }; result: GoalDetail };
  "goals.decide": { params: { goalId: string; decisionId: string; action: GoalDecisionAction }; result: GoalDetail };
  /** `Check again` on a conflicted merge. */
  "goals.checkMerge": { params: { goalId: string; taskId: string }; result: GoalDetail };
  /** The global kill switch; lifting it is your click too. */
  "goals.pauseAll": { params: { on: boolean }; result: { pausedAll: boolean } };
  /** The project's default goal budget (Settings → Project, and the first-goal card). */
  "goals.setProjectDefaults": { params: { projectId: string; budgetUsd: number }; result: { projectId: string; budgetUsd: number } };
}

export type GoalChangeCause =
  | "created"
  | "planning"
  | "planned"
  | "plan_failed"
  | "revised"
  | "edited"
  | "approved"
  | "collapsed"
  | "released"
  | "held"
  | "report_accepted"
  | "joined"
  | "conflict"
  | "decision"
  | "decided"
  | "limits"
  | "paused"
  | "resumed"
  | "halted"
  | "stopped"
  | "finished";

/** Pushed through the daemon's emit (context.emit is typed to TasksTopics); the renderer re-reads with goals.get. */
export interface GoalsTopics {
  "goals.changed": { goalId: string; projectId: string; status: GoalStatus; cause: GoalChangeCause };
}
