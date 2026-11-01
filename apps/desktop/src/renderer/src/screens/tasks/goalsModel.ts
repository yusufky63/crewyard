import { goalDependents, layers, skippedDependency, splitBudget, wouldCycle, type BudgetItem, type CostEstimate, type DagNode, type GoalDetail, type GoalRevisionView, type GoalPreview, type GoalTaskView, type TaskPreview } from "@crewyard/core";
import { goalNumber } from "./model.ts";

// Pure rules for the composer's mode control and the plan review (docs/adr/0019, design §1.2,
// §3.1, §3.2). The daemon checks every one of them again on its own call; these only decide what
// the screen offers, so a button never promises something the daemon will refuse.

// ---------------------------------------------------------------- the composer's mode

export type ComposerMode = "orchestra" | "crew" | "solo";
export const COMPOSER_MODES: readonly ComposerMode[] = ["orchestra", "crew", "solo"];
/** The modes a project remembers: Solo is picked per submission, never kept (design §1.2). */
export type RememberedMode = "orchestra" | "crew";

/**
 * The mode the composer opens on in a project: Orchestra when a profile can plan there, unless
 * you last submitted as Crew; Crew otherwise. `canPlan` is null while goals.preview is on its way,
 * and the composer then shows what it will most likely be, with Plan goal disabled until it knows.
 */
export function openingMode(remembered: RememberedMode | null | undefined, canPlan: boolean | null): ComposerMode {
  if (canPlan === false) return "crew";
  return remembered === "crew" ? "crew" : "orchestra";
}

/** What a submission leaves behind for next time: Orchestra or Crew, and nothing for Solo. */
export const modeToRemember = (mode: ComposerMode): RememberedMode | null => (mode === "solo" ? null : mode);

/**
 * The mode one submission really uses. Ready-made analyses and imported issues always run as one
 * Crew task (design §0, §1.2), whatever was picked: planning them would cost a planning run for one
 * task, and an issue's text comes from the web, so it is proposed for you to read rather than
 * started by Solo on the same click (§1.3). The control shows Crew while one is attached and goes
 * back to your pick when it is removed.
 */
export function submitMode(mode: ComposerMode, oneTaskSource: "preset" | "issue" | null): ComposerMode {
  return oneTaskSource !== null ? "crew" : mode;
}

/** Solo's button: `Start` with its estimate, or `Propose` when the estimate is Unknown or a cap would hold the step. */
export function soloAction(preview: Pick<TaskPreview, "estimate" | "hold"> | null | undefined): "start" | "propose" | null {
  if (!preview) return null;
  if (preview.hold || preview.estimate.usd === null || preview.estimate.provenance === "unknown") return "propose";
  return "start";
}

/** The first-goal card's default goal budget when the project has none yet: the design's own example. */
export const INTRO_BUDGET_USD = 3;

// ---------------------------------------------------------------- the plan review

/** The revision the review shows: the newest one. */
export function latestRevision(goal: Pick<GoalDetail, "revisions">): GoalRevisionView | null {
  return [...goal.revisions].sort((a, b) => a.revision - b.revision).at(-1) ?? null;
}

/**
 * The tiles of a plan: the tasks the latest revision holds, in plan order. Tasks of earlier
 * approved revisions are the running goal, not this proposal; discarded ones are gone.
 */
export function planTiles(goal: Pick<GoalDetail, "tasks" | "revisions">): GoalTaskView[] {
  const latest = latestRevision(goal);
  if (!latest) return [];
  return goal.tasks.filter((t) => t.revision === latest.revision && !t.discarded).sort((a, b) => a.number - b.number);
}

/** Whether the slot shows the plan review rather than the goal view: before the first approval, always. */
export function showsPlanReview(goal: Pick<GoalDetail, "approvedRevision" | "collapsedTaskId" | "status">): boolean {
  return goal.approvedRevision === null && goal.collapsedTaskId === null && goal.status !== "stopped";
}

/** A tile's graph node by plan key: its prerequisites inside the plan, overlap orderings marked. */
export function planNodes(tiles: readonly Pick<GoalTaskView, "key" | "dependsOn">[]): DagNode[] {
  const keys = new Set(tiles.map((t) => t.key));
  return tiles.map((t) => {
    const deps = t.dependsOn.filter((d) => keys.has(d.key));
    return { id: t.key, dependsOn: deps.map((d) => d.key), overlap: deps.filter((d) => d.source === "overlap").map((d) => d.key) };
  });
}

/** Step n holds the tiles whose prerequisites are all in earlier steps (beads' layers). */
export function planSteps<T extends Pick<GoalTaskView, "key" | "dependsOn">>(tiles: readonly T[]): T[][] {
  const byKey = new Map(tiles.map((t) => [t.key, t]));
  try {
    return layers(planNodes(tiles)).map((l) => l.map((k) => byKey.get(k)!));
  } catch {
    // Every write path refuses a loop; if one slipped through, one flat step still shows every task.
    return [tiles.slice()];
  }
}

/**
 * Unticking a task also unticks every task that builds on it (design §3.2). Returns the keys newly
 * skipped, the task itself first, so the line can say "04 also skipped: it waits for 02".
 */
export function skipWithDependents(tiles: readonly Pick<GoalTaskView, "key" | "dependsOn">[], skipped: ReadonlySet<string>, key: string): string[] {
  const out = [key, ...goalDependents(planNodes(tiles), key)];
  return out.filter((k) => k === key || !skipped.has(k));
}

/**
 * Ticking a task again also ticks what it builds on, so the plan never asks the daemon to approve a
 * task that waits for a skipped one (the daemon refuses that shape: goal.skipped_dependency).
 */
export function acceptWithPrerequisites(tiles: readonly Pick<GoalTaskView, "key" | "dependsOn">[], skipped: ReadonlySet<string>, key: string): Set<string> {
  const nodes = planNodes(tiles);
  const next = new Set(skipped);
  const stack = [key];
  while (stack.length) {
    const k = stack.pop()!;
    next.delete(k);
    const n = nodes.find((x) => x.id === k);
    const work = n ? n.dependsOn.filter((d) => !(n.overlap ?? []).includes(d)) : [];
    stack.push(...work.filter((d) => next.has(d)));
  }
  return next;
}

/** A budget typed in a field, or null when it is empty or not a positive number. */
export function typedUsd(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw.trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const unknown = (e: CostEstimate) => e.usd === null || e.provenance === "unknown";

/** The last review's line in a plan: present when any accepted task writes files. */
export interface ReviewItem {
  estimate: CostEstimate;
  /**
   * The share an earlier approval already gave it. goals.approve counts that share as it is, not
   * the estimate, so the check does too.
   */
  shareUsd?: number | null;
}

/**
 * The tasks an earlier approval accepted that approving the latest revision keeps (design §4.10,
 * goals.approve): accepted, not discarded or cancelled, and not replaced. A replan replaces the
 * keys it rebuilt (a tile now holds them) and the keys it removed; an `Add task` revision replaces
 * nothing. Without a diff, a key no tile holds counts as kept, the side that never under-counts.
 * Empty before the first approval.
 */
export function keptTasks(goal: Pick<GoalDetail, "tasks" | "revisions" | "approvedRevision">): GoalTaskView[] {
  if (goal.approvedRevision === null) return [];
  const latest = latestRevision(goal);
  if (!latest) return [];
  const rebuilt = new Set(planTiles(goal).map((t) => t.key));
  const removed = new Set(latest.diff?.removed ?? []);
  const add = latest.cause === "add";
  return goal.tasks
    .filter((t) => t.revision !== latest.revision && t.accepted === true && !t.discarded && t.status !== "cancelled")
    .filter((t) => add || (!rebuilt.has(t.key) && !removed.has(t.key)))
    .sort((a, b) => a.number - b.number);
}

/** What an approval covers besides the latest revision's tiles. */
export interface ApprovalScope {
  /** Tasks earlier approvals accepted that stay (keptTasks): each holds its share of the goal budget. */
  kept?: readonly Pick<GoalTaskView, "key" | "number" | "shareUsd" | "dependsOn" | "writes">[];
  /**
   * A plan of one task (before any approval): approving makes it an ordinary task whose budget is
   * the goal budget, with no goal branch and no last review, so no typed budget is asked for.
   */
  oneTask?: boolean;
  /** The goal's task limit: kept and accepted tasks together may not pass it. */
  maxTasks?: number;
}

/**
 * The plan total (design §3.2): the accepted tasks' estimates plus the last review. Unknown is
 * never summed into a number ("$1.61 Estimated + 1 task Unknown"); a budget typed for an Unknown
 * task counts as what it is, a budget, not an estimate. `untyped` are the Unknown ones still without one.
 */
export function planTotals(
  tiles: readonly Pick<GoalTaskView, "key" | "estimate" | "writes">[],
  accepted: ReadonlySet<string>,
  typed: Readonly<Record<string, string>>,
  review: ReviewItem | null,
): { knownUsd: number; unknown: number; untyped: number; typedUsd: number; count: number; reviewIncluded: boolean } {
  let knownUsd = 0;
  let unknownCount = 0;
  let untyped = 0;
  let typedTotal = 0;
  const on = tiles.filter((t) => accepted.has(t.key));
  const add = (key: string, e: CostEstimate) => {
    const own = typedUsd(typed[key]);
    if (unknown(e)) {
      unknownCount += 1;
      if (own !== null) typedTotal += own;
      else untyped += 1;
    } else knownUsd += Math.max(0, e.usd ?? 0);
  };
  for (const t of on) add(t.key, t.estimate);
  const reviewIncluded = review !== null && on.some((t) => t.writes);
  if (reviewIncluded) add(REVIEW_KEY, review!.estimate);
  const r6 = (x: number) => Math.round(x * 1_000_000) / 1_000_000;
  return { knownUsd: r6(knownUsd), unknown: unknownCount, untyped, typedUsd: r6(typedTotal), count: on.length, reviewIncluded };
}

/** The key the daemon takes a typed budget for the last review under (goals.approve `taskBudgets.review`). */
export const REVIEW_KEY = "review";

/** Why `Approve and start` is disabled, said beside it; null when it may be clicked. */
export type ApproveBlock =
  | { code: "none_accepted" }
  | { code: "skipped_dependency"; task: string; dependsOn: string }
  | { code: "bad_budget" }
  | { code: "bad_task_budget"; task: string }
  | { code: "needs_budget"; task: string }
  | { code: "typed_over"; typedUsd: number; budgetUsd: number }
  | { code: "over_budget"; totalUsd: number; budgetUsd: number }
  | { code: "too_many"; max: number }
  | { code: "at_once" };

/**
 * Checks the approval the way goals.approve will (core splitBudget, skippedDependency), so the
 * button is disabled with its reason instead of failing after the click. On success, each accepted
 * task's share of the goal budget, which the folded tile shows. For a replan or an added task,
 * the tasks earlier approvals keep hold their shares and the last review its share, as the daemon
 * counts them; for a plan of one task, the goal budget is that task's budget.
 */
export function approvalCheck(
  tiles: readonly Pick<GoalTaskView, "key" | "number" | "estimate" | "writes" | "dependsOn">[],
  accepted: ReadonlySet<string>,
  budgetRaw: string,
  typed: Readonly<Record<string, string>>,
  review: ReviewItem | null,
  atOnce: number,
  limits: { min: number; max: number },
  scope: ApprovalScope = {},
): { ok: true; shares: Record<string, number> } | { ok: false; block: ApproveBlock } {
  const on = tiles.filter((t) => accepted.has(t.key));
  if (on.length === 0) return { ok: false, block: { code: "none_accepted" } };
  const kept = scope.oneTask ? [] : (scope.kept ?? []);
  const num = (key: string) => {
    const t = tiles.find((x) => x.key === key) ?? kept.find((x) => x.key === key);
    return t ? goalNumber(t.number) : key;
  };
  if (scope.maxTasks !== undefined && kept.length + on.length > scope.maxTasks) return { ok: false, block: { code: "too_many", max: scope.maxTasks } };
  // Kept tasks count as accepted; an edge of theirs to a rebuilt key now points at the tile holding it.
  const live = new Set([...tiles.map((t) => t.key), ...kept.map((t) => t.key)]);
  const nodes: DagNode[] = [...planNodes(tiles), ...kept.map((t) => ({ id: t.key, dependsOn: t.dependsOn.map((d) => d.key).filter((k) => live.has(k) && k !== t.key) }))];
  const skippedDep = skippedDependency(nodes, new Set([...accepted, ...kept.map((t) => t.key)]));
  if (skippedDep) return { ok: false, block: { code: "skipped_dependency", task: num(skippedDep.taskId), dependsOn: num(skippedDep.dependsOn) } };
  if (!Number.isInteger(atOnce) || atOnce < limits.min || atOnce > limits.max) return { ok: false, block: { code: "at_once" } };
  const budget = typedUsd(budgetRaw);
  if (budget === null) return { ok: false, block: { code: "bad_budget" } };
  const items: BudgetItem[] = [];
  for (const t of kept) {
    const share = t.shareUsd;
    items.push(share !== null && share > 0 ? { id: t.key, estimate: { usd: share, provenance: "estimated" }, typedUsd: share } : { id: t.key, estimate: { usd: 0, provenance: "estimated" } });
  }
  for (const t of on) {
    if (scope.oneTask) {
      // The one task's budget is the goal budget (goals.approve's one-task route), so an Unknown
      // estimate needs nothing more; a known one past the budget still says so before the click.
      items.push({ id: t.key, estimate: t.estimate, typedUsd: unknown(t.estimate) ? budget : null });
      continue;
    }
    const raw = typed[t.key];
    if (raw !== undefined && raw.trim() !== "" && typedUsd(raw) === null) return { ok: false, block: { code: "bad_task_budget", task: num(t.key) } };
    // Only an Unknown estimate takes a typed budget; a known one is split by its estimate.
    items.push({ id: t.key, estimate: t.estimate, typedUsd: unknown(t.estimate) ? typedUsd(raw) : null });
  }
  const writes = on.some((t) => t.writes) || kept.some((t) => t.writes);
  if (review && !scope.oneTask && writes) {
    const held = review.shareUsd ?? null;
    items.push(
      held !== null && held > 0
        ? { id: REVIEW_KEY, estimate: { usd: held, provenance: "estimated" }, typedUsd: held }
        : { id: REVIEW_KEY, estimate: review.estimate, typedUsd: unknown(review.estimate) ? typedUsd(typed[REVIEW_KEY]) : null },
    );
  }
  const split = splitBudget(budget, items);
  if (split.ok) return { ok: true, shares: split.shares };
  switch (split.code) {
    case "needs_budget":
      return { ok: false, block: { code: "needs_budget", task: split.id === REVIEW_KEY ? REVIEW_KEY : num(split.id) } };
    case "typed_over":
      return { ok: false, block: { code: "typed_over", typedUsd: split.typedTotalUsd, budgetUsd: split.budgetUsd } };
    case "over_budget":
      return { ok: false, block: { code: "over_budget", totalUsd: split.totalUsd, budgetUsd: split.budgetUsd } };
    case "bad_budget":
      return { ok: false, block: split.id === null ? { code: "bad_budget" } : { code: "bad_task_budget", task: split.id === REVIEW_KEY ? REVIEW_KEY : num(split.id) } };
  }
}

/** What the kept tasks and the last review already hold of the goal budget, said beside a replan's total. */
export function heldShares(kept: readonly Pick<GoalTaskView, "shareUsd">[], review: ReviewItem | null): number {
  const sum = kept.reduce((a, t) => a + Math.max(0, t.shareUsd ?? 0), 0) + Math.max(0, review?.shareUsd ?? 0);
  return Math.round(sum * 1_000_000) / 1_000_000;
}

/** Where Ctrl Enter must not approve: the task editor (Ctrl Enter saves there) and the Revise note. */
export const APPROVE_KEY_EXCLUDED = ".gp-editor, .gp-revise";

/**
 * Whether Ctrl Enter in the plan review approves (design §3.7). Never from inside the task editor
 * or the Revise note, never while the editor is open with edits not saved, and never while a goal
 * call is on its way: the approval covers what you saw, and an edit in flight changes it.
 */
export function approveKeyApplies(target: { closest?: (selector: string) => unknown } | null, state: { editing: boolean; pending: boolean }): boolean {
  if (state.editing || state.pending) return false;
  return !(target && typeof target.closest === "function" && target.closest(APPROVE_KEY_EXCLUDED));
}

/** The keys and typed budgets goals.approve takes; typed budgets only for Unknown estimates. */
export function approveParams(
  tiles: readonly Pick<GoalTaskView, "key" | "estimate" | "writes">[],
  accepted: ReadonlySet<string>,
  typed: Readonly<Record<string, string>>,
  review: ReviewItem | null,
): { accept: string[]; taskBudgets: Record<string, number> } {
  const accept = tiles.filter((t) => accepted.has(t.key)).map((t) => t.key);
  const taskBudgets: Record<string, number> = {};
  for (const t of tiles) {
    if (!accepted.has(t.key) || !unknown(t.estimate)) continue;
    const v = typedUsd(typed[t.key]);
    if (v !== null) taskBudgets[t.key] = v;
  }
  if (review && unknown(review.estimate) && tiles.some((t) => accepted.has(t.key) && t.writes)) {
    const v = typedUsd(typed[REVIEW_KEY]);
    if (v !== null) taskBudgets[REVIEW_KEY] = v;
  }
  return { accept, taskBudgets };
}

/** One automatic ordering the review explains: `task` runs after `after`, because of `paths` or no planned files. */
export interface OverlapLine {
  taskKey: string;
  afterKey: string;
  task: string;
  after: string;
  cause: "paths" | "no_paths";
  /** The overlapping pattern, as the planner wrote it; absent for a task with no planned files. */
  paths: string | null;
}

/**
 * The info lines of the overlap ordering (design §3.2, §4.8): every `overlap` edge between two
 * accepted tasks, with the overlapping paths the revision recorded. The edge itself is the truth:
 * `Run side by side anyway` removes it, and the line goes with it.
 */
export function overlapLines(revision: Pick<GoalRevisionView, "overlaps"> | null, tiles: readonly Pick<GoalTaskView, "key" | "taskId" | "number" | "dependsOn" | "paths" | "writes">[], accepted: ReadonlySet<string>): OverlapLine[] {
  const byKey = new Map(tiles.map((t) => [t.key, t]));
  const out: OverlapLine[] = [];
  for (const t of tiles) {
    if (!accepted.has(t.key)) continue;
    for (const d of t.dependsOn) {
      if (d.source !== "overlap" || !accepted.has(d.key)) continue;
      const after = byKey.get(d.key);
      if (!after) continue;
      // The revision's record names tasks by id after materialisation, by key before; either matches.
      const edge = revision?.overlaps.find((o) => (o.taskId === t.taskId || o.taskId === t.key) && (o.dependsOn === after.taskId || o.dependsOn === after.key));
      const noPaths = edge ? edge.cause === "no_paths" : t.writes && t.paths.length === 0;
      out.push({
        taskKey: t.key,
        afterKey: after.key,
        task: goalNumber(t.number),
        after: goalNumber(after.number),
        cause: noPaths ? "no_paths" : "paths",
        paths: noPaths ? null : (edge?.paths?.[0] ?? sharedPath(t.paths, after.paths)),
      });
    }
  }
  return out;
}

/** The first pattern of `a` that names the same place as one of `b`, for a line without a recorded pair. */
function sharedPath(a: readonly string[], b: readonly string[]): string | null {
  const base = (p: string) => p.toLowerCase().replace(/[*?].*$/, "");
  for (const x of a) for (const y of b) if (base(x).startsWith(base(y)) || base(y).startsWith(base(x))) return x;
  return a[0] ?? null;
}

/**
 * Task numbers as a sentence lists them in the UI language: "02, 03 and 04", "02, 03 ve 04".
 * Joining with a translated " and " gave "02 and 03 and 04".
 */
export function joinList(items: readonly string[], lang: string): string {
  try {
    return new Intl.ListFormat(lang, { type: "conjunction" }).format(items);
  } catch {
    // An unknown language tag: English order is still readable.
    return new Intl.ListFormat("en", { type: "conjunction" }).format(items);
  }
}

/**
 * "01's report feeds 02 and 03: you read and accept it before they start" (design §3.2, §4.6):
 * every accepted task that writes nothing, with the accepted writing tasks that build on it.
 */
export function reportFeeds(tiles: readonly Pick<GoalTaskView, "key" | "number" | "writes" | "dependsOn">[], accepted: ReadonlySet<string>): Array<{ from: string; to: string[] }> {
  const out: Array<{ from: string; to: string[] }> = [];
  for (const r of tiles) {
    if (r.writes || !accepted.has(r.key)) continue;
    const to = tiles.filter((w) => w.writes && accepted.has(w.key) && w.dependsOn.some((d) => d.key === r.key && d.source !== "overlap")).map((w) => goalNumber(w.number));
    if (to.length > 0) out.push({ from: goalNumber(r.number), to });
  }
  return out;
}

/**
 * The revise diff (design §3.2, §4.10) in the review's own terms: added and changed tasks by their
 * plan number; removed tasks are gone from the tiles, so they are named by the title the earlier
 * revision gave them. A removed key no earlier task holds is only counted, never shown raw.
 */
export function diffLines(
  revision: Pick<GoalRevisionView, "diff" | "revision"> | null,
  tiles: readonly Pick<GoalTaskView, "key" | "number">[],
  tasks: readonly Pick<GoalTaskView, "key" | "title" | "revision">[] = [],
): { added: string[]; changed: string[]; removed: string[]; removedUnnamed: number } | null {
  const d = revision?.diff;
  if (!revision || !d || (d.added.length === 0 && d.changed.length === 0 && d.removed.length === 0)) return null;
  const name = (k: string) => {
    const t = tiles.find((x) => x.key === k);
    return t ? goalNumber(t.number) : null;
  };
  const removed: string[] = [];
  let removedUnnamed = 0;
  for (const k of d.removed) {
    const before = tasks.filter((t) => t.key === k && t.revision < revision.revision).sort((x, y) => y.revision - x.revision)[0];
    if (before) removed.push(before.title);
    else removedUnnamed += 1;
  }
  const named = (keys: string[]) => keys.map(name).filter((x): x is string => x !== null);
  return { added: named(d.added), changed: named(d.changed), removed, removedUnnamed };
}

/** The diff mark a tile carries after a revise. */
export function diffMark(revision: Pick<GoalRevisionView, "diff"> | null, key: string): "added" | "changed" | null {
  const d = revision?.diff;
  if (!d) return null;
  if (d.added.includes(key)) return "added";
  if (d.changed.includes(key)) return "changed";
  return null;
}

/**
 * The loop a new "Waits for" edge would close, as plan numbers ("01 → 03 → 01"), or null. The
 * editor refuses it before the call, as the Crew graph does; the daemon refuses it again.
 */
export function waitsForLoop(tiles: readonly Pick<GoalTaskView, "key" | "number" | "dependsOn">[], taskKey: string, dependsOnKey: string): string | null {
  const loop = wouldCycle(planNodes(tiles), taskKey, dependsOnKey);
  if (!loop) return null;
  const num = (k: string) => {
    const t = tiles.find((x) => x.key === k);
    return t ? goalNumber(t.number) : k;
  };
  return loop.map(num).join(" → ");
}

/** Plan text is untrusted: the editor sends lines as the planner's own checks take them. */
export const splitLines = (s: string): string[] =>
  s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * How `Plan goal` states a planning run's cost (design §3.1, §4.4): a sign-in or a local model
 * bills no API cost ($0 Estimated, named as such); a paid model without a price is Unknown; a
 * priced one is "~$x Estimated". The ceiling, the planning run's own budget, is stated only for an
 * API run, where it is what the run may spend.
 */
export function planningCost(p: Pick<GoalPreview, "estimate" | "billing" | "ceilingUsd">): { kind: "plan" | "local" | "unknown" | "approx"; usd: number | null; ceiling: number | null } {
  if (p.billing === "plan" || p.billing === "local") return { kind: p.billing, usd: 0, ceiling: null };
  const ceiling = p.ceilingUsd !== null && p.ceilingUsd > 0 ? p.ceilingUsd : null;
  if (p.estimate.usd === null || p.estimate.provenance === "unknown") return { kind: "unknown", usd: null, ceiling };
  return { kind: "approx", usd: p.estimate.usd, ceiling };
}
