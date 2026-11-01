import {
  capText,
  cleanText,
  defaultGoalBudget,
  deriveGoalStatus,
  firstOverlap,
  frozenBecause,
  GOAL_DECISION_ACTIONS,
  GOAL_LIMITS,
  GOAL_SETTINGS,
  prerequisiteHold,
  unmetPrerequisites,
  type CostEstimate,
  type GoalDecisionAction,
  type GoalDecisionPayload,
  type GoalDecisionView,
  type GoalDetail,
  type GoalJoinView,
  type GoalPlan,
  type GoalPlanTask,
  type GoalRevisionView,
  type GoalState,
  type GoalSummary,
  type GoalTaskFacts,
  type GoalTaskView,
  type OverlapEdge,
  type PlanDiff,
  type PlanState,
  type Reason,
  type TaskStatus,
} from "@crewyard/core";
import type { OrchestratorContext } from "../context.ts";
import type { TaskRow } from "../db.ts";
import { Part } from "../part.ts";
import { GoalError } from "./events.ts";
import { GoalJoin } from "./join.ts";
import type { GoalDecisionRow, GoalDepRow, GoalPlanRow, GoalRow, GoalTaskRow } from "./runner.ts";

// What the goal view and the goal list read (design §3.3, §6.2): GoalSummary and GoalDetail, built
// from the goal tables, the tasks' runs and the parts' live facts on every call. Nothing here
// writes; every status is derived (D5) with the same core rules the scheduler uses. Plan, report,
// decision and error text is untrusted: it is passed on as plain text, cleaned and capped, and the
// renderer shows it as text. Every cost carries its provenance.

export interface GoalViewDeps {
  /** GoalPlanner.planState: a revision's state, counting a corrective turn that waits for its slot. */
  planState(p: GoalPlanRow): PlanState;
  /** GoalRunner.facts: what the release pass knows about each goal task. */
  facts(goalId: string): GoalTaskFacts[];
  /** GoalRunner.integrationState: the last review's status and whether it passed on the goal branch's tip. */
  integration(goalId: string): { status: TaskStatus; reviewPassed: boolean } | null;
  /** GoalRunner.goalRef(task).hold: the reason the last pass recorded for a held task. */
  hold(task: TaskRow): Reason | null;
  /** `Pause all goals`. */
  pausedAll(): boolean;
}

/** Longest error or decision text the view passes on; the full text stays in the store and the events. */
const TEXT_BYTES = 4_000;
const FREE: CostEstimate = { usd: 0, provenance: "estimated" };
const UNKNOWN: CostEstimate = { usd: null, provenance: "unknown" };

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** Untrusted text as the view passes it on: cleaned, capped, null when nothing is left. */
const plain = (v: unknown, max = TEXT_BYTES): string | null => {
  if (typeof v !== "string") return null;
  const s = capText(cleanText(v), max).text;
  return s ? s : null;
};

const strings = (v: unknown, max = 200): string[] => (Array.isArray(v) ? v.map((x) => plain(x, max)).filter((x): x is string => x !== null) : []);

/** A goal task's entry in its revision's plan, by key. */
const entryOf = (plan: GoalPlan | null, key: string): GoalPlanTask | null => plan?.tasks.find((t) => t.key === key) ?? null;

export class GoalViews extends Part {
  constructor(
    ctx: OrchestratorContext,
    private readonly deps: GoalViewDeps,
  ) {
    super(ctx);
  }

  // ---------------------------------------------------------------- rows

  private all<T>(q: string, ...args: Array<string | number | null>): T[] {
    return this.opts.store.db.prepare(q).all(...args) as unknown as T[];
  }

  private one<T>(q: string, ...args: Array<string | number | null>): T | undefined {
    return this.opts.store.db.prepare(q).get(...args) as T | undefined;
  }

  private goal(goalId: string): GoalRow {
    const g = this.one<GoalRow>("select * from goals where id = ?", goalId);
    if (!g) throw new GoalError("goal.not_found", { goalId });
    return g;
  }

  private plans(goalId: string): GoalPlanRow[] {
    return this.all<GoalPlanRow>("select * from goal_plans where goal_id = ? order by revision", goalId);
  }

  private rows(goalId: string): GoalTaskRow[] {
    return this.all<GoalTaskRow>("select * from goal_tasks where goal_id = ? order by position, task_id", goalId);
  }

  private setting(key: string): unknown {
    return json(this.one<{ value: string }>("select value from settings where key = ?", key)?.value, null);
  }

  // ---------------------------------------------------------------- status

  /**
   * The goal's status with the freshest facts each part holds: the planner's revision state (a
   * corrective turn waiting for its slot reads planning) and the runner's last-review verdict.
   */
  state(goalId: string): GoalState {
    return this.stateOf(this.goal(goalId), this.plans(goalId).at(-1) ?? null);
  }

  private stateOf(goal: GoalRow, latest: GoalPlanRow | null): GoalState {
    return deriveGoalStatus({
      stopped: goal.stopped_at !== null,
      paused: goal.paused_at !== null,
      pausedAll: this.deps.pausedAll(),
      halted: goal.halted_at !== null,
      collapsed: goal.collapsed_task_id !== null,
      latestPlan: latest ? this.deps.planState(latest) : null,
      openDecisions: this.all<{ kind: GoalDecisionRow["kind"]; task_id: string | null }>("select kind, task_id from goal_decisions where goal_id = ? and answered_at is null", goal.id).map((d) => ({ kind: d.kind, taskId: d.task_id })),
      tasks: this.deps.facts(goal.id),
      integration: goal.integration_task_id ? this.deps.integration(goal.id) : null,
    });
  }

  // ---------------------------------------------------------------- the list

  /** The project's goals, newest first. */
  list(projectId: string): GoalSummary[] {
    this.db.project(projectId);
    return this.all<GoalRow>("select * from goals where project_id = ? order by created_at desc, id desc", projectId).map((g) => this.summaryOf(g, this.plans(g.id)));
  }

  private summaryOf(goal: GoalRow, plans: GoalPlanRow[]): GoalSummary {
    const latest = plans.at(-1) ?? null;
    const s = this.stateOf(goal, latest);
    const planning = this.planningRuns(plans);
    const own = this.rows(goal.id).map((r) => r.task_id);
    const runs = [...own, ...(goal.integration_task_id ? [goal.integration_task_id] : [])].flatMap((id) => this.db.runs(id));
    return {
      id: goal.id,
      projectId: goal.project_id,
      title: plain(goal.title, GOAL_LIMITS.goalTitleBytes) ?? "",
      status: s.status,
      reason: s.reason,
      outcome: s.outcome,
      done: s.done,
      total: s.total,
      budgetUsd: goal.budget_usd,
      spend: this.db.spend([...runs, ...planning]),
      planningSpend: this.db.spend(planning),
      branch: goal.integration_task_id ? (this.db.worktree(goal.integration_task_id)?.branch ?? GoalJoin.branchFor(goal)) : null,
      paused: goal.paused_at !== null,
      halted: goal.halted_at ? { reason: goal.halted_reason ?? "", at: goal.halted_at } : null,
      latestRevision: latest?.revision ?? 0,
      approvedRevision: goal.approved_revision,
      integrationTaskId: goal.integration_task_id,
      collapsedTaskId: goal.collapsed_task_id,
      createdAt: goal.created_at,
    };
  }

  private planningRuns(plans: GoalPlanRow[]) {
    return plans.flatMap((p) => (p.plan_task_id ? this.db.runs(p.plan_task_id) : []));
  }

  // ---------------------------------------------------------------- the goal view

  /** Everything the goal view shows: revisions, tasks with why they wait, decisions, joins and budget. */
  detail(goalId: string): GoalDetail {
    const goal = this.goal(goalId);
    const plans = this.plans(goalId);
    const latest = plans.at(-1) ?? null;
    const summary = this.summaryOf(goal, plans);
    const state = this.stateOf(goal, latest);
    const approved = goal.approved_revision !== null;
    const revisions = plans.map((p) => this.revisionView(goal, p));
    const tasks = this.taskViews(goal, plans);
    const latestState = latest ? this.deps.planState(latest) : null;
    return {
      ...summary,
      text: cleanText(goal.text),
      baseBranch: goal.base_branch,
      baseSha: goal.base_sha,
      maxParallel: goal.max_parallel,
      maxTasks: goal.max_tasks,
      plannerProfileId: goal.planner_profile_id,
      revisions,
      tasks,
      decisions: this.all<GoalDecisionRow>("select * from goal_decisions where goal_id = ? order by created_at, rowid", goalId).map(decisionView),
      joins: this.all<{ id: string; task_id: string; before_sha: string; after_sha: string | null; outcome: "joined" | "conflict"; conflict_paths: string | null; at: string }>(
        "select * from goal_joins where goal_id = ? order by at, rowid",
        goalId,
      ).map((j): GoalJoinView => ({ id: j.id, taskId: j.task_id, beforeSha: j.before_sha, afterSha: j.after_sha, outcome: j.outcome, conflictPaths: strings(json(j.conflict_paths, [])), at: j.at })),
      revisionsLeft: approved ? 0 : Math.max(0, GOAL_LIMITS.revisionsBeforeApproval - goal.revisions_used),
      replansLeft: Math.max(0, GOAL_LIMITS.replans - goal.replans_used),
      integration: goal.integration_task_id ? this.integrationView(goal, goal.integration_task_id) : null,
      stuck: state.stuck,
      suggestedBudgetUsd: latest && latestState === "ready" ? this.suggestedBudget(goal, latest, tasks) : null,
    };
  }

  private revisionView(goal: GoalRow, p: GoalPlanRow): GoalRevisionView {
    const state = this.deps.planState(p);
    const plan = json<GoalPlan | null>(p.plan, null);
    const runs = p.plan_task_id ? this.db.runs(p.plan_task_id) : [];
    // A failure the store did not keep (an interrupted run, a stopped one) reads from the run's own end.
    const error = state === "failed" ? (plain(p.error) ?? plain(runs.at(-1)?.end_detail ?? null)) : null;
    return {
      id: p.id,
      revision: p.revision,
      cause: p.cause,
      note: plain(p.note, GOAL_LIMITS.noteBytes),
      state,
      error,
      summary: plan ? (plain(plan.summary, GOAL_LIMITS.summaryBytes) ?? "") : null,
      planTaskId: p.plan_task_id,
      diff: p.revision > 1 ? this.diffOf(goal.id, p) : null,
      overlaps: this.overlapsOf(goal.id, p.id),
      planningSpend: p.plan_task_id ? this.db.spend(runs) : FREE,
      createdAt: p.created_at,
      approvedAt: p.approved_at,
      supersededAt: p.superseded_at,
    };
  }

  /** The diff the planner recorded when the revision's plan landed (goal.planned); null before that. */
  private diffOf(goalId: string, p: GoalPlanRow): PlanDiff | null {
    if (p.plan === null) return null;
    const rows = this.all<{ payload: string }>(
      "select payload from events where kind = 'goal.planned' and task_id is null and json_extract(payload, '$.goalId') = ? and json_extract(payload, '$.revision') = ? order by seq desc limit 1",
      goalId,
      p.revision,
    );
    const ev = json<Record<string, unknown> | null>(rows[0]?.payload, null);
    if (!ev) return null;
    const keys = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { added: keys(ev.added), changed: keys(ev.changed), removed: keys(ev.removed), kept: keys(ev.kept) };
  }

  /** The orderings the overlap check added for the revision's tasks, with the overlapping pair. */
  private overlapsOf(goalId: string, planId: string): OverlapEdge[] {
    const rows = new Map(this.rows(goalId).map((r) => [r.task_id, r]));
    return this.all<GoalDepRow>("select d.* from goal_task_deps d join goal_tasks gt on gt.task_id = d.task_id where d.goal_id = ? and d.source = 'overlap' and gt.plan_id = ? order by gt.position, d.depends_on", goalId, planId).map((d) => {
      const a = json<string[]>(rows.get(d.task_id)?.paths, []);
      const b = json<string[]>(rows.get(d.depends_on)?.paths, []);
      if (a.length === 0 || b.length === 0) return { taskId: d.task_id, dependsOn: d.depends_on, cause: "no_paths" };
      const hit = firstOverlap(b, a);
      // As overlapPairs records it: the earlier task's path first.
      return hit ? { taskId: d.task_id, dependsOn: d.depends_on, cause: "paths", paths: hit } : { taskId: d.task_id, dependsOn: d.depends_on, cause: "paths" };
    });
  }

  /**
   * The goal's tasks the view shows (design §3.3): the latest revision's live tasks, its skipped ones,
   * and every task an approved revision accepted or released, in plan order. Tasks of revisions that
   * were never approved, and drafts that did not land, stay out.
   */
  private taskViews(goal: GoalRow, plans: GoalPlanRow[]): GoalTaskView[] {
    const latest = plans.at(-1) ?? null;
    const byPlan = new Map(plans.map((p) => [p.id, p]));
    const planJson = new Map(plans.map((p) => [p.id, json<GoalPlan | null>(p.plan, null)]));
    const rows = this.rows(goal.id);
    const shown = rows.filter((r) => {
      if (latest && r.plan_id === latest.id) return r.discarded_at === null;
      const p = byPlan.get(r.plan_id);
      return Boolean(p?.approved_at) && ((r.accepted === 1 && r.discarded_at === null) || r.released_at !== null);
    });
    const facts = this.deps.facts(goal.id);
    const factById = new Map(facts.map((f) => [f.id, f]));
    const keyOf = new Map(rows.map((r) => [r.task_id, r.key]));
    const deps = this.all<GoalDepRow>("select * from goal_task_deps where goal_id = ? order by depends_on", goal.id);
    return shown
      .map((r) => {
        const task = this.db.task(r.task_id);
        const plan = byPlan.get(r.plan_id)!;
        const entry = entryOf(planJson.get(r.plan_id) ?? null, r.key);
        const f = factById.get(r.task_id);
        const status = f?.status ?? this.db.status(task);
        const released = r.released_at !== null;
        const joined = r.joined_sha !== null;
        const crew = this.db.crew(task.id);
        const steps = crew ? this.db.members(crew.id).filter((m) => !m.skipped_at).length : 0;
        const estimate: CostEstimate = crew ? { usd: crew.estimate_usd, provenance: crew.estimate_provenance } : UNKNOWN;
        const accepted = r.accepted === null ? null : r.accepted === 1;
        // A share exists once an approved revision accepted the task: its task budget, which the caps enforce.
        const share = accepted === true && plan.approved_at ? task.budget_usd : null;
        const unknown = estimate.usd === null || estimate.provenance === "unknown";
        const held = accepted === true && !released && r.discarded_at === null && !task.cancelled_at ? (this.deps.hold(task) ?? (f ? prerequisiteHold(f, facts) : null)) : null;
        return {
          sortRevision: plan.revision,
          view: {
            taskId: task.id,
            key: r.key,
            number: r.position + 1,
            revision: plan.revision,
            title: plain(task.title, GOAL_LIMITS.titleBytes) ?? "",
            kind: task.kind,
            mode: r.mode,
            size: task.size,
            priority: r.priority,
            description: plain(entry?.description ?? "", GOAL_LIMITS.descriptionBytes) ?? "",
            acceptance: strings(entry?.acceptance ?? [], GOAL_LIMITS.criterionBytes),
            basis: plain(r.basis, GOAL_LIMITS.basisBytes) ?? "",
            basisMatched: r.basis_matched === 1,
            reason: plain(r.reason, GOAL_LIMITS.reasonBytes) ?? "",
            paths: strings(json(r.paths, []), GOAL_LIMITS.pathBytes),
            writes: r.writes === 1,
            edited: r.edited === 1,
            accepted,
            discarded: r.discarded_at !== null,
            released,
            joined: r.joined_sha && r.joined_at ? { sha: r.joined_sha, at: r.joined_at } : null,
            reportAcceptedAt: r.report_accepted_at,
            status,
            dependsOn: deps.filter((d) => d.task_id === r.task_id).map((d) => ({ taskId: d.depends_on, key: keyOf.get(d.depends_on) ?? d.depends_on, source: d.source })),
            unmet: f ? unmetPrerequisites(f, factById).map((u) => ({ taskId: u.on, why: u.why })) : [],
            hold: held,
            frozen: frozenBecause({ status, released, joined, edited: r.edited === 1 }),
            crewSteps: steps,
            estimate,
            shareUsd: share,
            // Typed budgets are not stored apart from the share: after approval, an Unknown estimate's share is the budget you typed.
            typedBudgetUsd: share !== null && unknown ? share : null,
            spend: this.db.spend(this.db.runs(task.id)),
          } satisfies GoalTaskView,
        };
      })
      .sort((a, b) => a.view.number - b.view.number || a.sortRevision - b.sortRevision || a.view.taskId.localeCompare(b.view.taskId))
      .map((x) => x.view);
  }

  private integrationView(goal: GoalRow, taskId: string): NonNullable<GoalDetail["integration"]> {
    const task = this.db.task(taskId);
    const facts = this.deps.integration(goal.id);
    const crew = this.db.crew(taskId);
    return {
      taskId,
      status: facts?.status ?? this.db.status(task),
      reviewPassed: facts?.reviewPassed ?? false,
      estimate: crew ? { usd: crew.estimate_usd, provenance: crew.estimate_provenance } : UNKNOWN,
      shareUsd: goal.approved_revision !== null ? task.budget_usd : null,
    };
  }

  /** The plan review's prefill: max(project default, the known total of the plan's tasks rounded up x 1.5). */
  private suggestedBudget(goal: GoalRow, latest: GoalPlanRow, tasks: GoalTaskView[]): number {
    const known = tasks.filter((t) => t.revision === latest.revision && t.accepted !== false && !t.discarded).reduce((a, t) => a + Math.max(0, t.estimate.provenance === "unknown" ? 0 : (t.estimate.usd ?? 0)), 0);
    const def = this.setting(GOAL_SETTINGS.goalBudget(goal.project_id));
    return defaultGoalBudget(known, typeof def === "number" && def > 0 ? def : null);
  }

  // ---------------------------------------------------------------- approval routing

  /**
   * Which approval `goals.approve` is (design §1.2): a plan of one task before the first approval
   * becomes an ordinary task (GoalPlanner.approveOneTask); a repeated click on it finds the goal
   * collapsed from that plan and returns the same task. Every other approval is the goal
   * scheduler's (GoalRunner.approve), which refuses a goal collapsed from its text.
   */
  approvalRoute(goalId: string, revision: number): { route: "goal" } | { route: "one_task"; key: string; taskId: string | null } {
    const goal = this.goal(goalId);
    const plans = this.plans(goalId);
    const latest = plans.at(-1);
    if (goal.collapsed_task_id) {
      const ev = this.all<{ payload: string }>("select payload from events where kind = 'goal.collapsed' and task_id is null and json_extract(payload, '$.goalId') = ? order by seq desc limit 1", goalId)[0];
      const p = json<{ from?: unknown; revision?: unknown } | null>(ev?.payload, null);
      const plan = plans.find((x) => x.revision === revision);
      const only = json<GoalPlan | null>(plan?.plan, null)?.tasks;
      if (p?.from === "one_task_plan" && p.revision === revision && only?.length === 1) return { route: "one_task", key: only[0]!.key, taskId: goal.collapsed_task_id };
      return { route: "goal" };
    }
    if (goal.approved_revision !== null || goal.stopped_at || !latest || latest.revision !== revision || this.deps.planState(latest) !== "ready") return { route: "goal" };
    const live = this.rows(goalId).filter((r) => r.discarded_at === null);
    if (live.length === 1 && live[0]!.plan_id === latest.id) return { route: "one_task", key: live[0]!.key, taskId: live[0]!.task_id };
    return { route: "goal" };
  }
}

function decisionView(d: GoalDecisionRow): GoalDecisionView {
  const raw = json<Record<string, unknown> | null>(d.payload, null) ?? {};
  const kindActions = GOAL_DECISION_ACTIONS[d.kind] ?? [];
  const narrowed = Array.isArray(raw.actions) ? raw.actions.filter((a): a is GoalDecisionAction => typeof a === "string" && kindActions.includes(a as GoalDecisionAction)) : null;
  const payload: GoalDecisionPayload = {};
  const paths = Array.isArray(raw.paths) ? strings(raw.paths) : null;
  if (paths) payload.paths = paths;
  const detail = plain(raw.detail);
  if (detail) payload.detail = detail;
  if (Array.isArray(raw.waiting)) payload.waiting = raw.waiting.filter((x): x is string => typeof x === "string");
  const findings = plain(raw.findings);
  if (findings) payload.findings = findings;
  if (typeof raw.profileId === "string") payload.profileId = raw.profileId;
  if (raw.rule === "same_failure" || raw.rule === "failed_tasks") payload.rule = raw.rule;
  if (narrowed) payload.actions = narrowed;
  return {
    id: d.id,
    kind: d.kind,
    taskId: d.task_id,
    payload,
    // The answers goals.decide takes (GoalRunner.decide): the narrowed set when the payload has one.
    actions: narrowed ?? [...kindActions],
    createdAt: d.created_at,
    answeredAt: d.answered_at,
    answer: d.answer,
  };
}
