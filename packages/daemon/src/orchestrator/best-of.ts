import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BestOfPhase, BestOfVariantView, CandidateView, TaskStatus, CrewEdit, EndReason, Reason, TaskDetail, BestOfView } from "@crewyard/core";
import type { proposeCrew} from "./crew.ts";
import { sameModel, eligible, estimateFor, rankForRole, readOnlyConflict, scoreCandidate, sumEstimates, type ScoringContext } from "./crew.ts";
import { git } from "./git.ts";
import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { admitGroup, DEFAULT_LIMITS } from "./admission.ts";
import type { OrchestratorContext, LaunchSpec } from "./context.ts";
import { Part } from "./part.ts";
import type { MemberRow, OrchestratorDb, ProjectRow, TaskRow, WorktreeRow } from "./db.ts";
import type { Candidate } from "./directory.ts";
import { errorCode, errorDetail, OrchestratorError } from "./errors.ts";
import { overCap, projectDailyCap, projectDailyCapUsd, reachedCaps, reservedUsd, reserveSpend, spendCredential } from "./spend.ts";

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

// Best of N as an orchestrator part: the variants picked at proposal and approval, started all at
// once or not at all, compared, and the one you keep moved onto the parent task.

export interface BestOfRunnerDeps {
  insertRun(spec: LaunchSpec): string;
  boot(runId: string, spec: LaunchSpec): Promise<void>;
  stopRun(runId: string, detail: string, reason?: EndReason): Promise<void>;
  cancel(taskId: string): Promise<TaskDetail>;
  get(taskId: string): TaskDetail;
  tick(): Promise<void>;
}

export class BestOfRunner extends Part {
  constructor(ctx: OrchestratorContext, private readonly deps: BestOfRunnerDeps) {
    super(ctx);
  }

  /** At proposal: the variants for the implement step, never on a reviewer's model. */
  groupCandidates(members: ReturnType<typeof proposeCrew>["members"], candidates: Candidate[], ctx: ScoringContext, n: number): { index: number; candidates: CandidateView[] } {
    if (!Number.isInteger(n) || n < BEST_OF_MIN || n > BEST_OF_MAX) throw new OrchestratorError("best_of.bad_count", { min: BEST_OF_MIN, max: BEST_OF_MAX });
    const index = members.findIndex((m) => m.role === "implementer" && m.writesCode);
    if (index < 0) throw new OrchestratorError("best_of.not_found");
    const independent = members.filter((m) => m.chosen && m.template.independentOf.includes("implementer")).map((m) => m.chosen!);
    const ranked = rankForRole(candidates, "implementer", ctx, { models: new Set(), providers: new Set() }).filter((c) => !independent.some((r) => sameModel(r, c)));
    const picked = pickVariants(members[index]!.chosen, ranked, n);
    if (picked.length < n) throw new OrchestratorError("best_of.too_few", { found: picked.length, needed: n });
    return { index, candidates: picked };
  }

  /**
   * At approval: the group's variants after your edits, checked against the rules that make the
   * group able to start at all: enough slots for every variant at once, and an estimate that fits
   * the task budget on its own.
   */
  approvedVariants(task: TaskRow, project: ProjectRow, members: MemberRow[], views: Map<string, CandidateView | null>, candidates: Candidate[], group: GroupRow, p: { edits?: CrewEdit[]; bestOf?: { profileIds: string[] } }): CandidateView[] {
    const ctx = this.scoring(project.id, task.size, task.budget_usd);
    const member = members.find((m) => m.id === group.member_id)!;
    let out = this.bestOf.candidates(group.id);
    if (p.bestOf) {
      const ids = p.bestOf.profileIds;
      if (ids.length < BEST_OF_MIN || ids.length > BEST_OF_MAX || new Set(ids).size !== ids.length) throw new OrchestratorError("best_of.bad_count", { min: BEST_OF_MIN, max: BEST_OF_MAX });
      const before = out;
      out = ids.map((id) => {
        const c = candidates.find((x) => x.profile.id === id);
        if (c && readOnlyConflict(c, this.tpl(member))) throw new OrchestratorError("crew.read_only_profile", { profileId: id, role: member.role });
        if (!c || !eligible(c, this.tpl(member), ctx)) throw new OrchestratorError("crew.unknown_profile", { profileId: id });
        return before.find((v) => v.profileId === id) ?? scoreCandidate(c, this.tpl(member), ctx);
      });
    } else if (p.edits?.some((e) => e.memberId === member.id)) {
      // Changing the implementer in the crew changes the first variant.
      const first = views.get(member.id)!;
      out = [first, ...out.filter((v) => v.profileId !== first.profileId)].slice(0, out.length);
    }
    const slots = Math.min(this.config(project).config.rules.slots, this.opts.limits?.globalSlots ?? DEFAULT_LIMITS.globalSlots);
    if (out.length > slots) throw new OrchestratorError("best_of.slots", { needed: out.length, slots });
    const estimate = sumEstimates(out.map((v) => v.estimate));
    if (task.budget_usd !== null && estimate.usd !== null && estimate.usd > task.budget_usd) throw new OrchestratorError("best_of.over_budget", { estimateUsd: estimate.usd, capUsd: task.budget_usd });
    views.set(member.id, out[0]!);
    return out;
  }

  /**
   * Starts every variant of a group at once, or none: admission for all of them, then every
   * paid variant's estimate reserved against the parent's caps in one step, so parallel steps
   * cannot take the room between two variants. Then one hidden task per variant, and its run.
   */
  async startGroup(task: TaskRow, m: MemberRow, group: GroupRow, project: ProjectRow, slots: number, candidates: Candidate[]): Promise<void> {
    const variants = this.bestOf.variants(group.id);
    const views = variants.map((v) => JSON.parse(v.candidate) as CandidateView);
    const missing = views.find((v) => !this.adapters.has(v.runner));
    const reason: Reason | null = missing ? { code: "admission.no_adapter", params: { runner: missing.runner } } : (this.groupAdmission(task, views, slots) ?? this.groupBudgetHold(task, m, views, candidates));
    if (reason) {
      const prev = this.blocked.get(m.id);
      this.blocked.set(m.id, reason);
      if (prev?.code !== reason.code) this.emitTask(task.id, "admission");
      return;
    }
    this.blocked.delete(m.id);
    const at = this.iso();
    const created = new Map<string, string>();
    const specs: LaunchSpec[] = [];
    this.db.tx(() => {
      for (const [i, v] of variants.entries()) {
        const view = views[i]!;
        const taskId = randomUUID();
        const crewId = randomUUID();
        const memberId = randomUUID();
        this.db.exec(
          `insert into tasks (id, project_id, title, description, kind, size, base_branch, fallback, wait_reset_minutes, budget_usd, classification, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, '[]', ?)`,
          taskId,
          task.project_id,
          task.title,
          task.description,
          task.kind,
          task.size,
          task.base_branch,
          task.fallback,
          task.wait_reset_minutes,
          at,
        );
        this.db.exec("insert into crews (id, task_id, proposed_at, approved_at, estimate_usd, estimate_provenance) values (?, ?, ?, ?, ?, ?)", crewId, taskId, at, at, view.estimate.usd, view.estimate.provenance);
        this.db.exec(
          "insert into crew_members (id, crew_id, position, step, role, depends_on, required, writes_code, chosen, standby, reasons) values (?, ?, 0, ?, ?, '[]', 1, 1, ?, '[]', '[]')",
          memberId,
          crewId,
          m.step,
          m.role,
          JSON.stringify(view),
        );
        this.db.copyRoleTemplate(m.id, memberId);
        created.set(v.id, taskId);
        specs.push({ runId: randomUUID(), task: this.db.task(taskId), member: this.db.member(memberId), target: view });
      }
      this.bestOf.start(group.id, created);
      for (const spec of specs) {
        const c = candidates.find((x) => x.profile.id === spec.target.profileId);
        if (c?.profile.credential.kind === "api_key") reserveSpend(this.opts.store.db, { runId: spec.runId!, taskId: task.id, credentialId: spendCredential(c), amountUsd: estimateFor(c, this.tpl(m), task.size, this.now()).usd ?? 0 }, this.now());
      }
    });
    for (const spec of specs) this.deps.insertRun(spec);
    this.audit(task.id, null, "best_of.started", { groupId: group.id, variants: views.map((v) => v.profileId), estimate: sumEstimates(views.map((v) => v.estimate)) });
    this.emitTask(task.id, "best_of");
    // One after another: parallel `git worktree add` on one repo races for its locks.
    this.track(
      (async () => {
        for (const spec of specs) await this.deps.boot(spec.runId!, spec);
      })(),
    );
  }

  private groupAdmission(task: TaskRow, views: CandidateView[], projectSlots: number): Reason | null {
    const counts = this.db.activeCounts();
    const needed = new Map<string, number>();
    for (const v of views) needed.set(v.profileId, (needed.get(v.profileId) ?? 0) + 1);
    return admitGroup(
      {
        projectActive: counts.byProject.get(task.project_id) ?? 0,
        globalActive: counts.total,
        freeMb: this.freeMb(),
        profiles: [...needed].map(([profileId, n]) => ({ profileId, needed: n, active: counts.byProfile.get(profileId) ?? 0 })),
      },
      { ...DEFAULT_LIMITS, ...this.opts.limits, projectSlots },
    );
  }

  /**
   * Like budgetHold for one step, for the whole group: it waits while other unfinished runs hold
   * the room every variant's estimate needs together. A group that would not fit even once they
   * finish starts, and each paid variant pauses on its cap with a request, as a single step does.
   */
  private groupBudgetHold(task: TaskRow, m: MemberRow, views: CandidateView[], candidates: Candidate[]): Reason | null {
    const byCredential = new Map<string, { c: Candidate; usd: number }>();
    let total = 0;
    // What the ledger will see: only variants on a key it knows count against the project's cap.
    let ledgered = 0;
    for (const v of views) {
      const c = candidates.find((x) => x.profile.id === v.profileId);
      if (c?.profile.credential.kind !== "api_key") continue;
      const usd = estimateFor(c, this.tpl(m), task.size, this.now()).usd ?? 0;
      total += usd;
      if (spendCredential(c) !== null) ledgered += usd;
      const key = spendCredential(c) ?? `profile:${c.profile.id}`;
      const cur = byCredential.get(key);
      byCredential.set(key, { c, usd: (cur?.usd ?? 0) + usd });
    }
    for (const { c, usd } of byCredential.values()) {
      const cap = reachedCaps(this.opts.store.db, spendCredential(c), task.id, this.now(), { addUsd: usd }).find((x) => x.reservedUsd);
      if (cap && !overCap(cap.spentUsd, 0, usd, cap.capUsd)) return { code: "admission.budget_reserved", params: { reservedUsd: cap.reservedUsd!, capUsd: cap.capUsd, cap: cap.kind } };
    }
    if (ledgered > 0) {
      const cap = projectDailyCap(this.opts.store.db, task.project_id, projectDailyCapUsd(this.db.project(task.project_id)), this.now(), { addUsd: ledgered });
      if (cap?.reservedUsd && !overCap(cap.spentUsd, 0, ledgered, cap.capUsd)) return { code: "admission.budget_reserved", params: { reservedUsd: cap.reservedUsd, capUsd: cap.capUsd, cap: cap.kind } };
    }
    if (task.budget_usd !== null && total > 0) {
      const spent = this.db.spend(this.budgetRuns(task.id)).usd ?? 0;
      const held = reservedUsd(this.opts.store.db, { taskId: task.id });
      if (held > 0 && overCap(spent, held, total, task.budget_usd) && !overCap(spent, 0, total, task.budget_usd)) {
        return { code: "admission.budget_reserved", params: { reservedUsd: Math.round(held * 1_000_000) / 1_000_000, capUsd: task.budget_usd, cap: "task_budget" } };
      }
    }
    return null;
  }

  async refreshVariantDiff(variantId: string): Promise<void> {
    const v = this.bestOf.variant(variantId);
    const wt = v?.task_id ? this.db.worktree(v.task_id) : null;
    if (!v || !wt || !existsSync(wt.path)) return;
    try {
      this.bestOf.setDiff(v.id, await worktreeDiff(wt.path, wt.base_sha, this.opts.gitBin));
      this.emitTask(v.task_id!, "best_of");
    } catch (err) {
      this.audit(v.task_id!, null, "best_of.diff_failed", { code: errorCode(err) });
    }
  }

  /**
   * Keeps one finished variant (after you confirmed in the compare view). Its worktree, bootstrap
   * state and session move to the parent task, recorded as a completed run of the implement step,
   * so test, review and PR continue there. Every other variant is stopped, cancelled and parked.
   */
  async keepVariant(taskId: string, variantId: string): Promise<TaskDetail> {
    const task = this.db.task(taskId);
    if (task.cancelled_at) throw new OrchestratorError("task.cancelled");
    const group = this.bestOf.group(task.id);
    const kept = group ? this.bestOf.variant(variantId) : null;
    if (!group || !kept || kept.group_id !== group.id) throw new OrchestratorError("best_of.not_found");
    if (group.kept_variant_id) throw new OrchestratorError("best_of.kept");
    if (!group.started_at || !kept.task_id) throw new OrchestratorError("best_of.not_started");
    const runs = this.db.runs(kept.task_id);
    const last = runs.filter((r) => r.end_reason === "completed" && !this.db.successor(r, runs)).at(-1);
    const wt = this.db.worktree(kept.task_id);
    if (!last || !wt || runs.some((r) => !r.ended_at)) throw new OrchestratorError("best_of.not_finished", { variantId });
    if (this.db.worktree(task.id)) throw new OrchestratorError("best_of.kept");
    const member = this.db.member(group.member_id);
    const variantMember = this.db.member(last.member_id);
    const adoptedId = randomUUID();
    const at = this.iso();
    this.db.tx(() => {
      this.bestOf.keep(group.id, kept.id);
      // The worktree row moves, so its id (and every run that names it) stays valid.
      this.db.exec("update worktrees set task_id = ? where task_id = ?", task.id, kept.task_id);
      this.db.exec("update worktree_bootstrap set task_id = ? where task_id = ?", task.id, kept.task_id);
      this.db.exec(
        `insert into runs (id, task_id, member_id, role, profile_id, runner, model, cwd, worktree_id, native_session_id, started_at, ended_at, end_reason, end_detail, last_state, last_activity_at, cost_provenance, plan, diff)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'best_of.kept', ?, ?, 'estimated', ?, ?)`,
        adoptedId,
        task.id,
        member.id,
        member.role,
        last.profile_id,
        last.runner,
        last.model,
        last.cwd,
        wt.id,
        last.native_session_id,
        at,
        at,
        last.last_state,
        last.last_activity_at,
        last.plan,
        last.diff,
      );
    });
    this.loops.enlist(adoptedId, member.id);
    // The reviewer's prompt cites the last test; it belongs to the kept variant's worktree.
    const test = this.loops.lastTest(variantMember.id);
    if (test) this.loops.addTest({ task_id: task.id, member_id: member.id, run_id: adoptedId, command: test.command, exit_code: test.exit_code, passed: test.passed, tail: test.tail, tree_sha: test.tree_sha, head_sha: test.head_sha, duration_ms: test.duration_ms });
    this.audit(task.id, adoptedId, "best_of.kept", { groupId: group.id, variantId: kept.id, variantTaskId: kept.task_id, fromRun: last.id, profileId: last.profile_id, branch: wt.branch });
    for (const other of this.bestOf.variants(group.id).filter((v) => v.id !== kept.id && v.task_id)) await this.discardVariant(other.id, other.task_id!);
    this.emitTask(task.id, "best_of");
    await this.deps.tick();
    return this.deps.get(task.id);
  }

  private async discardVariant(variantId: string, variantTaskId: string): Promise<void> {
    for (const r of this.db.runs(variantTaskId).filter((r) => !r.ended_at)) await this.deps.stopRun(r.id, "best_of.discarded");
    await this.deps.cancel(variantTaskId);
    const wt = this.db.worktree(variantTaskId);
    if (!wt) {
      this.bestOf.parked(variantId, null);
      return;
    }
    let error: string | null = null;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.bootstrap.park(variantTaskId);
        break;
      } catch (err) {
        // On Windows a process tree killed a moment ago can still hold its folder: git removed the
        // files and the registration but not the folder. Finish that, or try again shortly.
        if (await this.finishHalfRemoved(wt)) break;
        if (attempt >= PARK_ATTEMPTS) {
          // A cleanup step waiting for approval, a locked file: the folder stays and the code says why.
          error = errorCode(err);
          this.audit(variantTaskId, null, "best_of.park_failed", { variantId, code: error, detail: errorDetail(err, []).slice(0, 400) });
          break;
        }
        await new Promise((r) => setTimeout(r, PARK_RETRY_MS * attempt));
      }
    }
    this.bestOf.parked(variantId, error);
    this.audit(variantTaskId, null, "best_of.discarded", { variantId, parked: error === null });
  }

  /** True when a park left only an empty folder behind, which is then removed and pruned from git. */
  private async finishHalfRemoved(wt: WorktreeRow): Promise<boolean> {
    if (!existsSync(wt.path)) return true;
    if (existsSync(join(wt.path, ".git")) || readdirSync(wt.path).length > 0) return false;
    for (let i = 0; i < PARK_ATTEMPTS; i++) {
      try {
        rmdirSync(wt.path);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, PARK_RETRY_MS));
      }
    }
    if (existsSync(wt.path)) return false;
    await git(wt.repo_path, ["worktree", "prune"], this.opts.gitBin).catch(() => "");
    return true;
  }

  groupView(task: TaskRow): BestOfView | null {
    const group = this.bestOf.group(task.id);
    if (!group) return null;
    const crew = this.db.crew(task.id);
    const max = this.config(this.db.project(task.project_id)).config.loop.maxIterations;
    const variants = this.bestOf.variants(group.id).map((v) => {
      const candidate = JSON.parse(v.candidate) as CandidateView;
      const vt = v.task_id ? this.db.task(v.task_id) : null;
      const summary = vt ? this.db.summary(vt) : null;
      const run = vt ? (this.db.runs(vt.id).at(-1) ?? null) : null;
      const loop = vt ? this.loops.view(vt.id, max, () => false) : null;
      // The kept variant's worktree belongs to the parent now.
      const wt = vt ? (this.db.worktree(vt.id) ?? (v.outcome === "kept" ? this.db.worktree(task.id) : null)) : null;
      // Parked later from the compare view or the Worktrees screen: the folder is gone, so it is parked.
      const parkedLater = v.outcome === "discarded" && !v.parked_at && wt !== null && !existsSync(wt.path);
      return {
        id: v.id,
        position: v.position,
        candidate,
        taskId: v.task_id,
        status: summary?.status ?? null,
        run: run ? this.db.runView(run) : null,
        resumableRunIds: summary?.resumableRunIds ?? [],
        spend: summary?.spend ?? { usd: 0, provenance: "estimated" as const },
        diffStat: v.diff_stat ? (JSON.parse(v.diff_stat) as DiffStat) : null,
        test: loop?.tests.at(-1) ?? null,
        decisions: loop?.decisions ?? [],
        branch: wt?.branch ?? null,
        worktreePath: wt?.path ?? null,
        outcome: v.outcome,
        parkedAt: v.parked_at ?? (parkedLater ? group.kept_at : null),
        parkError: parkedLater ? null : v.park_error,
      };
    });
    return {
      id: group.id,
      memberId: group.member_id,
      n: variants.length,
      phase: groupPhase(group, Boolean(crew?.approved_at), variants.map((v) => ({ status: v.status, finished: v.status === "review" }))),
      estimate: sumEstimates(variants.map((v) => v.candidate.estimate)),
      variants,
      startedAt: group.started_at,
      keptVariantId: group.kept_variant_id,
      keptAt: group.kept_at,
    };
  }

  /** What a task's summary adds from Best of N and schedules; cheap reads, called on every summary. */
  taskExtras(t: TaskRow): ReturnType<OrchestratorDb["taskExtras"]> {
    const parent = this.bestOf.parentOf(t.id);
    const scheduled = this.schedules.taskOrigin(t.id);
    if (parent) {
      const v = this.bestOf.variantByTask(t.id)!;
      return { scheduled, bestOf: null, variantOf: { taskId: parent, position: v.position, n: this.bestOf.variants(v.group_id).length }, fact: null, groupRuns: [] };
    }
    const group = this.bestOf.group(t.id);
    if (!group) return { scheduled, bestOf: null, variantOf: null, fact: null, groupRuns: [] };
    const variants = this.bestOf.variants(group.id);
    const statuses = variants.map((v) => (v.task_id ? this.db.status(this.db.task(v.task_id)) : null));
    const phase = groupPhase(group, Boolean(this.db.crew(t.id)?.approved_at), statuses.map((status) => ({ status, finished: status === "review" })));
    return {
      scheduled,
      bestOf: { n: variants.length, phase },
      variantOf: null,
      fact: groupFact(phase, statuses),
      groupRuns: variants.flatMap((v) => (v.task_id ? this.db.runs(v.task_id) : [])),
    };
  }
}

/** Parking a discarded Best of N variant: tries, and the wait before the next one (times the try). */
const PARK_ATTEMPTS = 3;
const PARK_RETRY_MS = 1_500;
