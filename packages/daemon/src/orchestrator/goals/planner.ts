import { randomUUID } from "node:crypto";
import {
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
  type PlanRevisionFacts,
  type PlanState,
  type Reason,
  type RunView,
  type TaskDetail,
  type TaskMode,
  type TaskStatus,
} from "@crewyard/core";
import { detectProjectType } from "../../setup/detect.ts";
import type { OrchestratorContext, ProposeParams } from "../context.ts";
import { classifyTask } from "../classify.ts";
import { rankForRole } from "../crew.ts";
import type { ProjectRow, RunRow } from "../db.ts";
import type { Candidate } from "../directory.ts";
import { errorCode, OrchestratorError } from "../errors.ts";
import { resolveBase } from "../git.ts";
import { Part } from "../part.ts";
import type { RoleResult } from "../results.ts";
import { projectRoles } from "../role-files.ts";
import { GOAL_PLANNER } from "../roles.ts";
import { correctiveTurn, goalTaskDescription, planningPrompt, waitsForLine, type FrozenTaskFacts, type PlanningPromptInput } from "./prompt.ts";

// The Orchestra planner (docs/adr/0019, design §4.3 to §4.5 and §4.10). Each plan revision is one
// hidden planning task: kind research, one step of the read-only goal-planner role, its own budget
// (the ceiling the composer states), approved by the click that showed its cost and then run like
// any other run (admission, spend caps, transcripts, recovery). Its result is checked here with
// parseGoalPlan; a refusal gets one corrective turn through Messages.followUp, a second one fails
// the plan with the parser's words. A plan that passes becomes proposed tasks through
// TaskFlow.propose, each with its goal_tasks row written in the same transaction, so a goal task
// is never visible or approvable without it. Nothing here approves a goal task or starts one: the
// goal scheduler releases them after you approve the plan (GoalRunner). Statuses are derived
// (D5): a revision reads planning, failed or ready from its planning task's runs and its facts.

export interface GoalPlannerDeps {
  /** TaskFlow.propose: classify, draft a crew, no process; `inTx` runs in the task's own transaction. */
  propose(p: ProposeParams, hooks?: { inTx?: (taskId: string) => void }): Promise<TaskDetail>;
  /** TaskFlow.cancel: stops the planning run when you collapse a goal mid-planning. */
  cancel(taskId: string): Promise<TaskDetail>;
  /** Messages.followUp: the corrective turn, a new run of the same member, natively resumed. */
  followUp(runId: string, text: string): Promise<RunView>;
  tick(): Promise<void>;
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

const STEP = GOAL_PLANNER.id;

export class GoalPlanner extends Part {
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
   * What `Plan goal` would cost and whether it can run: the planner candidates, the estimate and
   * its ceiling, the small-change hint and whether the first-goal card is due. Writes nothing.
   */
  async preview(p: { projectId: string; text: string; plannerProfileId?: string }): Promise<GoalPreview> {
    const project = this.db.project(p.projectId);
    const enabled = this.enabled();
    const { views } = await this.plannerChoice(project, p.plannerProfileId ?? null);
    const planner = views.find((v) => v.profileId === p.plannerProfileId) ?? views[0] ?? null;
    const estimate: CostEstimate = planner?.estimate ?? { usd: null, provenance: "unknown" };
    const reason: Reason | null = !enabled ? { code: "goal.disabled" } : !planner ? { code: "goal.no_planner" } : null;
    const budget = this.setting(GOAL_SETTINGS.goalBudget(project.id));
    return {
      canPlan: reason === null,
      reason,
      planner,
      candidates: views,
      estimate,
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
  async create(p: { projectId: string; text: string; plannerProfileId?: string; baseBranch?: string; attachments?: string[]; defaultBudgetUsd?: number }): Promise<GoalPlanStart> {
    if (!this.enabled()) throw new OrchestratorError("goal.disabled");
    const project = this.db.project(p.projectId);
    const text = parseGoalText(p.text);
    if (!text.ok) throw new OrchestratorError("goal.text", { error: text.error });
    const limits = parseGoalLimits({ budgetUsd: p.defaultBudgetUsd });
    if (!limits.ok) throw new OrchestratorError("goal.bad_budget", { field: "defaultBudgetUsd" });
    const attachmentIds = [...(p.attachments ?? [])];
    this.attachments.check(attachmentIds);
    const choice = await this.pickPlanner(project, p.plannerProfileId ?? null, true);
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
    // The first-goal card's click is this one: its budget becomes the project default, and the card is done.
    if (limits.value.budgetUsd !== undefined) this.writeSetting(GOAL_SETTINGS.goalBudget(project.id), limits.value.budgetUsd);
    this.writeSetting(GOAL_SETTINGS.introduced(project.id), true);
    // You picked this planner on the chip: remembered per project the way crew edits are.
    if (p.plannerProfileId) this.db.bumpPreference(project.id, STEP, p.plannerProfileId, 1);
    this.goalEvent(goal, "goal.created", { title: goal.title, baseBranch, baseSha, plannerProfileId: choice.chosen.profileId });
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
          this.appendWaitsFor(taskId);
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
    const base = this.baseTasks(goal.id);
    const checked = applyPlanRevision(
      base.map((b) => ({ task: b.task, frozen: b.frozen })),
      parsed.value,
    );
    if (!checked.ok) {
      await this.refuse(goal, planRow, run, checked.error);
      return;
    }
    await this.materialise(goal, planRow, parsed.value, base, checked.diff);
  }

  private async refuse(goal: GoalRow, planRow: PlanRow, run: RunRow, error: string): Promise<void> {
    // Stored at once: if the corrective turn cannot even start, the revision reads failed with why.
    this.db.exec("update goal_plans set error = ? where id = ?", error, planRow.id);
    const results = this.db.runs(planRow.plan_task_id!).filter((r) => r.end_reason === "completed").length;
    if (results <= GOAL_LIMITS.correctiveTurns) {
      this.goalEvent(goal, "goal.plan_refused", { revision: planRow.revision, error, corrective: true });
      try {
        await this.deps.followUp(run.id, correctiveTurn(error));
        this.emitGoal(goal.id, "planning");
      } catch (err) {
        this.goalEvent(goal, "goal.plan_failed", { revision: planRow.revision, error, code: errorCode(err) });
        this.emitGoal(goal.id, "plan_failed");
      }
      return;
    }
    this.goalEvent(goal, "goal.plan_failed", { revision: planRow.revision, error });
    this.emitGoal(goal.id, "plan_failed");
  }

  /**
   * A checked plan becomes proposed tasks. Frozen tasks are kept as they are and move into the new
   * revision; every other live task of the goal is discarded (its crew was never approved, so
   * nothing stops). The plan JSON is written last, in one transaction with the discards, the
   * dependencies and the automatic overlap ordering, so a revision reads ready only once whole.
   */
  private async materialise(goal: GoalRow, planRow: PlanRow, plan: GoalPlan, base: BaseTask[], diff: { added: string[]; changed: string[]; removed: string[]; kept: string[] }): Promise<void> {
    const frozen = new Map(base.filter((b) => b.frozen).map((b) => [b.task.key, b]));
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
      return;
    }
    const at = this.iso();
    const ids = new Map<string, string>([...created.map((c) => [c.key, c.taskId] as const), ...[...frozen.values()].map((b) => [b.task.key, b.row.task_id] as const)]);
    const discarded = base.filter((b) => !b.frozen).map((b) => b.row.task_id);
    let applied = false;
    this.db.tx(() => {
      // Read again: a stop, a collapse or a newer revision while the tasks were drafted wins.
      if (!this.current(this.goal(goal.id), this.planRowById(planRow.id))) return;
      this.db.exec("update goal_plans set plan = ?, error = null where id = ?", JSON.stringify(plan), planRow.id);
      this.db.exec("update goal_plans set superseded_at = ? where goal_id = ? and revision < ? and superseded_at is null and approved_at is null", at, goal.id, planRow.revision);
      this.discard(discarded);
      for (const [i, t] of plan.tasks.entries()) {
        const kept = frozen.get(t.key);
        if (kept) this.db.exec("update goal_tasks set plan_id = ?, position = ? where task_id = ?", planRow.id, i, kept.row.task_id);
      }
      this.writeDeps(goal.id, plan, ids, frozen);
      for (const c of created) this.appendWaitsFor(c.taskId);
      applied = true;
    });
    if (!applied) {
      this.dropCreated(created.map((c) => c.taskId));
      this.goalEvent(goal, "goal.plan_ignored", { revision: planRow.revision, reason: "superseded" });
      return;
    }
    for (const id of discarded) {
      this.audit(id, null, "task.cancelled", { by: "goal", goalId: goal.id, revision: planRow.revision });
      this.emitTask(id, "cancelled");
    }
    const overlaps = Number((this.opts.store.db.prepare("select count(*) as n from goal_task_deps where goal_id = ? and source = 'overlap'").get(goal.id) as { n: number }).n);
    this.goalEvent(goal, "goal.planned", { revision: planRow.revision, cause: planRow.cause, tasks: plan.tasks.length, ...diff, overlaps });
    this.emitGoal(goal.id, "planned");
  }

  /**
   * The revision's dependencies, rebuilt by key: the plan's edges, your own edges on tasks that
   * stayed (remapped to the task that now holds their key, dropped if they would close a loop),
   * and the overlap ordering over the result (design §4.8).
   */
  private writeDeps(goalId: string, plan: GoalPlan, ids: ReadonlyMap<string, string>, frozen: ReadonlyMap<string, BaseTask>): void {
    const members = new Set(ids.values());
    const keyOf = new Map(this.goalRows(goalId).map((r) => [r.task_id, r.key]));
    const userEdges: Array<{ task: string; on: string }> = [];
    for (const b of frozen.values()) {
      for (const d of this.depsOf(b.row.task_id)) {
        if (d.source !== "user") continue;
        const target = members.has(d.on) ? d.on : ids.get(keyOf.get(d.on) ?? "");
        if (target && target !== b.row.task_id) userEdges.push({ task: b.row.task_id, on: target });
      }
    }
    const list = [...members];
    if (list.length > 0) {
      const marks = list.map(() => "?").join(", ");
      this.opts.store.db.prepare(`delete from goal_task_deps where task_id in (${marks})`).run(...list);
    }
    const graph = new Map<string, string[]>([...members].map((id) => [id, []]));
    const add = (task: string, on: string, source: GoalDepSource) => {
      this.db.exec("insert or ignore into goal_task_deps (goal_id, task_id, depends_on, source) values (?, ?, ?, ?)", goalId, task, on, source);
      graph.get(task)!.push(on);
    };
    for (const t of plan.tasks) for (const d of t.dependsOn) add(ids.get(t.key)!, ids.get(d)!, "plan");
    for (const e of userEdges) {
      if (graph.get(e.task)!.includes(e.on)) continue;
      const nodes = [...graph].map(([id, dependsOn]) => ({ id, dependsOn }));
      if (!wouldCycle(nodes, e.task, e.on)) add(e.task, e.on, "user");
    }
    const input = this.overlapInput(goalId).filter((t) => members.has(t.id));
    for (const e of overlapPairs(input)) add(e.taskId, e.dependsOn, "overlap");
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
      runs: task ? this.db.runs(task.id).map((r) => ({ endedAt: r.ended_at })) : null,
      taskCancelled: Boolean(task?.cancelled_at),
    };
  }

  private taskFacts(r: GoalTaskRow): GoalTaskFacts {
    return {
      id: r.task_id,
      label: String(r.position + 1).padStart(2, "0"),
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
    return this.baseTasks(goalId)
      .filter((b) => b.frozen)
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

  /** Ends the description with "[Goal: waits for 01, 02]" while the task waits for others. */
  private appendWaitsFor(taskId: string): void {
    const positions = new Map(this.goalRows(this.goalTaskRow(taskId).goal_id).map((r) => [r.task_id, r.position]));
    const line = waitsForLine(this.depsOf(taskId).map((d) => positions.get(d.on)!).filter((n) => n !== undefined));
    if (!line) return;
    const task = this.db.task(taskId);
    this.db.exec("update tasks set description = ? where id = ?", task.description ? `${task.description}\n\n${line}` : line, taskId);
  }

  /** Discards goal tasks that never ran: their crews were never approved, so cancelling stops nothing. */
  private discard(taskIds: readonly string[]): void {
    const at = this.iso();
    for (const id of taskIds) {
      this.db.exec("update goal_tasks set discarded_at = ? where task_id = ? and discarded_at is null", at, id);
      this.db.exec("update tasks set cancelled_at = ? where id = ? and cancelled_at is null", at, id);
    }
  }

  /** Tasks proposed for a revision that did not land (a failure, or a newer revision won). */
  private dropCreated(taskIds: readonly string[]): void {
    if (taskIds.length === 0) return;
    this.db.tx(() => this.discard(taskIds));
    for (const id of taskIds) this.emitTask(id, "cancelled");
  }

  /** The goal's live tasks with their plan entries and whether a revision may change them. */
  private baseTasks(goalId: string): BaseTask[] {
    const plans = new Map<string, GoalPlan | null>();
    const planOf = (id: string) => {
      if (!plans.has(id)) plans.set(id, this.planJson(id));
      return plans.get(id) ?? null;
    };
    return this.liveRows(goalId).map((row) => {
      const task = this.db.task(row.task_id);
      const status = this.db.status(task);
      const entry = planOf(row.plan_id)?.tasks.find((t) => t.key === row.key) ?? fallbackEntry(row, task.title, task.kind, task.size);
      return { row, task: entry, status, frozen: frozenBecause({ status, released: row.released_at !== null, joined: row.joined_sha !== null, edited: row.edited === 1 }) };
    });
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

  private planJson(planId: string): GoalPlan | null {
    const row = this.opts.store.db.prepare("select plan from goal_plans where id = ?").get(planId) as { plan: string | null } | undefined;
    return row?.plan ? (JSON.parse(row.plan) as GoalPlan) : null;
  }

  private planTaskIds(): string[] {
    return (this.opts.store.db.prepare("select plan_task_id from goal_plans where plan_task_id is not null").all() as Array<{ plan_task_id: string }>).map((r) => r.plan_task_id);
  }

  private goalRows(goalId: string): GoalTaskRow[] {
    return this.opts.store.db.prepare("select * from goal_tasks where goal_id = ? order by position, task_id").all(goalId) as unknown as GoalTaskRow[];
  }

  private liveRows(goalId: string): GoalTaskRow[] {
    return this.goalRows(goalId).filter((r) => r.discarded_at === null);
  }

  private goalTaskRow(taskId: string): GoalTaskRow {
    return this.opts.store.db.prepare("select * from goal_tasks where task_id = ?").get(taskId) as unknown as GoalTaskRow;
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

/** A plan entry for a task whose revision JSON is missing (never written by this code; a guard for old rows). */
function fallbackEntry(row: GoalTaskRow, title: string, kind: GoalPlanTask["kind"], size: GoalPlanTask["size"]): GoalPlanTask {
  return { key: row.key, title, kind, mode: row.mode, size, description: "", acceptance: [], basis: row.basis, dependsOn: [], paths: JSON.parse(row.paths) as string[], reason: row.reason, priority: row.priority };
}
