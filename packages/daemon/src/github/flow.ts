import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { CleanupVerdict, FeedbackItem, FeedbackKind, MergeMethod, PullsResult, RunView, TaskDetail, TaskPull, TaskPullDraft, TaskPullState, TaskPullView, TaskSummary } from "@crewyard/core";
import type { Store } from "../store.ts";
import type { GithubClient } from "./client.ts";
import * as git from "./git.ts";
import { clip, cleanupVerdict, feedbackKey, feedbackMessage, finalMessage, logExcerpt, newFeedback, pullBody, pullGate, samePath, type FeedbackDraft } from "./pr.ts";
import type { GithubService, RepoRef } from "./service.ts";

// From a finished task to a merged PR (PLAN.md §10, M4). Every outward step is its own explicit
// call from a click: push (GithubService.push), open the PR (create), merge (GithubService.merge),
// remove the worktree (remove). Reads and feedback routing hang off the GitHub refresh, which
// runs every 60 s only while a task is in review, plus manual refreshes.

/** The orchestrator's public surface this flow uses. */
export interface TaskSource {
  list(projectId: string): TaskSummary[];
  get(taskId: string): TaskDetail;
  message(runId: string, text: string): Promise<RunView>;
  followUp(runId: string, text: string): Promise<RunView>;
}

export interface PrFlowDeps {
  store: Store;
  service: GithubService;
  client: GithubClient;
  /** Resolved on each use, so the orchestrator is created by its own handlers first. */
  tasks: () => TaskSource;
  projectPath(projectId: string): string;
  emit(topic: string, payload: unknown): void;
  now?: () => Date;
}

interface PullRow {
  task_id: string;
  project_id: string;
  number: number;
  url: string;
  head: string;
  base: string;
  head_sha: string;
  state: TaskPullState;
  origin: "app" | "linked";
  created_at: string;
  merged_at: string | null;
  merged_sha: string | null;
  synced_at: string;
  worktree_removed_at: string | null;
}

interface FeedbackRow {
  id: string;
  task_id: string;
  dedupe_key: string;
  kind: FeedbackKind;
  source: string;
  excerpt: string;
  url: string | null;
  path: string | null;
  line: number | null;
  observed_at: string;
  state: "sent" | "held";
  run_id: string | null;
  sent_at: string | null;
}

interface RestPull {
  number: number;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  created_at?: string;
  head: { ref: string; sha: string };
  base: { ref: string };
}

interface RestCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  output?: { title?: string | null; summary?: string | null } | null;
  app?: { slug?: string } | null;
}

const PASSING = new Set(["success", "neutral", "skipped"]);
const FEEDBACK_SHOWN = 50;

const toPull = (r: PullRow): TaskPull => ({
  taskId: r.task_id,
  number: r.number,
  url: r.url,
  head: r.head,
  base: r.base,
  headSha: r.head_sha,
  state: r.state,
  origin: r.origin,
  createdAt: r.created_at,
  mergedAt: r.merged_at,
  mergedSha: r.merged_sha,
  syncedAt: r.synced_at,
  worktreeRemovedAt: r.worktree_removed_at,
});

const toFeedback = (r: FeedbackRow): FeedbackItem => ({
  id: r.id,
  kind: r.kind,
  source: r.source,
  excerpt: r.excerpt,
  url: r.url,
  path: r.path,
  line: r.line,
  observedAt: r.observed_at,
  state: r.state,
  runId: r.run_id,
  sentAt: r.sent_at,
});

const latestRun = (detail: TaskDetail, memberId: string) =>
  detail.runs.filter((r) => r.memberId === memberId).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1) ?? null;

/** The review gate's crew half: every required step's latest run completed. */
export function requiredDone(detail: TaskDetail): boolean {
  const members = detail.crew?.members ?? [];
  return members.length > 0 && members.filter((m) => m.required).every((m) => latestRun(detail, m.id)?.endReason === "completed");
}

/** The run that owns the task's branch: the latest run of the step that writes in the worktree. */
export function ownerRun(detail: TaskDetail): RunView | null {
  const byId = detail.worktree?.ownerRunId ? detail.runs.find((r) => r.id === detail.worktree!.ownerRunId) : undefined;
  const memberId = byId?.memberId ?? detail.crew?.members.find((m) => m.writesCode)?.id;
  return memberId ? latestRun(detail, memberId) : null;
}

export class PrFlow {
  private readonly creating = new Set<string>();
  private readonly removing = new Set<string>();
  private readonly sending = new Set<string>();
  private readonly deps: PrFlowDeps;
  private readonly now: () => Date;

  constructor(deps: PrFlowDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  private get db() {
    return this.deps.store.db;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private row(taskId: string): PullRow | null {
    return (this.db.prepare("select * from task_pulls where task_id = ?").get(taskId) as unknown as PullRow | undefined) ?? null;
  }

  private branchOf(taskId: string): string | null {
    return (this.db.prepare("select branch from worktrees where task_id = ?").get(taskId) as { branch: string } | undefined)?.branch ?? null;
  }

  // ---- settings and gates

  routing(projectId: string): boolean {
    const r = this.db.prepare("select route_feedback from github_projects where project_id = ?").get(projectId) as { route_feedback: number } | undefined;
    return r?.route_feedback === 1;
  }

  setRouting(projectId: string, enabled: boolean): boolean {
    this.db.prepare("insert into github_projects (project_id, route_feedback) values (?, ?) on conflict(project_id) do update set route_feedback = excluded.route_feedback").run(projectId, enabled ? 1 : 0);
    this.deps.store.appendEvent({ kind: "github.routing", source: "github", payload: { enabled }, projectId });
    this.deps.emit("github.changed", { projectId });
    return enabled;
  }

  /** Open requests on the task that owns the branch; 0 when no task owns it, so a hand-made PR has no agent questions. */
  openQuestions(projectId: string, branch: string): number {
    const task = this.db.prepare("select t.id from worktrees w join tasks t on t.id = w.task_id where t.project_id = ? and w.branch = ?").get(projectId, branch) as { id: string } | undefined;
    if (!task) return 0;
    return Number((this.db.prepare("select count(*) as n from requests where task_id = ? and answered_at is null").get(task.id) as { n: number }).n);
  }

  /** Projects with a code task in review: only those get the 60 s refresh. */
  watched(): string[] {
    return this.deps.store
      .listProjects()
      .map((p) => p.id)
      .filter((id) => this.deps.tasks().list(id).some((t) => t.kind === "code" && t.status === "review"));
  }

  // ---- reads

  async view(taskId: string): Promise<TaskPullView> {
    const detail = this.deps.tasks().get(taskId);
    let pulls: PullsResult | null = null;
    try {
      pulls = await this.deps.service.pulls(detail.projectId);
    } catch {
      pulls = null;
    }
    return this.build(detail, pulls);
  }

  async views(projectId: string): Promise<TaskPullView[]> {
    const tasks = this.deps.tasks().list(projectId).filter((t) => t.kind === "code" && (t.status === "review" || t.status === "merged" || this.row(t.id) !== null));
    if (tasks.length === 0) return [];
    let pulls: PullsResult | null = null;
    try {
      pulls = await this.deps.service.pulls(projectId);
    } catch {
      pulls = null;
    }
    const out: TaskPullView[] = [];
    for (const t of tasks) out.push(await this.build(this.deps.tasks().get(t.id), pulls));
    return out;
  }

  private async build(detail: TaskDetail, pulls: PullsResult | null): Promise<TaskPullView> {
    const row = this.row(detail.id);
    const live = row ? (pulls?.pulls.find((p) => p.number === row.number) ?? null) : null;
    const needsDraft = detail.kind === "code" && (!row || row.state === "closed");
    const draft = needsDraft ? await this.draft(detail, row) : null;
    const wt = detail.worktree;
    const cleanup = row?.state === "merged" && !row.worktree_removed_at && wt && existsSync(wt.path) ? await this.verdict(detail.projectId, wt.path) : null;
    const feedback = (this.db.prepare("select * from pull_feedback where task_id = ? order by observed_at desc, rowid desc limit ?").all(detail.id, FEEDBACK_SHOWN) as unknown as FeedbackRow[]).map(toFeedback);
    return {
      taskId: detail.id,
      projectId: detail.projectId,
      pull: row ? toPull(row) : null,
      live,
      mergeMethod: (pulls?.mergeMethod ?? this.deps.service.repoRef(detail.projectId)?.mergeMethod ?? null) as MergeMethod | null,
      draft,
      cleanup,
      feedback,
      routing: this.routing(detail.projectId),
      problem: pulls?.problem ?? null,
    };
  }

  private async remoteName(repoPath: string): Promise<string> {
    return (await git.readRemote(repoPath))?.name ?? "origin";
  }

  async draft(detail: TaskDetail, row: PullRow | null = this.row(detail.id)): Promise<TaskPullDraft> {
    const repoPath = this.deps.projectPath(detail.projectId);
    const remote = await this.remoteName(repoPath);
    const base = detail.baseBranch ?? this.deps.service.repoRef(detail.projectId)?.defaultBranch ?? (await git.defaultBranch(repoPath, remote));
    const wt = detail.worktree;
    const hasPull = row !== null && row.state !== "closed";
    const status = detail.status;
    const done = requiredDone(detail);
    if (!wt) {
      return { title: detail.title, body: detail.description, head: null, base, headSha: null, ahead: null, unpushed: 0, gate: pullGate({ status, requiredDone: done, ahead: null, dirty: null, unpushed: 0, onRemote: false, hasPull }) };
    }
    const tip = await git.branchTip(repoPath, wt.branch);
    const remoteBase = base ? `refs/remotes/${remote}/${base}` : null;
    const baseRef = base ? ((await git.refSha(repoPath, remoteBase!)) ? remoteBase : `refs/heads/${base}`) : null;
    const [ahead, dirty, unpushedList, remoteTip, commits, totals] = await Promise.all([
      tip && baseRef ? git.revCount(repoPath, baseRef, tip) : Promise.resolve(null),
      existsSync(wt.path) ? git.isDirty(wt.path) : Promise.resolve(null),
      git.unpushedBranches(repoPath),
      git.refSha(repoPath, `refs/remotes/${remote}/${wt.branch}`),
      tip && baseRef ? git.commitSubjects(repoPath, baseRef, tip) : Promise.resolve([]),
      tip && baseRef ? git.diffTotals(repoPath, baseRef, tip) : Promise.resolve(null),
    ]);
    const unpushed = unpushedList.find((b) => b.branch === wt.branch)?.commits ?? 0;
    const gate = pullGate({ status, requiredDone: done, ahead, dirty, unpushed, onRemote: Boolean(tip && remoteTip === tip), hasPull });
    const plan = [...detail.runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).filter((r) => r.plan?.length).at(-1)?.plan ?? null;
    const crew = (detail.crew?.members ?? []).map((m) => {
      const r = latestRun(detail, m.id);
      return { role: m.role, runner: r?.runner ?? m.chosen?.runner ?? "unknown", model: r?.model ?? m.chosen?.model ?? null };
    });
    const body = pullBody({ description: detail.description, plan, commits, totals, crew, review: this.reviewNote(detail) });
    return { title: detail.title, body, head: wt.branch, base, headSha: tip, ahead, unpushed, gate };
  }

  /** The reviewer's final message, from the stored event log. */
  private reviewNote(detail: TaskDetail): string | null {
    const member = detail.crew?.members.find((m) => m.role === "reviewer");
    const run = member ? latestRun(detail, member.id) : null;
    if (!run) return null;
    const rows = this.db.prepare("select kind, payload from events where run_id = ? and kind in ('run.message.delta', 'run.tool.call') order by seq").all(run.id) as Array<{ kind: string; payload: string }>;
    return finalMessage(rows.map((r) => ({ kind: r.kind, text: r.kind === "run.message.delta" ? (JSON.parse(r.payload) as { text?: string }).text : undefined })));
  }

  // ---- outward steps (each one is a click)

  async create(taskId: string, title: string, body: string, headSha: string): Promise<TaskPull> {
    if (this.creating.has(taskId)) throw new Error("pull.busy");
    this.creating.add(taskId);
    try {
      const detail = this.deps.tasks().get(taskId);
      const projectId = detail.projectId;
      let ref = this.deps.service.repoRef(projectId);
      if (!ref) {
        await this.deps.service.refresh(projectId);
        ref = this.deps.service.repoRef(projectId);
      }
      if (!ref) throw new Error("pull.no_github");
      if (!title.trim()) throw new Error("pull.no_title");
      // A fresh read: the gate and the branch tip are checked again at the moment of the click.
      const draft = await this.draft(detail);
      if (!draft.head || !draft.base || !draft.headSha) throw new Error("pull.no_branch");
      if (draft.headSha !== headSha) throw new Error("pull.moved");
      if (!draft.gate.ready) throw new Error("pull.gate_closed");
      const res = await this.deps.client.write<RestPull>("POST", `/repos/${ref.owner}/${ref.repo}/pulls`, { title: title.trim(), body, head: draft.head, base: draft.base });
      const now = this.iso();
      this.db
        .prepare(
          `insert into task_pulls (task_id, project_id, number, url, head, base, head_sha, state, origin, created_at, synced_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, 'app', ?, ?)
           on conflict(task_id) do update set number = excluded.number, url = excluded.url, head = excluded.head, base = excluded.base,
             head_sha = excluded.head_sha, state = excluded.state, origin = 'app', created_at = excluded.created_at, merged_at = null,
             merged_sha = null, synced_at = excluded.synced_at`,
        )
        .run(taskId, projectId, res.number, res.html_url, res.head?.ref ?? draft.head, res.base?.ref ?? draft.base, res.head?.sha ?? headSha, res.draft ? "draft" : "open", res.created_at ?? now, now);
      this.deps.store.appendEvent({ kind: "github.pull_opened", source: "github", payload: { number: res.number, head: draft.head, base: draft.base, headSha }, projectId, taskId });
      this.changed(taskId, projectId);
      void this.deps.service.refresh(projectId).catch(() => undefined);
      return toPull(this.row(taskId)!);
    } finally {
      this.creating.delete(taskId);
    }
  }

  /** Records a merge done through GithubService.merge right away, before the next refresh confirms it. */
  afterMerge(projectId: string, number: number, headSha: string, res: { merged: boolean; sha: string | null }): void {
    if (!res.merged) return;
    const row = this.db.prepare("select * from task_pulls where project_id = ? and number = ?").get(projectId, number) as unknown as PullRow | undefined;
    if (!row) return;
    const now = this.iso();
    this.db.prepare("update task_pulls set state = 'merged', head_sha = ?, merged_at = ?, merged_sha = ?, synced_at = ? where task_id = ?").run(headSha, now, res.sha, now, row.task_id);
    this.deps.store.appendEvent({ kind: "github.pull_merged", source: "github", payload: { number, sha: res.sha }, projectId, taskId: row.task_id });
    this.changed(row.task_id, projectId);
  }

  async verdict(projectId: string, path: string): Promise<CleanupVerdict> {
    const repoPath = this.deps.projectPath(projectId);
    const match = (await git.listWorktrees(repoPath)).find((w) => samePath(w.path, path));
    const exists = existsSync(path);
    const branch = match?.branch ?? null;
    const dirty = match && exists ? await git.isDirty(path) : false;
    const unpushed = branch ? ((await git.unpushedBranches(repoPath)).find((b) => b.branch === branch)?.commits ?? 0) : 0;
    const mergedHead = branch ? this.mergedHead(projectId, branch) : null;
    let merged = mergedHead !== null;
    if (!merged && branch) {
      const ref = this.deps.service.repoRef(projectId);
      const remote = await this.remoteName(repoPath);
      const base = ref?.defaultBranch ?? (await git.defaultBranch(repoPath, remote));
      if (base && branch !== base) merged = (await git.mergedInto(repoPath, `${remote}/${base}`)).has(branch);
    }
    const liveRuns = (this.db.prepare("select cwd from runs where ended_at is null").all() as Array<{ cwd: string }>).filter((r) => samePath(r.cwd, path)).length;
    return cleanupVerdict({
      path,
      branch,
      known: Boolean(match),
      primary: match?.primary ?? false,
      exists,
      dirty,
      unpushed,
      tipIsMergedHead: Boolean(mergedHead && match?.head === mergedHead),
      merged,
      liveRuns,
    });
  }

  /** Head sha of a merged PR for the branch: the task's own record first, then the GitHub cache. */
  private mergedHead(projectId: string, branch: string): string | null {
    const row = this.db.prepare("select head_sha from task_pulls where project_id = ? and head = ? and state = 'merged'").get(projectId, branch) as { head_sha: string } | undefined;
    if (row) return row.head_sha;
    return this.deps.service.cachedPulls(projectId)?.pulls.find((p) => p.state === "merged" && p.head === branch)?.headSha ?? null;
  }

  async remove(projectId: string, path: string): Promise<{ removed: boolean; verdict: CleanupVerdict }> {
    const key = path.toLowerCase();
    if (this.removing.has(key)) throw new Error("worktree.busy");
    this.removing.add(key);
    try {
      const verdict = await this.verdict(projectId, path);
      if (!verdict.ok) return { removed: false, verdict };
      const res = await git.removeWorktree(this.deps.projectPath(projectId), path);
      if (!res.ok) throw new Error(res.output || "git worktree remove failed");
      const owners = (this.db.prepare("select w.task_id, w.path from worktrees w join tasks t on t.id = w.task_id where t.project_id = ?").all(projectId) as Array<{ task_id: string; path: string }>).filter((w) => samePath(w.path, path));
      const now = this.iso();
      for (const o of owners) this.db.prepare("update task_pulls set worktree_removed_at = ? where task_id = ?").run(now, o.task_id);
      this.deps.store.appendEvent({ kind: "github.worktree_removed", source: "github", payload: { path, branch: verdict.branch }, projectId, taskId: owners[0]?.task_id ?? null });
      this.deps.emit("github.changed", { projectId });
      return { removed: true, verdict };
    } finally {
      this.removing.delete(key);
    }
  }

  /** "Send to agent": held feedback goes to the owning step, which continues if its run finished. */
  async sendHeld(taskId: string): Promise<number> {
    if (this.sending.has(taskId)) throw new Error("feedback.busy");
    this.sending.add(taskId);
    try {
      const detail = this.deps.tasks().get(taskId);
      const row = this.row(taskId);
      const held = this.db.prepare("select * from pull_feedback where task_id = ? and state = 'held' order by observed_at, rowid").all(taskId) as unknown as FeedbackRow[];
      if (!row || held.length === 0) return 0;
      const owner = ownerRun(detail);
      if (!owner) throw new Error("feedback.no_owner");
      const view = await this.deps.tasks().followUp(owner.id, feedbackMessage({ number: row.number, url: row.url, head: row.head }, held));
      this.markSent(held, view.id);
      this.deps.emit("github.changed", { projectId: detail.projectId });
      return held.length;
    } finally {
      this.sending.delete(taskId);
    }
  }

  private markSent(items: FeedbackRow[], runId: string): void {
    const now = this.iso();
    const stmt = this.db.prepare("update pull_feedback set state = 'sent', run_id = ?, sent_at = ? where id = ?");
    for (const it of items) stmt.run(runId, now, it.id);
  }

  private changed(taskId: string, projectId: string): void {
    let status;
    try {
      status = this.deps.tasks().get(taskId).status;
    } catch {
      return;
    }
    this.deps.emit("tasks.changed", { taskId, projectId, status, cause: "pull_request" });
    this.deps.emit("github.changed", { projectId });
  }

  // ---- after each refresh

  /** Links PRs found for task branches, updates stored PR facts, then routes feedback if the project opted in. */
  async sync(projectId: string): Promise<void> {
    const pulls = this.deps.service.cachedPulls(projectId);
    const ref = this.deps.service.repoRef(projectId);
    if (!pulls || pulls.problem || !ref) return;
    const changed = new Set<string>();
    const now = this.iso();
    for (const t of this.deps.tasks().list(projectId)) {
      if (t.kind !== "code") continue;
      const row = this.row(t.id);
      if (!row) {
        const branch = this.branchOf(t.id);
        const pr = branch ? pulls.pulls.find((p) => p.head === branch) : undefined;
        if (!pr) continue;
        this.db
          .prepare("insert into task_pulls (task_id, project_id, number, url, head, base, head_sha, state, origin, created_at, merged_at, synced_at) values (?, ?, ?, ?, ?, ?, ?, ?, 'linked', ?, ?, ?)")
          .run(t.id, projectId, pr.number, pr.url, pr.head, pr.base, pr.headSha, pr.state, now, pr.mergedAt, now);
        changed.add(t.id);
        continue;
      }
      if (row.state === "merged" || row.state === "closed") continue;
      const next = await this.readState(ref, row, pulls);
      if (!next) continue;
      this.db.prepare("update task_pulls set state = ?, head_sha = ?, merged_at = coalesce(?, merged_at), merged_sha = coalesce(?, merged_sha), synced_at = ? where task_id = ?").run(next.state, next.headSha, next.mergedAt, next.mergedSha, now, t.id);
      if (next.state !== row.state) changed.add(t.id);
    }
    for (const id of changed) this.changed(id, projectId);
    if (this.routing(projectId)) await this.route(projectId, ref, pulls);
  }

  /** From the PR list when it has the PR; a PR that left the list (closed, or merged long ago) is read on its own. */
  private async readState(ref: RepoRef, row: PullRow, pulls: PullsResult): Promise<{ state: TaskPullState; headSha: string; mergedAt: string | null; mergedSha: string | null } | null> {
    const pr = pulls.pulls.find((p) => p.number === row.number);
    if (pr) return { state: pr.state, headSha: pr.headSha, mergedAt: pr.mergedAt, mergedSha: null };
    try {
      const { data } = await this.deps.client.get<RestPull>(`/repos/${ref.owner}/${ref.repo}/pulls/${row.number}`);
      const state: TaskPullState = data.merged_at ? "merged" : data.state === "closed" ? "closed" : data.draft ? "draft" : "open";
      return { state, headSha: data.head.sha, mergedAt: data.merged_at ?? null, mergedSha: data.merge_commit_sha ?? null };
    } catch {
      return null;
    }
  }

  private async route(projectId: string, ref: RepoRef, pulls: PullsResult): Promise<void> {
    const rows = this.db.prepare("select * from task_pulls where project_id = ? and state in ('open', 'draft')").all(projectId) as unknown as PullRow[];
    for (const row of rows) {
      const seen = new Set((this.db.prepare("select dedupe_key from pull_feedback where task_id = ?").all(row.task_id) as Array<{ dedupe_key: string }>).map((r) => r.dedupe_key));
      const live = pulls.pulls.find((p) => p.number === row.number);
      const drafts: FeedbackDraft[] = [];
      if (live?.checks.state === "failing") drafts.push(...(await this.checkFeedback(ref, live.headSha, seen)));
      drafts.push(...(await this.reviewFeedback(ref, row.number)));
      const fresh = newFeedback(seen, drafts);
      if (fresh.length === 0) continue;
      const now = this.iso();
      const insert = this.db.prepare(
        "insert or ignore into pull_feedback (id, task_id, dedupe_key, kind, source, excerpt, url, path, line, observed_at, state) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held')",
      );
      const ids = fresh.map((d) => {
        const id = randomUUID();
        insert.run(id, row.task_id, d.key, d.kind, d.source, d.excerpt, d.url, d.path, d.line, now);
        return id;
      });
      await this.deliver(row, ids);
    }
  }

  /** Automatic delivery goes only to an unfinished owning run; a finished one waits for "Send to agent". */
  private async deliver(row: PullRow, ids: string[]): Promise<void> {
    let detail: TaskDetail;
    try {
      detail = this.deps.tasks().get(row.task_id);
    } catch {
      return;
    }
    const owner = ownerRun(detail);
    if (!owner || owner.endReason === "completed" || detail.cancelledAt) return;
    const items = ids.map((id) => this.db.prepare("select * from pull_feedback where id = ?").get(id) as unknown as FeedbackRow);
    try {
      const view = await this.deps.tasks().message(owner.id, feedbackMessage({ number: row.number, url: row.url, head: row.head }, items));
      this.markSent(items, view.id);
    } catch {
      // stays held; the user can send it by hand
    }
  }

  private async checkFeedback(ref: RepoRef, sha: string, seen: Set<string>): Promise<FeedbackDraft[]> {
    const base = `/repos/${ref.owner}/${ref.repo}`;
    const out: FeedbackDraft[] = [];
    try {
      const { data } = await this.deps.client.get<{ check_runs: RestCheckRun[] }>(`${base}/commits/${sha}/check-runs?per_page=100`);
      for (const run of data.check_runs ?? []) {
        if (run.status !== "completed" || PASSING.has(run.conclusion ?? "")) continue;
        const key = feedbackKey.check(sha, run.name);
        // Seen failures are skipped before their log is downloaded again.
        if (seen.has(key) || out.some((d) => d.key === key)) continue;
        const parts = [run.output?.title, run.output?.summary].filter((s): s is string => Boolean(s?.trim())).map((s) => clip(s, 800));
        if (run.app?.slug === "github-actions") {
          try {
            const log = logExcerpt(await this.deps.client.text(`${base}/actions/jobs/${run.id}/logs`));
            if (log) parts.push(log);
          } catch {
            // the summary alone still says which job failed
          }
        }
        out.push({ key, kind: "check", source: run.name, excerpt: parts.join("\n"), url: run.html_url ?? null, path: null, line: null });
      }
      const statuses = await this.deps.client.get<Array<{ context: string; state: string; description?: string | null; target_url?: string | null }>>(`${base}/commits/${sha}/statuses?per_page=100`);
      const latest = new Set<string>();
      for (const st of statuses.data ?? []) {
        if (latest.has(st.context)) continue;
        latest.add(st.context);
        if (st.state !== "failure" && st.state !== "error") continue;
        out.push({ key: feedbackKey.status(sha, st.context), kind: "check", source: st.context, excerpt: clip(st.description ?? "", 800), url: st.target_url ?? null, path: null, line: null });
      }
    } catch {
      // checks unreadable this round; the next refresh tries again
    }
    return out;
  }

  private async reviewFeedback(ref: RepoRef, number: number): Promise<FeedbackDraft[]> {
    const base = `/repos/${ref.owner}/${ref.repo}/pulls/${number}`;
    const out: FeedbackDraft[] = [];
    try {
      const [reviews, comments] = await Promise.all([
        this.deps.client.get<Array<{ id: number; state: string; body?: string | null; html_url?: string; user?: { login?: string } | null }>>(`${base}/reviews?per_page=100`),
        this.deps.client.get<Array<{ id: number; body: string; path?: string; line?: number | null; original_line?: number | null; html_url?: string; user?: { login?: string } | null }>>(`${base}/comments?per_page=100`),
      ]);
      for (const r of reviews.data ?? []) {
        if (!r.body?.trim() || (r.state !== "CHANGES_REQUESTED" && r.state !== "COMMENTED")) continue;
        out.push({ key: feedbackKey.review(r.id), kind: "review", source: r.user?.login ?? "unknown", excerpt: clip(r.body, 1500), url: r.html_url ?? null, path: null, line: null });
      }
      for (const c of comments.data ?? []) {
        if (!c.body?.trim()) continue;
        out.push({ key: feedbackKey.comment(c.id), kind: "review_comment", source: c.user?.login ?? "unknown", excerpt: clip(c.body, 1500), url: c.html_url ?? null, path: c.path ?? null, line: c.line ?? c.original_line ?? null });
      }
    } catch {
      // reviews unreadable this round
    }
    return out;
  }
}
