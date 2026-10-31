import { basisMatch, failureKey } from "./autopilot.ts";
import { MAX_CREW_STEPS } from "./crew-edit.ts";
import { capText, utf8Length } from "./event-caps.ts";
import type { CostEstimate, Reason, TaskKind, TaskMode, TaskSize } from "./ipc/tasks.ts";
import { cleanText } from "./mcp.ts";
import type { TaskStatus } from "./state.ts";

// Orchestra goals (docs/adr/0019): one goal, a plan of tasks written once by a read-only planner,
// approved once by you, and released by the daemon in dependency order. Everything here is pure:
// the plan's checks, the task graph, the file-overlap ordering, the budget split, the stop rule and
// the derived goal status. The daemon applies these rules on every call; no prompt enforces them.
// The planner's output is untrusted text: it is cleaned and capped here, refused rather than cut,
// and shown as plain text.

/** Every number a goal is held to (design §5.1). Each one has a test that proves it is enforced. */
export const GOAL_LIMITS = {
  /** Tasks per goal: the default, and the hard maximum (the same as a crew's steps). */
  maxTasks: 8,
  maxTasksHard: MAX_CREW_STEPS,
  /** Goal tasks released and unfinished at once. */
  maxParallel: 2,
  maxParallelMin: 1,
  maxParallelMax: 4,
  /** Replans after approval (Magentic-UI `max_replans` 3). */
  replans: 3,
  /** `Revise` before the first approval; each one is a paid planning run. */
  revisionsBeforeApproval: 5,
  /** Corrective turns after our own check refuses a plan. */
  correctiveTurns: 1,
  /** The stop rule: two goal tasks failing the same way, or this many failed goal tasks. */
  stopSameFailure: 2,
  stopFailedTasks: 3,
  /** Your goal text, its title (first line, cut), and a note to the planner. */
  goalTextBytes: 8_000,
  goalTitleBytes: 120,
  noteBytes: 2_000,
  /** Plan fields, refused (not cut) past these. */
  summaryBytes: 600,
  titleBytes: 120,
  descriptionBytes: 4_000,
  criteriaMin: 1,
  criteria: 12,
  criterionBytes: 300,
  basisBytes: 300,
  reasonBytes: 300,
  paths: 20,
  pathBytes: 200,
  /** An accepted report's summary as a writing task reads it (design §4.11). */
  reportSummaryBytes: 4_096,
  /** Goal budget prefill: the known total rounded up to whole dollars, times this. */
  budgetFactor: 1.5,
  /** The smallest whole-dollar total the prefill starts from, so a free plan still gets a budget. */
  budgetFloorUsd: 1,
  /** Highest goal budget the daemon accepts; a typo of extra zeros is refused, not spent. */
  budgetMaxUsd: 10_000,
  /** The planning run's own budget: min(project per-task cap, max(3 x estimate, $0.25)). */
  planningMultiplier: 3,
  planningFloorUsd: 0.25,
  /** The planning estimate heuristic (design §4.4); corrected from measured runs before release. */
  plannerTokensIn: 80_000,
  plannerTokensOut: 8_000,
  /** Goal events per page in the goal view's Details fold. */
  eventsPage: 40,
} as const;

/** Settings rows (design §6.1). Values are JSON, like every other settings row. */
export const GOAL_SETTINGS = {
  enabled: "orchestra.enabled",
  pausedAll: "goals.paused_all",
  goalBudget: (projectId: string) => `orchestra.goalBudget.${projectId}`,
  introduced: (projectId: string) => `orchestra.introduced.${projectId}`,
} as const;

/** What a missing `orchestra.enabled` row means. The migration writes the same value. */
export const ORCHESTRA_ENABLED_DEFAULT = true;

export type GoalPriority = "high" | "medium" | "low";
export const GOAL_PRIORITIES: readonly GoalPriority[] = ["high", "medium", "low"];
export const GOAL_TASK_KINDS: readonly TaskKind[] = ["code", "research", "review", "docs"];
export const GOAL_TASK_SIZES: readonly TaskSize[] = ["S", "M", "L"];
export const GOAL_TASK_MODES: readonly TaskMode[] = ["solo", "crew"];

/** Why a plan revision exists: the first plan, your `Revise` before approval, a `Replan` after it, or `Add task`. */
export type GoalPlanCause = "initial" | "revise" | "replan" | "add";
/** Where a dependency came from: the planner, you, or the automatic file-overlap ordering. */
export type GoalDepSource = "plan" | "user" | "overlap";

export interface GoalPlanTask {
  /** `^[a-z0-9-]{1,16}$`, unique in the plan. */
  key: string;
  title: string;
  kind: TaskKind;
  /** A suggestion; the crew scorer still picks who runs it. */
  mode: TaskMode;
  size: TaskSize;
  description: string;
  acceptance: string[];
  /** The words of your goal this task rests on; checked softly (goalBasisMatches). */
  basis: string;
  /** Keys of tasks listed earlier in the plan, so a plan is a DAG by construction. */
  dependsOn: string[];
  /** Repo-relative paths or globs it plans to change; compared, never opened. */
  paths: string[];
  reason: string;
  priority: GoalPriority;
}

export interface GoalPlan {
  summary: string;
  tasks: GoalPlanTask[];
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** `too_many_tasks` lets the UI offer "Raise the limit to 12 and retry"; everything else is `invalid`. */
export type GoalPlanRefusal = "too_many_tasks" | "invalid";
export type GoalPlanParse = { ok: true; value: GoalPlan } | { ok: false; error: string; code: GoalPlanRefusal; count?: number; limit?: number };

export const GOAL_TASK_KEY = /^[a-z0-9-]{1,16}$/;

const PLAN_KEYS = new Set(["summary", "tasks"]);
const TASK_KEYS = new Set(["key", "title", "kind", "mode", "size", "description", "acceptance", "basis", "dependsOn", "paths", "reason", "priority"]);

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function text(v: unknown, field: string, max: number, opts: { required: boolean; oneLine?: boolean }): Parsed<string> {
  if (v === undefined || v === null) return { ok: false, error: `${field} is required` };
  if (typeof v !== "string") return { ok: false, error: `${field} must be a string` };
  const s = cleanText(v);
  if (opts.required && !s) return { ok: false, error: `${field} must not be empty` };
  if (opts.oneLine && s.includes("\n")) return { ok: false, error: `${field} must be one line` };
  const n = utf8Length(s);
  // Refused rather than cut: the planner learns the limit in its corrective turn and says it shorter.
  if (n > max) return { ok: false, error: `${field} is ${n} bytes; the limit is ${max}` };
  return { ok: true, value: s };
}

function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): Parsed<T> {
  if (typeof v !== "string" || !allowed.includes(v as T)) return { ok: false, error: `${field} must be one of ${allowed.join(", ")}` };
  return { ok: true, value: v as T };
}

function unknownKey(o: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): string | null {
  const extra = Object.keys(o).find((k) => !allowed.has(k));
  return extra === undefined ? null : `${where} has an unknown field "${extra}"`;
}

// Windows device names open the device, not a file, whatever the extension (the same list as the Files tab).
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

/**
 * Why a planned path is refused, or null. Paths are repo-relative with forward slashes; globs use
 * `*`, `**` and `?` only. They are only ever compared with each other, but the same refusals as the
 * Files tab keep anything that names a place outside the repository out of the record.
 */
export function plannedPathError(p: string): string | null {
  if (!p) return "a path must not be empty";
  const n = utf8Length(p);
  if (n > GOAL_LIMITS.pathBytes) return `path "${p.slice(0, 40)}..." is ${n} bytes; the limit is ${GOAL_LIMITS.pathBytes}`;
  if (p.includes("\\")) return `path "${p}" must use forward slashes`;
  if (/[\t\n]/.test(p)) return `path "${p}" must be one line`;
  if (p.startsWith("/")) return `path "${p}" must be relative to the repository, not absolute`;
  // A colon is a drive (C:), a stream (a.txt:secret) or a device; none belongs in a relative path.
  if (p.includes(":")) return `path "${p}" must not contain ":"`;
  if (/[<>"|[\]{}!]/.test(p)) return `path "${p}" may use only * , ** and ? as wildcards`;
  const parts = p.split("/");
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i]!;
    // A trailing slash names a folder; an empty part anywhere else is a typo.
    if (s === "" && i === parts.length - 1 && i > 0) continue;
    if (s === "") return `path "${p}" has an empty part`;
    if (s === "." || s === "..") return `path "${p}" must not contain "." or ".." parts`;
    if (DEVICE.test(s)) return `path "${p}" names a Windows device`;
  }
  return null;
}

function paths(v: unknown, field: string, kind: TaskKind): Parsed<string[]> {
  if (!Array.isArray(v)) return { ok: false, error: `${field} must be an array of strings` };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== "string") return { ok: false, error: `${field} must be an array of strings` };
    const p = cleanText(raw);
    const why = plannedPathError(p);
    if (why) return { ok: false, error: `${field}: ${why}` };
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  if (out.length > GOAL_LIMITS.paths) return { ok: false, error: `${field} has ${out.length} paths; the limit is ${GOAL_LIMITS.paths}` };
  // Code and docs tasks commit files; without their paths the overlap ordering has nothing to compare.
  if ((kind === "code" || kind === "docs") && out.length === 0) return { ok: false, error: `${field} must list at least one path for a ${kind} task` };
  return { ok: true, value: out };
}

function acceptance(v: unknown, field: string): Parsed<string[]> {
  if (!Array.isArray(v)) return { ok: false, error: `${field} must be an array of strings` };
  const out: string[] = [];
  for (const c of v) {
    const s = text(c, `${field} line`, GOAL_LIMITS.criterionBytes, { required: false, oneLine: true });
    if (!s.ok) return s;
    if (s.value && !out.includes(s.value)) out.push(s.value);
  }
  if (out.length < GOAL_LIMITS.criteriaMin) return { ok: false, error: `${field} needs at least ${GOAL_LIMITS.criteriaMin} line` };
  if (out.length > GOAL_LIMITS.criteria) return { ok: false, error: `${field} has ${out.length} lines; the limit is ${GOAL_LIMITS.criteria}` };
  return { ok: true, value: out };
}

/** The task-count limit a goal may set: 1 to the hard maximum. */
export const clampMaxTasks = (n: number | null | undefined): number =>
  n === null || n === undefined || !Number.isFinite(n) ? GOAL_LIMITS.maxTasks : Math.min(GOAL_LIMITS.maxTasksHard, Math.max(1, Math.round(n)));

const invalid = (error: string): GoalPlanParse => ({ ok: false, error, code: "invalid" });

/**
 * Checks a planner's result (or a revision you edited) in the style of parseTaskDraft: unknown
 * fields refused, text cleaned, every bound checked here and refused rather than cut. The
 * structured-output schema (GOAL_PLAN_OUTPUT) carries no bounds, so this is the only place they live.
 */
export function parseGoalPlan(value: unknown, opts: { maxTasks?: number | null } = {}): GoalPlanParse {
  const limit = clampMaxTasks(opts.maxTasks);
  const a = rec(value);
  if (!a) return invalid("the plan must be an object");
  const extra = unknownKey(a, PLAN_KEYS, "the plan");
  if (extra) return invalid(extra);
  const summary = text(a.summary, "summary", GOAL_LIMITS.summaryBytes, { required: false });
  if (!summary.ok) return invalid(summary.error);
  if (!Array.isArray(a.tasks)) return invalid("tasks must be an array");
  if (a.tasks.length === 0) return invalid("the plan has no tasks; it needs at least 1");
  if (a.tasks.length > limit) return { ok: false, error: `the plan has ${a.tasks.length} tasks; the limit is ${limit}`, code: "too_many_tasks", count: a.tasks.length, limit };
  const tasks: GoalPlanTask[] = [];
  const keys = new Set<string>();
  for (let i = 0; i < a.tasks.length; i++) {
    const t = parseGoalTask(a.tasks[i], keys, `tasks[${i}]`);
    if (!t.ok) return invalid(t.error);
    keys.add(t.value.key);
    tasks.push(t.value);
  }
  return { ok: true, value: { summary: summary.value, tasks } };
}

/**
 * Checks one plan task with the same rules as parseGoalPlan. `earlier` holds the keys it may depend
 * on: the tasks listed before it, or for `Add task` and tile edits, the goal's other tasks (the
 * caller still refuses a loop with wouldCycle). Its own key must not be among them.
 */
export function parseGoalTask(value: unknown, earlier: ReadonlySet<string>, at = "task"): Parsed<GoalPlanTask> {
  const t = rec(value);
  if (!t) return { ok: false, error: `${at} must be an object` };
  const ex = unknownKey(t, TASK_KEYS, at);
  if (ex) return { ok: false, error: ex };
  if (typeof t.key !== "string" || !GOAL_TASK_KEY.test(t.key)) return { ok: false, error: `${at}.key must be 1 to 16 lowercase letters, digits or dashes` };
  const key = t.key;
  if (earlier.has(key)) return { ok: false, error: `${at}.key "${key}" is used twice` };
  const title = text(t.title, `${at}.title`, GOAL_LIMITS.titleBytes, { required: true, oneLine: true });
  if (!title.ok) return title;
  const kind = oneOf(t.kind, `${at}.kind`, GOAL_TASK_KINDS);
  if (!kind.ok) return kind;
  const mode = oneOf(t.mode, `${at}.mode`, GOAL_TASK_MODES);
  if (!mode.ok) return mode;
  const size = oneOf(t.size, `${at}.size`, GOAL_TASK_SIZES);
  if (!size.ok) return size;
  const priority = oneOf(t.priority, `${at}.priority`, GOAL_PRIORITIES);
  if (!priority.ok) return priority;
  const description = text(t.description, `${at}.description`, GOAL_LIMITS.descriptionBytes, { required: false });
  if (!description.ok) return description;
  const acc = acceptance(t.acceptance, `${at}.acceptance`);
  if (!acc.ok) return acc;
  const basis = text(t.basis, `${at}.basis`, GOAL_LIMITS.basisBytes, { required: false });
  if (!basis.ok) return basis;
  const reason = text(t.reason, `${at}.reason`, GOAL_LIMITS.reasonBytes, { required: true });
  if (!reason.ok) return reason;
  if (!Array.isArray(t.dependsOn)) return { ok: false, error: `${at}.dependsOn must be an array of keys` };
  const deps: string[] = [];
  for (const d of t.dependsOn) {
    if (typeof d !== "string") return { ok: false, error: `${at}.dependsOn must be an array of keys` };
    if (d === key) return { ok: false, error: `${at} ("${key}") must not depend on itself` };
    // Only keys listed earlier: task-master's "lower ids" rule, which makes a cycle impossible.
    if (!earlier.has(d)) return { ok: false, error: `${at} ("${key}") depends on "${d}", which is not a task listed before it` };
    if (!deps.includes(d)) deps.push(d);
  }
  const p = paths(t.paths, `${at}.paths`, kind.value);
  if (!p.ok) return p;
  return {
    ok: true,
    value: {
      key,
      title: title.value,
      kind: kind.value,
      mode: mode.value,
      size: size.value,
      description: description.value,
      acceptance: acc.value,
      basis: basis.value,
      dependsOn: deps,
      paths: p.value,
      reason: reason.value.replace(/\s+/g, " "),
      priority: priority.value,
    },
  };
}

/** Your note to the planner on Revise or Replan: cleaned, may be empty, refused past the limit. */
export function parseGoalNote(v: unknown): Parsed<string> {
  if (v === undefined || v === null) return { ok: true, value: "" };
  return text(v, "note", GOAL_LIMITS.noteBytes, { required: false });
}

/**
 * An accepted report's summary as a writing task's prompt quotes it (design §4.11): cut at whole
 * characters to 4 KB with a marker. You read and accepted the full report; the excerpt only bounds the prompt.
 */
export function goalReportExcerpt(summary: string): string {
  return capText(cleanText(summary), GOAL_LIMITS.reportSummaryBytes).text;
}

// Dotless ı and dotted İ fold to i, accents and smart quotes to their plain forms, so a planner
// that re-cases or re-types Turkish text still matches your words.
const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ı/g, "i")
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/**
 * Whether a task's basis quotes your goal. A soft check: a miss leaves the plan accepted and the
 * tile reads "Not tied to your words". The hard version stays with Autopilot (basisMatch), where it
 * guards against injected text; here it only shows which of your words a task rests on.
 */
export function goalBasisMatches(basis: string, goalText: string): boolean {
  if (basisMatch(basis, [goalText]) >= 0) return true;
  const b = fold(basis);
  if (b.length < 8) return false;
  return fold(goalText).includes(b);
}

/** Your goal text, cleaned; refused when empty or past the limit. */
export function parseGoalText(v: unknown): Parsed<string> {
  return text(v, "goal", GOAL_LIMITS.goalTextBytes, { required: true });
}

/** The goal's title: its first non-empty line, cut at whole characters to the title limit. */
export function goalTitle(goalText: string): string {
  const line = (cleanText(goalText).split("\n").find((l) => l.trim()) ?? "").trim().replace(/\s+/g, " ");
  if (utf8Length(line) <= GOAL_LIMITS.goalTitleBytes) return line;
  let out = "";
  for (const ch of line) {
    if (utf8Length(out + ch) > GOAL_LIMITS.goalTitleBytes - 3) break;
    out += ch;
  }
  return `${out.trimEnd()}...`;
}

// ---------------------------------------------------------------- the task graph

/** A node of a goal's task graph: a plan key before materialisation, a task id after. */
export interface DagNode {
  id: string;
  dependsOn: readonly string[];
}

const depsMap = (nodes: readonly DagNode[]) => new Map(nodes.map((n) => [n.id, n.dependsOn]));

/** Every task `id` waits for, directly or through others. */
export function ancestorsOf(nodes: readonly DagNode[], id: string): Set<string> {
  const deps = depsMap(nodes);
  const out = new Set<string>();
  const stack = [...(deps.get(id) ?? [])];
  while (stack.length) {
    const d = stack.pop()!;
    if (out.has(d)) continue;
    out.add(d);
    stack.push(...(deps.get(d) ?? []));
  }
  return out;
}

/** Every task that waits for `id`, directly or through others, in input order (skipping cascades to these). */
export function goalDependents(nodes: readonly DagNode[], id: string): string[] {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (out.has(n.id)) continue;
      if (n.dependsOn.some((d) => d === id || out.has(d))) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return nodes.filter((n) => out.has(n.id)).map((n) => n.id);
}

/**
 * The loop that `taskId` waiting for `dependsOn` would close, as ids from `taskId` back to itself
 * ("01 → 03 → 01"), or null when the edge is safe. Edges you draw, overlap edges and added tasks
 * all pass through this before they are stored.
 */
export function wouldCycle(nodes: readonly DagNode[], taskId: string, dependsOn: string): string[] | null {
  if (taskId === dependsOn) return [taskId, taskId];
  const deps = depsMap(nodes);
  const seen = new Set<string>();
  // Walk dependsOn's own prerequisites; reaching taskId means the new edge closes a loop.
  const walk = (at: string, path: string[]): string[] | null => {
    if (at === taskId) return path;
    if (seen.has(at)) return null;
    seen.add(at);
    for (const d of deps.get(at) ?? []) {
      const found = walk(d, [...path, d]);
      if (found) return found;
    }
    return null;
  };
  const loop = walk(dependsOn, [dependsOn]);
  return loop ? [taskId, ...loop] : null;
}

/**
 * The plan review's steps: step n holds the tasks whose longest path from a root is n (beads'
 * layers). Dependencies on ids outside `nodes` (discarded tasks) are ignored. Throws on a cycle,
 * which every write path refuses before it gets here.
 */
export function layers(nodes: readonly DagNode[]): string[][] {
  const ids = new Set(nodes.map((n) => n.id));
  const deps = depsMap(nodes);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const of = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new Error(`cycle through ${id}`);
    visiting.add(id);
    let d = 0;
    for (const p of deps.get(id) ?? []) if (ids.has(p)) d = Math.max(d, of(p) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  const out: string[][] = [];
  for (const n of nodes) {
    const d = of(n.id);
    (out[d] ??= []).push(n.id);
  }
  return out.filter((l) => l !== undefined);
}

/** The first accepted task that waits for a skipped one, or null. A goal with that shape cannot be approved. */
export function skippedDependency(nodes: readonly DagNode[], accepted: ReadonlySet<string>): { taskId: string; dependsOn: string } | null {
  for (const n of nodes) {
    if (!accepted.has(n.id)) continue;
    const d = n.dependsOn.find((x) => !accepted.has(x));
    if (d !== undefined) return { taskId: n.id, dependsOn: d };
  }
  return null;
}

// ---------------------------------------------------------------- readiness

/** What the release pass knows about one goal task. `status` is the task's derived TaskStatus. */
export interface GoalTaskFacts {
  id: string;
  /** What the person reads for it ("01"); used in hold reasons. */
  label: string;
  position: number;
  priority: GoalPriority;
  /** Any crew member writes (code and docs): it counts as finished only once merged into the goal branch. */
  writes: boolean;
  /** null until decided, false when you skipped it. */
  accepted: boolean | null;
  discarded: boolean;
  released: boolean;
  joined: boolean;
  reportAccepted: boolean;
  status: TaskStatus;
  deps: ReadonlyArray<{ on: string; source: GoalDepSource }>;
}

const PRIORITY_RANK: Record<GoalPriority, number> = { high: 0, medium: 1, low: 2 };

/** Statuses of a released task that holds one of the goal's parallel slots. */
const ACTIVE: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["running", "queued", "handing_off", "needs_input", "limited"]);

/** A non-writing task's own work is over when its derived status is done (or review, for a code-kind crew that writes nothing). */
const reportReady = (t: GoalTaskFacts) => t.status === "done" || t.status === "review";

/** A writing task whose gates passed and that waits only for the scheduler to merge it. */
export const awaitingJoin = (t: GoalTaskFacts): boolean => t.writes && !t.joined && t.released && (t.status === "review" || t.status === "done" || t.status === "merged");

/** Finished, as the goal counts it: merged into the goal branch for a writer; done for the rest. */
export const goalTaskFinished = (t: GoalTaskFacts): boolean => (t.writes ? t.joined : reportReady(t));

/** Accepted, not discarded and not cancelled: a task the goal still counts. */
const live = (t: GoalTaskFacts) => t.accepted === true && !t.discarded && t.status !== "cancelled";

export type GoalUnmet = "finish" | "report" | "join" | "failed" | "cancelled" | "skipped";

/**
 * The prerequisites of `task` that are not satisfied, with why (design §4.6). A failed, cancelled
 * or skipped prerequisite is never satisfied: its dependents hold and you choose.
 */
export function unmetPrerequisites(task: GoalTaskFacts, byId: ReadonlyMap<string, GoalTaskFacts>): Array<{ on: string; source: GoalDepSource; why: GoalUnmet }> {
  const out: Array<{ on: string; source: GoalDepSource; why: GoalUnmet }> = [];
  for (const d of task.deps) {
    const p = byId.get(d.on);
    const why = unmetWhy(p, task);
    if (why) out.push({ on: d.on, source: d.source, why });
  }
  return out;
}

function unmetWhy(p: GoalTaskFacts | undefined, dependent: GoalTaskFacts): GoalUnmet | null {
  if (!p || p.accepted !== true || p.discarded) return "skipped";
  if (p.status === "cancelled") return "cancelled";
  if (p.status === "failed") return "failed";
  if (p.writes) {
    if (p.joined) return null;
    return awaitingJoin(p) ? "join" : "finish";
  }
  if (!reportReady(p)) return "finish";
  // Untrusted text from a task that writes nothing reaches a writing agent only after you read it.
  if (dependent.writes && !p.reportAccepted) return "report";
  return null;
}

/**
 * Tasks the scheduler may release now: accepted, not released, not discarded, every prerequisite
 * satisfied. Ordered by priority, then fewer prerequisites, then plan position (task-master's
 * tie-breaks, returning the whole set). The goal's parallel cap is applied by the caller.
 */
export function readySet(tasks: readonly GoalTaskFacts[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks
    .filter((t) => t.accepted === true && !t.released && !t.discarded && t.status !== "cancelled" && unmetPrerequisites(t, byId).length === 0)
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.deps.length - b.deps.length || a.position - b.position)
    .map((t) => t.id);
}

/** Released goal tasks that still hold one of the goal's parallel slots. */
export const releasedUnfinished = (tasks: readonly GoalTaskFacts[]): number => tasks.filter((t) => live(t) && t.released && !goalTaskFinished(t) && !awaitingJoin(t) && t.status !== "failed").length;

/** How many more tasks the release pass may release under the goal's cap. */
export const releaseRoom = (tasks: readonly GoalTaskFacts[], maxParallel: number): number => Math.max(0, maxParallel - releasedUnfinished(tasks));

const UNMET_REASON: Record<GoalUnmet, Reason["code"]> = {
  finish: "goal.waits_finish",
  report: "goal.waits_report",
  join: "goal.waits_join",
  failed: "goal.prereq_failed",
  cancelled: "goal.prereq_cancelled",
  skipped: "goal.prereq_skipped",
};

/**
 * Why an accepted, unreleased task does not start, as a translatable reason naming the task it
 * waits for, or null when its prerequisites are all satisfied. An ordering from the overlap check
 * reads "same files" while that task is unfinished.
 */
export function prerequisiteHold(task: GoalTaskFacts, tasks: readonly GoalTaskFacts[]): Reason | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const first = unmetPrerequisites(task, byId)[0];
  if (!first) return null;
  const label = byId.get(first.on)?.label ?? first.on;
  const code = first.source === "overlap" && (first.why === "finish" || first.why === "join") ? "goal.waits_overlap" : UNMET_REASON[first.why];
  return { code, params: { task: label, taskId: first.on } };
}

// ---------------------------------------------------------------- file overlap

/** A path's comparison form: forward slashes, lower case (as Windows compares), no trailing slash. */
const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");

/**
 * The literal folder a glob is reduced to: everything before the first wildcard, cut back to a
 * folder boundary, with a trailing slash ("src/auth/**" → "src/auth/", "src/a*.ts" → "src/").
 * An empty string means the glob can match anywhere.
 */
export function globBase(p: string): string {
  const n = p.replace(/\\/g, "/").toLowerCase();
  const w = n.search(/[*?]/);
  if (w < 0) return n;
  const head = n.slice(0, w);
  const slash = head.lastIndexOf("/");
  return slash < 0 ? "" : head.slice(0, slash + 1);
}

const isGlob = (p: string) => /[*?]/.test(p);
const under = (child: string, folder: string) => child === folder || child.startsWith(`${folder}/`);

/**
 * Whether two planned paths could name the same file. Deliberately conservative: equal paths
 * (case-insensitive), one a folder of the other, or a glob whose literal folder contains or is
 * contained by the other. A false positive only orders two tasks; a false negative risks a conflict.
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (!isGlob(a) && !isGlob(b)) {
    const x = norm(a);
    const y = norm(b);
    return under(x, y) || under(y, x);
  }
  const x = isGlob(a) ? globBase(a) : `${norm(a)}/`;
  const y = isGlob(b) ? globBase(b) : `${norm(b)}/`;
  return x.startsWith(y) || y.startsWith(x);
}

/** The first overlapping pair between two path lists, or null. */
export function firstOverlap(a: readonly string[], b: readonly string[]): [string, string] | null {
  for (const x of a) for (const y of b) if (pathsOverlap(x, y)) return [x, y];
  return null;
}

export interface OverlapTask {
  id: string;
  position: number;
  writes: boolean;
  /** false (skipped) leaves the task out; null and true count. */
  accepted?: boolean | null;
  paths: readonly string[];
  dependsOn: readonly string[];
}

/** One automatic ordering: `taskId` waits for `dependsOn`. `paths` is the overlapping pair, absent for a task with no planned paths. */
export interface OverlapEdge {
  taskId: string;
  dependsOn: string;
  cause: "paths" | "no_paths";
  paths?: [string, string];
}

const pairKey = (a: string, b: string) => (a < b ? `${a}\n${b}` : `${b}\n${a}`);

/**
 * The automatic ordering of writing tasks that could run at the same time (design §4.8). For each
 * pair of accepted writing tasks where neither already waits for the other, overlapping planned
 * paths put the later task after the earlier one, as Spec Kit's "same files run sequentially".
 * A writing task with no planned paths goes after the other writing tasks. Edges are added one
 * at a time against the graph so far, so the result never closes a loop. `sideBySide` holds the
 * pairs you chose to run side by side anyway.
 */
export function overlapPairs(tasks: readonly OverlapTask[], opts: { sideBySide?: ReadonlyArray<readonly [string, string]> } = {}): OverlapEdge[] {
  const allowed = new Set((opts.sideBySide ?? []).map(([a, b]) => pairKey(a, b)));
  const graph: DagNode[] = tasks.map((t) => ({ id: t.id, dependsOn: [...t.dependsOn] }));
  const node = new Map(graph.map((n) => [n.id, n]));
  const writers = tasks.filter((t) => t.writes && t.accepted !== false).sort((a, b) => a.position - b.position);
  const out: OverlapEdge[] = [];
  const ordered = (a: string, b: string) => ancestorsOf(graph, a).has(b) || ancestorsOf(graph, b).has(a);
  const add = (edge: OverlapEdge) => {
    (node.get(edge.taskId)!.dependsOn as string[]).push(edge.dependsOn);
    out.push(edge);
  };
  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      const a = writers[i]!;
      const b = writers[j]!;
      if (a.paths.length === 0 || b.paths.length === 0 || allowed.has(pairKey(a.id, b.id))) continue;
      const hit = firstOverlap(a.paths, b.paths);
      if (!hit || ordered(a.id, b.id)) continue;
      add({ taskId: b.id, dependsOn: a.id, cause: "paths", paths: hit });
    }
  }
  for (const w of writers.filter((t) => t.paths.length === 0)) {
    for (const o of writers) {
      // Two pathless tasks keep their plan order: the later one goes after the earlier one, once.
      if (o.id === w.id || (o.paths.length === 0 && o.position > w.position)) continue;
      if (allowed.has(pairKey(w.id, o.id)) || ordered(w.id, o.id)) continue;
      add({ taskId: w.id, dependsOn: o.id, cause: "no_paths" });
    }
  }
  return out;
}

// ---------------------------------------------------------------- revisions

/** Why a task cannot change in a revision (design §4.10). */
export type FrozenBecause = "joined" | "done" | "running" | "released" | "edited";

/** Frozen tasks keep their place and content through `Revise` and `Replan`; null when the task may change. */
export function frozenBecause(t: { status: TaskStatus; released: boolean; joined: boolean; edited: boolean }): FrozenBecause | null {
  if (t.joined) return "joined";
  if (t.status === "done" || t.status === "review" || t.status === "merged") return "done";
  if (ACTIVE.has(t.status)) return "running";
  if (t.released) return "released";
  if (t.edited) return "edited";
  return null;
}

export interface RevisionBaseTask {
  task: GoalPlanTask;
  frozen: FrozenBecause | null;
}

export interface PlanDiff {
  added: string[];
  changed: string[];
  removed: string[];
  kept: string[];
}

export type PlanRevisionResult = { ok: true; diff: PlanDiff } | { ok: false; error: string; code: "frozen_changed" | "frozen_removed"; key: string; because: FrozenBecause };

// `reason` is the planner's commentary, not the work; everything else defines what runs.
const material = (t: GoalPlanTask) =>
  JSON.stringify([t.title, t.kind, t.mode, t.size, t.description, t.acceptance, t.basis, [...t.dependsOn].sort(), [...t.paths].map((p) => p.toLowerCase()).sort(), t.priority]);

/**
 * Checks a revision against the plan it replaces. Frozen tasks (done, running, released, joined,
 * and the ones you edited) must come back under the same key, unchanged; the revision may add
 * tasks, change or remove the others, and its new tasks may depend on frozen ones. The diff is
 * what the review shows: added, changed, removed and kept.
 */
export function applyPlanRevision(current: readonly RevisionBaseTask[], next: GoalPlan): PlanRevisionResult {
  const incoming = new Map(next.tasks.map((t) => [t.key, t]));
  const diff: PlanDiff = { added: [], changed: [], removed: [], kept: [] };
  for (const c of current) {
    const n = incoming.get(c.task.key);
    if (!n) {
      if (c.frozen) return { ok: false, error: `task "${c.task.key}" is frozen (${c.frozen}) and cannot be removed`, code: "frozen_removed", key: c.task.key, because: c.frozen };
      diff.removed.push(c.task.key);
      continue;
    }
    if (material(n) === material(c.task)) {
      diff.kept.push(c.task.key);
      continue;
    }
    if (c.frozen) return { ok: false, error: `task "${c.task.key}" is frozen (${c.frozen}) and cannot change`, code: "frozen_changed", key: c.task.key, because: c.frozen };
    diff.changed.push(c.task.key);
  }
  const before = new Set(current.map((c) => c.task.key));
  for (const t of next.tasks) if (!before.has(t.key)) diff.added.push(t.key);
  return { ok: true, diff };
}

export type PlanRevisionRefusal = "stopped" | "approved" | "not_approved" | "revisions_used" | "replans_used" | "too_many";

/**
 * Whether a new revision may be asked for (design §4.10): `Revise` only before approval and at
 * most 5 times, `Replan` only after approval and at most 3 times, `Add task` within the task
 * limit. Never for a stopped goal.
 */
export function planRevisionRefusal(cause: Exclude<GoalPlanCause, "initial">, g: { stopped: boolean; approved: boolean; revisionsUsed: number; replansUsed: number; taskCount: number; maxTasks: number }): PlanRevisionRefusal | null {
  if (g.stopped) return "stopped";
  if (cause === "revise") {
    if (g.approved) return "approved";
    if (g.revisionsUsed >= GOAL_LIMITS.revisionsBeforeApproval) return "revisions_used";
    return null;
  }
  if (cause === "replan") {
    if (!g.approved) return "not_approved";
    if (g.replansUsed >= GOAL_LIMITS.replans) return "replans_used";
    return null;
  }
  if (g.taskCount >= clampMaxTasks(g.maxTasks)) return "too_many";
  return null;
}

// ---------------------------------------------------------------- budget

export interface BudgetItem {
  id: string;
  estimate: CostEstimate;
  /** A budget you typed on the tile; required when the estimate is Unknown. */
  typedUsd?: number | null;
}

export type BudgetSplit =
  | { ok: true; shares: Record<string, number>; knownTotalUsd: number; typedTotalUsd: number }
  | { ok: false; code: "bad_budget"; id: string | null }
  | { ok: false; code: "needs_budget"; id: string }
  | { ok: false; code: "typed_over"; typedTotalUsd: number; budgetUsd: number }
  | { ok: false; code: "over_budget"; totalUsd: number; budgetUsd: number };

const r6 = (x: number) => Math.round(x * 1_000_000) / 1_000_000;
// Shares round down, so their sum never passes the goal budget.
const floor4 = (x: number) => Math.floor(r6(x) * 10_000) / 10_000;
const unknownEstimate = (e: CostEstimate) => e.usd === null || e.provenance === "unknown";
const validUsd = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0 && x <= GOAL_LIMITS.budgetMaxUsd;

/**
 * Splits the goal budget into task budgets (design §4.5): a typed budget is kept as typed; every
 * task with a known estimate gets estimate x (budget left after typed budgets / known total). An
 * Unknown estimate needs a typed budget, since nothing can price it. The last review is one more
 * item. The existing task-budget cap, reservations and unpriced ask then enforce each share. A $0
 * estimate (a plan or local model) gets a $0 share, so a fallback to a paid key asks first.
 */
export function splitBudget(budgetUsd: number, items: readonly BudgetItem[]): BudgetSplit {
  if (!validUsd(budgetUsd)) return { ok: false, code: "bad_budget", id: null };
  let typedTotal = 0;
  let knownTotal = 0;
  for (const it of items) {
    if (it.typedUsd !== undefined && it.typedUsd !== null) {
      if (!validUsd(it.typedUsd)) return { ok: false, code: "bad_budget", id: it.id };
      typedTotal += it.typedUsd;
    } else if (unknownEstimate(it.estimate)) return { ok: false, code: "needs_budget", id: it.id };
    else knownTotal += Math.max(0, it.estimate.usd ?? 0);
  }
  typedTotal = r6(typedTotal);
  knownTotal = r6(knownTotal);
  if (typedTotal > r6(budgetUsd)) return { ok: false, code: "typed_over", typedTotalUsd: typedTotal, budgetUsd };
  const left = r6(budgetUsd - typedTotal);
  if (knownTotal > left) return { ok: false, code: "over_budget", totalUsd: r6(knownTotal + typedTotal), budgetUsd };
  const ratio = knownTotal > 0 ? left / knownTotal : 0;
  const shares: Record<string, number> = {};
  for (const it of items) shares[it.id] = it.typedUsd !== undefined && it.typedUsd !== null ? floor4(it.typedUsd) : floor4(Math.max(0, it.estimate.usd ?? 0) * ratio);
  return { ok: true, shares, knownTotalUsd: knownTotal, typedTotalUsd: typedTotal };
}

/**
 * New shares after you change the goal budget: finished tasks keep theirs, unfinished ones scale
 * in the same proportion over what is left, so the sum stays within the new budget. Null when the
 * new budget is under what finished tasks already hold.
 */
export function rescaleShares(oldBudgetUsd: number, newBudgetUsd: number, shares: ReadonlyArray<{ id: string; shareUsd: number; finished: boolean }>): Record<string, number> | null {
  if (!validUsd(newBudgetUsd)) return null;
  const fixed = r6(shares.filter((s) => s.finished).reduce((a, s) => a + s.shareUsd, 0));
  if (fixed > r6(newBudgetUsd)) return null;
  const open = r6(shares.filter((s) => !s.finished).reduce((a, s) => a + s.shareUsd, 0));
  const room = Math.max(0, oldBudgetUsd - fixed);
  // Shares that already overflowed the old budget are scaled to fit, never past the new one.
  const factor = open > 0 ? (newBudgetUsd - fixed) / Math.max(room, open) : 0;
  const out: Record<string, number> = {};
  for (const s of shares) out[s.id] = s.finished ? s.shareUsd : floor4(s.shareUsd * factor);
  return out;
}

/** The goal budget the plan review prefills: max(project default, known total rounded up to whole dollars x 1.5). */
export function defaultGoalBudget(knownTotalUsd: number, projectDefaultUsd: number | null): number {
  const prefill = Math.max(GOAL_LIMITS.budgetFloorUsd, Math.ceil(r6(Math.max(0, knownTotalUsd)))) * GOAL_LIMITS.budgetFactor;
  return Math.min(GOAL_LIMITS.budgetMaxUsd, Math.max(projectDefaultUsd ?? 0, prefill));
}

/** The planning run's own budget, the ceiling the composer states: min(project per-task cap, max(3 x estimate, $0.25)). */
export function planningBudget(estimateUsd: number | null, perTaskCapUsd: number | null): number {
  const base = Math.max(GOAL_LIMITS.planningMultiplier * Math.max(0, estimateUsd ?? 0), GOAL_LIMITS.planningFloorUsd);
  return r6(perTaskCapUsd !== null && perTaskCapUsd > 0 ? Math.min(perTaskCapUsd, base) : base);
}

/** Checks the goal limits you set on approval or later: a budget, and how many tasks run at once. */
export function parseGoalLimits(input: { budgetUsd?: unknown; maxParallel?: unknown }): Parsed<{ budgetUsd?: number; maxParallel?: number }> {
  const out: { budgetUsd?: number; maxParallel?: number } = {};
  if (input.budgetUsd !== undefined) {
    if (!validUsd(input.budgetUsd)) return { ok: false, error: `budgetUsd must be more than 0 and at most ${GOAL_LIMITS.budgetMaxUsd}` };
    out.budgetUsd = Math.round(input.budgetUsd * 100) / 100;
    if (out.budgetUsd <= 0) return { ok: false, error: "budgetUsd must be at least 0.01" };
  }
  if (input.maxParallel !== undefined) {
    const n = input.maxParallel;
    if (typeof n !== "number" || !Number.isInteger(n) || n < GOAL_LIMITS.maxParallelMin || n > GOAL_LIMITS.maxParallelMax)
      return { ok: false, error: `maxParallel must be a whole number from ${GOAL_LIMITS.maxParallelMin} to ${GOAL_LIMITS.maxParallelMax}` };
    out.maxParallel = n;
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------- stop rule

/**
 * The goal's stop rule (design §4.7), Orca's circuit break at goal level: two goal tasks failing
 * with the same failureKey, or three goal tasks failed in all. Counted per task, never per run,
 * so a task you retried counts once. A halted goal releases nothing until you resume it.
 */
export function goalStopRule(failures: ReadonlyArray<{ taskId: string; detail: string | null }>): { halt: false } | { halt: true; reason: "same_failure"; key: string; taskIds: string[] } | { halt: true; reason: "failed_tasks"; taskIds: string[] } {
  const byKey = new Map<string, Set<string>>();
  const tasks = new Set<string>();
  for (const f of failures) {
    tasks.add(f.taskId);
    const k = failureKey(f.detail);
    const set = byKey.get(k) ?? new Set<string>();
    set.add(f.taskId);
    byKey.set(k, set);
    if (set.size >= GOAL_LIMITS.stopSameFailure) return { halt: true, reason: "same_failure", key: k, taskIds: [...set] };
  }
  if (tasks.size >= GOAL_LIMITS.stopFailedTasks) return { halt: true, reason: "failed_tasks", taskIds: [...tasks] };
  return { halt: false };
}

// ---------------------------------------------------------------- decisions

/** Goal decisions: the scheduler never guesses, it asks (design §4.1). They are not Inbox requests. */
export type GoalDecisionKind = "conflict" | "prerequisite" | "stop_rule" | "stuck" | "changes" | "report" | "profile_gone";

export type GoalDecisionAction =
  | "send_to_implementer"
  | "merge_myself"
  | "check_again"
  | "leave_out"
  | "run_without"
  | "replan"
  | "cancel_dependents"
  | "resume"
  | "retry"
  | "stop"
  | "accept_report";

/** The buttons each decision offers, first is the suggested one. The daemon refuses any other answer. */
export const GOAL_DECISION_ACTIONS: Record<GoalDecisionKind, readonly GoalDecisionAction[]> = {
  conflict: ["send_to_implementer", "merge_myself", "check_again", "leave_out"],
  prerequisite: ["run_without", "replan", "cancel_dependents"],
  stop_rule: ["resume", "replan", "stop"],
  stuck: ["retry", "replan", "run_without", "stop"],
  changes: ["replan", "stop"],
  report: ["accept_report"],
  profile_gone: ["replan", "leave_out", "stop"],
};

// ---------------------------------------------------------------- status

/** A plan revision's state, derived from its facts and its planning task's runs (D5; nothing stores it). */
export type PlanState = "planning" | "failed" | "ready" | "approved" | "superseded";

export interface PlanRevisionFacts {
  hasPlan: boolean;
  error: string | null;
  supersededAt: string | null;
  approvedAt: string | null;
  /** The planning task's runs; null for an `add` revision, which has no planner. */
  runs: ReadonlyArray<{ endedAt: string | null }> | null;
}

/**
 * planning: its planning task has an unfinished run (or none has started yet); failed: its error
 * is set, or its planning task's last run ended without a result. A restart mid-planning marks the
 * run interrupted, so the plan reads failed and never stays "Planning" forever.
 */
export function derivePlanState(p: PlanRevisionFacts): PlanState {
  if (p.approvedAt) return "approved";
  if (p.supersededAt) return "superseded";
  if (p.error) return "failed";
  if (p.hasPlan) return "ready";
  if (p.runs === null) return "failed";
  if (p.runs.length === 0 || p.runs.some((r) => r.endedAt === null)) return "planning";
  return "failed";
}

/** Seven states (design §3.9); everything else is a reason line inside `needs_you`. */
export type GoalStatus = "planning" | "needs_you" | "running" | "paused" | "ready_for_review" | "finished" | "stopped";
export type GoalNeedsReason = "plan_ready" | "plan_failed" | "halted" | "decision" | "request" | "failed" | "report" | "stuck";
/** `finished` as Merged (the goal's PR merged), Done (a goal with no branch), or collapsed into one ordinary task. */
export type GoalOutcome = "merged" | "done" | "collapsed";

export interface GoalStatusFacts {
  stopped: boolean;
  paused: boolean;
  /** `Pause all goals` is on. */
  pausedAll: boolean;
  halted: boolean;
  collapsed: boolean;
  /** The latest revision's state; null before the first revision exists. */
  latestPlan: PlanState | null;
  openDecisions: ReadonlyArray<{ kind: GoalDecisionKind; taskId?: string | null }>;
  /** Every goal task of the goal; skipped, discarded and cancelled ones are filtered here. */
  tasks: readonly GoalTaskFacts[];
  /** The hidden integration task that owns the goal branch; null for a goal with no writing task. */
  integration: { status: TaskStatus; reviewPassed: boolean } | null;
}

export interface GoalState {
  status: GoalStatus;
  reason: GoalNeedsReason | null;
  outcome: GoalOutcome | null;
  /** Finished accepted tasks, and all accepted tasks the goal still counts ("2 of 4"). */
  done: number;
  total: number;
  /** For `stuck`: the first task that cannot start and the prerequisite it waits for. */
  stuck: { taskId: string; waitsFor: string; why: GoalUnmet } | null;
}

/**
 * The goal's status, first match wins (design §4.2): stopped; planning; needs you (a plan ready or
 * failed, halted, an open decision, a task that needs you or failed, a report to accept, stuck);
 * paused; running; finished as Merged; ready for review; finished as Done. A task counts as done
 * only from its runs' facts, and a writer only once merged into the goal branch (Kiro #11786).
 */
export function deriveGoalStatus(f: GoalStatusFacts): GoalState {
  const counted = f.tasks.filter(live);
  const done = counted.filter(goalTaskFinished).length;
  const base = { done, total: counted.length, stuck: null } as const;
  const state = (status: GoalStatus, reason: GoalNeedsReason | null = null, outcome: GoalOutcome | null = null): GoalState => ({ ...base, status, reason, outcome });
  if (f.stopped) return state("stopped");
  if (f.latestPlan === "planning") return state("planning");
  if (f.collapsed) return state("finished", null, "collapsed");
  if (f.latestPlan === "failed") return state("needs_you", "plan_failed");
  if (f.latestPlan === "ready") return state("needs_you", "plan_ready");
  if (f.halted) return state("needs_you", "halted");
  if (f.openDecisions.length > 0) return state("needs_you", "decision");
  const integration = f.integration?.status ?? null;
  if (counted.some((t) => t.status === "needs_input" || t.status === "limited") || integration === "needs_input" || integration === "limited") return state("needs_you", "request");
  if (counted.some((t) => t.status === "failed") || integration === "failed") return state("needs_you", "failed");
  const byId = new Map(f.tasks.map((t) => [t.id, t]));
  const waitingReport = counted.some((t) => unmetPrerequisites(t, byId).some((u) => u.why === "report") && !t.released);
  if (waitingReport) return state("needs_you", "report");
  const unfinished = counted.filter((t) => !goalTaskFinished(t));
  const active = counted.some((t) => (t.released && ACTIVE.has(t.status)) || awaitingJoin(t));
  const integrationBusy = f.integration !== null && ACTIVE.has(f.integration.status);
  if (unfinished.length > 0 && !active && !integrationBusy && readySet(f.tasks).length === 0) {
    const blocked = unfinished.find((t) => !t.released);
    const first = blocked ? unmetPrerequisites(blocked, byId)[0] : undefined;
    return { ...state("needs_you", "stuck"), stuck: blocked && first ? { taskId: blocked.id, waitsFor: first.on, why: first.why } : null };
  }
  if (f.paused || f.pausedAll) return state("paused");
  if (active || integrationBusy || counted.some((t) => !t.released)) return state("running");
  if (f.integration) {
    if (f.integration.status === "merged") return state("finished", null, "merged");
    const writersJoined = counted.filter((t) => t.writes).every((t) => t.joined);
    if (writersJoined && f.integration.reviewPassed) return state("ready_for_review");
    return state("running");
  }
  if (unfinished.length === 0) return state("finished", null, "done");
  return state("running");
}
