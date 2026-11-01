import {
  ancestorsOf,
  frozenBecause,
  GOAL_LIMITS,
  GOAL_SETTINGS,
  overlapPairs,
  parseGoalLimits,
  parseGoalTask,
  pathsOverlap,
  wouldCycle,
  type DagNode,
  type GoalChangeCause,
  type GoalDepSource,
  type GoalPlan,
  type GoalPlanTask,
  type GoalStatus,
  type GoalTaskPatch,
  type PlanState,
  type TaskDetail,
  type TaskKind,
  type TaskMode,
  type TaskSize,
} from "@crewyard/core";
import type { OrchestratorContext } from "../context.ts";
import { Part } from "../part.ts";
import { stripWaitsFor } from "./planner.ts";
import { goalTaskDescription, goalTaskNumber, waitsForLine } from "./prompt.ts";
import { GoalError } from "./events.ts";
import type { GoalApproveParams, GoalPlanRow, GoalRow, GoalTaskRow } from "./runner.ts";

// Your edits to a plan before you approve it (design §3.2, §4.10, §6.2): a tile's fields
// (goals.editTask) and one dependency at a time (goals.setDependency), plus the project's default
// goal budget. Only the latest revision, while it is ready and unapproved, can change, and only its
// tasks that never started; everything you change is checked with the same core rules as the
// planner's output (parseGoalTask with origin "user", wouldCycle). An edited tile is frozen for the
// next Revise, so the planner must return it unchanged. Nothing here approves or starts anything.

export interface GoalEditorDeps {
  /**
   * TaskFlow.edit with `byGoal`: the task's title, description, kind, size and mode; the crew is
   * drafted again when they change it. `inTx` runs inside the edit's own transaction.
   */
  edit(taskId: string, patch: { title?: string; description?: string; kind?: TaskKind; size?: TaskSize }, how: { byGoal: true; mode?: TaskMode; inTx?: () => void }): Promise<TaskDetail>;
  /** GoalPlanner.planState. */
  planState(p: GoalPlanRow): PlanState;
  /** The goal's derived status, for goals.changed (GoalViews.state). */
  status(goalId: string): GoalStatus;
  /** GoalViews.approvalRoute: whether goals.approve is a plan of one task or the goal scheduler's approval. */
  approvalRoute(goalId: string, revision: number): { route: "goal" } | { route: "one_task"; key: string; taskId: string | null };
  /** GoalRunner.approve: `Approve and start`, idempotent per revision. */
  approveGoal(p: GoalApproveParams): Promise<void>;
  /** GoalPlanner.approveOneTask: a plan of one task becomes that ordinary task, approved in the same click. */
  approveOneTask(goalId: string, revision: number): Promise<unknown>;
  /** GoalRunner.pausedAllState: whether Pause all goals is on. */
  pausedAll(): boolean;
}

/** The tile fields you may change; basis, reason and dependencies are not tile fields. */
const PATCH_FIELDS: ReadonlySet<string> = new Set(["title", "kind", "mode", "size", "description", "acceptance", "paths", "priority"]);

const json = <T>(s: string | null, fallback: T): T => {
  if (s === null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export class GoalEditor extends Part {
  /**
   * One plan click per goal at a time: approvals, tile edits and dependency changes. A double click
   * reads the first click's outcome, and an edit can never land while an approval awaits the
   * directory or git, where the approval would go on with the tasks it read before the edit.
   */
  private readonly busy = new Map<string, Promise<unknown>>();

  constructor(
    ctx: OrchestratorContext,
    private readonly deps: GoalEditorDeps,
  ) {
    super(ctx);
  }

  // ---------------------------------------------------------------- rows and checks

  private one<T>(q: string, ...args: Array<string | number | null>): T | undefined {
    return this.opts.store.db.prepare(q).get(...args) as T | undefined;
  }

  private all<T>(q: string, ...args: Array<string | number | null>): T[] {
    return this.opts.store.db.prepare(q).all(...args) as unknown as T[];
  }

  private goal(goalId: string): GoalRow {
    const g = this.one<GoalRow>("select * from goals where id = ?", goalId);
    if (!g) throw new GoalError("goal.not_found", { goalId });
    return g;
  }

  private latest(goalId: string): GoalPlanRow | null {
    return this.one<GoalPlanRow>("select * from goal_plans where goal_id = ? order by revision desc limit 1", goalId) ?? null;
  }

  private liveRows(goalId: string): GoalTaskRow[] {
    return this.all<GoalTaskRow>("select * from goal_tasks where goal_id = ? and discarded_at is null order by position, task_id", goalId);
  }

  private depsOf(taskId: string): Array<{ on: string; source: GoalDepSource }> {
    return this.all<{ depends_on: string; source: GoalDepSource }>("select depends_on, source from goal_task_deps where task_id = ? order by depends_on", taskId).map((d) => ({ on: d.depends_on, source: d.source }));
  }

  /**
   * The revision you may edit: `revision` must be the latest, ready and not approved. Read again
   * inside the write's transaction, so a Revise, an approval or a stop in between wins.
   */
  private editable(goalId: string, revision: unknown): { goal: GoalRow; plan: GoalPlanRow } {
    const goal = this.goal(goalId);
    // A goal that became one ordinary task is finished, like a stopped one.
    if (goal.stopped_at || goal.collapsed_task_id) throw new GoalError("goal.stopped", { goalId });
    const plan = this.latest(goalId);
    if (!plan) throw new GoalError("goal.not_ready");
    if (plan.revision !== revision) throw new GoalError("goal.stale_revision", { revision: typeof revision === "number" ? revision : String(revision), latest: plan.revision });
    if (plan.approved_at) throw new GoalError("goal.approved");
    if (this.deps.planState(plan) !== "ready") throw new GoalError("goal.not_ready", { revision: plan.revision });
    return { goal, plan };
  }

  /**
   * The tasks a revision's ordering is computed over: the revision's own, and the live tasks earlier
   * approvals accepted that it does not replace (no task of it holds their key).
   */
  private members(goalId: string, plan: GoalPlanRow): { own: GoalTaskRow[]; kept: GoalTaskRow[] } {
    const live = this.liveRows(goalId).filter((r) => r.accepted !== 0 && !this.db.task(r.task_id).cancelled_at);
    const own = live.filter((r) => r.plan_id === plan.id);
    const ownKeys = new Set(own.map((r) => r.key));
    const kept = live.filter((r) => r.plan_id !== plan.id && r.accepted === 1 && !ownKeys.has(r.key));
    return { own, kept };
  }

  /** Why a task may not change: it ran, was released or merged. An earlier edit does not count. */
  private started(row: GoalTaskRow): ReturnType<typeof frozenBecause> {
    const because = frozenBecause({ status: this.db.status(this.db.task(row.task_id)), released: row.released_at !== null, joined: row.joined_sha !== null, edited: false });
    if (because) return because;
    return this.db.runs(row.task_id).length > 0 ? "running" : null;
  }

  // ---------------------------------------------------------------- goals.editTask

  /**
   * Edits a tile of the unapproved revision. The patch is merged onto the plan entry and checked
   * like a task you wrote; the task and its crew follow (a new kind, size or mode drafts the crew
   * again, so the estimate you approve is the crew's). The tile is then frozen for the next Revise,
   * and the file-overlap ordering of this task is computed again from its new paths, keeping any
   * pair you set to run side by side.
   */
  editTask(goalId: string, revision: number, key: string, patch: GoalTaskPatch): Promise<void> {
    return this.serial(goalId, () => this.doEditTask(goalId, revision, key, patch));
  }

  private async doEditTask(goalId: string, revision: number, key: string, patch: GoalTaskPatch): Promise<void> {
    const { plan } = this.editable(goalId, revision);
    const row = this.liveRows(goalId).find((r) => r.plan_id === plan.id && r.key === key);
    if (!row) throw new GoalError("goal.task_not_found", { key: String(key) });
    const because = this.started(row);
    if (because) throw new GoalError("goal.frozen", { key, because });
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new GoalError("goal.invalid_task", { error: "the patch must be an object" });
    const extra = Object.keys(patch).find((k) => !PATCH_FIELDS.has(k));
    if (extra !== undefined) throw new GoalError("goal.invalid_task", { error: `the patch has an unknown field "${extra}"` });
    const parsedPlan = json<GoalPlan | null>(plan.plan, null);
    const task = this.db.task(row.task_id);
    const entry: GoalPlanTask = parsedPlan?.tasks.find((t) => t.key === key) ?? {
      key,
      title: task.title,
      kind: task.kind,
      mode: row.mode,
      size: task.size,
      description: "",
      acceptance: [],
      basis: row.basis,
      dependsOn: [],
      paths: json<string[]>(row.paths, []),
      reason: row.reason,
      priority: row.priority,
    };
    const fields: Record<string, unknown> = { ...entry };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) fields[k] = v;
    // Its dependencies stay as planned; they may name any other task the goal holds.
    const others = new Set([...(parsedPlan?.tasks.map((t) => t.key) ?? []), ...this.liveRows(goalId).map((r) => r.key), ...entry.dependsOn]);
    others.delete(key);
    const checked = parseGoalTask(fields, others, "task", { origin: "user" });
    if (!checked.ok) throw new GoalError("goal.invalid_task", { error: checked.error });
    const next = checked.value;
    const oldPaths = json<string[]>(row.paths, []);

    // The task, its crew and the goal's records change in one transaction (TaskFlow.edit's), where
    // the revision is read again: a Revise, an approval or a stop while the crew was drafted wins.
    await this.deps.edit(
      row.task_id,
      { title: next.title, description: goalTaskDescription(next), kind: next.kind, size: next.size },
      {
        byGoal: true,
        mode: next.mode,
        inTx: () => {
          const again = this.editable(goalId, revision);
          if (again.plan.id !== plan.id) throw new GoalError("goal.stale_revision", { revision, latest: again.plan.revision });
          const fresh = this.liveRows(goalId).find((r) => r.task_id === row.task_id);
          if (!fresh) throw new GoalError("goal.task_not_found", { key });
          const stored = json<GoalPlan | null>(again.plan.plan, null);
          if (stored) {
            const tasks = stored.tasks.map((t) => (t.key === key ? { ...next, dependsOn: t.dependsOn } : t));
            this.db.exec("update goal_plans set plan = ? where id = ?", JSON.stringify({ ...stored, tasks }), plan.id);
          }
          // A new kind may have drafted a crew that writes, or one that does not.
          const writes = this.one<{ w: number | null }>("select max(m.writes_code) as w from crew_members m join crews c on c.id = m.crew_id where c.task_id = ?", row.task_id)?.w ?? 0;
          this.db.exec("update goal_tasks set mode = ?, priority = ?, paths = ?, writes = ?, edited = 1 where task_id = ?", next.mode, next.priority, JSON.stringify(next.paths), writes ? 1 : 0, row.task_id);
          const touched = this.reorderOverlaps(goalId, plan, row.task_id, oldPaths);
          for (const id of new Set([row.task_id, ...touched])) this.setWaitsFor(goalId, id);
        },
      },
    );
    const goal = this.goal(goalId);
    this.goalEvent(goal, "goal.edited", { revision, key, taskId: row.task_id, fields: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined) });
    this.emitTask(row.task_id, "edited");
    this.emitGoal(goal, "edited");
  }

  /**
   * Inside editTask's transaction: drops the automatic orderings of the edited task and computes
   * them again from its new paths. A pair whose old paths overlapped but that ran side by side was
   * your choice and stays side by side. Only a task of this revision gains an ordering (design
   * §4.8): a task an earlier approval kept is past drafting. Returns the tasks whose orderings changed.
   */
  private reorderOverlaps(goalId: string, plan: GoalPlanRow, taskId: string, oldPaths: readonly string[]): string[] {
    const { own, kept } = this.members(goalId, plan);
    const all = [...own, ...kept];
    const ownIds = new Set(own.map((r) => r.task_id));
    const graph = (): DagNode[] => all.map((r) => ({ id: r.task_id, dependsOn: this.depsOf(r.task_id).map((d) => d.on) }));
    const sideBySide: Array<[string, string]> = [];
    const before = graph();
    for (const r of all) {
      if (r.task_id === taskId || r.writes !== 1) continue;
      const paths = json<string[]>(r.paths, []);
      const overlapped = oldPaths.some((a) => paths.some((b) => pathsOverlap(a, b)));
      if (overlapped && !ancestorsOf(before, taskId).has(r.task_id) && !ancestorsOf(before, r.task_id).has(taskId)) sideBySide.push([taskId, r.task_id]);
    }
    const dropped = this.all<{ task_id: string; depends_on: string }>("select task_id, depends_on from goal_task_deps where goal_id = ? and source = 'overlap' and (task_id = ? or depends_on = ?)", goalId, taskId, taskId).filter((d) => ownIds.has(d.task_id));
    for (const d of dropped) this.db.exec("delete from goal_task_deps where task_id = ? and depends_on = ? and source = 'overlap'", d.task_id, d.depends_on);
    // Kept tasks count as earlier, as the planner orders them: what is new waits for them.
    const input = all.map((r) => ({
      id: r.task_id,
      position: ownIds.has(r.task_id) ? r.position : r.position - GOAL_LIMITS.maxTasksHard,
      writes: r.writes === 1,
      accepted: true,
      paths: json<string[]>(r.paths, []),
      dependsOn: this.depsOf(r.task_id).map((d) => d.on),
    }));
    const added: string[] = [];
    for (const e of overlapPairs(input, { sideBySide })) {
      if (e.taskId !== taskId && e.dependsOn !== taskId) continue;
      if (!ownIds.has(e.taskId) || wouldCycle(graph(), e.taskId, e.dependsOn)) continue;
      this.db.exec("insert or ignore into goal_task_deps (goal_id, task_id, depends_on, source) values (?, ?, ?, 'overlap')", goalId, e.taskId, e.dependsOn);
      added.push(e.taskId);
    }
    return [...dropped.map((d) => d.task_id), ...added];
  }

  // ---------------------------------------------------------------- goals.setDependency

  /**
   * Adds or removes `taskKey` waiting for `dependsOnKey` in the unapproved revision. The task must be
   * one of the revision's and never started; the task it waits for may be any task the revision
   * keeps, including one an earlier approval accepted. A loop is refused with its path ("01 → 03 → 01").
   * Removing an automatic ordering is "Run side by side anyway"; at approval the overlap check keeps it so.
   *
   * A changed ordering is an edit of the tile that waits (design §4.10: your edits are kept on
   * Revise), so that tile is marked edited and the planner must return it as it is now: a planned
   * edge you removed leaves its stored plan entry, an edge you drew stays yours. "Run side by side
   * anyway" marks both tiles of this revision, so the planner's overlap check finds them both kept
   * and unordered, which only your choice leaves them, and keeps them side by side.
   */
  setDependency(goalId: string, revision: number, taskKey: string, dependsOnKey: string, on: boolean): Promise<void> {
    if (typeof on !== "boolean") return Promise.reject(new GoalError("goal.action", { action: "setDependency" }));
    return this.serial(goalId, () => this.doSetDependency(goalId, revision, taskKey, dependsOnKey, on));
  }

  private doSetDependency(goalId: string, revision: number, taskKey: string, dependsOnKey: string, on: boolean): void {
    const { plan } = this.editable(goalId, revision);
    const find = () => {
      const { own, kept } = this.members(goalId, plan);
      const task = own.find((r) => r.key === taskKey);
      if (!task) throw new GoalError("goal.task_not_found", { key: String(taskKey) });
      const dep = own.find((r) => r.key === dependsOnKey) ?? kept.find((r) => r.key === dependsOnKey);
      if (!dep) throw new GoalError("goal.task_not_found", { key: String(dependsOnKey) });
      return { task, dep, all: [...own, ...kept] };
    };
    const first = find();
    const because = this.started(first.task);
    if (because) throw new GoalError("goal.frozen", { key: taskKey, because });
    let changed: { source: GoalDepSource | null } | null = null;
    this.db.tx(() => {
      const again = this.editable(goalId, revision);
      if (again.plan.id !== plan.id) throw new GoalError("goal.stale_revision", { revision, latest: again.plan.revision });
      const { task, dep, all } = find();
      const ownIds = new Set(this.members(goalId, plan).own.map((r) => r.task_id));
      const existing = this.one<{ source: GoalDepSource }>("select source from goal_task_deps where task_id = ? and depends_on = ?", task.task_id, dep.task_id);
      if (on) {
        if (existing && existing.source !== "overlap") return;
        const label = new Map(all.map((r) => [r.task_id, goalTaskNumber(r.position)]));
        const loop = wouldCycle(
          all.map((r) => ({ id: r.task_id, dependsOn: this.depsOf(r.task_id).map((d) => d.on) })),
          task.task_id,
          dep.task_id,
        );
        if (loop) throw new GoalError("goal.cycle", { path: loop.map((id) => label.get(id) ?? id).join(" → ") });
        // You chose this order: an automatic one becomes yours, so a later overlap check never drops it.
        if (existing) this.db.exec("update goal_task_deps set source = 'user' where task_id = ? and depends_on = ?", task.task_id, dep.task_id);
        else this.db.exec("insert into goal_task_deps (goal_id, task_id, depends_on, source) values (?, ?, ?, 'user')", goalId, task.task_id, dep.task_id);
        changed = { source: existing?.source ?? null };
      } else {
        if (!existing) return;
        this.db.exec("delete from goal_task_deps where task_id = ? and depends_on = ?", task.task_id, dep.task_id);
        changed = { source: existing.source };
        // A planned edge you removed leaves the plan entry, or a Revise would bring it back.
        if (existing.source === "plan") this.dropPlannedEdge(again.plan, taskKey, dependsOnKey);
        if (existing.source === "overlap" && ownIds.has(dep.task_id)) this.db.exec("update goal_tasks set edited = 1 where task_id = ?", dep.task_id);
      }
      this.db.exec("update goal_tasks set edited = 1 where task_id = ?", task.task_id);
      this.setWaitsFor(goalId, task.task_id);
    });
    if (!changed) return;
    const goal = this.goal(goalId);
    this.goalEvent(goal, "goal.edited", { revision, key: taskKey, dependsOn: dependsOnKey, on, was: (changed as { source: GoalDepSource | null }).source });
    this.emitTask(first.task.task_id, "edited");
    this.emitGoal(goal, "edited");
  }

  // ---------------------------------------------------------------- the project default

  /** The project's default goal budget (Settings, and the first-goal card's value); the plan review prefills from it. */
  /** The project's default goal budget (Settings → Orchestra); null when none is set. */
  projectDefaults(projectId: string): { projectId: string; budgetUsd: number | null } {
    this.db.project(projectId);
    const v = this.opts.store.db.prepare("select value from settings where key = ?").get(GOAL_SETTINGS.goalBudget(projectId)) as { value: string } | undefined;
    let budgetUsd: number | null = null;
    try {
      const n = v ? (JSON.parse(v.value) as unknown) : null;
      budgetUsd = typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      budgetUsd = null;
    }
    return { projectId, budgetUsd };
  }

  setProjectDefaults(projectId: string, budgetUsd: number): { projectId: string; budgetUsd: number } {
    this.db.project(projectId);
    const limits = parseGoalLimits({ budgetUsd });
    if (!limits.ok || limits.value.budgetUsd === undefined) throw new GoalError("goal.bad_budget", { field: "budgetUsd" });
    this.writeSetting(GOAL_SETTINGS.goalBudget(projectId), limits.value.budgetUsd);
    return { projectId, budgetUsd: limits.value.budgetUsd };
  }

  // ---------------------------------------------------------------- goals.approve

  /**
   * `Approve and start`, idempotent per revision and one click per goal at a time: a plan of one
   * task before the first approval becomes that ordinary task (design §1.2); every other plan is
   * the goal scheduler's. A second click waits for the first and then reads its outcome, so it
   * creates nothing twice.
   */
  approve(p: GoalApproveParams): Promise<void> {
    return this.serial(p.goalId, async () => {
      const route = this.deps.approvalRoute(p.goalId, p.revision);
      if (route.route === "goal") return this.deps.approveGoal(p);
      this.prepareOneTask(p.goalId, route.key, route.taskId, p);
      await this.deps.approveOneTask(p.goalId, p.revision);
    });
  }

  // ---------------------------------------------------------------- a plan of one task

  /**
   * Before `Approve and start` turns a plan of one task into an ordinary task (design §1.2): the
   * click must accept that task, and its limits must be valid. The budget you approved becomes the
   * task's own budget when it is lower, so the one task never spends past what you saw; it is never
   * raised. A repeated click on a goal already collapsed checks the same and changes nothing more.
   *
   * The goal route approves a paused goal but releases nothing until you lift the pause (design
   * §5.2). Here the approval itself starts the run, so it is refused while either switch is on.
   */
  private prepareOneTask(goalId: string, key: string, taskId: string | null, p: { accept: unknown; budgetUsd: unknown; maxParallel: unknown }): void {
    const goal = this.goal(goalId);
    if (!Array.isArray(p.accept) || p.accept.length === 0) throw new GoalError("goal.no_accepted");
    for (const k of p.accept) if (k !== key) throw new GoalError("goal.task_not_found", { key: String(k) });
    // Both limits are required, as on the goal route: the one task never runs without a budget.
    if (p.budgetUsd === undefined) throw new GoalError("goal.bad_budget", { field: "budgetUsd" });
    if (p.maxParallel === undefined) throw new GoalError("goal.bad_budget", { field: "maxParallel" });
    const limits = parseGoalLimits({ budgetUsd: p.budgetUsd, maxParallel: p.maxParallel });
    if (!limits.ok) throw new GoalError("goal.bad_budget", { field: /maxParallel/.test(limits.error) ? "maxParallel" : "budgetUsd" });
    const budget = limits.value.budgetUsd;
    if (!goal.collapsed_task_id) {
      if (goal.paused_at) throw new GoalError("goal.paused", { goalId });
      if (this.deps.pausedAll()) throw new GoalError("goal.paused_all");
    }
    if (!taskId || budget === undefined) return;
    // Only a proposal's budget moves: an approved crew keeps the budget it was approved with.
    this.db.exec(
      "update tasks set budget_usd = ? where id = ? and (budget_usd is null or budget_usd > ?) and exists (select 1 from crews c where c.task_id = tasks.id and c.approved_at is null)",
      budget,
      taskId,
      budget,
    );
  }

  // ---------------------------------------------------------------- helpers

  /** Runs one plan click after any other click on the same goal has settled, whatever its outcome. */
  private async serial<T>(goalId: string, fn: () => T | Promise<T>): Promise<T> {
    for (;;) {
      const pending = this.busy.get(goalId);
      if (!pending) break;
      await pending.catch(() => undefined);
    }
    // The slot is taken before `fn` runs: its synchronous part may already reach a click of the
    // same goal (an approval reads the directory, which a click can interleave with).
    let release!: () => void;
    const slot = new Promise<void>((resolve) => (release = resolve));
    this.busy.set(goalId, slot);
    try {
      return await fn();
    } finally {
      if (this.busy.get(goalId) === slot) this.busy.delete(goalId);
      release();
    }
  }

  /** Drops `dependsOnKey` from the stored plan entry of `taskKey` (inside the caller's transaction). */
  private dropPlannedEdge(plan: GoalPlanRow, taskKey: string, dependsOnKey: string): void {
    const stored = json<GoalPlan | null>(plan.plan, null);
    if (!stored) return;
    const tasks = stored.tasks.map((t) => (t.key === taskKey ? { ...t, dependsOn: t.dependsOn.filter((d) => d !== dependsOnKey) } : t));
    this.db.exec("update goal_plans set plan = ? where id = ?", JSON.stringify({ ...stored, tasks }), plan.id);
  }

  /** "[Goal: waits for 01, 02]" at the end of the description, as the planner writes it, for an older build after a rollback. */
  private setWaitsFor(goalId: string, taskId: string): void {
    const positions = new Map(this.liveRows(goalId).map((r) => [r.task_id, r.position]));
    const line = waitsForLine(this.depsOf(taskId).map((d) => positions.get(d.on)).filter((n): n is number => n !== undefined));
    const task = this.db.task(taskId);
    const body = stripWaitsFor(task.description);
    const next = line ? (body ? `${body}\n\n${line}` : line) : body;
    if (next !== task.description) this.db.exec("update tasks set description = ? where id = ?", next, taskId);
  }

  private writeSetting(key: string, value: unknown): void {
    this.opts.store.db.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, JSON.stringify(value));
  }

  /** Goal events have no task: the goal id rides in the payload (design §4.1). */
  private goalEvent(goal: GoalRow, kind: string, payload: Record<string, unknown>): void {
    this.opts.store.appendEvent({ kind, source: "orchestrator", payload: { goalId: goal.id, ...payload }, projectId: goal.project_id });
  }

  private emitGoal(goal: GoalRow, cause: GoalChangeCause): void {
    try {
      this.opts.emit("goals.changed", { goalId: goal.id, projectId: goal.project_id, status: this.deps.status(goal.id), cause });
    } catch {
      // The window re-reads goals on its next refresh; a failed notice must not undo the change.
    }
  }
}
