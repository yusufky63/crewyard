import { randomUUID } from "node:crypto";
import {
  derivePlanState,
  deriveGoalStatus,
  GOAL_DECISION_ACTIONS,
  GOAL_SETTINGS,
  goalDependents,
  goalReportExcerpt,
  goalStopRule,
  goalTaskFinished,
  overlapPairs,
  ancestorsOf,
  parseGoalLimits,
  prerequisiteHold,
  readySet,
  releaseRoom,
  releasedUnfinished,
  rescaleShares,
  skippedDependency,
  splitBudget,
  awaitingJoin,
  capText,
  cleanText,
  unmetPrerequisites,
  type BudgetItem,
  type CandidateView,
  type CostEstimate,
  type DagNode,
  type GoalDecisionAction,
  type GoalDecisionKind,
  type GoalDecisionPayload,
  type GoalDepSource,
  type GoalPlanCause,
  type GoalPriority,
  type GoalState,
  type GoalStopPreview,
  type GoalTaskFacts,
  type GoalChangeCause,
  type OverlapTask,
  type Reason,
  type TaskDetail,
  type TaskGoalRef,
  type TaskMode,
  type TaskPreview,
  type TaskPreviewParams,
  type TaskStatus,
} from "@crewyard/core";
import type { OrchestratorContext, ProposeParams } from "../context.ts";
import { sumEstimates, validateCrew } from "../crew.ts";
import type { TaskRow } from "../db.ts";
import { commitsBetween, isAncestor, resolveBase } from "../git.ts";
import { errorCode } from "../errors.ts";
import { Part } from "../part.ts";
import { GoalError, GoalEvents } from "./events.ts";
import { GoalJoin } from "./join.ts";

// The goal scheduler (docs/adr/0019, design §4.5 to §4.7 and §5): one approval click per plan
// revision, then a deterministic pass, called by the dispatcher at the start of every scheduling
// pass, that releases accepted tasks in dependency order (at most `max_parallel` per goal), merges
// finished writing tasks into the goal branch, releases the last review once every writer joined,
// and halts or asks you when the rules say so. It never decides for you: a failed, cancelled or
// skipped prerequisite holds its dependents, a conflict asks, and a report from a task that writes
// nothing reaches a writing task only after you accept it. Released tasks then meet every rule an
// ordinary task meets: admission (D7), the per-step budget hold, the task budget and key caps.

// ---------------------------------------------------------------- rows

export interface GoalRow {
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

export interface GoalPlanRow {
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

export interface GoalTaskRow {
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

export interface GoalDepRow {
  goal_id: string;
  task_id: string;
  depends_on: string;
  source: GoalDepSource;
}

export interface GoalDecisionRow {
  id: string;
  goal_id: string;
  kind: GoalDecisionKind;
  task_id: string | null;
  payload: string;
  created_at: string;
  answered_at: string | null;
  answer: GoalDecisionAction | null;
}

/** Plain SQL over the goal tables. Rows are facts; status is derived on read (D5). */
export class GoalRows {
  constructor(
    private readonly ctx: OrchestratorContext,
    private readonly events: GoalEvents,
  ) {}

  private get sql() {
    return this.ctx.opts.store.db;
  }

  one<T>(q: string, ...args: Array<string | number | null>): T | undefined {
    return this.sql.prepare(q).get(...args) as T | undefined;
  }

  all<T>(q: string, ...args: Array<string | number | null>): T[] {
    return this.sql.prepare(q).all(...args) as unknown as T[];
  }

  /** Runs one statement and says how many rows it changed, for the checks inside transactions. */
  run(q: string, ...args: Array<string | number | null>): number {
    return Number(this.sql.prepare(q).run(...args).changes);
  }

  goal(id: string): GoalRow {
    const g = this.one<GoalRow>("select * from goals where id = ?", id);
    if (!g) throw new GoalError("goal.not_found", { goalId: id });
    return g;
  }

  /** Goals the scheduler looks at: approved at least once, not stopped, not collapsed into one task. */
  activeGoals(): GoalRow[] {
    return this.all<GoalRow>("select * from goals where approved_revision is not null and stopped_at is null and collapsed_task_id is null order by created_at, id");
  }

  /**
   * Tasks of stopped goals that are not cancelled yet, and their last reviews: Stop goal cancels them
   * one by one, and none of them may start a run in between (design §5.2).
   */
  stoppedGoalTasks(): string[] {
    return this.all<{ id: string }>(
      `select gt.task_id as id from goal_tasks gt join goals g on g.id = gt.goal_id join tasks t on t.id = gt.task_id where g.stopped_at is not null and t.cancelled_at is null
       union select g.integration_task_id as id from goals g join tasks t on t.id = g.integration_task_id where g.stopped_at is not null and t.cancelled_at is null`,
    ).map((r) => r.id);
  }

  plans(goalId: string): GoalPlanRow[] {
    return this.all<GoalPlanRow>("select * from goal_plans where goal_id = ? order by revision", goalId);
  }

  latestPlan(goalId: string): GoalPlanRow | null {
    return this.one<GoalPlanRow>("select * from goal_plans where goal_id = ? order by revision desc limit 1", goalId) ?? null;
  }

  tasks(goalId: string): GoalTaskRow[] {
    return this.all<GoalTaskRow>("select * from goal_tasks where goal_id = ? order by position, task_id", goalId);
  }

  goalTask(taskId: string): GoalTaskRow | null {
    return this.one<GoalTaskRow>("select * from goal_tasks where task_id = ?", taskId) ?? null;
  }

  deps(goalId: string): GoalDepRow[] {
    return this.all<GoalDepRow>("select * from goal_task_deps where goal_id = ?", goalId);
  }

  decisions(goalId: string, open = false): GoalDecisionRow[] {
    return this.all<GoalDecisionRow>(`select * from goal_decisions where goal_id = ?${open ? " and answered_at is null" : ""} order by created_at, rowid`, goalId);
  }

  decision(id: string): GoalDecisionRow | null {
    return this.one<GoalDecisionRow>("select * from goal_decisions where id = ?", id) ?? null;
  }

  lastJoinedSha(goalId: string): string | null {
    return this.one<{ sha: string }>("select after_sha as sha from goal_joins where goal_id = ? and outcome = 'joined' and after_sha is not null order by at desc, rowid desc limit 1", goalId)?.sha ?? null;
  }

  /** The goal an integration task closes, or a planning task plans; null for any other task. */
  goalOfIntegration(taskId: string): GoalRow | null {
    return this.one<GoalRow>("select * from goals where integration_task_id = ?", taskId) ?? null;
  }

  goalOfPlanning(taskId: string): GoalRow | null {
    return this.one<GoalRow>("select g.* from goals g join goal_plans p on p.goal_id = g.id where p.plan_task_id = ?", taskId) ?? null;
  }

  /**
   * Asks you, once: a decision of the same kind for the same task is not raised again while one is
   * open, or after you answered `Replan` for it since the goal's last approval (the replan's own
   * approval lets it come back).
   */
  raiseDecision(goal: GoalRow, kind: GoalDecisionKind, taskId: string | null, payload: GoalDecisionPayload): string | null {
    const fresh = this.goal(goal.id);
    const same = this.decisions(goal.id).filter((d) => d.kind === kind && d.task_id === taskId);
    if (same.some((d) => d.answered_at === null)) return null;
    if (same.some((d) => d.answer === "replan" && (fresh.approved_at === null || d.answered_at! >= fresh.approved_at))) return null;
    const id = randomUUID();
    this.run("insert into goal_decisions (id, goal_id, kind, task_id, payload, created_at) values (?, ?, ?, ?, ?, ?)", id, goal.id, kind, taskId, JSON.stringify(payload), this.ctx.iso());
    this.events.append(goal.project_id, goal.id, "goal.decision", { decisionId: id, kind, taskId, payload });
    return id;
  }

  answerDecision(d: GoalDecisionRow, action: GoalDecisionAction): void {
    this.run("update goal_decisions set answered_at = ?, answer = ? where id = ? and answered_at is null", this.ctx.iso(), action, d.id);
  }

  setting<T>(key: string): T | null {
    const v = this.one<{ value: string }>("select value from settings where key = ?", key)?.value;
    if (v === undefined) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }

  writeSetting(key: string, value: unknown): void {
    this.run("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value", key, JSON.stringify(value));
  }
}

// ---------------------------------------------------------------- the part

export interface GoalRunnerDeps {
  /** TaskFlow.propose: the hidden integration task, with its goal row written in the same transaction. */
  propose(p: ProposeParams, hooks: { inTx?: (taskId: string) => void }): Promise<TaskDetail>;
  /** TaskFlow.preview: the last review's estimate before anything is written. */
  preview(p: TaskPreviewParams): Promise<TaskPreview>;
  /** TaskFlow.cancel: stops every run of a task and closes what is open; worktrees stay. */
  cancel(taskId: string): Promise<TaskDetail>;
  /** RunActions: pause and resume at a turn boundary, and your Retry of a failed run. */
  pauseRun(runId: string): Promise<unknown>;
  resumeRun(runId: string): Promise<unknown>;
  retryRun(runId: string): Promise<unknown>;
  /** Messages.followUp, for a conflict sent back to the task's implementer. */
  followUp(runId: string, text: string): Promise<unknown>;
  tick(): Promise<void>;
}

/** What the dispatcher must not start this pass, and the completed steps it should run again. */
export interface GoalPassResult {
  /** Goal task ids: no new run of them starts (a paused goal, `Pause all goals`, a failed goal pass). */
  held: ReadonlySet<string>;
  /** Member ids whose finished run runs again through admission: the last review after new merges. */
  rerun: ReadonlySet<string>;
}

export interface GoalApproveParams {
  goalId: string;
  revision: number;
  accept: string[];
  budgetUsd: number;
  maxParallel: number;
  taskBudgets?: Record<string, number>;
}

/** The pausedAll settings row: on, and when you turned it on. */
interface PausedAll {
  on: boolean;
  at: string | null;
}

const label = (position: number) => String(position + 1).padStart(2, "0");
const json = <T>(s: string | null, fallback: T): T => {
  if (s === null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** A live goal task: accepted, not discarded, not cancelled (skipped and superseded ones drop out). */
const isLive = (f: GoalTaskFacts) => f.accepted === true && !f.discarded && f.status !== "cancelled";

export class GoalRunner extends Part {
  readonly rows: GoalRows;
  readonly events: GoalEvents;
  readonly join: GoalJoin;
  /** Why an accepted goal task does not start, shown on its row; recomputed every pass, never stored. */
  private readonly holds = new Map<string, Reason>();
  /** The status each goal was last announced with, so goals.changed goes out when it changes. */
  private readonly announced = new Map<string, string>();
  /**
   * Goals that finished (Merged, or Done with no branch), by the approval they finished under: the
   * pass skips them until a new revision is approved, so old goals cost nothing on every tick.
   */
  private readonly settled = new Map<string, string | null>();
  /** The error code each goal's pass last failed with, so goal.error is written once per error. */
  private readonly failing = new Map<string, string>();
  /**
   * Last review runs whose pinned head descends from the goal branch's recorded tip: a commit made in
   * the goal worktree outside our merges, which the review read. Their verdict counts for that tip.
   */
  private readonly reviewCovers = new Set<string>();
  /** One approval per goal at a time; a second click waits and then reads the approved revision. */
  private readonly approving = new Map<string, Promise<void>>();

  constructor(
    ctx: OrchestratorContext,
    private readonly deps: GoalRunnerDeps,
  ) {
    super(ctx);
    this.events = new GoalEvents(ctx.opts.store, ctx.opts.emit);
    this.rows = new GoalRows(ctx, this.events);
    this.join = new GoalJoin(ctx, this.rows, this.events, { followUp: (runId, text) => this.deps.followUp(runId, text) });
  }

  // ---------------------------------------------------------------- facts

  /** What the release pass and the status rules know about each goal task (core GoalTaskFacts). */
  facts(goalId: string): GoalTaskFacts[] {
    const deps = this.rows.deps(goalId);
    return this.rows.tasks(goalId).map((t) => ({
      id: t.task_id,
      label: label(t.position),
      position: t.position,
      priority: t.priority,
      writes: t.writes === 1,
      accepted: t.accepted === null ? null : t.accepted === 1,
      discarded: t.discarded_at !== null,
      released: t.released_at !== null,
      joined: t.joined_sha !== null,
      reportAccepted: t.report_accepted_at !== null,
      status: this.db.status(this.db.task(t.task_id)),
      deps: deps.filter((d) => d.task_id === t.task_id).map((d) => ({ on: d.depends_on, source: d.source })),
    }));
  }

  /** The integration task's status and whether its last review passed on the goal branch's tip. */
  private integrationFacts(goal: GoalRow): { status: TaskStatus; reviewPassed: boolean } | null {
    if (!goal.integration_task_id) return null;
    const task = this.db.task(goal.integration_task_id);
    const head = this.join.recordedHead(goal);
    let verdict = head ? this.loops.verdictFor(task.id, head) : null;
    if (!verdict) {
      // The latest review read a commit past the recorded tip (made in the goal worktree by hand).
      const last = this.db.runs(task.id).filter((r) => r.role === "reviewer" && r.end_reason === "completed").at(-1);
      if (last && this.reviewCovers.has(last.id)) verdict = this.loops.verdict(last.id);
    }
    return { status: this.db.status(task), reviewPassed: verdict?.verdict === "pass" };
  }

  /** The goal's derived status (core deriveGoalStatus), from its stored facts only. */
  state(goalId: string): GoalState {
    const goal = this.rows.goal(goalId);
    const latest = this.rows.latestPlan(goal.id);
    const planTask = latest?.plan_task_id ? this.db.task(latest.plan_task_id) : null;
    return deriveGoalStatus({
      stopped: goal.stopped_at !== null,
      paused: goal.paused_at !== null,
      pausedAll: this.pausedAll().on,
      halted: goal.halted_at !== null,
      collapsed: goal.collapsed_task_id !== null,
      latestPlan: latest
        ? derivePlanState({
            hasPlan: latest.plan !== null,
            error: latest.error,
            supersededAt: latest.superseded_at,
            approvedAt: latest.approved_at,
            runs: planTask ? this.db.runs(planTask.id).map((r) => ({ endedAt: r.ended_at })) : null,
            taskCancelled: planTask?.cancelled_at != null,
          })
        : null,
      openDecisions: this.rows.decisions(goal.id, true).map((d) => ({ kind: d.kind, taskId: d.task_id })),
      tasks: this.facts(goal.id),
      integration: this.integrationFacts(goal),
    });
  }

  private pausedAll(): PausedAll {
    const v = this.rows.setting<PausedAll | boolean>(GOAL_SETTINGS.pausedAll);
    if (typeof v === "boolean") return { on: v, at: null };
    return v && typeof v === "object" ? { on: v.on === true, at: v.at ?? null } : { on: false, at: null };
  }

  /** Tells the window the goal changed when its status did, or always for a change you made. */
  private announce(goalId: string, cause: GoalChangeCause, force = false): void {
    const goal = this.rows.goal(goalId);
    const s = this.state(goal.id);
    const key = `${s.status}:${s.reason ?? ""}:${s.done}/${s.total}`;
    if (!force && this.announced.get(goal.id) === key) return;
    this.announced.set(goal.id, key);
    this.events.changed({ goalId: goal.id, projectId: goal.project_id, status: s.status, cause });
  }

  // ---------------------------------------------------------------- task views (db hooks)

  /** TaskSummary.goal: what a task is to its goal, so the task list counts it there (design §3.4). */
  goalRef(task: TaskRow): TaskGoalRef | null {
    const gt = this.rows.goalTask(task.id);
    if (gt) {
      const goal = this.rows.goal(gt.goal_id);
      const plan = this.rows.one<{ approved_at: string | null }>("select approved_at from goal_plans where id = ?", gt.plan_id);
      const waiting = gt.accepted === 1 && gt.released_at === null && gt.discarded_at === null && task.cancelled_at === null;
      return {
        goalId: goal.id,
        key: gt.key,
        number: gt.position + 1,
        waiting,
        hold: this.holds.get(task.id) ?? null,
        joined: gt.joined_sha !== null,
        hidden: gt.discarded_at !== null || gt.accepted !== 1 || !plan?.approved_at,
        role: "task",
      };
    }
    const integration = this.rows.goalOfIntegration(task.id);
    if (integration) return { goalId: integration.id, key: "review", number: 0, waiting: false, hold: this.holds.get(task.id) ?? null, joined: false, hidden: true, role: "integration" };
    const planning = this.rows.goalOfPlanning(task.id);
    if (planning) return { goalId: planning.id, key: "plan", number: 0, waiting: false, hold: null, joined: false, hidden: true, role: "planning" };
    return null;
  }

  /**
   * implementationDone for an integration task (design §4.9): every accepted writing task has
   * joined the goal branch and its last review has run to completion. Before that it reads queued
   * or running, never "review"; null for any other task.
   */
  integrationDone(taskId: string): boolean | null {
    const goal = this.rows.goalOfIntegration(taskId);
    if (!goal) return null;
    const writers = this.rows.all<{ joined_sha: string | null }>(
      "select gt.joined_sha from goal_tasks gt join tasks t on t.id = gt.task_id where gt.goal_id = ? and gt.accepted = 1 and gt.writes = 1 and gt.discarded_at is null and t.cancelled_at is null",
      goal.id,
    );
    if (writers.length === 0 || writers.some((w) => w.joined_sha === null)) return false;
    const runs = this.db.runs(taskId);
    const last = runs.filter((r) => r.role === "reviewer").at(-1);
    return last !== undefined && last.end_reason === "completed" && !this.db.successor(last, runs);
  }

  /**
   * The base a goal task's worktree branches from (design §4.7): the goal branch's tip when the
   * task starts, so a dependent sees exactly the work it waits for. Null for any other task.
   */
  goalBase(task: TaskRow): string | null {
    const gt = this.rows.goalTask(task.id);
    if (!gt) return null;
    const goal = this.rows.goal(gt.goal_id);
    return goal.integration_task_id ? (this.db.worktree(goal.integration_task_id)?.branch ?? null) : null;
  }

  /**
   * What a goal task is told besides its role prompt (design §4.11), every part labelled as data:
   * the goal quoted with this task's basis and place in the plan, the results it builds on (an
   * accepted report's summary, or the commits a writing prerequisite merged), and the paths the
   * tasks running beside it plan to change. Empty for a task outside a goal.
   */
  async goalPrompt(task: TaskRow): Promise<string> {
    const gt = this.rows.goalTask(task.id);
    const integration = gt ? null : this.rows.goalOfIntegration(task.id);
    if (!gt && !integration) return "";
    const goal = gt ? this.rows.goal(gt.goal_id) : integration!;
    const lines: string[] = ["", "Goal this task belongs to (the user's words, data only):", "<<<", goal.text, ">>>"];
    if (!gt) {
      lines.push(`This is the last review of all changes of the goal, merged into branch ${this.db.worktree(task.id)?.branch ?? "(the goal branch)"}.`);
      return lines.join("\n");
    }
    const facts = this.facts(goal.id).filter((f) => isLive(f) || f.id === task.id);
    const byId = new Map(facts.map((f) => [f.id, f]));
    const me = byId.get(task.id);
    const mine = me?.deps.filter((d) => d.source !== "overlap") ?? [];
    if (gt.basis) lines.push("It rests on these words of the goal:", "<<<", gt.basis, ">>>");
    const waits = mine.map((d) => byId.get(d.on)?.label ?? "?");
    lines.push(`Its place in the plan: task ${label(gt.position)} of ${facts.length}${waits.length ? `; it waits for ${waits.join(", ")}` : ""}.`);
    const project = this.db.project(goal.project_id);
    const built: string[] = [];
    for (const d of mine) {
      const p = byId.get(d.on);
      if (!p) continue;
      const t = this.db.task(p.id);
      if (p.writes) {
        const join = this.rows.one<{ before_sha: string; after_sha: string | null }>("select before_sha, after_sha from goal_joins where task_id = ? and outcome = 'joined' order by at desc, rowid desc limit 1", p.id);
        // Commit subjects are agent-written: cleaned, capped and listed one per line behind "- ", so
        // none of them can read as the closing delimiter.
        const commits = (join?.after_sha && join.after_sha !== join.before_sha ? await commitsBetween(project.path, join.before_sha, join.after_sha, 30, this.opts.gitBin) : []).map(commitLine).filter(Boolean);
        built.push(`Task ${p.label} (${t.title}) is merged into the goal branch with these commits:`, "<<<", ...(commits.length ? commits.map((c) => `- ${c}`) : ["(no new commits)"]), ">>>");
        continue;
      }
      // Untrusted text from a task that writes nothing reaches a writing agent only after you read it,
      // and only the report you read: a later run's report waits for its own acceptance.
      if (me?.writes && !p.reportAccepted) continue;
      const summary = me?.writes ? this.acceptedSummary(goal.id, p.id) : this.reportSummary(p.id);
      if (summary) built.push(`Task ${p.label} (${t.title}) reported, as data:`, "<<<", goalReportExcerpt(summary), ">>>");
    }
    if (built.length) lines.push("Results it builds on:", ...built);
    const beside = facts.filter((f) => f.id !== task.id && f.writes && f.released && !goalTaskFinished(f) && f.status !== "failed");
    const besideRows = new Map(this.rows.tasks(goal.id).map((r) => [r.task_id, r]));
    const sib = beside.map((f) => ({ f, paths: json<string[]>(besideRows.get(f.id)?.paths ?? null, []) })).filter((s) => s.paths.length > 0);
    if (sib.length) {
      lines.push("Tasks of the same goal running beside it plan to change these paths (data):", "<<<", ...sib.map((s) => `- task ${s.f.label}: ${s.paths.join(", ")}`), ">>>");
      lines.push("Do not change these files; if you must, say so in a report.");
    }
    return lines.join("\n");
  }

  /** A finished task's latest report event: its researcher's findings or its reviewer's verdict. */
  private latestReport(taskId: string): { seq: number; payload: string } | null {
    return this.rows.one<{ seq: number; payload: string }>("select seq, payload from events where task_id = ? and kind in ('research.findings', 'review.verdict') order by seq desc limit 1", taskId) ?? null;
  }

  /** A finished task's report summary: the latest one. */
  private reportSummary(taskId: string): string | null {
    return summaryOf(this.latestReport(taskId)?.payload ?? null);
  }

  /** The report you accepted for a task, by the event it was read from; null when none was pinned. */
  private acceptedSummary(goalId: string, taskId: string): string | null {
    const seq = this.events
      .read(goalId, "goal.report_accepted")
      .filter((e) => e.payload.taskId === taskId)
      .at(-1)?.payload.reportSeq;
    if (typeof seq !== "number") return null;
    const row = this.rows.one<{ payload: string }>("select payload from events where seq = ? and task_id = ? and kind in ('research.findings', 'review.verdict')", seq, taskId);
    return summaryOf(row?.payload ?? null);
  }

  // ---------------------------------------------------------------- the pass

  /**
   * One scheduling pass over every approved goal (design §4.7). Each goal runs inside its own
   * try/catch: a throw from one goal becomes a decision and a hold for that goal only, and the pass
   * goes on, so one broken goal never stops scheduling for every task in every project.
   */
  async pass(): Promise<GoalPassResult> {
    const held = new Set<string>();
    const rerun = new Set<string>();
    if (this.closed) return { held, rerun };
    for (const id of this.rows.stoppedGoalTasks()) held.add(id);
    const pausedAll = this.pausedAll();
    for (const goal of this.rows.activeGoals()) {
      if (this.settled.has(goal.id) && this.settled.get(goal.id) === goal.approved_at) continue;
      try {
        await this.passGoal(goal, pausedAll, held, rerun);
      } catch (err) {
        this.failGoal(goal, err, held);
      }
    }
    return { held, rerun };
  }

  /**
   * Released tasks are ordinary approved tasks and go on; the ones the goal has not released yet
   * show why. A paused goal stays paused even when its pass failed.
   */
  private failGoal(goal: GoalRow, err: unknown, held: Set<string>): void {
    try {
      const code = err instanceof GoalError ? err.code : errorCode(err);
      const fresh = this.rows.goal(goal.id);
      const paused = fresh.paused_at !== null || this.pausedAll().on;
      for (const t of this.rows.tasks(goal.id)) {
        if (paused) held.add(t.task_id);
        if (t.accepted === 1 && t.released_at === null && t.discarded_at === null) this.hold(goal, t.task_id, { code: "goal.error", params: { code } });
      }
      if (paused && goal.integration_task_id) held.add(goal.integration_task_id);
      // Written once per error, not on every tick while the goal stays broken.
      if (this.failing.get(goal.id) !== code) this.events.append(goal.project_id, goal.id, "goal.error", { code, detail: err instanceof Error ? cleanText(err.message).slice(0, 300) : null });
      this.failing.set(goal.id, code);
      this.rows.raiseDecision(goal, "stuck", null, { detail: code });
      this.announce(goal.id, "decision");
    } catch {
      // The store is closing; the next pass tries again.
    }
  }

  private async passGoal(goal: GoalRow, pausedAll: PausedAll, held: Set<string>, rerun: Set<string>): Promise<void> {
    const all = this.rows.tasks(goal.id);
    // Pause means pause: no new run of any goal task starts, nothing is released or merged. It is
    // checked first, so nothing that could fail later in the pass can let a paused goal's step start.
    if (goal.paused_at || pausedAll.on) {
      const reason: Reason = { code: goal.paused_at ? "goal.paused" : "goal.paused_all" };
      for (const t of all) {
        held.add(t.task_id);
        this.hold(goal, t.task_id, reason);
      }
      if (goal.integration_task_id) held.add(goal.integration_task_id);
      this.announce(goal.id, "paused");
      return;
    }
    this.recordFailures(goal);
    goal = this.stopRule(goal);
    await this.mergeFinished(goal);
    let facts = this.facts(goal.id);
    this.prerequisiteDecisions(goal, facts);
    if (goal.halted_at) {
      for (const f of facts.filter((x) => isLive(x) && !x.released)) this.hold(goal, f.id, { code: "goal.halted" });
    } else {
      await this.release(goal, facts);
      facts = this.facts(goal.id);
    }
    await this.integrationStep(goal, facts, rerun);
    this.clearError(goal);
    this.stuckCheck(goal);
    this.finishedCheck(goal);
    this.announce(goal.id, "released");
  }

  /**
   * The goal's pass went through again: a stuck decision raised for a pass error (a detail and no
   * waiting tasks) no longer describes the goal, so it closes with no answer, and goal.error may be
   * written again if the error comes back.
   */
  private clearError(goal: GoalRow): void {
    this.failing.delete(goal.id);
    for (const d of this.rows.decisions(goal.id, true).filter((x) => x.kind === "stuck")) {
      const p = json<GoalDecisionPayload>(d.payload, {});
      if (p.waiting !== undefined || p.detail === undefined) continue;
      if (this.rows.run("update goal_decisions set answered_at = ? where id = ? and answered_at is null", this.iso(), d.id) === 1) {
        this.events.append(goal.project_id, goal.id, "goal.decision_closed", { decisionId: d.id, kind: d.kind, why: "error_cleared" });
        this.announce(goal.id, "decided", true);
      }
    }
  }

  /** A goal task that failed is written down once per failed run, so the stop rule counts it after a restart too. */
  private recordFailures(goal: GoalRow): void {
    const seen = new Set(this.events.read(goal.id, "goal.task_failed").map((e) => e.payload.runId as string));
    for (const t of this.rows.tasks(goal.id)) {
      const task = this.db.task(t.task_id);
      if (this.db.status(task) !== "failed") continue;
      const runs = this.db.runs(task.id);
      const failed = runs.filter((r) => r.end_reason === "failed" && !this.db.successor(r, runs) && r.resume_at === null).at(-1);
      if (!failed || seen.has(failed.id)) continue;
      this.events.append(goal.project_id, goal.id, "goal.task_failed", { taskId: task.id, runId: failed.id, detail: failed.end_detail });
    }
  }

  /**
   * The stop rule (design §4.7): two goal tasks failing with the same failure key, or three failed
   * goal tasks, halt the goal. Only failures after the halt was last lifted count (your `Resume`, or
   * your approval of a revision while it was halted), or the same failures would halt it again at once.
   */
  private stopRule(goal: GoalRow): GoalRow {
    if (goal.halted_at) return goal;
    const resumed = this.events.read(goal.id, "goal.halt_lifted").at(-1)?.seq;
    const failures = this.events
      .read(goal.id, "goal.task_failed")
      .filter((e) => resumed === undefined || e.seq > resumed)
      .map((e) => ({ taskId: e.payload.taskId as string, detail: (e.payload.detail as string | null) ?? null }));
    const rule = goalStopRule(failures);
    if (!rule.halt) return goal;
    const at = this.iso();
    this.rows.run("update goals set halted_reason = ?, halted_at = ? where id = ? and halted_at is null", rule.reason, at, goal.id);
    this.events.append(goal.project_id, goal.id, "goal.halted", { rule: rule.reason, taskIds: rule.taskIds, ...(rule.reason === "same_failure" ? { key: rule.key } : {}) });
    this.rows.raiseDecision(goal, "stop_rule", null, { rule: rule.reason, waiting: rule.taskIds, ...(rule.reason === "same_failure" ? { detail: rule.key } : {}) });
    this.announce(goal.id, "halted", true);
    return this.rows.goal(goal.id);
  }

  /** Merges every writing task whose gates passed and that has not joined; a conflict waits for your answer. */
  private async mergeFinished(goal: GoalRow): Promise<void> {
    if (!goal.integration_task_id) return;
    const open = new Set(this.rows.decisions(goal.id, true).filter((d) => d.kind === "conflict").map((d) => d.task_id));
    for (const f of this.facts(goal.id)) {
      if (!isLive(f) || !awaitingJoin(f) || open.has(f.id)) continue;
      if (!(await this.join.gatesPassed(f.id))) continue;
      const res = await this.join.merge(this.rows.goal(goal.id), f.id);
      if (res?.outcome === "joined") this.announce(goal.id, "joined", true);
      else if (res?.outcome === "conflict") {
        this.hold(goal, f.id, { code: "goal.conflict", params: { paths: res.paths.join(", ") } });
        this.announce(goal.id, "conflict", true);
      }
    }
  }

  /**
   * A cancelled or skipped prerequisite never counts as satisfied, and the scheduler does not decide
   * what that means for the tasks that wait for it: one decision per prerequisite asks you.
   */
  private prerequisiteDecisions(goal: GoalRow, facts: GoalTaskFacts[]): void {
    const byId = new Map(facts.map((f) => [f.id, f]));
    const waiting = new Map<string, string[]>();
    for (const f of facts.filter((x) => isLive(x) && !x.released)) {
      for (const u of unmetPrerequisites(f, byId)) {
        if (u.why !== "cancelled" && u.why !== "skipped") continue;
        waiting.set(u.on, [...(waiting.get(u.on) ?? []), f.id]);
      }
    }
    for (const [prereq, tasks] of waiting) {
      if (this.rows.raiseDecision(goal, "prerequisite", prereq, { waiting: tasks })) this.announce(goal.id, "decision", true);
    }
  }

  /** Releases ready tasks in order until the goal's parallel cap is reached (design §4.5, §4.7). */
  private async release(goal: GoalRow, facts: GoalTaskFacts[]): Promise<void> {
    const ready = readySet(facts);
    let room = releaseRoom(facts, goal.max_parallel);
    let running = releasedUnfinished(facts);
    for (const f of facts.filter((x) => isLive(x) && !x.released && !ready.includes(x.id))) {
      const why = prerequisiteHold(f, facts);
      if (why) this.hold(goal, f.id, why);
    }
    for (const id of ready) {
      const f = facts.find((x) => x.id === id)!;
      if (room <= 0) {
        this.hold(goal, id, { code: "goal.parallel_cap", params: { running, max: goal.max_parallel } });
        continue;
      }
      if (await this.releaseTask(goal, f)) {
        room--;
        running++;
      }
    }
  }

  /**
   * Release (design §4.5): the crew is checked again and approved in one transaction, audited as
   * `task.approved {by: "goal"}`. It never goes through TaskFlow.approve, whose emit and tick would
   * re-enter this pass. A profile that went away since approval asks you, never a silent substitute.
   */
  private async releaseTask(goal: GoalRow, f: GoalTaskFacts): Promise<boolean> {
    const task = this.db.task(f.id);
    if (f.writes) await this.join.ensureGoalWorktree(goal);
    const approved = await this.approveCrew(goal, task, () => {
      const row = this.rows.goalTask(task.id);
      const g = this.rows.goal(goal.id);
      return row !== null && row.accepted === 1 && row.released_at === null && row.discarded_at === null && !g.paused_at && !g.stopped_at && !g.halted_at;
    });
    if (!approved) return false;
    this.rows.run("update goal_tasks set released_at = ? where task_id = ? and released_at is null", this.iso(), task.id);
    const plan = this.rows.one<{ revision: number }>("select p.revision from goal_plans p join goal_tasks gt on gt.plan_id = p.id where gt.task_id = ?", task.id);
    this.audit(task.id, null, "task.approved", { by: "goal", goalId: goal.id, revision: plan?.revision ?? null });
    this.events.append(goal.project_id, goal.id, "goal.task_released", { taskId: task.id, key: this.rows.goalTask(task.id)?.key ?? null });
    this.holds.delete(task.id);
    this.emitTask(task.id, "goal");
    return true;
  }

  /** Re-checks the crew and approves it in one transaction, if `still()` holds there too. */
  private async approveCrew(goal: GoalRow, task: TaskRow, still: () => boolean): Promise<boolean> {
    const crew = this.db.crew(task.id);
    if (!crew || crew.approved_at || task.cancelled_at) return false;
    const members = this.db.members(crew.id).filter((m) => !m.skipped_at);
    const views = new Map(members.map((m) => [m.id, m.chosen ? (JSON.parse(m.chosen) as CandidateView) : null]));
    const candidates = await this.candidates(this.db.project(task.project_id));
    const problem = validateCrew({ members: members.map((m) => ({ id: m.id, role: m.role, template: this.tpl(m) })), views, candidates, available: (c) => c.ready });
    if (problem) {
      const profileId = typeof problem.params.profileId === "string" ? problem.params.profileId : undefined;
      this.rows.raiseDecision(goal, "profile_gone", task.id, { detail: problem.code, ...(profileId ? { profileId } : {}) });
      this.announce(goal.id, "decision", true);
      return false;
    }
    const estimate = sumEstimates(members.map((m) => views.get(m.id)?.estimate ?? { usd: null, provenance: "unknown" as const }));
    return this.db.tx(() => {
      const now = this.db.crew(task.id);
      if (!now || now.id !== crew.id || now.approved_at || this.db.task(task.id).cancelled_at || !still()) return false;
      this.db.exec("update crews set approved_at = ?, estimate_usd = ?, estimate_provenance = ? where id = ?", this.iso(), estimate.usd, estimate.provenance, crew.id);
      return true;
    });
  }

  /**
   * The last review (design §4.9, §4.12): released once every accepted writing task has joined the
   * goal branch, and run again when new work joined after it reviewed. A `changes` verdict on the
   * branch's tip asks you; it never becomes a plan by itself.
   */
  private async integrationStep(goal: GoalRow, facts: GoalTaskFacts[], rerun: Set<string>): Promise<void> {
    if (!goal.integration_task_id) return;
    const integration = this.db.task(goal.integration_task_id);
    if (integration.cancelled_at) return;
    const writers = facts.filter((f) => isLive(f) && f.writes);
    if (writers.length === 0 || writers.some((w) => !w.joined)) {
      if (!this.db.crew(integration.id)?.approved_at) this.hold(goal, integration.id, { code: "goal.waits_join", params: { task: writers.find((w) => !w.joined)?.label ?? "", taskId: writers.find((w) => !w.joined)?.id ?? "" } });
      return;
    }
    await this.join.ensureGoalWorktree(goal);
    const crew = this.db.crew(integration.id);
    if (!crew) return;
    if (!crew.approved_at) {
      const ok = await this.approveCrew(goal, integration, () => !this.rows.goal(goal.id).stopped_at);
      if (ok) {
        this.audit(integration.id, null, "task.approved", { by: "goal", goalId: goal.id, revision: this.rows.goal(goal.id).approved_revision });
        this.events.append(goal.project_id, goal.id, "goal.task_released", { taskId: integration.id, key: "review" });
        this.holds.delete(integration.id);
        this.emitTask(integration.id, "goal");
      }
      return;
    }
    const reviewer = this.db.members(crew.id).find((m) => m.role === "reviewer");
    if (!reviewer) return;
    const runs = this.db.runs(integration.id);
    const last = runs.filter((r) => r.member_id === reviewer.id).at(-1);
    if (!last || last.ended_at === null || this.db.successor(last, runs) || last.end_reason !== "completed") return;
    const head = this.join.recordedHead(goal);
    const verdict = this.loops.verdict(last.id);
    if (verdict && head && verdict.headSha !== null && verdict.headSha !== head) {
      // Run again only when our merges moved the branch past what the review read. A review that read
      // a later commit made outside our merges already covers the recorded tip: no rerun, or every
      // review would ask for the next one with no click (design §1.3).
      const project = this.db.project(goal.project_id);
      if (await isAncestor(project.path, head, verdict.headSha, this.opts.gitBin)) this.reviewCovers.add(last.id);
      else {
        rerun.add(reviewer.id);
        return;
      }
    }
    if (verdict?.verdict === "changes") {
      const fresh = this.rows.decisions(goal.id).some((d) => d.kind === "changes" && d.created_at >= (last.ended_at ?? ""));
      if (!fresh && this.rows.raiseDecision(goal, "changes", integration.id, { findings: verdictText(verdict), detail: verdict.summary })) this.announce(goal.id, "decision", true);
    }
  }

  /** Stuck: accepted unfinished tasks, none active, none releasable. It says which chain blocks. */
  private stuckCheck(goal: GoalRow): void {
    const s = this.state(goal.id);
    if (s.status !== "needs_you" || s.reason !== "stuck") return;
    if (this.rows.raiseDecision(goal, "stuck", null, s.stuck ? { waiting: [s.stuck.taskId], detail: `${s.stuck.why}:${s.stuck.waitsFor}` } : {})) this.announce(goal.id, "decision", true);
  }

  private finishedCheck(goal: GoalRow): void {
    const s = this.state(goal.id);
    if (s.status !== "finished" && s.status !== "ready_for_review") return;
    if (s.status === "finished") this.settled.set(goal.id, goal.approved_at);
    const kind = s.status === "finished" ? `finished:${s.outcome}` : "ready_for_review";
    if (this.events.read(goal.id, "goal.finished").some((e) => e.payload.state === kind)) return;
    this.events.append(goal.project_id, goal.id, "goal.finished", { state: kind });
    this.announce(goal.id, "finished", true);
  }

  /** Keeps why a task waits, and writes `goal.task_held` only when the reason changes. */
  private hold(goal: GoalRow, taskId: string, reason: Reason): void {
    const prev = this.holds.get(taskId);
    if (prev && prev.code === reason.code && JSON.stringify(prev.params ?? {}) === JSON.stringify(reason.params ?? {})) return;
    this.holds.set(taskId, reason);
    this.events.append(goal.project_id, goal.id, "goal.task_held", { taskId, reason });
    try {
      this.emitTask(taskId, "goal");
    } catch {
      // A task row that went away has nothing to tell the window.
    }
  }

  // ---------------------------------------------------------------- approval

  /**
   * `Approve and start n tasks` (design §4.5): one click per revision, idempotent. Refused unless the
   * revision is the latest one that is ready; a repeated call for an approved revision returns
   * without writing anything. Every accepted task's crew is checked, no accepted task may wait for a
   * skipped one, and the goal budget, which is always required, is split into task budgets that the
   * existing caps enforce. The crews stay unapproved until the scheduler releases each task.
   */
  async approve(p: GoalApproveParams): Promise<void> {
    for (;;) {
      const pending = this.approving.get(p.goalId);
      if (!pending) break;
      await pending.catch(() => undefined);
    }
    const run = this.doApprove(p);
    const tracked = run.finally(() => this.approving.delete(p.goalId));
    this.approving.set(p.goalId, tracked);
    await tracked;
  }

  private async doApprove(p: GoalApproveParams): Promise<void> {
    let goal = this.rows.goal(p.goalId);
    if (goal.stopped_at) throw new GoalError("goal.stopped");
    if (goal.collapsed_task_id) throw new GoalError("goal.not_ready");
    const plans = this.rows.plans(goal.id);
    const latest = plans.at(-1);
    const target = plans.find((x) => x.revision === p.revision);
    // The same click twice: the revision it approved is still the latest; nothing more to do.
    if (target?.approved_at && target.revision === latest?.revision) return;
    if (!target || !latest || target.revision !== latest.revision) throw new GoalError("goal.stale_revision", { revision: p.revision, latest: latest?.revision ?? 0 });
    if (target.plan === null || target.superseded_at || target.error) throw new GoalError("goal.not_ready");
    const limits = parseGoalLimits({ budgetUsd: p.budgetUsd, maxParallel: p.maxParallel });
    if (!limits.ok) throw new GoalError("goal.bad_budget", { field: /maxParallel/.test(limits.error) ? "maxParallel" : "budgetUsd" });
    const budgetUsd = limits.value.budgetUsd!;
    const maxParallel = limits.value.maxParallel!;

    const all = this.rows.tasks(goal.id);
    const mine = all.filter((t) => t.plan_id === target.id && t.discarded_at === null);
    const byKey = new Map(mine.map((t) => [t.key, t]));
    const accept = new Set<string>();
    for (const key of p.accept) {
      if (!byKey.has(key)) throw new GoalError("goal.task_not_found", { key });
      accept.add(key);
    }
    if (accept.size === 0) throw new GoalError("goal.no_accepted");
    // Tasks earlier revisions accepted and that still count: they keep their shares.
    const kept = all.filter((t) => t.plan_id !== target.id && t.accepted === 1 && t.discarded_at === null && !this.db.task(t.task_id).cancelled_at);
    if (kept.length + accept.size > goal.max_tasks) throw new GoalError("goal.too_many", { max: goal.max_tasks });
    const acceptedIds = new Set([...kept.map((t) => t.task_id), ...mine.filter((t) => accept.has(t.key)).map((t) => t.task_id)]);

    const project = this.db.project(goal.project_id);
    const candidates = await this.candidates(project);
    for (const t of mine.filter((x) => accept.has(x.key))) {
      const crew = this.db.crew(t.task_id);
      const members = crew ? this.db.members(crew.id).filter((m) => !m.skipped_at) : [];
      if (!crew || members.length === 0) throw new GoalError("goal.crew", { task: t.key, code: "crew.missing_profile" });
      const views = new Map(members.map((m) => [m.id, m.chosen ? (JSON.parse(m.chosen) as CandidateView) : null]));
      const problem = validateCrew({ members: members.map((m) => ({ id: m.id, role: m.role, template: this.tpl(m) })), views, candidates, available: (c) => c.ready });
      if (problem) throw new GoalError("goal.crew", { task: t.key, code: problem.code });
    }

    const deps = this.rows.deps(goal.id);
    const live = [...kept, ...mine];
    const nodes: DagNode[] = live.map((t) => {
      const mineDeps = deps.filter((d) => d.task_id === t.task_id);
      return { id: t.task_id, dependsOn: mineDeps.map((d) => d.depends_on), overlap: mineDeps.filter((d) => d.source === "overlap").map((d) => d.depends_on) };
    });
    const skipped = skippedDependency(nodes, acceptedIds);
    if (skipped) throw new GoalError("goal.skipped_dependency", { task: this.keyOf(live, skipped.taskId), dependsOn: this.keyOf(live, skipped.dependsOn) });

    // The goal budget split (design §4.5): kept tasks keep their shares; the rest is split by estimate.
    const writes = live.some((t) => acceptedIds.has(t.task_id) && t.writes === 1);
    const items: BudgetItem[] = [];
    for (const t of kept) {
      const share = this.db.task(t.task_id).budget_usd;
      items.push(share && share > 0 ? { id: t.task_id, estimate: { usd: share, provenance: "estimated" }, typedUsd: share } : { id: t.task_id, estimate: { usd: 0, provenance: "estimated" } });
    }
    for (const t of mine.filter((x) => accept.has(x.key))) {
      const crew = this.db.crew(t.task_id)!;
      items.push({ id: t.task_id, estimate: { usd: crew.estimate_usd, provenance: crew.estimate_provenance }, typedUsd: p.taskBudgets?.[t.key] ?? null });
    }
    const integrationShare = goal.integration_task_id ? this.db.task(goal.integration_task_id).budget_usd : null;
    let reviewEstimate: CostEstimate | null = null;
    if (writes) {
      if (goal.integration_task_id && integrationShare && integrationShare > 0) items.push({ id: "review", estimate: { usd: integrationShare, provenance: "estimated" }, typedUsd: integrationShare });
      else {
        reviewEstimate = (await this.deps.preview(this.integrationDraft(goal))).estimate;
        items.push({ id: "review", estimate: reviewEstimate, typedUsd: p.taskBudgets?.review ?? null });
      }
    }
    const split = splitBudget(budgetUsd, items);
    if (!split.ok) {
      if (split.code === "needs_budget") throw new GoalError("goal.needs_budget", { task: split.id === "review" ? "review" : this.keyOf(live, split.id) });
      if (split.code === "typed_over") throw new GoalError("goal.typed_over", { typedTotalUsd: split.typedTotalUsd, budgetUsd: split.budgetUsd });
      if (split.code === "over_budget") throw new GoalError("goal.over_budget", { totalUsd: split.totalUsd, budgetUsd: split.budgetUsd });
      throw new GoalError("goal.bad_budget", { field: split.id ? this.keyOf(live, split.id) : "budgetUsd" });
    }

    // Everything checked: the goal branch's base, then the hidden integration task.
    if (!goal.base_sha) {
      const sha = await resolveBase(project.path, goal.base_branch, this.opts.gitBin);
      this.rows.run("update goals set base_sha = ? where id = ? and base_sha is null", sha, goal.id);
    }
    if (writes && !goal.integration_task_id) await this.createIntegration(goal);
    goal = this.rows.goal(goal.id);

    const at = this.iso();
    const accepted = mine.filter((t) => accept.has(t.key));
    const skippedRows = mine.filter((t) => !accept.has(t.key));
    let liftedHalt = false;
    const done = this.db.tx(() => {
      const now = this.rows.one<GoalPlanRow>("select * from goal_plans where id = ?", target.id);
      const newest = this.rows.latestPlan(goal.id);
      if (!now || now.approved_at || now.superseded_at || newest?.id !== now.id || this.rows.goal(goal.id).stopped_at) return false;
      for (const t of accepted) {
        this.rows.run("update goal_tasks set accepted = 1 where task_id = ?", t.task_id);
        this.rows.run("update tasks set budget_usd = ? where id = ?", split.shares[t.task_id] ?? 0, t.task_id);
      }
      // Nothing ran for a skipped task; cancelling its proposal stops nothing and keeps it off the list.
      for (const t of skippedRows) {
        this.rows.run("update goal_tasks set accepted = 0 where task_id = ?", t.task_id);
        this.rows.run("update tasks set cancelled_at = ? where id = ? and cancelled_at is null", at, t.task_id);
      }
      if (goal.integration_task_id && split.shares.review !== undefined && !(integrationShare && integrationShare > 0)) this.rows.run("update tasks set budget_usd = ? where id = ?", split.shares.review, goal.integration_task_id);
      this.addOverlapOrder(goal.id, [...kept, ...mine], acceptedIds);
      // Your approval of a revision is also your answer to a halt: the new plan starts from here.
      liftedHalt = this.rows.goal(goal.id).halted_at !== null;
      this.rows.run("update goals set approved_revision = ?, approved_at = ?, budget_usd = ?, max_parallel = ?, halted_reason = null, halted_at = null where id = ?", target.revision, at, budgetUsd, maxParallel, goal.id);
      this.rows.run("update goal_plans set approved_at = ? where id = ?", at, target.id);
      return true;
    });
    if (!done) {
      const again = this.rows.one<GoalPlanRow>("select * from goal_plans where id = ?", target.id);
      if (again?.approved_at) return;
      throw new GoalError("goal.stale_revision", { revision: p.revision, latest: this.rows.latestPlan(goal.id)?.revision ?? 0 });
    }
    // The failures that halted the goal stay behind: only new ones count toward the stop rule again.
    if (liftedHalt) this.events.append(goal.project_id, goal.id, "goal.halt_lifted", { by: "approval", revision: target.revision });
    const shares = Object.fromEntries(Object.entries(split.shares).map(([id, usd]) => [id === "review" ? "review" : this.keyOf(live, id), usd]));
    this.events.append(goal.project_id, goal.id, "goal.approved", {
      revision: target.revision,
      accepted: accepted.map((t) => t.key),
      skipped: skippedRows.map((t) => t.key),
      budgetUsd,
      maxParallel,
      shares,
      ...(reviewEstimate ? { reviewEstimate } : {}),
    });
    for (const t of [...accepted, ...skippedRows]) this.emitTask(t.task_id, "goal");
    if (goal.integration_task_id) {
      // The goal branch is made now when it can be; the pass makes it later if git was busy.
      await this.join.ensureGoalWorktree(goal).catch(() => undefined);
    }
    this.announce(goal.id, "approved", true);
    await this.deps.tick();
  }

  private keyOf(rows: GoalTaskRow[], taskId: string): string {
    return rows.find((r) => r.task_id === taskId)?.key ?? taskId;
  }

  /** The last review as a task draft: one read-only reviewer step, its input the goal text. */
  private integrationDraft(goal: GoalRow): TaskPreviewParams {
    return { projectId: goal.project_id, title: `Review all changes: ${goal.title}`, description: goal.text, kind: "review", size: "M", mode: "solo" };
  }

  /**
   * The hidden integration task (design §4.9): kind code, so its reviewer reads a pinned checkout
   * of the goal branch's head and the existing PR gate requires its `pass`; one reviewer step, drafted
   * as a Solo review and stored as code in the transaction that ties it to the goal.
   */
  private async createIntegration(goal: GoalRow): Promise<void> {
    const draft = this.integrationDraft(goal);
    const t = await this.deps.propose(
      { projectId: draft.projectId, title: draft.title, description: draft.description, kind: "review", size: "M", mode: "solo", ...(goal.base_branch ? { baseBranch: goal.base_branch } : {}) },
      {
        inTx: (taskId) => {
          this.rows.run("update tasks set kind = 'code' where id = ?", taskId);
          if (this.rows.run("update goals set integration_task_id = ? where id = ? and integration_task_id is null", taskId, goal.id) !== 1) throw new GoalError("goal.stale_revision");
        },
      },
    );
    this.events.append(goal.project_id, goal.id, "goal.integration_created", { taskId: t.id, branch: GoalJoin.branchFor(goal) });
  }

  /**
   * Runs the file-overlap ordering again with the accepted set (design §4.8): a pair that was
   * ordered only through a skipped task gets its own edge. A pair you set side by side (overlapping,
   * not ordered in the full plan) stays side by side.
   */
  private addOverlapOrder(goalId: string, rows: GoalTaskRow[], accepted: ReadonlySet<string>): void {
    const deps = this.rows.deps(goalId);
    const full: DagNode[] = rows.map((r) => ({ id: r.task_id, dependsOn: deps.filter((d) => d.task_id === r.task_id).map((d) => d.depends_on) }));
    const sideBySide: Array<[string, string]> = [];
    const writers = rows.filter((r) => r.writes === 1);
    for (let i = 0; i < writers.length; i++)
      for (let j = i + 1; j < writers.length; j++) {
        const a = writers[i]!.task_id;
        const b = writers[j]!.task_id;
        if (!ancestorsOf(full, a).has(b) && !ancestorsOf(full, b).has(a)) sideBySide.push([a, b]);
      }
    const keep = rows.filter((r) => accepted.has(r.task_id));
    const input: OverlapTask[] = keep.map((r) => ({
      id: r.task_id,
      position: r.position,
      writes: r.writes === 1,
      accepted: true,
      paths: json<string[]>(r.paths, []),
      dependsOn: deps.filter((d) => d.task_id === r.task_id && accepted.has(d.depends_on)).map((d) => d.depends_on),
    }));
    for (const e of overlapPairs(input, { sideBySide })) {
      this.rows.run("insert or ignore into goal_task_deps (goal_id, task_id, depends_on, source) values (?, ?, ?, 'overlap')", goalId, e.taskId, e.dependsOn);
    }
  }

  // ---------------------------------------------------------------- your clicks

  /** You read a report a writing task builds on and pass it on (design §4.6). Idempotent. */
  acceptReport(goalId: string, taskId: string): void {
    const goal = this.rows.goal(goalId);
    const gt = this.rows.goalTask(taskId);
    if (!gt || gt.goal_id !== goal.id) throw new GoalError("goal.task_not_found", { taskId });
    if (gt.writes === 1) throw new GoalError("goal.not_report");
    const facts = this.facts(goal.id);
    const waitsForIt = facts.some((f) => isLive(f) && f.writes && f.deps.some((d) => d.on === taskId && d.source !== "overlap"));
    if (!waitsForIt) throw new GoalError("goal.not_report");
    const status = this.db.status(this.db.task(taskId));
    if (status !== "done" && status !== "review") throw new GoalError("goal.report_not_done");
    if (!gt.report_accepted_at) {
      this.rows.run("update goal_tasks set report_accepted_at = ? where task_id = ? and report_accepted_at is null", this.iso(), taskId);
      // The report you read is pinned by its event, so a later run's report is never passed on as accepted.
      this.events.append(goal.project_id, goal.id, "goal.report_accepted", { taskId, reportSeq: this.latestReport(taskId)?.seq ?? null });
    }
    for (const d of this.rows.decisions(goal.id, true).filter((x) => x.kind === "report" && x.task_id === taskId)) this.rows.answerDecision(d, "accept_report");
    this.emitTask(taskId, "goal");
    this.announce(goal.id, "report_accepted", true);
    void this.deps.tick();
  }

  /** The goal's open runs: its tasks' and its last review's. */
  private goalRuns(goal: GoalRow) {
    const ids = [...this.rows.tasks(goal.id).map((t) => t.task_id), ...(goal.integration_task_id ? [goal.integration_task_id] : [])];
    return ids.flatMap((id) => this.db.runs(id));
  }

  /** Pauses running steps at their next turn boundary; no new run of a goal task starts (design §5.2). */
  async pause(goalId: string): Promise<void> {
    const goal = this.rows.goal(goalId);
    if (goal.stopped_at) throw new GoalError("goal.stopped");
    if (!goal.paused_at) {
      this.rows.run("update goals set paused_at = ? where id = ? and paused_at is null", this.iso(), goal.id);
      this.events.append(goal.project_id, goal.id, "goal.paused", {});
    }
    for (const r of this.goalRuns(goal).filter((x) => x.ended_at === null && x.paused_at === null)) await this.deps.pauseRun(r.id).catch(() => undefined);
    this.announce(goal.id, "paused", true);
    await this.deps.tick();
  }

  /** Lifts your Pause: the steps it paused go on, and the scheduler releases again. */
  async resume(goalId: string): Promise<void> {
    const goal = this.rows.goal(goalId);
    if (goal.stopped_at) throw new GoalError("goal.stopped");
    if (!goal.paused_at) throw new GoalError("goal.not_paused");
    this.rows.run("update goals set paused_at = null where id = ?", goal.id);
    this.events.append(goal.project_id, goal.id, "goal.resumed", {});
    if (!this.pausedAll().on) for (const r of this.goalRuns(goal).filter((x) => x.ended_at === null && x.paused_at !== null && x.paused_at >= goal.paused_at!)) await this.deps.resumeRun(r.id).catch(() => undefined);
    this.announce(goal.id, "resumed", true);
    await this.deps.tick();
  }

  /** `Pause all goals`, the global kill switch (design §5.2); lifting it is your click too. */
  async pauseAll(on: boolean): Promise<{ pausedAll: boolean }> {
    const before = this.pausedAll();
    const at = this.iso();
    this.rows.writeSetting(GOAL_SETTINGS.pausedAll, { on, at: on ? (before.on ? before.at : at) : null });
    for (const goal of this.rows.activeGoals()) {
      if (on) {
        for (const r of this.goalRuns(goal).filter((x) => x.ended_at === null && x.paused_at === null)) await this.deps.pauseRun(r.id).catch(() => undefined);
      } else if (before.on && !goal.paused_at) {
        for (const r of this.goalRuns(goal).filter((x) => x.ended_at === null && x.paused_at !== null && (before.at === null || x.paused_at >= before.at))) await this.deps.resumeRun(r.id).catch(() => undefined);
      }
      this.events.append(goal.project_id, goal.id, "goal.paused_all", { on });
      this.announce(goal.id, on ? "paused" : "resumed", true);
    }
    await this.deps.tick();
    return { pausedAll: on };
  }

  pausedAllState(): boolean {
    return this.pausedAll().on;
  }

  /** What `Stop goal` would cancel, for its confirmation. */
  stopPreview(goalId: string): GoalStopPreview {
    const goal = this.rows.goal(goalId);
    const cancel = this.stoppable(goal);
    const runs = this.goalRuns(goal);
    const planning = this.rows.plans(goal.id).flatMap((p) => (p.plan_task_id ? this.db.runs(p.plan_task_id) : []));
    return { cancelTasks: cancel.length, runningRuns: [...runs, ...planning].filter((r) => r.ended_at === null).length, spend: this.db.spend([...runs, ...planning]) };
  }

  /** Unfinished tasks of the goal, the last review and a planning run in progress. */
  private stoppable(goal: GoalRow): string[] {
    const facts = this.facts(goal.id);
    const out = facts.filter((f) => !f.discarded && f.status !== "cancelled" && !goalTaskFinished(f)).map((f) => f.id);
    if (goal.integration_task_id) {
      const st = this.db.status(this.db.task(goal.integration_task_id));
      if (st !== "merged" && st !== "cancelled") out.push(goal.integration_task_id);
    }
    const latest = this.rows.latestPlan(goal.id);
    if (latest?.plan_task_id && !this.db.task(latest.plan_task_id).cancelled_at && this.db.runs(latest.plan_task_id).some((r) => r.ended_at === null)) out.push(latest.plan_task_id);
    return out;
  }

  /** `Stop goal`: cancels every unfinished task of the goal. Worktrees and branches are kept. */
  async stop(goalId: string): Promise<void> {
    const goal = this.rows.goal(goalId);
    if (goal.stopped_at) return;
    this.rows.run("update goals set stopped_at = ? where id = ? and stopped_at is null", this.iso(), goal.id);
    const ids = this.stoppable(goal);
    for (const id of ids) await this.deps.cancel(id);
    this.events.append(goal.project_id, goal.id, "goal.stopped", { cancelled: ids });
    this.announce(goal.id, "stopped", true);
  }

  /**
   * Changes the goal's limits after approval. A new budget scales the unfinished tasks' shares in
   * the same proportion; finished ones keep theirs, and a budget under what they hold is refused.
   */
  setLimits(goalId: string, input: { budgetUsd?: number; maxParallel?: number }): void {
    const goal = this.rows.goal(goalId);
    if (goal.stopped_at) throw new GoalError("goal.stopped");
    const limits = parseGoalLimits(input);
    if (!limits.ok) throw new GoalError("goal.bad_budget", { field: /maxParallel/.test(limits.error) ? "maxParallel" : "budgetUsd" });
    const { budgetUsd, maxParallel } = limits.value;
    if (budgetUsd !== undefined && goal.approved_revision !== null && goal.budget_usd !== null) {
      const facts = this.facts(goal.id).filter(isLive);
      const shares = facts.map((f) => ({ id: f.id, shareUsd: this.db.task(f.id).budget_usd ?? 0, finished: goalTaskFinished(f) }));
      if (goal.integration_task_id) {
        const t = this.db.task(goal.integration_task_id);
        shares.push({ id: t.id, shareUsd: t.budget_usd ?? 0, finished: this.integrationFacts(goal)?.reviewPassed === true });
      }
      const next = rescaleShares(goal.budget_usd, budgetUsd, shares);
      if (!next) throw new GoalError("goal.under_spent", { spentUsd: shares.filter((s) => s.finished).reduce((a, s) => a + s.shareUsd, 0) });
      this.db.tx(() => {
        for (const [id, usd] of Object.entries(next)) this.rows.run("update tasks set budget_usd = ? where id = ?", usd, id);
      });
    }
    this.rows.run("update goals set budget_usd = coalesce(?, budget_usd), max_parallel = coalesce(?, max_parallel) where id = ?", budgetUsd ?? null, maxParallel ?? null, goal.id);
    this.events.append(goal.project_id, goal.id, "goal.limits", { ...(budgetUsd !== undefined ? { budgetUsd } : {}), ...(maxParallel !== undefined ? { maxParallel } : {}) });
    this.announce(goal.id, "limits", true);
    void this.deps.tick();
  }

  /**
   * Your answer to a goal decision (design §4.6 to §4.9). Only the answers the decision offers are
   * taken. `Replan` is recorded here; the planning run itself is the planner's (`goals.replan`), and
   * its approval lifts a halt. `I'll merge it` keeps the conflict open until you click `Check again`.
   */
  async decide(goalId: string, decisionId: string, action: GoalDecisionAction): Promise<void> {
    const goal = this.rows.goal(goalId);
    const d = this.rows.decision(decisionId);
    if (!d || d.goal_id !== goal.id) throw new GoalError("goal.decision_not_found");
    if (d.answered_at) throw new GoalError("goal.decision_answered");
    const payload = json<GoalDecisionPayload>(d.payload, {});
    // A decision may offer fewer answers than its kind (a merge with no conflicted file to resolve).
    const offered = payload.actions?.filter((a) => GOAL_DECISION_ACTIONS[d.kind].includes(a)) ?? GOAL_DECISION_ACTIONS[d.kind];
    if (!offered.includes(action)) throw new GoalError("goal.action", { action, kind: d.kind });
    let close = true;
    switch (action) {
      case "send_to_implementer":
        if (!d.task_id) throw new GoalError("goal.task_not_found");
        await this.join.sendToImplementer(goal, d.task_id, payload.paths ?? []);
        this.holds.delete(d.task_id);
        break;
      case "merge_myself":
        close = false;
        break;
      case "check_again":
        break;
      case "leave_out":
        if (d.task_id) await this.leaveOut(goal, d.task_id);
        break;
      case "run_without":
        this.runWithout(goal, d, payload);
        break;
      case "cancel_dependents":
        if (d.task_id) await this.cancelDependents(goal, d.task_id);
        break;
      case "replan":
        break;
      case "resume":
        this.rows.run("update goals set halted_reason = null, halted_at = null where id = ?", goal.id);
        this.events.append(goal.project_id, goal.id, "goal.halt_lifted", { by: "resume" });
        break;
      case "retry":
        await this.retryFailed(goal);
        break;
      case "stop":
        await this.stop(goal.id);
        break;
      case "accept_report":
        if (d.task_id) this.acceptReport(goal.id, d.task_id);
        break;
    }
    if (close) this.rows.answerDecision(d, action);
    this.events.append(goal.project_id, goal.id, "goal.decided", { decisionId: d.id, kind: d.kind, taskId: d.task_id, action, closed: close });
    if (action === "check_again" && d.task_id) await this.checkMergeNow(this.rows.goal(goal.id), d.task_id);
    this.announce(goal.id, "decided", true);
    await this.deps.tick();
  }

  /** `Check again` on a conflicted merge: closes its open conflict and tries the merge now. */
  async checkMerge(goalId: string, taskId: string): Promise<void> {
    const goal = this.rows.goal(goalId);
    const gt = this.rows.goalTask(taskId);
    if (!gt || gt.goal_id !== goal.id) throw new GoalError("goal.task_not_found", { taskId });
    if (!goal.integration_task_id) throw new GoalError("goal.no_integration");
    for (const d of this.rows.decisions(goal.id, true).filter((x) => x.kind === "conflict" && x.task_id === taskId)) {
      this.rows.answerDecision(d, "check_again");
      this.events.append(goal.project_id, goal.id, "goal.decided", { decisionId: d.id, kind: d.kind, taskId, action: "check_again", closed: true });
    }
    await this.checkMergeNow(goal, taskId);
    this.announce(goal.id, "decided", true);
    await this.deps.tick();
  }

  private async checkMergeNow(goal: GoalRow, taskId: string): Promise<void> {
    if (goal.paused_at || this.pausedAll().on || goal.stopped_at) return;
    const f = this.facts(goal.id).find((x) => x.id === taskId);
    if (!f || !isLive(f) || !awaitingJoin(f) || !(await this.join.gatesPassed(taskId))) return;
    this.holds.delete(taskId);
    const res = await this.join.merge(goal, taskId);
    if (res?.outcome === "conflict") this.hold(goal, taskId, { code: "goal.conflict", params: { paths: res.paths.join(", ") } });
  }

  /** `Leave 02 out of the goal`: discarded and cancelled; what waits for it gets the prerequisite decision. */
  private async leaveOut(goal: GoalRow, taskId: string): Promise<void> {
    const gt = this.rows.goalTask(taskId);
    if (!gt || gt.goal_id !== goal.id) throw new GoalError("goal.task_not_found", { taskId });
    if (gt.joined_sha) throw new GoalError("goal.frozen", { key: gt.key, because: "joined" });
    this.rows.run("update goal_tasks set discarded_at = ? where task_id = ? and discarded_at is null", this.iso(), taskId);
    await this.deps.cancel(taskId);
    this.holds.delete(taskId);
  }

  /** `Run without it`: the tasks that wait for a prerequisite you gave up on stop waiting for it. */
  private runWithout(goal: GoalRow, d: GoalDecisionRow, payload: GoalDecisionPayload): void {
    const facts = this.facts(goal.id);
    const byId = new Map(facts.map((f) => [f.id, f]));
    const waiting = new Set(payload.waiting ?? []);
    this.db.tx(() => {
      for (const f of facts.filter((x) => isLive(x) && !x.released && (waiting.size === 0 || waiting.has(x.id)))) {
        for (const u of unmetPrerequisites(f, byId)) {
          const givenUp = u.why === "failed" || u.why === "cancelled" || u.why === "skipped";
          if ((d.task_id ? u.on === d.task_id : givenUp) && givenUp) this.rows.run("delete from goal_task_deps where task_id = ? and depends_on = ?", f.id, u.on);
        }
      }
    });
  }

  /** `Cancel the tasks that wait for it`: every task that builds on it, directly or through others. */
  private async cancelDependents(goal: GoalRow, prereq: string): Promise<void> {
    const deps = this.rows.deps(goal.id);
    const nodes: DagNode[] = this.rows.tasks(goal.id).map((t) => ({
      id: t.task_id,
      dependsOn: deps.filter((d) => d.task_id === t.task_id).map((d) => d.depends_on),
      overlap: deps.filter((d) => d.task_id === t.task_id && d.source === "overlap").map((d) => d.depends_on),
    }));
    for (const id of goalDependents(nodes, prereq)) {
      const gt = this.rows.goalTask(id);
      if (!gt || gt.joined_sha || gt.discarded_at) continue;
      this.rows.run("update goal_tasks set discarded_at = ? where task_id = ? and discarded_at is null", this.iso(), id);
      await this.deps.cancel(id);
      this.holds.delete(id);
    }
  }

  /** `Retry` on a stuck goal: your click retries each failed goal task's failed step. */
  private async retryFailed(goal: GoalRow): Promise<void> {
    for (const f of this.facts(goal.id).filter((x) => isLive(x) && x.status === "failed")) {
      const runs = this.db.runs(f.id);
      const failed = runs.filter((r) => r.end_reason === "failed" && !this.db.successor(r, runs));
      for (const r of failed) await this.deps.retryRun(r.id).catch(() => undefined);
    }
  }
}

/** The last review's findings as plain text for the `changes` decision (shown, never executed). */
export function verdictText(v: { summary: string; comments: Array<{ file?: string | null; line?: number | null; body: string }> }): string {
  return capText(cleanText([v.summary, ...v.comments.map((c) => `- ${c.file ?? ""}${c.line ? `:${c.line}` : ""} ${c.body}`.trim())].join("\n")), VERDICT_TEXT_BYTES).text;
}

/** One agent-written commit subject for a prompt: cleaned, on one line, capped; empty when nothing is left. */
export function commitLine(line: string): string {
  return capText(cleanText(line).replace(/\s+/g, " "), COMMIT_LINE_BYTES).text;
}

const VERDICT_TEXT_BYTES = 4_000;
const COMMIT_LINE_BYTES = 200;

function summaryOf(payload: string | null): string | null {
  const summary = json<{ summary?: unknown } | null>(payload, null)?.summary;
  return typeof summary === "string" && summary.trim() ? summary : null;
}

