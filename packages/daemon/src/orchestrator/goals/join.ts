import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanText, type GoalDecisionAction, type RoleId } from "@crewyard/core";
import type { OrchestratorContext } from "../context.ts";
import type { MemberRow, RunRow, TaskRow, WorktreeRow } from "../db.ts";
import { branchSha, checkpoint, ensureWorktree, gitAtLeast, gitVersion, isAncestor, isClean, mergeNoFf, mergeTreeCheck, taskSlug } from "../git.ts";
import { Part } from "../part.ts";
import type { GoalEvents } from "./events.ts";
import type { GoalRow, GoalRows } from "./runner.ts";

// Merging finished goal tasks into the goal branch (docs/adr/0019, design §4.8 and §4.9). The goal
// branch is checked out only in the integration task's own worktree, which Crewyard made for this
// goal: git then refuses to check it out anywhere else, so nothing here can move a branch under
// your working tree. Each merge is test-merged first with `merge-tree --write-tree` (no worktree,
// no index); a clean one becomes `git merge --no-ff` there, a conflicting one a goal decision.
// Nothing is ever pushed.

export interface GoalJoinDeps {
  /** Messages.followUp: a new run of the same member, natively resumed (your click is its approval). */
  followUp(runId: string, text: string): Promise<unknown>;
}

export type JoinOutcome = { outcome: "joined"; sha: string } | { outcome: "conflict"; paths: string[]; detail: string | null };

/** The answers to a failed merge that named no conflicted file. */
const NO_FILE_CONFLICT_ACTIONS: readonly GoalDecisionAction[] = ["merge_myself", "check_again", "leave_out"];

/** Steps that write a task's commits: the implementer of a code crew, the docs step of a docs crew. */
const WRITER_ROLES: readonly RoleId[] = ["implementer", "docs"];

export class GoalJoin extends Part {
  /** The installed Git, read once per daemon; an update is seen after a restart. */
  private version: Promise<string | null> | null = null;
  /** One merge per goal at a time: two passes never race git in the same worktree. */
  private readonly merging = new Map<string, Promise<JoinOutcome | null>>();

  constructor(
    ctx: OrchestratorContext,
    private readonly rows: GoalRows,
    private readonly events: GoalEvents,
    private readonly deps: GoalJoinDeps,
  ) {
    super(ctx);
  }

  /** The goal branch's name: `crewyard/goal/<words>-<id6>`, the id suffix as taskSlug adds it. */
  static branchFor(goal: Pick<GoalRow, "id" | "title">): string {
    return `crewyard/goal/${taskSlug(goal.title, goal.id)}`;
  }

  /**
   * The integration task's worktree on the goal branch, created at the goal's base the first time
   * and reused after (a restart, a second pass). The row belongs to the integration task, so the
   * existing task-bound PR flow, merge gate and pinned review find the branch's owner.
   */
  async ensureGoalWorktree(goal: GoalRow): Promise<WorktreeRow> {
    if (!goal.integration_task_id) throw new Error("goal has no integration task");
    const existing = this.db.worktree(goal.integration_task_id);
    const project = this.db.project(goal.project_id);
    const root = this.config(project).config.worktreeRoot;
    const branch = existing?.branch ?? GoalJoin.branchFor(goal);
    const path = existing?.path ?? join(root, `goal-${taskSlug(goal.title, goal.id)}`);
    const info = await ensureWorktree(project.path, path, branch, existing ? branch : (goal.base_sha ?? goal.base_branch), this.opts.gitBin);
    if (!existing) {
      this.db.exec(
        "insert into worktrees (id, task_id, repo_path, path, branch, base_sha, created_at) values (?, ?, ?, ?, ?, ?, ?)",
        randomUUID(),
        goal.integration_task_id,
        project.path,
        info.path,
        info.branch,
        info.baseSha,
        this.iso(),
      );
      this.audit(goal.integration_task_id, null, "worktree.created", { path: info.path, branch: info.branch, goalId: goal.id });
    }
    return this.db.worktree(goal.integration_task_id)!;
  }

  /** The goal branch's tip as recorded by our own merges: the last joined sha, or the goal's base. */
  recordedHead(goal: GoalRow): string | null {
    return this.rows.lastJoinedSha(goal.id) ?? this.db.worktree(goal.integration_task_id ?? "")?.base_sha ?? goal.base_sha;
  }

  /**
   * Whether a released writing task's own gates have passed (design §4.9): every step it has ran to
   * completion after the steps it depends on last finished (so Test and Review read the latest
   * work), and when a reviewer belongs to the crew, its verdict is `pass` and, for code, pinned to
   * the commit the task branch points at now. A limit or a cap never counts as done (D5).
   */
  async gatesPassed(taskId: string): Promise<boolean> {
    const task = this.db.task(taskId);
    if (task.cancelled_at) return false;
    const status = this.db.status(task);
    if (status !== "review" && status !== "done") return false;
    const crew = this.db.crew(task.id);
    if (!crew?.approved_at) return false;
    const members = this.db.members(crew.id).filter((m) => !m.pending_since && !m.skipped_at);
    const runs = this.db.runs(task.id);
    const latest = new Map<string, RunRow>();
    for (const m of members) {
      const r = this.effectiveRun(m, runs);
      if (!r || r.end_reason !== "completed" || r.ended_at === null) return false;
      latest.set(m.step, r);
    }
    // A step whose dependency finished again after it started is due to run again (the loops).
    for (const m of members) {
      const mine = latest.get(m.step)!;
      for (const dep of JSON.parse(m.depends_on) as string[]) {
        const d = latest.get(dep);
        if (d?.ended_at && d.ended_at > mine.started_at) return false;
      }
    }
    const reviewer = members.find((m) => m.role === "reviewer");
    if (!reviewer) return true;
    const verdict = this.loops.verdict(latest.get(reviewer.step)!.id);
    if (verdict?.verdict !== "pass") return false;
    if (task.kind !== "code") return true;
    const wt = this.db.worktree(task.id);
    const tip = wt ? await branchSha(wt.repo_path, wt.branch, this.opts.gitBin) : null;
    return tip !== null && verdict.headSha === tip;
  }

  /** The member's run that holds its step now: its latest run nothing continued. */
  private effectiveRun(m: MemberRow, runs: RunRow[]): RunRow | null {
    const mine = runs.filter((r) => r.member_id === m.id);
    for (let i = mine.length - 1; i >= 0; i--) if (!this.db.successor(mine[i]!, runs)) return mine[i]!;
    return null;
  }

  /** Merges one task, one merge per goal at a time; null when another merge of the goal is running. */
  merge(goal: GoalRow, taskId: string): Promise<JoinOutcome | null> {
    if (this.merging.has(goal.id)) return Promise.resolve(null);
    const p = this.doMerge(goal, taskId).finally(() => this.merging.delete(goal.id));
    this.merging.set(goal.id, p);
    return p;
  }

  private async doMerge(goal: GoalRow, taskId: string): Promise<JoinOutcome> {
    const task = this.db.task(taskId);
    const twt = this.db.worktree(task.id);
    const gwt = await this.ensureGoalWorktree(goal);
    const bin = this.opts.gitBin;
    // A task that changed nothing has no worktree: there is nothing to merge, and it joins as is.
    if (!twt) return this.recordJoin(goal, task, gwt, (await branchSha(gwt.repo_path, gwt.branch, bin))!, null);
    await this.commitLeftovers(task, twt);
    const before = await branchSha(gwt.repo_path, gwt.branch, bin);
    const tip = await branchSha(twt.repo_path, twt.branch, bin);
    if (!before || !tip) return this.recordConflict(goal, task, before ?? "", [], "git.branch_missing");
    // A merge that landed before a restart, or a task that added no commit: already in the branch.
    // A task that added no commit but left changes in its worktree would join with its work silently
    // dropped; that asks you instead.
    if (await isAncestor(gwt.repo_path, tip, before, bin)) {
      if (tip === twt.base_sha && existsSync(twt.path) && !(await isClean(twt.path, bin))) return this.recordConflict(goal, task, before, [], "git.uncommitted");
      return this.recordJoin(goal, task, gwt, before, before);
    }
    if (!gitAtLeast(await (this.version ??= gitVersion(bin)))) return this.recordConflict(goal, task, before, [], "git.too_old");
    const check = await mergeTreeCheck(gwt.repo_path, gwt.branch, twt.branch, bin);
    if (!check.clean) return this.recordConflict(goal, task, before, check.paths, null);
    if (!existsSync(gwt.path) || !(await isClean(gwt.path, bin))) return this.recordConflict(goal, task, before, [], "git.goal_worktree_dirty");
    const merged = await mergeNoFf(gwt.path, twt.branch, bin);
    if (!merged.ok) return this.recordConflict(goal, task, before, [], merged.detail);
    return this.recordJoin(goal, task, gwt, before, merged.sha);
  }

  /**
   * What a writing step left uncommitted would never reach the goal branch. pinHead commits it when
   * the step completes (code, and a goal's docs step); this is the fallback for a commit that did
   * not happen then. A crew with a reviewer is left alone: its pass is for the commit it read, and a
   * new commit would merge work nobody reviewed (an empty join of a dirty worktree asks you instead).
   */
  private async commitLeftovers(task: TaskRow, wt: WorktreeRow): Promise<void> {
    const crew = this.db.crew(task.id);
    if (!crew || !existsSync(wt.path)) return;
    if (this.db.members(crew.id).some((m) => m.role === "reviewer" && !m.skipped_at)) return;
    if (this.db.runs(task.id).some((r) => r.ended_at === null)) return;
    if (await isClean(wt.path, this.opts.gitBin)) return;
    const res = await checkpoint(wt.path, "crewyard: commit what the step left uncommitted before merging it into the goal branch", this.opts.gitBin);
    if (res.committed) this.audit(task.id, null, "worktree.pinned", { sha: res.sha, skipped: res.skipped.length, goal: true });
  }

  private recordJoin(goal: GoalRow, task: TaskRow, gwt: WorktreeRow, before: string, after: string | null): JoinOutcome {
    const sha = after ?? before;
    const at = this.iso();
    this.db.tx(() => {
      this.db.exec("insert into goal_joins (id, goal_id, task_id, before_sha, after_sha, outcome, conflict_paths, at) values (?, ?, ?, ?, ?, 'joined', null, ?)", randomUUID(), goal.id, task.id, before, sha, at);
      this.db.exec("update goal_tasks set joined_sha = ?, joined_at = ? where task_id = ? and joined_sha is null", sha, at, task.id);
    });
    this.events.append(goal.project_id, goal.id, "goal.joined", { taskId: task.id, branch: gwt.branch, before, after: sha });
    this.emitTask(task.id, "goal");
    return { outcome: "joined", sha };
  }

  private recordConflict(goal: GoalRow, task: TaskRow, before: string, paths: string[], detail: string | null): JoinOutcome {
    this.db.exec(
      "insert into goal_joins (id, goal_id, task_id, before_sha, after_sha, outcome, conflict_paths, at) values (?, ?, ?, ?, null, 'conflict', ?, ?)",
      randomUUID(),
      goal.id,
      task.id,
      before,
      JSON.stringify(paths),
      this.iso(),
    );
    this.events.append(goal.project_id, goal.id, "goal.join_conflict", { taskId: task.id, paths, detail });
    // With no conflicted file (Git too old to test the merge, uncommitted work, a refused merge)
    // there is nothing for the implementer to resolve: you merge it yourself, check again, or leave it out.
    this.rows.raiseDecision(goal, "conflict", task.id, { paths, ...(detail ? { detail } : {}), ...(paths.length === 0 ? { actions: [...NO_FILE_CONFLICT_ACTIONS] } : {}) });
    this.emitTask(task.id, "goal");
    return { outcome: "conflict", paths, detail };
  }

  /**
   * `Send to 02's implementer`: the step that wrote the task's commits gets one more run, natively
   * resumed, told to merge the goal branch into its worktree and resolve the files git named.
   * Test and Review then run again because their dependency finished again (Dispatcher.rerunOf),
   * and the merge is tried on a later pass once the task's gates pass again.
   */
  async sendToImplementer(goal: GoalRow, taskId: string, paths: readonly string[]): Promise<void> {
    const task = this.db.task(taskId);
    const crew = this.db.crew(task.id);
    if (!crew) throw new Error("task has no crew");
    const writer = this.db.members(crew.id).find((m) => WRITER_ROLES.includes(m.role) && m.writes_code === 1 && !m.skipped_at);
    const runs = this.db.runs(task.id);
    const last = writer ? this.effectiveRun(writer, runs) : null;
    if (!writer || !last || last.end_reason !== "completed") throw new Error("no finished writer run to send the conflict to");
    const gwt = await this.ensureGoalWorktree(goal);
    await this.deps.followUp(last.id, conflictMessage(gwt.branch, paths));
  }
}

/** Agent-facing text; it names git's own file list, which is data, inside clear delimiters. */
export function conflictMessage(goalBranch: string, paths: readonly string[]): string {
  return [
    `Your branch conflicts with the goal branch ${goalBranch}, which holds the work of the other tasks of this goal.`,
    `Merge ${goalBranch} into this worktree (git merge ${goalBranch}), resolve the conflicts, run the tests, and commit the merge locally. Never push.`,
    ...(paths.length > 0 ? ["Files git reported as conflicting:", "<<<", ...paths.map((p) => `- ${cleanText(p).replace(/\s+/g, " ")}`), ">>>"] : []),
  ].join("\n");
}
