import { randomUUID } from "node:crypto";
import {
  ancestorsOf,
  capText,
  cleanText,
  applyPlanRevision,
  deriveGoalStatus,
  derivePlanState,
  estimateCost,
  frozenBecause,
  GOAL_LIMITS,
  GOAL_SETTINGS,
  goalBasisMatches,
  goalTitle,
  ORCHESTRA_ENABLED_DEFAULT,
  overlapPairs,
  parseGoalLimits,
  parseGoalNote,
  parseGoalPlan,
  parseGoalTask,
  parseGoalText,
  peakFactor,
  planningBudget,
  planRevisionRefusal,
  wouldCycle,
  type CandidateView,
  type CostEstimate,
  type DagNode,
  type EndReason,
  type FrozenBecause,
  type GoalChangeCause,
  type GoalDecisionKind,
  type GoalDepSource,
  type GoalPlan,
  type GoalPlanCause,
  type GoalPlanTask,
  type GoalPreview,
  type GoalPriority,
  type GoalState,
  type GoalTaskDraft,
  type GoalTaskFacts,
  type PlanDiff,
  type PlanRevisionFacts,
  type PlanState,
  type Reason,
  type RunView,
  type TaskDetail,
  type TaskMode,
  type TaskStatus,
  type TasksIpc,
} from "@crewyard/core";
import { detectProjectType } from "../../setup/detect.ts";
import type { OrchestratorContext, ProposeParams } from "../context.ts";
import { classifyTask } from "../classify.ts";
import { rankForRole } from "../crew.ts";
import type { MemberRow, ProjectRow, RunRow, TaskRow } from "../db.ts";
import type { Candidate } from "../directory.ts";
import { errorCode, OrchestratorError } from "../errors.ts";
import { resolveBase } from "../git.ts";
import { Part } from "../part.ts";
import type { RoleResult } from "../results.ts";
import { projectRoles } from "../role-files.ts";
import { GOAL_PLANNER } from "../roles.ts";
import { correctiveTurn, goalTaskDescription, goalTaskNumber, planningPrompt, waitsForLine, type FrozenTaskFacts, type PlanningPromptInput } from "./prompt.ts";

// The Orchestra planner (docs/adr/0019, design §4.3 to §4.5 and §4.10). Each plan revision is one
// hidden planning task: kind research, one step of the read-only goal-planner role, its own budget
// (the ceiling the composer states), approved by the click that showed its cost and then run like
// any other run (admission, spend caps, transcripts, recovery). Its result is checked here with
// parseGoalPlan; a refusal gets one corrective turn through Messages.followUp, started by the
// dispatcher under admission, and a second one fails the plan with the parser's words. A plan
// that passes becomes proposed tasks through TaskFlow.propose, each with its goal_tasks row
// written in the same transaction, so a goal task is never visible or approvable without it.
// Nothing here approves a goal task or starts one: the goal scheduler releases them after you
// approve the plan (GoalRunner); a plan of one task is approved only once it is an ordinary task
// (approveOneTask). After approval, a new revision changes nothing of the running plan until you
// approve it too (applyReplacements). Statuses are derived (D5): a revision reads planning,
// failed or ready from its planning task's runs and its facts.

export interface GoalPlannerDeps {
  /** TaskFlow.propose: classify, draft a crew, no process; `inTx` runs in the task's own transaction. */
  propose(p: ProposeParams, hooks?: { inTx?: (taskId: string) => void }): Promise<TaskDetail>;
  /** TaskFlow.cancel: stops the planning run when you collapse a goal mid-planning. */
  cancel(taskId: string): Promise<TaskDetail>;
  /** Messages.followUp: the corrective turn, a new run of the same member, natively resumed. */
  followUp(runId: string, text: string): Promise<RunView>;
  /** TaskFlow.approve: a one-task plan's approval, once it is an ordinary task (design §1.2). */
  approve(p: TasksIpc["tasks.approve"]["params"]): Promise<TaskDetail>;
  /** TaskFlow.get. */
  get(taskId: string): TaskDetail;
  tick(): Promise<void>;
}

/** The dispatcher's admission check (D7 slots, memory, spend held by other runs) for one step. */
export type AdmitStep = (task: TaskRow, member: MemberRow, profileId: string) => Promise<Reason | null>;

/** What approving a revision replaces (design §4.10): never-started tasks it discards, and started ones that block it. */
export interface GoalReplacements {
  discard: string[];
  started: Array<{ key: string; taskId: string; because: FrozenBecause }>;
}

/** `Plan goal`'s parameters. `by: "autopilot"` is Autopilot's create_goal, which changes none of your settings. */
export interface GoalCreateParams {
  projectId: string;
  text: string;
  plannerProfileId?: string;
  baseBranch?: string;
  attachments?: string[];
  defaultBudgetUsd?: number;
  by?: "person" | "autopilot";
}

/** What a planning click returns; the goal view is built from the store (handlers/goals.ts). */
export interface GoalPlanStart {
  goalId: string;
  revision: number;
  /** The hidden planning task; null for an `Add task` revision, which has no planner. */
  planTaskId: string | null;
  /** The task an `Add task` revision or a collapse produced. */
  taskId?: string;
}

interface GoalRow {
  id: string;
  project_id: string;
  text: string;
  title: string;
  base_branch: string | null;
  base_sha: string | null;
  budget_usd: number | null;
  max_parallel: number;
  max_tasks: number;
  planner_profile_id: string | null;
  integration_task_id: string | null;
  collapsed_task_id: string | null;
  approved_revision: number | null;
  approved_at: string | null;
  paused_at: string | null;
  stopped_at: string | null;
  halted_reason: string | null;
  halted_at: string | null;
  replans_used: number;
  revisions_used: number;
  created_at: string;
}

interface PlanRow {
  id: string;
  goal_id: string;
  revision: number;
  cause: GoalPlanCause;
  note: string | null;
  plan_task_id: string | null;
  plan: string | null;
  error: string | null;
  superseded_at: string | null;
  approved_at: string | null;
  created_at: string;
}

interface GoalTaskRow {
  task_id: string;
  goal_id: string;
  plan_id: string;
  key: string;
  position: number;
  mode: TaskMode;
  priority: GoalPriority;
  basis: string;
  basis_matched: number;
  reason: string;
  paths: string;
  writes: number;
  edited: number;
  accepted: number | null;
  discarded_at: string | null;
  released_at: string | null;
  joined_sha: string | null;
  joined_at: string | null;
  report_accepted_at: string | null;
}

/** A live goal task as a revision sees it: its plan entry, and why it may not change, if it may not. */
interface BaseTask {
  row: GoalTaskRow;
  task: GoalPlanTask;
  status: TaskStatus;
  frozen: FrozenBecause | null;
}

/**
 * The plan a revision is checked against: one live task per key. A key can be held twice after
 * approval, by an approved task and by the newer, unapproved revision's replacement for it; the
 * base then takes the frozen one, else the newer one. The other is `shadowed`.
 */
interface RevisionBase {
  base: BaseTask[];
  shadowed: GoalTaskRow[];
}

const STEP = GOAL_PLANNER.id;
/** How often a plan's tasks are drafted again when the goal's tasks change underneath the drafting. */
const MATERIALISE_ATTEMPTS = 3;

export class GoalPlanner extends Part {
  /**
   * Corrective turns waiting for an admission slot, by planning task. Kept in memory only: after a
   * restart the revision reads failed with the stored refusal, and Retry planning is your click.
   */
  private readonly corrective = new Map<string, { runId: string; error: string }>();

  constructor(
    ctx: OrchestratorContext,
    private readonly deps: GoalPlannerDeps,
  ) {
    super(ctx);
  }

  // ---------------------------------------------------------------- before the click

  /** Orchestra's switch; a missing row reads as the shipped default (design §6.5). */
  enabled(): boolean {
    const v = this.setting(GOAL_SETTINGS.enabled);
    return typeof v === "boolean" ? v : ORCHESTRA_ENABLED_DEFAULT;
  }

  /**
   * Settings → Orchestra. Writing the row makes your choice outlive a later change of the shipped
   * default. Only new goals are affected: an approved goal's waiting tasks still wait for the goal
   * scheduler, so turning Orchestra off never lets them start out of order.
   */
  setEnabled(on: boolean): boolean {
    this.writeSetting(GOAL_SETTINGS.enabled, on);
    return this.enabled();
  }

  /**
   * What `Plan goal` would cost and whether it can run: the planner candidates, the estimate and
   * its ceiling, the small-change hint and whether the first-goal card is due. Writes nothing.
   */
  async preview(p: { projectId: string; text: string; plannerProfileId?: string }): Promise<GoalPreview> {
    const project = this.db.project(p.projectId);
    const enabled = this.enabled();
    const pin = p.plannerProfileId ?? this.rememberedPlanner(project.id);
    const { views, all } = await this.plannerChoice(project, pin);
    const planner = views.find((v) => v.profileId === pin) ?? views[0] ?? null;
    const billed = planner ? all.find((c) => c.profile.id === planner.profileId) : undefined;
    const estimate: CostEstimate = planner?.estimate ?? { usd: null, provenance: "unknown" };
    const reason: Reason | null = !enabled ? { code: "goal.disabled" } : !planner ? { code: "goal.no_planner" } : null;
    const budget = this.setting(GOAL_SETTINGS.goalBudget(project.id));
    return {
      canPlan: reason === null,
      reason,
      planner,
      candidates: views,
      estimate,
      billing: billed ? billingOf(billed) : null,
      ceilingUsd: planner ? this.planningCeiling(project, estimate) : null,
      smallHint: smallChange(p.text),
      introDue: this.setting(GOAL_SETTINGS.introduced(project.id)) === null,
      defaultBudgetUsd: typeof budget === "number" && budget > 0 ? budget : null,
    };
  }

  // ---------------------------------------------------------------- the planning clicks

  /**
   * `Plan goal`: stores the goal and its first revision and approves its one read-only planning
   * run, whose cost the button showed. The scheduler starts it under admission control.
   */
  async create(p: GoalCreateParams): Promise<GoalPlanStart> {
    if (!this.enabled()) throw new OrchestratorError("goal.disabled");
    const project = this.db.project(p.projectId);
    const text = parseGoalText(p.text);
    if (!text.ok) throw new OrchestratorError("goal.text", { error: text.error });
    const limits = parseGoalLimits({ budgetUsd: p.defaultBudgetUsd });
    if (!limits.ok) throw new OrchestratorError("goal.bad_budget", { field: "defaultBudgetUsd" });
    const attachmentIds = [...(p.attachments ?? [])];
    this.attachments.check(attachmentIds);
    // Your pick on the chip is checked strictly; the one remembered from an earlier pick only leads while it can still plan.
    const choice = await this.pickPlanner(project, p.plannerProfileId ?? this.rememberedPlanner(project.id), Boolean(p.plannerProfileId));
    const baseBranch = p.baseBranch?.trim() ? p.baseBranch.trim() : null;
    const baseSha = await this.baseShaOf(project, baseBranch);
    const goalId = randomUUID();
    const at = this.iso();
    const goal: GoalRow = {
      id: goalId,
      project_id: project.id,
      text: text.value,
      title: goalTitle(text.value),
      base_branch: baseBranch,
      base_sha: baseSha,
      budget_usd: null,
      max_parallel: GOAL_LIMITS.maxParallel,
      max_tasks: GOAL_LIMITS.maxTasks,
      planner_profile_id: choice.chosen.profileId,
      integration_task_id: null,
      collapsed_task_id: null,
      approved_revision: null,
      approved_at: null,
      paused_at: null,
      stopped_at: null,
      halted_reason: null,
      halted_at: null,
      replans_used: 0,
      revisions_used: 0,
      created_at: at,
    };
    const prompt = this.promptFor(goal, project, null);
    const planTaskId = this.db.tx(() => {
      this.db.exec(
        `insert into goals (id, project_id, text, title, base_branch, base_sha, max_parallel, max_tasks, planner_profile_id, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        goal.id,
        goal.project_id,
        goal.text,
        goal.title,
        goal.base_branch,
        goal.base_sha,
        goal.max_parallel,
        goal.max_tasks,
        goal.planner_profile_id,
        at,
      );
      return this.insertRevision(goal, 1, "initial", null, choice, prompt, at);
    });
    if (attachmentIds.length > 0) {
      this.attachments.claim(attachmentIds, planTaskId, null);
      // The files have their paths only now; the prompt names them, as design §4.4 asks.
      this.db.exec("update tasks set description = ? where id = ?", this.promptFor(goal, project, null), planTaskId);
    }
    // Your settings change only on your click. A goal Autopilot creates (docs/adr/0022) leaves the
    // first-goal card due for your own first goal and your remembered planner as you picked it.
    if (p.by !== "autopilot") {
      // The first-goal card's click is this one: its budget becomes the project default, and the card is done.
      if (limits.value.budgetUsd !== undefined) this.writeSetting(GOAL_SETTINGS.goalBudget(project.id), limits.value.budgetUsd);
      this.writeSetting(GOAL_SETTINGS.introduced(project.id), true);
      // You picked this planner on the chip: remembered per project (design §4.4), and pinned from now on.
      if (p.plannerProfileId) this.writeSetting(GOAL_SETTINGS.planner(project.id), p.plannerProfileId);
    }
    this.goalEvent(goal, "goal.created", { title: goal.title, baseBranch, baseSha, plannerProfileId: choice.chosen.profileId, ...(p.by === "autopilot" ? { by: "autopilot" } : {}) });
    this.planningStarted(goal, 1, "initial", planTaskId, choice.chosen);
    this.emitGoal(goal.id, "created");
    await this.deps.tick();
    return { goalId, revision: 1, planTaskId };
  }

  /** `Revise` before approval: a new paid planning run with your note; tasks you edited are frozen. */
  async revise(goalId: string, revision: number, note: string): Promise<GoalPlanStart> {
    const goal = this.goal(goalId);
    this.assertOpen(goal);
    const latest = this.latestRevision(goalId);
    if (latest.revision !== revision) throw new OrchestratorError("goal.stale_revision", { revision, latest: latest.revision });
    if (this.planState(latest) === "planning") throw new OrchestratorError("goal.not_ready", { revision });
    this.assertRevision("revise", goal);
    const n = parseGoalNote(note);
    if (!n.ok) throw new OrchestratorError("goal.text", { error: n.error });
    return this.startRevision(goal, latest.revision, "revise", n.value);
  }

  /** `Replan` after approval: done, running, released, joined and edited tasks are frozen. */
  async replan(goalId: string, note?: string): Promise<GoalPlanStart> {
    const goal = this.goal(goalId);
    this.assertOpen(goal);
    const latest = this.latestRevision(goalId);
    if (this.planState(latest) === "planning") throw new OrchestratorError("goal.not_ready", { revision: latest.revision });
    this.assertRevision("replan", goal);
    const n = parseGoalNote(note);
    if (!n.ok) throw new OrchestratorError("goal.text", { error: n.error });
    return this.startRevision(goal, latest.revision, "replan", n.value);
  }

  /**
   * `Add task`: a one-task revision you write, with no planner call, approved like a plan. Only
   * after the plan is approved, and not while a newer plan waits for you or is being written.
   * `dependsOn` are task ids of the goal's live tasks; it does not count as a replan.
   */
  async addTask(goalId: string, draft: GoalTaskDraft, dependsOn: string[]): Promise<GoalPlanStart> {
    const goal = this.goal(goalId);
    this.assertOpen(goal);
    if (goal.approved_revision === null) throw new OrchestratorError("goal.not_approved");
    const latest = this.latestRevision(goalId);
    const state = this.planState(latest);
    if (state === "planning" || state === "ready") throw new OrchestratorError("goal.not_ready", { revision: latest.revision });
    const live = this.liveRows(goalId).filter((r) => r.accepted !== 0 && !this.db.task(r.task_id).cancelled_at);
    this.assertRevision("add", goal, live.length);
    const keys = new Set(this.liveRows(goalId).map((r) => r.key));
    let k = live.length + 1;
    while (keys.has(`added-${k}`)) k++;
    const key = `added-${k}`;
    // IPC params are not checked at runtime: only the draft's own fields reach the parser.
    const fields: Record<string, unknown> = { key, title: draft.title, kind: draft.kind, mode: draft.mode, dependsOn: [] };
    for (const f of ["size", "description", "acceptance", "paths", "priority"] as const) if (draft[f] !== undefined) fields[f] = draft[f];
    const parsed = parseGoalTask(fields, keys, "task", { origin: "user" });
    if (!parsed.ok) throw new OrchestratorError("goal.invalid_task", { error: parsed.error });
    const t = parsed.value;
    const byId = new Map(live.map((r) => [r.task_id, r]));
    const waits = [...new Set(dependsOn)];
    for (const id of waits) if (!byId.has(id)) throw new OrchestratorError("goal.task_not_found", { taskId: id });
    const plan: GoalPlan = { summary: "", tasks: [{ ...t, dependsOn: waits.map((id) => byId.get(id)!.key) }] };
    const planId = randomUUID();
    let revision = 0;
    const at = this.iso();
    const detail = await this.deps.propose(
      { projectId: goal.project_id, title: t.title, description: goalTaskDescription(t), kind: t.kind, size: t.size, mode: t.mode, ...(goal.base_branch ? { baseBranch: goal.base_branch } : {}) },
      {
        inTx: (taskId) => {
          // Read again inside the task's transaction: a stop, a collapse or another revision may have landed meanwhile.
          const now = this.goal(goalId);
          this.assertOpen(now);
          const top = this.latestRevision(goalId);
          if (top.id !== latest.id) throw new OrchestratorError("goal.stale_revision", { revision: latest.revision, latest: top.revision });
          revision = top.revision + 1;
          this.db.exec("insert into goal_plans (id, goal_id, revision, cause, plan_task_id, plan, created_at) values (?, ?, ?, 'add', null, ?, ?)", planId, goalId, revision, JSON.stringify(plan), at);
          const position = Math.max(-1, ...this.liveRows(goalId).map((r) => r.position)) + 1;
          // You wrote it, so it rests on your words by definition; the soft basis check is for the planner.
          this.insertGoalTask(goalId, planId, taskId, t, position, true);
          for (const id of waits) this.db.exec("insert or ignore into goal_task_deps (goal_id, task_id, depends_on, source) values (?, ?, ?, 'user')", goalId, taskId, id);
          const graph = this.liveRows(goalId).map((r) => ({ id: r.task_id, dependsOn: this.depsOf(r.task_id).map((d) => d.on) }));
          for (const d of waits) {
            const loop = wouldCycle(graph, taskId, d);
            if (loop) throw new OrchestratorError("goal.cycle", { path: loop.join(" → ") });
          }
          // Only the new task is ordered after others: a task already running never gains a prerequisite.
          const edges = overlapPairs(this.overlapInput(goalId)).filter((e) => e.taskId === taskId);
          for (const e of edges) this.db.exec("insert or ignore into goal_task_deps (goal_id, task_id, depends_on, source) values (?, ?, ?, 'overlap')", goalId, e.taskId, e.dependsOn);
          this.setWaitsFor(taskId);
        },
      },
    );
    this.goalEvent(goal, "goal.revised", { cause: "add", revision, key, taskId: detail.id, dependsOn: waits });
    this.goalEvent(goal, "goal.planned", { revision, cause: "add", tasks: 1, added: [key] });
    this.emitGoal(goalId, "planned");
    return { goalId, revision, planTaskId: null, taskId: detail.id };
  }

  /**
   * `Run as one task`, only before approval: a plan of one task becomes that ordinary task (its
   * goal_tasks row goes, so it starts through the normal crew review); anything else becomes one
   * new Crew task from your goal text, and the plan's proposals are discarded. A planning run in
   * flight is stopped. The goal keeps your text and the planning spend (collapsed_task_id).
   */
  async collapse(goalId: string): Promise<GoalPlanStart> {
    const goal = this.goal(goalId);
    if (goal.collapsed_task_id) return { goalId, revision: this.latestRevision(goalId).revision, planTaskId: null, taskId: goal.collapsed_task_id };
    this.assertOpen(goal);
    if (goal.approved_revision !== null) throw new OrchestratorError("goal.collapse_after_approval");
    const latest = this.latestRevision(goalId);
    const live = this.liveRows(goalId);
    if (this.planState(latest) === "ready" && live.length === 1 && live[0]!.plan_id === latest.id) {
      const only = live[0]!;
      this.db.tx(() => {
        this.assertCollapsible(goalId);
        this.db.exec("delete from goal_task_deps where task_id = ? or depends_on = ?", only.task_id, only.task_id);
        this.db.exec("delete from goal_tasks where task_id = ?", only.task_id);
        this.db.exec("update goals set collapsed_task_id = ? where id = ?", only.task_id, goalId);
      });
      this.goalEvent(goal, "goal.collapsed", { revision: latest.revision, taskId: only.task_id, from: "one_task_plan" });
      this.emitTask(only.task_id, "edited");
      this.emitGoal(goalId, "collapsed");
      return { goalId, revision: latest.revision, planTaskId: null, taskId: only.task_id };
    }
    if (latest.plan_task_id && this.planState(latest) === "planning") await this.deps.cancel(latest.plan_task_id);
    const detail = await this.deps.propose(
      { projectId: goal.project_id, title: goal.title, description: goal.text, mode: "crew", ...(goal.base_branch ? { baseBranch: goal.base_branch } : {}) },
      {
        inTx: (taskId) => {
          this.assertCollapsible(goalId);
          this.discard(this.liveRows(goalId).map((r) => r.task_id));
          this.db.exec("update goals set collapsed_task_id = ? where id = ?", taskId, goalId);
        },
      },
    );
    for (const r of this.goalRows(goalId).filter((r) => r.discarded_at)) this.emitTask(r.task_id, "cancelled");
    this.goalEvent(goal, "goal.collapsed", { revision: latest.revision, taskId: detail.id, from: "goal_text" });
    this.emitGoal(goalId, "collapsed");
    return { goalId, revision: latest.revision, planTaskId: null, taskId: detail.id };
  }

  /**
   * `Approve and start` on a plan of one task (design §1.2, §3.2): one click makes it an ordinary
   * task (no goal_tasks row, no goal branch, the per-task PR flow) and approves its crew through
   * TaskFlow.approve, the crew the review showed. GoalRunner's goals.approve calls this when the
   * revision it approves holds exactly one task. A repeated click returns the task unchanged.
   */
  async approveOneTask(goalId: string, revision: number, params: Omit<TasksIpc["tasks.approve"]["params"], "taskId"> = {}): Promise<TaskDetail> {
    const goal = this.goal(goalId);
    if (goal.collapsed_task_id) {
      const crew = this.db.crew(goal.collapsed_task_id);
      if (crew?.approved_at) return this.deps.get(goal.collapsed_task_id);
      // Collapsed but unapproved: `Run as one task` moved it to the normal crew review, where it
      // may have changed since. A plan click never approves what that review has not shown.
      throw new OrchestratorError("goal.not_ready", { revision });
    } else {
      this.assertOpen(goal);
      if (goal.approved_revision !== null) throw new OrchestratorError("goal.approved");
      const latest = this.latestRevision(goalId);
      if (latest.revision !== revision) throw new OrchestratorError("goal.stale_revision", { revision, latest: latest.revision });
      if (this.planState(latest) !== "ready") throw new OrchestratorError("goal.not_ready", { revision });
      const live = this.liveRows(goalId);
      if (live.length !== 1 || live[0]!.plan_id !== latest.id) throw new OrchestratorError("goal.not_one_task", { tasks: live.length });
    }
    // Collapse first: TaskFlow.approve refuses a task that still has its goal row.
    const res = await this.collapse(goalId);
    return this.deps.approve({ ...params, taskId: res.taskId! });
  }

  // ---------------------------------------------------------------- the planning run's end

  /**
   * Every end of a planning run (run-lifecycle.ts). A completed run's result is checked; a refusal
   * gets one corrective turn and then fails with the parser's words; a plan that passes is stored
   * and materialised. Any other end leaves the revision reading failed (derived), and nothing is
   * relaunched by itself: the goal offers Retry planning.
   */
  async planningEnded(runId: string, reason: EndReason, result: RoleResult | null): Promise<void> {
    const run = this.db.run(runId);
    const planRow = this.planOfTask(run.task_id);
    if (!planRow) return;
    const goal = this.goal(planRow.goal_id);
    if (!this.current(goal, planRow)) {
      this.goalEvent(goal, "goal.plan_ignored", { revision: planRow.revision, reason });
      return;
    }
    if (reason !== "completed") {
      this.goalEvent(goal, "goal.plan_failed", { revision: planRow.revision, reason, detail: run.end_detail });
      this.emitGoal(goal.id, "plan_failed");
      return;
    }
    if (!result || result.kind !== "goal_plan") {
      await this.refuse(goal, planRow, run, result?.kind === "invalid" ? result.error : "the runner returned no result");
      return;
    }
    const parsed = parseGoalPlan(result.value, { maxTasks: goal.max_tasks });
    if (!parsed.ok) {
      await this.refuse(goal, planRow, run, parsed.error);
      return;
    }
    await this.materialise(goal, planRow, run, parsed.value);
  }

  private async refuse(goal: GoalRow, planRow: PlanRow, run: RunRow, error: string): Promise<void> {
    // Stored at once: if the corrective turn cannot even start, the revision reads failed with why.
    this.db.exec("update goal_plans set error = ? where id = ?", error, planRow.id);
    const results = this.db.runs(planRow.plan_task_id!).filter((r) => r.end_reason === "completed").length;
    if (results <= GOAL_LIMITS.correctiveTurns) {
      this.goalEvent(goal, "goal.plan_refused", { revision: planRow.revision, error, corrective: true });
      // Queued, not launched from here: the dispatcher starts it at its next pass under admission
      // (D7 slots, memory, spend held), so the slot this run just freed is not handed out twice.
      // Until then the revision reads planning (planFacts).
      this.corrective.set(planRow.plan_task_id!, { runId: run.id, error });
      this.emitGoal(goal.id, "planning");
      await this.deps.tick();
      return;
    }
    this.goalEvent(goal, "goal.plan_failed", { revision: planRow.revision, error });
    this.emitGoal(goal.id, "plan_failed");
  }

  /**
   * The dispatcher's hook at the start of each pass: queued corrective turns start once admission
   * lets them, as a native resume of the refused run's session. A turn whose revision no longer
   * matters (stopped, collapsed, cancelled, superseded) is dropped.
   */
  async correctiveTurns(admit: AdmitStep): Promise<void> {
    for (const [taskId, turn] of [...this.corrective]) {
      const planRow = this.planOfTask(taskId);
      const goal = planRow ? this.goal(planRow.goal_id) : null;
      if (!planRow || !goal || !this.current(goal, planRow) || this.db.task(taskId).cancelled_at) {
        this.corrective.delete(taskId);
        continue;
      }
      // A paused goal, or Pause all goals, keeps the turn queued: it is a paid run the daemon would
      // start by itself, and the kill switch stops every goal's spend (design §5.2).
      if (goal.paused_at || this.pausedAll()) continue;
      const run = this.db.run(turn.runId);
      if (await admit(this.db.task(taskId), this.db.member(run.member_id), run.profile_id)) continue;
      this.corrective.delete(taskId);
      try {
        await this.deps.followUp(run.id, correctiveTurn(turn.error));
      } catch (err) {
        this.goalEvent(goal, "goal.plan_failed", { revision: planRow.revision, error: turn.error, code: errorCode(err) });
        this.emitGoal(goal.id, "plan_failed");
      }
    }
  }

  /**
   * A checked plan becomes proposed tasks, drafted against the goal's tasks as they are now. If
   * those change while the drafting awaits (a task released, edited or started), the drafts are
   * dropped and the plan is drafted again against the new state, a few times at most; a plan that
   * now changes or removes a frozen task is refused like any other.
   */
  private async materialise(goal: GoalRow, planRow: PlanRow, run: RunRow, plan: GoalPlan): Promise<void> {
    for (let attempt = 0; attempt < MATERIALISE_ATTEMPTS; attempt++) {
      const state = this.revisionBase(goal.id);
      const checked = applyPlanRevision(
        state.base.map((b) => ({ task: b.task, frozen: b.frozen })),
        plan,
      );
      if (!checked.ok) {
        await this.refuse(goal, planRow, run, checked.error);
        return;
      }
      const outcome = await this.draftAndApply(goal, planRow, plan, state, checked.diff);
      if (outcome !== "moved") return;
    }
    const error = "the goal's tasks kept changing while the plan's tasks were created";
    this.db.exec("update goal_plans set error = ? where id = ?", error, planRow.id);
    this.goalEvent(goal, "goal.plan_failed", { revision: planRow.revision, error });
    this.emitGoal(goal.id, "plan_failed");
  }

  /**
   * One drafting pass. Frozen tasks are kept as they are; every other planned task becomes a new
   * proposal. The plan JSON is written last, in one transaction with the discards, the
   * dependencies and the automatic overlap ordering, so a revision reads ready only once whole.
   * That transaction first checks that the goal's tasks are still what the drafts were made from.
   *
   * What is discarded at arrival is only what was never approved, so cancelling it stops nothing.
   * After approval, the approved plan keeps running until you approve the new revision: its
   * tasks stay live and on their own revision, and approving the new one discards the tasks it
   * replaces (applyReplacements, from goals.approve). Before approval, a frozen (edited) task moves
   * into the new revision, since goals.approve accepts only the tasks of the revision it approves.
   */
  private async draftAndApply(goal: GoalRow, planRow: PlanRow, plan: GoalPlan, state: RevisionBase, diff: PlanDiff): Promise<"applied" | "superseded" | "moved" | "failed"> {
    const signature = this.baseSignature(goal.id, state);
    const frozen = new Map(state.base.filter((b) => b.frozen).map((b) => [b.task.key, b]));
    const created: Array<{ key: string; taskId: string }> = [];
    try {
      for (const [i, t] of plan.tasks.entries()) {
        if (frozen.has(t.key)) continue;
        const detail = await this.deps.propose(
          { projectId: goal.project_id, title: t.title, description: goalTaskDescription(t), kind: t.kind, size: t.size, mode: t.mode, ...(goal.base_branch ? { baseBranch: goal.base_branch } : {}) },
          { inTx: (taskId) => this.insertGoalTask(goal.id, planRow.id, taskId, t, i, goalBasisMatches(t.basis, goal.text)) },
        );
        created.push({ key: t.key, taskId: detail.id });
      }
    } catch (err) {
      this.dropCreated(created.map((c) => c.taskId));
      const error = `the plan's tasks could not be created (${errorCode(err)})`;
      this.db.exec("update goal_plans set error = ? where id = ?", error, planRow.id);
      this.goalEvent(goal, "goal.plan_failed", { revision: planRow.revision, error });
      this.emitGoal(goal.id, "plan_failed");
      return "failed";
    }
    const at = this.iso();
    const ids = new Map<string, string>([...created.map((c) => [c.key, c.taskId] as const), ...[...frozen.values()].map((b) => [b.task.key, b.row.task_id] as const)]);
    // Never approved: nothing ran, so discarding stops nothing. An approved task waits for the new revision's approval.
    const discarded = [...state.base.filter((b) => !b.frozen).map((b) => b.row), ...state.shadowed].filter((r) => r.accepted !== 1).map((r) => r.task_id);
    const moved = [...frozen.values()].filter((b) => b.row.accepted !== 1);
    const stayed = new Set([...frozen.values()].map((b) => b.row.task_id));
    const rebuilt = new Set([...created.map((c) => c.taskId), ...moved.map((b) => b.row.task_id)]);
    let outcome: "applied" | "superseded" | "moved";
    try {
      outcome = this.db.tx(() => {
        // Read again: a stop, a collapse or a newer revision while the tasks were drafted wins,
        // and so does any change to the tasks the drafts were made against.
        if (!this.current(this.goal(goal.id), this.planRowById(planRow.id))) return "superseded" as const;
        // The drafts themselves are rows of this revision by now; they are not what they were drafted against.
        if (this.baseSignature(goal.id, this.revisionBase(goal.id, planRow.id)) !== signature) return "moved" as const;
        this.db.exec("update goal_plans set plan = ?, error = null where id = ?", JSON.stringify(plan), planRow.id);
        this.db.exec("update goal_plans set superseded_at = ? where goal_id = ? and revision < ? and superseded_at is null and approved_at is null", at, goal.id, planRow.revision);
        this.discard(discarded);
        for (const b of moved) this.db.exec("update goal_tasks set plan_id = ?, position = ? where task_id = ?", planRow.id, plan.tasks.findIndex((t) => t.key === b.task.key), b.row.task_id);
        this.writeDeps(goal.id, plan, ids, rebuilt, stayed);
        for (const id of rebuilt) this.setWaitsFor(id);
        return "applied" as const;
      });
    } catch {
      // discard() refused a task that started after all: the same as a change underneath.
      outcome = "moved";
    }
    if (outcome !== "applied") {
      this.dropCreated(created.map((c) => c.taskId));
      if (outcome === "superseded") this.goalEvent(goal, "goal.plan_ignored", { revision: planRow.revision, reason: "superseded" });
      return outcome;
    }
    for (const id of discarded) {
      this.audit(id, null, "task.cancelled", { by: "goal", goalId: goal.id, revision: planRow.revision });
      this.emitTask(id, "cancelled");
    }
    const overlaps = Number((this.opts.store.db.prepare("select count(*) as n from goal_task_deps where goal_id = ? and source = 'overlap'").get(goal.id) as { n: number }).n);
    this.goalEvent(goal, "goal.planned", { revision: planRow.revision, cause: planRow.cause, tasks: plan.tasks.length, ...diff, overlaps });
    this.emitGoal(goal.id, "planned");
    return "applied";
  }

  /** What the drafts depend on: which tasks are live, their revision, approval and whether they are frozen. */
  private baseSignature(goalId: string, state: RevisionBase): string {
    const goal = this.goal(goalId);
    const parts = state.base.map((b) => `${b.row.task_id}:${b.row.plan_id}:${b.row.accepted ?? "-"}:${b.frozen ?? "-"}`);
    parts.push(...state.shadowed.map((r) => `${r.task_id}:${r.plan_id}:${r.accepted ?? "-"}:shadowed`));
    return `${goal.approved_revision ?? "-"}|${parts.sort().join(",")}`;
  }

  /**
   * The revision's dependencies for the tasks it (re)built, by key: the plan's edges, your own
   * edges on tasks that moved in (remapped to the task that now holds their key, dropped if they
   * would close a loop), and the overlap ordering (design §4.8). A task the revision keeps on an
   * approved revision is left as it is; its edges change only when the revision is approved.
   */
  private writeDeps(goalId: string, plan: GoalPlan, ids: ReadonlyMap<string, string>, rebuilt: ReadonlySet<string>, stayed: ReadonlySet<string>): void {
    const members = new Set(ids.values());
    const keyOf = new Map(this.goalRows(goalId).map((r) => [r.task_id, r.key]));
    const userEdges: Array<{ task: string; on: string }> = [];
    for (const id of rebuilt) {
      if (!stayed.has(id)) continue;
      for (const d of this.depsOf(id)) {
        if (d.source !== "user") continue;
        const target = members.has(d.on) ? d.on : ids.get(keyOf.get(d.on) ?? "");
        if (target && target !== id) userEdges.push({ task: id, on: target });
      }
    }
    // Writing tasks that keep their task id through this revision and that nothing orders: only
    // "Run side by side anyway" leaves two overlapping writers unordered, so the overlap check
    // below keeps them so instead of ordering them again. Read before the old edges go.
    const carried = this.overlapInput(goalId).filter((t) => members.has(t.id) && t.writes && (stayed.has(t.id) || !rebuilt.has(t.id)));
    const before: DagNode[] = this.overlapInput(goalId).map((t) => ({ id: t.id, dependsOn: t.dependsOn }));
    const sideBySide: Array<[string, string]> = [];
    for (let i = 0; i < carried.length; i++)
      for (let j = i + 1; j < carried.length; j++) {
        const a = carried[i]!.id;
        const b = carried[j]!.id;
        if (!ancestorsOf(before, a).has(b) && !ancestorsOf(before, b).has(a)) sideBySide.push([a, b]);
      }
    const list = [...rebuilt];
    if (list.length > 0) {
      const marks = list.map(() => "?").join(", ");
      this.opts.store.db.prepare(`delete from goal_task_deps where task_id in (${marks})`).run(...list);
    }
    // Kept approved tasks bring their current edges, so a loop through them is seen too.
    const graph = new Map<string, string[]>([...members].map((id) => [id, rebuilt.has(id) ? [] : this.depsOf(id).map((d) => d.on)]));
    const add = (task: string, on: string, source: GoalDepSource) => {
      this.db.exec("insert or ignore into goal_task_deps (goal_id, task_id, depends_on, source) values (?, ?, ?, ?)", goalId, task, on, source);
      graph.get(task)!.push(on);
    };
    const loops = (task: string, on: string) => wouldCycle([...graph].map(([id, dependsOn]) => ({ id, dependsOn })), task, on) !== null;
    for (const t of plan.tasks) {
      const id = ids.get(t.key)!;
      if (!rebuilt.has(id)) continue;
      for (const d of t.dependsOn) add(id, ids.get(d)!, "plan");
    }
    for (const e of userEdges) if (!graph.get(e.task)!.includes(e.on) && !loops(e.task, e.on)) add(e.task, e.on, "user");
    // Tasks that stayed count as earlier, so what is new waits for them, never the other way round;
    // and only a task this revision built gains an ordering (a kept one is past drafting).
    const input = this.overlapInput(goalId)
      .filter((t) => members.has(t.id))
      .map((t) => (stayed.has(t.id) ? { ...t, position: t.position - GOAL_LIMITS.maxTasksHard } : t));
    for (const e of overlapPairs(input, { sideBySide })) {
      if (!rebuilt.has(e.taskId) || graph.get(e.taskId)!.includes(e.dependsOn) || loops(e.taskId, e.dependsOn)) continue;
      add(e.taskId, e.dependsOn, "overlap");
    }
  }

  // ---------------------------------------------------------------- approving a revision (for GoalRunner)

  /**
   * What approving `revision` replaces (design §4.10): the live tasks of earlier revisions whose
   * key the revision drops, or holds a new task for. The tasks it returned unchanged (frozen ones)
   * stay. A replaced task that started since the revision was planned is in `started`: approval is
   * refused rather than cancelling work in flight. An `Add task` revision replaces nothing.
   */
  replacements(goalId: string, revision: number): GoalReplacements {
    const out: GoalReplacements = { discard: [], started: [] };
    const target = this.planByRevision(goalId, revision);
    if (!target?.plan || target.cause === "add") return out;
    const planned = new Set((JSON.parse(target.plan) as GoalPlan).tasks.map((t) => t.key));
    const live = this.liveRows(goalId);
    const own = new Set(live.filter((r) => r.plan_id === target.id).map((r) => r.key));
    for (const r of live) {
      if (r.plan_id === target.id || r.accepted === 0) continue;
      if (planned.has(r.key) && !own.has(r.key)) continue;
      const because = this.startedFacts(r);
      if (because) out.started.push({ key: r.key, taskId: r.task_id, because });
      else out.discard.push(r.task_id);
    }
    return out;
  }

  /**
   * Inside goals.approve's transaction, before it accepts the revision's tasks: discards what the
   * revision replaces, points the kept tasks' edges at the tasks that now hold those keys, and
   * numbers the kept tasks as the revision does. Refuses with `goal.plan_moved` when a replaced
   * task has started meanwhile. Returns the discarded task ids, for the caller's notices.
   */
  applyReplacements(goalId: string, revision: number): string[] {
    const r = this.replacements(goalId, revision);
    if (r.started.length > 0) throw new OrchestratorError("goal.plan_moved", { keys: r.started.map((s) => s.key).join(", ") });
    const target = this.planByRevision(goalId, revision);
    if (!target?.plan || target.cause === "add") return [];
    const plan = JSON.parse(target.plan) as GoalPlan;
    const replaced = new Set(r.discard);
    const live = this.liveRows(goalId);
    const own = new Map(live.filter((x) => x.plan_id === target.id).map((x) => [x.key, x.task_id]));
    const keyOf = new Map(live.map((x) => [x.task_id, x.key]));
    const kept = live.filter((x) => x.plan_id !== target.id && x.accepted !== 0 && !replaced.has(x.task_id));
    const after = [...kept.map((x) => x.task_id), ...own.values()];
    const loops = (task: string, on: string) => wouldCycle(after.map((id) => ({ id, dependsOn: this.depsOf(id).map((d) => d.on).filter((x) => !replaced.has(x)) })), task, on) !== null;
    for (const k of kept) {
      for (const d of this.depsOf(k.task_id)) {
        if (!replaced.has(d.on)) continue;
        this.db.exec("delete from goal_task_deps where task_id = ? and depends_on = ?", k.task_id, d.on);
        const to = own.get(keyOf.get(d.on) ?? "");
        if (!to) continue;
        // A plan or user edge outranks an automatic ordering that would now run the other way.
        if (loops(k.task_id, to)) this.db.exec("delete from goal_task_deps where task_id = ? and depends_on = ? and source = 'overlap'", to, k.task_id);
        if (!loops(k.task_id, to)) this.db.exec("insert or ignore into goal_task_deps (goal_id, task_id, depends_on, source) values (?, ?, ?, ?)", goalId, k.task_id, to, d.source);
      }
    }
    this.discard(r.discard);
    for (const k of kept) {
      const i = plan.tasks.findIndex((t) => t.key === k.key);
      if (i >= 0) this.db.exec("update goal_tasks set position = ? where task_id = ?", i, k.task_id);
    }
    for (const id of after) this.setWaitsFor(id);
    for (const id of r.discard) this.audit(id, null, "task.cancelled", { by: "goal", goalId, revision });
    return r.discard;
  }

  // ---------------------------------------------------------------- status

  /** The goal's derived status (deriveGoalStatus over its facts), as goals.changed carries it. */
  state(goalId: string): GoalState {
    const goal = this.goal(goalId);
    const latest = this.latestRevisionOrNull(goalId);
    const rows = this.goalRows(goalId);
    const tasks = rows.map((r) => this.taskFacts(r));
    const decisions = this.opts.store.db.prepare("select kind, task_id from goal_decisions where goal_id = ? and answered_at is null").all(goalId) as Array<{ kind: GoalDecisionKind; task_id: string | null }>;
    const integration = goal.integration_task_id ? this.integrationFacts(goal.integration_task_id) : null;
    return deriveGoalStatus({
      stopped: goal.stopped_at !== null,
      paused: goal.paused_at !== null,
      pausedAll: this.pausedAll(),
      halted: goal.halted_at !== null,
      collapsed: goal.collapsed_task_id !== null,
      latestPlan: latest ? this.planState(latest) : null,
      openDecisions: decisions.map((d) => ({ kind: d.kind, taskId: d.task_id })),
      tasks,
      integration,
    });
  }

  /** A revision's state from its facts and its planning task's runs (derivePlanState). */
  planState(p: PlanRow): PlanState {
    return derivePlanState(this.planFacts(p));
  }

  private planFacts(p: PlanRow): PlanRevisionFacts {
    const task = p.plan_task_id ? this.db.task(p.plan_task_id) : null;
    return {
      hasPlan: p.plan !== null,
      error: p.error,
      supersededAt: p.superseded_at,
      approvedAt: p.approved_at,
      // A corrective turn waiting for its admission slot counts as a run still to finish.
      runs: task ? [...this.db.runs(task.id).map((r) => ({ endedAt: r.ended_at })), ...(this.corrective.has(task.id) ? [{ endedAt: null }] : [])] : null,
      taskCancelled: Boolean(task?.cancelled_at),
    };
  }

  private taskFacts(r: GoalTaskRow): GoalTaskFacts {
    return {
      id: r.task_id,
      label: goalTaskNumber(r.position),
      position: r.position,
      priority: r.priority,
      writes: r.writes === 1,
      accepted: r.accepted === null ? null : r.accepted === 1,
      discarded: r.discarded_at !== null,
      released: r.released_at !== null,
      joined: r.joined_sha !== null,
      reportAccepted: r.report_accepted_at !== null,
      status: this.db.status(this.db.task(r.task_id)),
      deps: this.depsOf(r.task_id),
    };
  }

  private integrationFacts(taskId: string): { status: TaskStatus; reviewPassed: boolean } {
    const task = this.db.task(taskId);
    const last = this.db.taskLoop(task).verdicts.at(-1);
    return { status: this.db.status(task), reviewPassed: last?.verdict === "pass" };
  }

  // ---------------------------------------------------------------- planning tasks

  private async startRevision(goal: GoalRow, after: number, cause: "revise" | "replan", note: string): Promise<GoalPlanStart> {
    const project = this.db.project(goal.project_id);
    const choice = await this.pickPlanner(project, goal.planner_profile_id, false);
    const prompt = this.promptFor(goal, project, { cause, note });
    const revision = after + 1;
    const at = this.iso();
    const planTaskId = this.db.tx(() => {
      // Read again: another click may have started a revision while the candidates were scored.
      const now = this.goal(goal.id);
      this.assertOpen(now);
      const top = this.latestRevision(goal.id);
      if (top.revision !== after) throw new OrchestratorError("goal.stale_revision", { revision: after, latest: top.revision });
      if (this.planState(top) === "planning") throw new OrchestratorError("goal.not_ready", { revision: after });
      this.assertRevision(cause, now);
      const id = this.insertRevision(now, revision, cause, note || null, choice, prompt, at);
      if (cause === "revise") this.db.exec("update goals set revisions_used = revisions_used + 1, planner_profile_id = ? where id = ?", choice.chosen.profileId, goal.id);
      else this.db.exec("update goals set replans_used = replans_used + 1, planner_profile_id = ? where id = ?", choice.chosen.profileId, goal.id);
      return id;
    });
    this.goalEvent(goal, "goal.revised", { cause, revision, note: note.length > 0 });
    this.planningStarted(goal, revision, cause, planTaskId, choice.chosen);
    this.emitGoal(goal.id, "revised");
    await this.deps.tick();
    return { goalId: goal.id, revision, planTaskId };
  }

  /**
   * Inside the caller's transaction: the revision row and its hidden planning task, whose one
   * crew step is approved by the click that showed its cost. The member keeps GOAL_PLANNER as its
   * role snapshot. The task's budget is the stated ceiling; reaching it pauses the run with the
   * normal budget Inbox item. Its fallback is Ask, so a limit never hands it off by itself.
   */
  private insertRevision(goal: GoalRow, revision: number, cause: Exclude<GoalPlanCause, "add">, note: string | null, choice: PlannerChoice, prompt: string, at: string): string {
    const project = this.db.project(goal.project_id);
    const taskId = randomUUID();
    const crewId = randomUUID();
    const memberId = randomUUID();
    const estimate = choice.chosen.estimate;
    this.db.exec(
      `insert into tasks (id, project_id, title, description, kind, size, base_branch, fallback, wait_reset_minutes, budget_usd, classification, created_at)
       values (?, ?, ?, ?, 'research', 'S', ?, 'ask', 20, ?, ?, ?)`,
      taskId,
      goal.project_id,
      `Plan: ${goal.title}`,
      prompt,
      goal.base_branch,
      this.planningCeiling(project, estimate),
      JSON.stringify([{ code: "classify.explicit", params: { kind: "research" } }]),
      at,
    );
    this.db.exec("insert into crews (id, task_id, proposed_at, approved_at, estimate_usd, estimate_provenance) values (?, ?, ?, ?, ?, ?)", crewId, taskId, at, at, estimate.usd, estimate.provenance);
    this.db.exec(
      `insert into crew_members (id, crew_id, position, step, role, depends_on, required, writes_code, chosen, standby, reasons)
       values (?, ?, 0, ?, ?, '[]', 1, 0, ?, ?, '[]')`,
      memberId,
      crewId,
      STEP,
      STEP,
      JSON.stringify(choice.chosen),
      JSON.stringify(choice.standby),
    );
    this.db.saveRoleTemplate(memberId, { template: GOAL_PLANNER, source: "builtin", path: null });
    this.db.exec("insert into goal_plans (id, goal_id, revision, cause, note, plan_task_id, created_at) values (?, ?, ?, ?, ?, ?, ?)", randomUUID(), goal.id, revision, cause, note, taskId, at);
    return taskId;
  }

  private planningStarted(goal: GoalRow, revision: number, cause: GoalPlanCause, planTaskId: string, chosen: CandidateView): void {
    this.audit(planTaskId, null, "task.proposed", { kind: "research", size: "S", mode: "solo", goalId: goal.id, planning: true, members: [{ role: STEP, profileId: chosen.profileId }] });
    this.audit(planTaskId, null, "task.approved", { by: "goal", goalId: goal.id, revision, edits: [] });
    this.emitTask(planTaskId, "approved");
    this.goalEvent(goal, "goal.planning_started", { revision, cause, planTaskId, profileId: chosen.profileId, model: chosen.model, estimate: chosen.estimate });
  }

  // ---------------------------------------------------------------- the planner profile

  /** The planning estimate: a fixed heuristic at the catalog price (design §4.4); a plan sign-in is $0. */
  estimateOf(c: Candidate): CostEstimate {
    if (c.profile.credential.kind !== "api_key") return { usd: 0, provenance: "estimated" };
    const usd = c.model ? estimateCost(c.model, GOAL_LIMITS.plannerTokensIn, GOAL_LIMITS.plannerTokensOut) : null;
    if (usd === null) return { usd: null, provenance: "unknown" };
    return { usd: Math.round(usd * peakFactor(c.peak, this.now()) * 10_000) / 10_000, provenance: "estimated" };
  }

  /**
   * The profiles that can plan here, best first: scored like a planner step (reasoning first),
   * only runners that enforce read-only. A paid model nobody can price is left out unless you
   * picked it on the chip, so the default never starts spend without a number.
   */
  private async plannerChoice(project: ProjectRow, pin: string | null): Promise<{ views: CandidateView[]; all: Candidate[] }> {
    const all = await this.candidates(project);
    const ctx = this.scoring(project.id, "S", null, pin ? { [STEP]: pin } : undefined);
    const byId = new Map(all.map((c) => [c.profile.id, c]));
    const views = rankForRole(all, GOAL_PLANNER, ctx, { models: new Set(), providers: new Set() })
      .map((v) => ({ ...v, estimate: this.estimateOf(byId.get(v.profileId)!) }))
      .filter((v) => v.profileId === pin || !(byId.get(v.profileId)!.profile.credential.kind === "api_key" && v.estimate.usd === null));
    return { views, all };
  }

  /** The planner a click uses: the one you picked (refused when it cannot plan), else the best. */
  private async pickPlanner(project: ProjectRow, pin: string | null, strict: boolean): Promise<PlannerChoice> {
    const { views } = await this.plannerChoice(project, pin);
    if (pin && strict && !views.some((v) => v.profileId === pin)) throw new OrchestratorError("goal.planner_unknown", { profileId: pin });
    const chosen = views.find((v) => v.profileId === pin) ?? views[0];
    if (!chosen) throw new OrchestratorError("goal.no_planner");
    return { chosen, standby: views.filter((v) => v.profileId !== chosen.profileId).slice(0, 2) };
  }

  /** The planning run's own budget: min(project per-task cap, max(3 x estimate, $0.25)). */
  private planningCeiling(project: ProjectRow, estimate: CostEstimate): number {
    const { config, fromFile } = this.config(project);
    // The same per-task cap a proposal gets (TaskFlow.propose): the project's, when it has a file.
    return planningBudget(estimate.usd, fromFile ? config.budget.perTaskUsd : null);
  }

  private async baseShaOf(project: ProjectRow, baseBranch: string | null): Promise<string | null> {
    if (baseBranch) return resolveBase(project.path, baseBranch, this.opts.gitBin);
    try {
      return await resolveBase(project.path, null, this.opts.gitBin);
    } catch {
      // A folder that is not a repository yet, or one with no commit: the goal branch is made later.
      return null;
    }
  }

  // ---------------------------------------------------------------- prompt facts

  /** The planning task's description: the goal, local project facts and, for a revision, the plan so far. */
  private promptFor(goal: GoalRow, project: ProjectRow, revision: { cause: "revise" | "replan"; note: string } | null): string {
    const { config } = this.config(project);
    const kind = detectProjectType(project.path).kind;
    const own = new Set([...this.goalRows(goal.id).map((r) => r.task_id), ...this.planTaskIds()]);
    const openTasks = this.db
      .tasks(project.id)
      .filter((t) => !t.cancelled_at && !own.has(t.id))
      .filter((t) => !["done", "merged", "cancelled"].includes(this.db.status(t)))
      .map((t) => t.title);
    const roles = [...projectRoles(this.opts.dataDir, project.path, config, null).set.roles.values()].map((r) => ({ id: r.template.id, title: r.template.title }));
    const input: PlanningPromptInput = {
      goalText: goal.text,
      attachments: this.goalAttachments(goal.id),
      project: { type: kind === "unknown" ? null : kind, build: config.commands.build || null, test: config.commands.test || null },
      openTasks,
      roles,
      maxTasks: goal.max_tasks,
      maxParallel: goal.max_parallel,
      ...(revision ? { revision: { ...revision, previous: this.previousPlan(goal.id), frozen: this.frozenFacts(goal.id), findings: this.findings(goal.id) } } : {}),
    };
    return planningPrompt(input);
  }

  private goalAttachments(goalId: string): string[] {
    const first = this.opts.store.db.prepare("select plan_task_id from goal_plans where goal_id = ? and plan_task_id is not null order by revision limit 1").get(goalId) as { plan_task_id: string } | undefined;
    return first ? this.attachments.forTask(first.plan_task_id).map((a) => a.path) : [];
  }

  private previousPlan(goalId: string): GoalPlan | null {
    const row = this.opts.store.db.prepare("select plan from goal_plans where goal_id = ? and plan is not null order by revision desc limit 1").get(goalId) as { plan: string } | undefined;
    return row ? (JSON.parse(row.plan) as GoalPlan) : null;
  }

  private frozenFacts(goalId: string): FrozenTaskFacts[] {
    return this.revisionBase(goalId)
      .base.filter((b) => b.frozen)
      .map((b) => {
        const runs = this.db.runs(b.row.task_id);
        const last = runs.at(-1);
        const diff = last?.diff ? (JSON.parse(last.diff) as Array<{ path: string }>) : [];
        return {
          key: b.task.key,
          title: b.task.title,
          because: b.frozen!,
          status: b.status,
          report: this.reportSummary(b.row.task_id),
          files: diff.map((f) => f.path),
          failure: b.status === "failed" ? (runs.findLast((r) => r.end_reason === "failed")?.end_detail ?? null) : null,
        };
      });
  }

  /** The newest research or review summary a task's runs reported, as a revision quotes it. */
  private reportSummary(taskId: string): string | null {
    const row = this.opts.store.db.prepare("select payload from events where task_id = ? and kind in ('research.findings', 'review.verdict') order by seq desc limit 1").get(taskId) as { payload: string } | undefined;
    if (!row) return null;
    try {
      const summary = (JSON.parse(row.payload) as { summary?: unknown }).summary;
      return typeof summary === "string" && summary.trim() ? summary : null;
    } catch {
      return null;
    }
  }

  /** Open decisions' findings and failure details: what a Replan from a decision is about. */
  private findings(goalId: string): string[] {
    const rows = this.opts.store.db.prepare("select payload from goal_decisions where goal_id = ? and answered_at is null order by created_at").all(goalId) as Array<{ payload: string }>;
    const out: string[] = [];
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload) as { findings?: unknown; detail?: unknown };
        if (typeof p.findings === "string" && p.findings.trim()) out.push(p.findings);
        else if (typeof p.detail === "string" && p.detail.trim()) out.push(p.detail);
      } catch {
        // A payload that does not parse says nothing the planner could use.
      }
    }
    return out.slice(0, 4);
  }

  // ---------------------------------------------------------------- goal tasks

  /** Inside the task's own transaction: its goal_tasks row, with `writes` read from the crew just drafted. */
  private insertGoalTask(goalId: string, planId: string, taskId: string, t: GoalPlanTask, position: number, basisMatched: boolean): void {
    const writes = this.opts.store.db.prepare("select 1 as x from crew_members m join crews c on c.id = m.crew_id where c.task_id = ? and m.writes_code = 1 limit 1").get(taskId) !== undefined;
    this.db.exec(
      `insert into goal_tasks (task_id, goal_id, plan_id, key, position, mode, priority, basis, basis_matched, reason, paths, writes)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      taskId,
      goalId,
      planId,
      t.key,
      position,
      t.mode,
      t.priority,
      t.basis,
      basisMatched ? 1 : 0,
      t.reason,
      JSON.stringify(t.paths),
      writes ? 1 : 0,
    );
  }

  /**
   * Ends the description with "[Goal: waits for 01, 02]" while the task waits for others, replacing
   * the line an earlier revision wrote, so the order an older build shows stays current.
   */
  private setWaitsFor(taskId: string): void {
    const positions = new Map(this.goalRows(this.goalTaskRow(taskId).goal_id).map((r) => [r.task_id, r.position]));
    const line = waitsForLine(this.depsOf(taskId).map((d) => positions.get(d.on)).filter((n) => n !== undefined));
    const task = this.db.task(taskId);
    const body = stripWaitsFor(task.description);
    const next = line ? (body ? `${body}\n\n${line}` : line) : body;
    if (next !== task.description) this.db.exec("update tasks set description = ? where id = ?", next, taskId);
  }

  /**
   * Discards goal tasks that never started: nothing ran, so cancelling stops nothing. A task that
   * was released, joined or has run is refused (goal.frozen), which aborts the caller's transaction.
   */
  private discard(taskIds: readonly string[]): void {
    const at = this.iso();
    for (const id of taskIds) {
      const row = this.goalTaskRowOrNull(id);
      if (row && row.discarded_at === null) {
        const because = this.startedFacts(row);
        if (because) throw new OrchestratorError("goal.frozen", { key: row.key, because });
      }
      this.db.exec("update goal_tasks set discarded_at = ? where task_id = ? and discarded_at is null and released_at is null and joined_sha is null", at, id);
      this.db.exec("update tasks set cancelled_at = ? where id = ? and cancelled_at is null", at, id);
    }
  }

  /** Why a goal task may no longer be discarded or replaced: it was released, joined or has run. Edits do not count here. */
  private startedFacts(row: GoalTaskRow): FrozenBecause | null {
    const because = frozenBecause({ status: this.db.status(this.db.task(row.task_id)), released: row.released_at !== null, joined: row.joined_sha !== null, edited: false });
    if (because) return because;
    return this.db.runs(row.task_id).length > 0 ? "running" : null;
  }

  /** Tasks proposed for a revision that did not land (a failure, or a newer revision won). */
  private dropCreated(taskIds: readonly string[]): void {
    if (taskIds.length === 0) return;
    this.db.tx(() => {
      this.discard(taskIds);
      // Frees the key within its revision (unique per plan and key), so drafting again can use it.
      // The row stays, discarded, so the cancelled proposal still reads as the goal's and stays hidden.
      for (const id of taskIds) this.db.exec("update goal_tasks set key = key || '~' || substr(task_id, 1, 8) where task_id = ?", id);
      this.db.exec(`delete from goal_task_deps where task_id in (${taskIds.map(() => "?").join(", ")})`, ...taskIds);
    });
    for (const id of taskIds) this.emitTask(id, "cancelled");
  }

  /**
   * The goal's live tasks as a revision is checked against them (RevisionBase); skipped tasks are
   * not part of it, nor the drafts of the revision `draftsOf` itself.
   */
  private revisionBase(goalId: string, draftsOf?: string): RevisionBase {
    const revisions = new Map((this.opts.store.db.prepare("select id, revision, plan from goal_plans where goal_id = ?").all(goalId) as Array<{ id: string; revision: number; plan: string | null }>).map((p) => [p.id, p]));
    const plans = new Map<string, GoalPlan | null>();
    const planOf = (id: string) => {
      if (!plans.has(id)) {
        const raw = revisions.get(id)?.plan;
        plans.set(id, raw ? (JSON.parse(raw) as GoalPlan) : null);
      }
      return plans.get(id) ?? null;
    };
    const all = this.liveRows(goalId)
      .filter((row) => row.accepted !== 0 && row.plan_id !== draftsOf)
      .map((row) => {
        const task = this.db.task(row.task_id);
        const status = this.db.status(task);
        const entry = planOf(row.plan_id)?.tasks.find((t) => t.key === row.key) ?? fallbackEntry(row, task.title, task.kind, task.size);
        const frozen = frozenBecause({ status, released: row.released_at !== null, joined: row.joined_sha !== null, edited: row.edited === 1 });
        return { row, task: entry, status, frozen, revision: revisions.get(row.plan_id)?.revision ?? 0 };
      });
    const byKey = new Map<string, (typeof all)[number]>();
    for (const b of all) {
      const held = byKey.get(b.row.key);
      const wins = !held || (b.frozen !== null && held.frozen === null) || ((b.frozen === null) === (held.frozen === null) && b.revision > held.revision);
      if (wins) byKey.set(b.row.key, b);
    }
    const chosen = new Set([...byKey.values()].map((b) => b.row.task_id));
    return {
      base: all.filter((b) => chosen.has(b.row.task_id)).map(({ row, task, status, frozen }) => ({ row, task, status, frozen })),
      shadowed: all.filter((b) => !chosen.has(b.row.task_id)).map((b) => b.row),
    };
  }

  private overlapInput(goalId: string) {
    return this.liveRows(goalId).map((r) => ({
      id: r.task_id,
      position: r.position,
      writes: r.writes === 1,
      accepted: r.accepted === null ? null : r.accepted === 1,
      paths: JSON.parse(r.paths) as string[],
      dependsOn: this.depsOf(r.task_id).map((d) => d.on),
    }));
  }

  // ---------------------------------------------------------------- rows and checks

  private goal(goalId: string): GoalRow {
    const g = this.opts.store.db.prepare("select * from goals where id = ?").get(goalId) as unknown as GoalRow | undefined;
    if (!g) throw new OrchestratorError("goal.not_found", { goalId });
    return g;
  }

  private latestRevisionOrNull(goalId: string): PlanRow | null {
    return (this.opts.store.db.prepare("select * from goal_plans where goal_id = ? order by revision desc limit 1").get(goalId) as unknown as PlanRow | undefined) ?? null;
  }

  private latestRevision(goalId: string): PlanRow {
    const p = this.latestRevisionOrNull(goalId);
    if (!p) throw new OrchestratorError("goal.not_found", { goalId });
    return p;
  }

  private planRowById(id: string): PlanRow {
    return this.opts.store.db.prepare("select * from goal_plans where id = ?").get(id) as unknown as PlanRow;
  }

  private planOfTask(taskId: string): PlanRow | null {
    return (this.opts.store.db.prepare("select * from goal_plans where plan_task_id = ?").get(taskId) as unknown as PlanRow | undefined) ?? null;
  }

  private planTaskIds(): string[] {
    return (this.opts.store.db.prepare("select plan_task_id from goal_plans where plan_task_id is not null").all() as Array<{ plan_task_id: string }>).map((r) => r.plan_task_id);
  }

  private goalRows(goalId: string): GoalTaskRow[] {
    return this.opts.store.db.prepare("select * from goal_tasks where goal_id = ? order by position, task_id").all(goalId) as unknown as GoalTaskRow[];
  }

  /**
   * A follow-up a goal task proposed, accepted in the Inbox (design §5.3): it becomes an added task
   * of its goal, a one-task revision that waits for the proposing task and for your approval, never
   * a task that starts. Null when the task belongs to no goal that still takes tasks (none, stopped,
   * or a plan of one task that became an ordinary task): it is then an ordinary draft, as before.
   * The agent's words are untrusted: cleaned and cut to the plan's own caps.
   */
  async addFollowup(fromTaskId: string, title: string, text: string): Promise<GoalPlanStart | null> {
    const row = this.goalTaskRowOrNull(fromTaskId);
    if (!row) return null;
    const goal = this.goal(row.goal_id);
    if (goal.stopped_at || goal.collapsed_task_id) return null;
    const from = this.db.task(fromTaskId);
    const firstLine = (s: string) => cleanText(s).replace(/\s+/g, " ").trim();
    const name = capText(firstLine(title) || firstLine(text), GOAL_LIMITS.titleBytes).text;
    const description = capText(cleanText(text), GOAL_LIMITS.descriptionBytes).text;
    // It builds on what the proposing task did, so it waits for it while that task still counts.
    const waits = row.accepted !== 0 && row.discarded_at === null && !from.cancelled_at ? [fromTaskId] : [];
    return this.addTask(goal.id, { title: name, kind: from.kind, mode: "crew", ...(description ? { description } : {}) }, waits);
  }

  private liveRows(goalId: string): GoalTaskRow[] {
    return this.goalRows(goalId).filter((r) => r.discarded_at === null);
  }

  private goalTaskRow(taskId: string): GoalTaskRow {
    return this.opts.store.db.prepare("select * from goal_tasks where task_id = ?").get(taskId) as unknown as GoalTaskRow;
  }

  private goalTaskRowOrNull(taskId: string): GoalTaskRow | null {
    return (this.opts.store.db.prepare("select * from goal_tasks where task_id = ?").get(taskId) as unknown as GoalTaskRow | undefined) ?? null;
  }

  private planByRevision(goalId: string, revision: number): PlanRow | null {
    return (this.opts.store.db.prepare("select * from goal_plans where goal_id = ? and revision = ?").get(goalId, revision) as unknown as PlanRow | undefined) ?? null;
  }

  /** True for a hidden planning task: it runs only through the goal's planning clicks (Revise, Replan, Retry planning). */
  isPlanningTask(taskId: string): boolean {
    return this.planOfTask(taskId) !== null;
  }

  /** The planner you picked on the chip in this project, if any. */
  private rememberedPlanner(projectId: string): string | null {
    const v = this.setting(GOAL_SETTINGS.planner(projectId));
    return typeof v === "string" && v ? v : null;
  }

  private depsOf(taskId: string): Array<{ on: string; source: GoalDepSource }> {
    return (this.opts.store.db.prepare("select depends_on, source from goal_task_deps where task_id = ? order by depends_on").all(taskId) as Array<{ depends_on: string; source: GoalDepSource }>).map((d) => ({ on: d.depends_on, source: d.source }));
  }

  /** A planning result still matters: the goal is open and this is its latest revision, unanswered. */
  private current(goal: GoalRow, p: PlanRow): boolean {
    if (goal.stopped_at || goal.collapsed_task_id || p.superseded_at || p.approved_at || p.plan) return false;
    return this.latestRevision(goal.id).id === p.id;
  }

  private assertOpen(goal: GoalRow): void {
    // A goal that became one ordinary task is finished; nothing more is planned for it.
    if (goal.stopped_at || goal.collapsed_task_id) throw new OrchestratorError("goal.stopped", { goalId: goal.id });
  }

  private assertCollapsible(goalId: string): void {
    const g = this.goal(goalId);
    this.assertOpen(g);
    if (g.approved_revision !== null) throw new OrchestratorError("goal.collapse_after_approval");
  }

  /** The revision caps (design §4.10): 5 revisions before approval, 3 replans after, the task limit for Add task. */
  private assertRevision(cause: "revise" | "replan" | "add", goal: GoalRow, taskCount = 0): void {
    const refusal = planRevisionRefusal(cause, {
      stopped: goal.stopped_at !== null,
      approved: goal.approved_revision !== null,
      revisionsUsed: goal.revisions_used,
      replansUsed: goal.replans_used,
      taskCount,
      maxTasks: goal.max_tasks,
    });
    if (refusal === null) return;
    if (refusal === "stopped") throw new OrchestratorError("goal.stopped", { goalId: goal.id });
    if (refusal === "approved") throw new OrchestratorError("goal.approved");
    if (refusal === "not_approved") throw new OrchestratorError("goal.not_approved");
    if (refusal === "revisions_used") throw new OrchestratorError("goal.revisions_used", { max: GOAL_LIMITS.revisionsBeforeApproval });
    if (refusal === "replans_used") throw new OrchestratorError("goal.replans_used", { max: GOAL_LIMITS.replans });
    throw new OrchestratorError("goal.too_many", { max: goal.max_tasks });
  }

  // ---------------------------------------------------------------- settings, events, topic

  private setting(key: string): unknown {
    const row = this.opts.store.db.prepare("select value from settings where key = ?").get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return null;
    }
  }

  private writeSetting(key: string, value: unknown): void {
    this.opts.store.db.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, JSON.stringify(value));
  }

  private pausedAll(): boolean {
    const v = this.setting(GOAL_SETTINGS.pausedAll);
    return v === true || (typeof v === "object" && v !== null && (v as { on?: unknown }).on === true);
  }

  /** Goal events have no task: the goal id rides in the payload (design §4.1). */
  private goalEvent(goal: Pick<GoalRow, "id" | "project_id">, kind: string, payload: Record<string, unknown>): void {
    this.opts.store.appendEvent({ kind, source: "orchestrator", payload: { goalId: goal.id, ...payload }, projectId: goal.project_id });
  }

  /** `goals.changed` goes through the daemon's own emit: context.emit is typed to the tasks topics. */
  private emitGoal(goalId: string, cause: GoalChangeCause): void {
    try {
      const goal = this.goal(goalId);
      this.opts.emit("goals.changed", { goalId, projectId: goal.project_id, status: this.state(goalId).status, cause });
    } catch {
      // The window re-reads goals on its next refresh; a failed notice must not undo the change.
    }
  }
}

interface PlannerChoice {
  chosen: CandidateView;
  standby: CandidateView[];
}

/**
 * The composer's "Looks like one small change" hint: the classifier sized the text S because of a
 * small-change keyword ("typo", "küçük", ...). Only a hint; nothing switches mode by itself.
 */
export const smallChange = (text: string): boolean => classifyTask(text, "").reasons.some((r) => r.code === "classify.keyword" && r.params?.size === "S");

/** How a planner candidate is billed: per token on a key, under a plan sign-in, or locally. */
const billingOf = (c: Candidate): "api" | "plan" | "local" => (c.profile.credential.kind === "api_key" ? "api" : c.profile.credential.kind === "plan_signin" ? "plan" : "local");

const WAITS_FOR = /(?:\n\n)?\[Goal: waits for [0-9, ]+\]$/;

/** A description without the "[Goal: waits for ...]" line a revision wrote at its end. */
export const stripWaitsFor = (description: string): string => description.replace(WAITS_FOR, "");

/** A plan entry for a task whose revision JSON is missing (never written by this code; a guard for old rows). */
function fallbackEntry(row: GoalTaskRow, title: string, kind: GoalPlanTask["kind"], size: GoalPlanTask["size"]): GoalPlanTask {
  return { key: row.key, title, kind, mode: row.mode, size, description: "", acceptance: [], basis: row.basis, dependsOn: [], paths: JSON.parse(row.paths) as string[], reason: row.reason, priority: row.priority };
}
