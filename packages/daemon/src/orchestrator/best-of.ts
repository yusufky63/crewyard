import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BestOfPhase, BestOfVariantView, CandidateView, TaskStatus } from "@crewyard/core";
import { sameModel } from "./crew.ts";
import { git } from "./git.ts";

// Best of N (feature scan A8; the idea from crystal's session dialog and orca's parallel-agents
// recipe, our own design). The implement step of a task runs as 2 to 4 variants on different
// profiles. Each variant is a hidden task with a crew of one, so it gets its own worktree,
// bootstrap, run-until-green loop, queue and undo from the code that already does that for a
// task. The parent's caps and reservations count every variant; the kept variant's worktree
// moves to the parent, and its session continues the crew there.

export const BEST_OF_MIN = 2;
export const BEST_OF_MAX = 4;

export interface GroupRow {
  id: string;
  task_id: string;
  member_id: string;
  started_at: string | null;
  kept_variant_id: string | null;
  kept_at: string | null;
}

export interface VariantRow {
  id: string;
  group_id: string;
  position: number;
  candidate: string;
  task_id: string | null;
  outcome: "kept" | "discarded" | null;
  diff_stat: string | null;
  parked_at: string | null;
  park_error: string | null;
}

export type DiffStat = NonNullable<BestOfVariantView["diffStat"]>;

/**
 * The variants for a step: the proposal's own choice first, then the best ranked other profiles,
 * preferring models the group does not have yet, so the comparison is worth its cost. Returns
 * fewer than `n` when there are not enough profiles; the caller refuses that.
 */
export function pickVariants(first: CandidateView | null, ranked: CandidateView[], n: number): CandidateView[] {
  const out: CandidateView[] = first ? [first] : [];
  const pool = ranked.filter((c) => !out.some((o) => o.profileId === c.profileId));
  for (const fresh of [true, false]) {
    for (const c of pool) {
      if (out.length >= n) break;
      if (out.some((o) => o.profileId === c.profileId)) continue;
      if (fresh && out.some((o) => sameModel(o, c))) continue;
      out.push(c);
    }
  }
  return out.slice(0, n);
}

const ACTIVE: TaskStatus[] = ["queued", "running", "handing_off"];
const WAITING_ON_YOU: TaskStatus[] = ["needs_input", "limited", "proposed"];

/**
 * The group's phase from its variants' statuses. A variant "finished" when its implement run
 * completed (its task reads `review`); one that failed or was stopped can still be retried, which
 * makes the group active again.
 */
export function groupPhase(group: Pick<GroupRow, "started_at" | "kept_variant_id">, approved: boolean, variants: Array<{ status: TaskStatus | null; finished: boolean }>): BestOfPhase {
  if (group.kept_variant_id) return "kept";
  if (!approved) return "proposed";
  if (!group.started_at) return "waiting";
  if (variants.some((v) => v.status !== null && (ACTIVE.includes(v.status) || WAITING_ON_YOU.includes(v.status)))) return "running";
  return variants.some((v) => v.finished) ? "choosing" : "failed";
}

/** The parent task's fact for deriveTaskStatus (TaskFacts.bestOf). */
export function groupFact(phase: BestOfPhase, statuses: Array<TaskStatus | null>): "needs_input" | "running" | "choosing" | "failed" | null {
  if (phase === "running") return statuses.some((s) => s !== null && WAITING_ON_YOU.includes(s)) ? "needs_input" : "running";
  if (phase === "choosing" || phase === "failed") return phase;
  return null;
}

/** `git diff --numstat` lines; binary files (`-` counts) count as zero lines. */
export function parseNumstat(out: string): DiffStat {
  const files: DiffStat["files"] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    files.push({ path: m[3]!, added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return { files, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
}

/** What the variant's worktree changed against the task's base, committed or not. */
export async function worktreeDiff(path: string, baseSha: string, bin = "git"): Promise<DiffStat> {
  return parseNumstat(await git(path, ["diff", "--numstat", baseSha], bin));
}

export class BestOfStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date,
  ) {}

  private one<T>(sql: string, ...args: Array<string | number | null>): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }

  private all<T>(sql: string, ...args: Array<string | number | null>): T[] {
    return this.db.prepare(sql).all(...args) as unknown as T[];
  }

  private exec(sql: string, ...args: Array<string | number | null>): void {
    this.db.prepare(sql).run(...args);
  }

  create(taskId: string, memberId: string, candidates: CandidateView[]): string {
    const id = randomUUID();
    this.exec("insert into best_of_groups (id, task_id, member_id) values (?, ?, ?)", id, taskId, memberId);
    candidates.forEach((c, i) => this.exec("insert into best_of_variants (id, group_id, position, candidate) values (?, ?, ?, ?)", randomUUID(), id, i + 1, JSON.stringify(c)));
    return id;
  }

  /** Replaces the variants of a group that has not started (crew edits at approval). */
  replace(groupId: string, candidates: CandidateView[]): void {
    this.exec("delete from best_of_variants where group_id = ? and task_id is null", groupId);
    candidates.forEach((c, i) => this.exec("insert into best_of_variants (id, group_id, position, candidate) values (?, ?, ?, ?)", randomUUID(), groupId, i + 1, JSON.stringify(c)));
  }

  group(taskId: string): GroupRow | null {
    return this.one<GroupRow>("select * from best_of_groups where task_id = ?", taskId) ?? null;
  }

  variants(groupId: string): VariantRow[] {
    return this.all<VariantRow>("select * from best_of_variants where group_id = ? order by position", groupId);
  }

  variant(id: string): VariantRow | null {
    return this.one<VariantRow>("select * from best_of_variants where id = ?", id) ?? null;
  }

  candidates(groupId: string): CandidateView[] {
    return this.variants(groupId).map((v) => JSON.parse(v.candidate) as CandidateView);
  }

  /** The visible task a hidden variant task belongs to; null for any other task. */
  parentOf(taskId: string): string | null {
    return this.one<{ task_id: string }>("select g.task_id from best_of_variants v join best_of_groups g on g.id = v.group_id where v.task_id = ?", taskId)?.task_id ?? null;
  }

  /** Every variant task, so the task list can leave them out. */
  variantTaskIds(): Set<string> {
    return new Set(this.all<{ task_id: string }>("select task_id from best_of_variants where task_id is not null").map((r) => r.task_id));
  }

  variantTasksOf(parentTaskId: string): string[] {
    return this.all<{ task_id: string }>("select v.task_id from best_of_variants v join best_of_groups g on g.id = v.group_id where g.task_id = ? and v.task_id is not null order by v.position", parentTaskId).map((r) => r.task_id);
  }

  start(groupId: string, variantTasks: Map<string, string>): void {
    this.exec("update best_of_groups set started_at = ? where id = ?", this.now().toISOString(), groupId);
    for (const [variantId, taskId] of variantTasks) this.exec("update best_of_variants set task_id = ? where id = ?", taskId, variantId);
  }

  keep(groupId: string, variantId: string): void {
    this.exec("update best_of_groups set kept_variant_id = ?, kept_at = ? where id = ?", variantId, this.now().toISOString(), groupId);
    this.exec("update best_of_variants set outcome = case when id = ? then 'kept' else 'discarded' end where group_id = ?", variantId, groupId);
  }

  setDiff(variantId: string, stat: DiffStat): void {
    this.exec("update best_of_variants set diff_stat = ? where id = ?", JSON.stringify(stat), variantId);
  }

  parked(variantId: string, error: string | null): void {
    this.exec("update best_of_variants set parked_at = ?, park_error = ? where id = ?", error ? null : this.now().toISOString(), error, variantId);
  }

  variantByTask(taskId: string): VariantRow | null {
    return this.one<VariantRow>("select * from best_of_variants where task_id = ?", taskId) ?? null;
  }
}
