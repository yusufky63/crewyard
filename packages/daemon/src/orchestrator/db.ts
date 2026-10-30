import type { DatabaseSync } from "node:sqlite";
import {
  deriveTaskStatus,
  type CandidateView,
  type CostEstimate,
  type CrewMemberView,
  type CrewView,
  type EndReason,
  type FallbackMode,
  type Headroom,
  type HandoffView,
  type LimitSample,
  type LimitWindow,
  type Provenance,
  type Reason,
  type RequestAnswer,
  type RequestPayload,
  type RequestView,
  type RiskLevel,
  type RoleId,
  type RunnerId,
  type RunState,
  type RunView,
  type TaskDetail,
  type TaskFacts,
  type TaskKind,
  type TaskSize,
  type TaskStatus,
  type TaskSummary,
  type WorktreeView,
} from "@crewyard/core";
import { sumEstimates } from "./crew.ts";
import { OrchestratorError } from "./errors.ts";

// Plain SQL over the store's connection. Rows are facts; every view (status, run state,
// pending request, open handoff) is computed here on read (PLAN.md D5, §13).

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
}

export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  kind: TaskKind;
  size: TaskSize;
  base_branch: string | null;
  fallback: FallbackMode;
  wait_reset_minutes: number;
  budget_usd: number | null;
  classification: string;
  created_at: string;
  cancelled_at: string | null;
}

export interface CrewRow {
  id: string;
  task_id: string;
  proposed_at: string;
  approved_at: string | null;
  estimate_usd: number | null;
  estimate_provenance: Provenance;
}

export interface MemberRow {
  id: string;
  crew_id: string;
  position: number;
  step: string;
  role: RoleId;
  depends_on: string;
  required: number;
  writes_code: number;
  chosen: string | null;
  standby: string;
  reasons: string;
  edited: number;
}

export interface RunRow {
  id: string;
  task_id: string;
  member_id: string;
  role: RoleId;
  profile_id: string;
  runner: RunnerId;
  model: string | null;
  cwd: string;
  worktree_id: string | null;
  native_session_id: string | null;
  pid: number | null;
  resumed_from: string | null;
  handoff_id: string | null;
  started_at: string;
  ended_at: string | null;
  end_reason: EndReason | null;
  end_detail: string | null;
  last_state: RunState | null;
  last_activity_at: string | null;
  paused_at: string | null;
  resume_at: string | null;
  limit_reached: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  cost_provenance: Provenance;
  plan: string | null;
  diff: string | null;
}

export interface RequestRow {
  id: string;
  task_id: string;
  run_id: string | null;
  native_id: string | null;
  kind: RequestView["kind"];
  risk: RiskLevel | null;
  payload: string;
  created_at: string;
  answered_at: string | null;
  answer: string | null;
  answered_by: RequestView["answeredBy"];
}

export interface WorktreeRow {
  id: string;
  task_id: string;
  repo_path: string;
  path: string;
  branch: string;
  base_sha: string;
  owner_run_id: string | null;
  created_at: string;
  last_heartbeat_at: string | null;
}

export interface HandoffRow {
  id: string;
  task_id: string;
  from_run_id: string;
  to_run_id: string | null;
  target_profile_id: string | null;
  mode: FallbackMode;
  kind: HandoffView["kind"];
  trigger_kind: HandoffView["trigger"];
  phase: HandoffView["phase"];
  package_path: string | null;
  checkpoint_sha: string | null;
  opened_at: string;
  closed_at: string | null;
  outcome: HandoffView["outcome"];
  detail: string | null;
}

const json = <T>(s: string | null): T | null => (s === null ? null : (JSON.parse(s) as T));
const isActive = (r: RunRow) => r.ended_at === null;
/** Ended runs a user can pick up again; completed and handed-off runs are not. */
const RESUMABLE: EndReason[] = ["interrupted", "stopped", "failed"];

interface SampleRow {
  id: number;
  profile_id: string;
  limit_window: LimitWindow;
  used_pct: number | null;
  resets_at: string | null;
  provenance: Provenance;
  observed_at: string;
  bucket: string;
  bucket_label: string | null;
}

const toSample = (r: SampleRow): LimitSample => ({
  profileId: r.profile_id,
  window: r.limit_window,
  usedPct: r.used_pct,
  resetsAt: r.resets_at,
  provenance: r.provenance,
  observedAt: r.observed_at,
  ...(r.bucket ? { bucket: r.bucket, bucketLabel: r.bucket_label } : {}),
});

export class OrchestratorDb {
  constructor(readonly db: DatabaseSync) {}

  private one<T>(sql: string, ...args: Array<string | number | null>): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }

  private all<T>(sql: string, ...args: Array<string | number | null>): T[] {
    return this.db.prepare(sql).all(...args) as unknown as T[];
  }

  exec(sql: string, ...args: Array<string | number | null>): void {
    this.db.prepare(sql).run(...args);
  }

  /** Runs `fn` in one transaction so a crash never leaves half a crew or half a handoff. */
  tx<T>(fn: () => T): T {
    this.db.exec("begin");
    try {
      const r = fn();
      this.db.exec("commit");
      return r;
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
  }

  project(id: string): ProjectRow {
    const p = this.one<ProjectRow>("select id, name, path from projects where id = ?", id);
    if (!p) throw new OrchestratorError("project.not_found", { projectId: id });
    return p;
  }

  task(id: string): TaskRow {
    const t = this.one<TaskRow>("select * from tasks where id = ?", id);
    if (!t) throw new OrchestratorError("task.not_found", { taskId: id });
    return t;
  }

  tasks(projectId?: string): TaskRow[] {
    return projectId
      ? this.all<TaskRow>("select * from tasks where project_id = ? order by created_at desc, id", projectId)
      : this.all<TaskRow>("select * from tasks order by created_at desc, id");
  }

  /** Approved, not cancelled tasks the scheduler should look at, oldest first. */
  schedulable(): TaskRow[] {
    return this.all<TaskRow>(
      "select t.* from tasks t join crews c on c.task_id = t.id where c.approved_at is not null and t.cancelled_at is null order by t.created_at, t.id",
    );
  }

  crew(taskId: string): CrewRow | null {
    return this.one<CrewRow>("select * from crews where task_id = ?", taskId) ?? null;
  }

  members(crewId: string): MemberRow[] {
    return this.all<MemberRow>("select * from crew_members where crew_id = ? order by position", crewId);
  }

  member(id: string): MemberRow {
    const m = this.one<MemberRow>("select * from crew_members where id = ?", id);
    if (!m) throw new OrchestratorError("crew.member_not_found", { memberId: id });
    return m;
  }

  run(id: string): RunRow {
    const r = this.one<RunRow>("select * from runs where id = ?", id);
    if (!r) throw new OrchestratorError("run.not_found", { runId: id });
    return r;
  }

  runs(taskId: string): RunRow[] {
    return this.all<RunRow>("select * from runs where task_id = ? order by started_at, id", taskId);
  }

  openRuns(): RunRow[] {
    return this.all<RunRow>("select * from runs where ended_at is null order by started_at");
  }

  /** Ended runs waiting for a same-profile retry after a transient error. */
  pendingRetries(): RunRow[] {
    return this.all<RunRow>("select * from runs where ended_at is not null and resume_at is not null");
  }

  /** Which same-profile retry this run is: 0 for a run nobody retried. */
  retryAttempt(runId: string): number {
    return Number(this.one<{ attempt: number }>("select attempt from run_retries where run_id = ?", runId)?.attempt ?? 0);
  }

  /** Runs that hold a process slot: open and not paused. */
  activeCounts(): { byProject: Map<string, number>; byProfile: Map<string, number>; total: number } {
    const rows = this.all<{ project_id: string; profile_id: string }>(
      "select t.project_id, r.profile_id from runs r join tasks t on t.id = r.task_id where r.ended_at is null and r.paused_at is null",
    );
    const byProject = new Map<string, number>();
    const byProfile = new Map<string, number>();
    for (const r of rows) {
      byProject.set(r.project_id, (byProject.get(r.project_id) ?? 0) + 1);
      byProfile.set(r.profile_id, (byProfile.get(r.profile_id) ?? 0) + 1);
    }
    return { byProject, byProfile, total: rows.length };
  }

  request(id: string): RequestRow {
    const r = this.one<RequestRow>("select * from requests where id = ?", id);
    if (!r) throw new OrchestratorError("request.not_found", { requestId: id });
    return r;
  }

  openRequestsForRun(runId: string): RequestRow[] {
    return this.all<RequestRow>("select * from requests where run_id = ? and answered_at is null order by created_at, id", runId);
  }

  requests(filter: { projectId?: string; taskId?: string; includeAnswered?: boolean }): RequestRow[] {
    const where = ["1 = 1"];
    const args: string[] = [];
    if (!filter.includeAnswered) where.push("q.answered_at is null");
    if (filter.taskId) {
      where.push("q.task_id = ?");
      args.push(filter.taskId);
    }
    if (filter.projectId) {
      where.push("t.project_id = ?");
      args.push(filter.projectId);
    }
    return this.all<RequestRow>(`select q.* from requests q join tasks t on t.id = q.task_id where ${where.join(" and ")} order by q.created_at, q.id`, ...args);
  }

  worktree(taskId: string): WorktreeRow | null {
    return this.one<WorktreeRow>("select * from worktrees where task_id = ?", taskId) ?? null;
  }

  handoff(id: string): HandoffRow {
    const h = this.one<HandoffRow>("select * from handoffs where id = ?", id);
    if (!h) throw new OrchestratorError("run.not_found", { handoffId: id });
    return h;
  }

  handoffs(taskId: string): HandoffRow[] {
    return this.all<HandoffRow>("select * from handoffs where task_id = ? order by opened_at, id", taskId);
  }

  openHandoffs(): HandoffRow[] {
    return this.all<HandoffRow>("select * from handoffs where closed_at is null");
  }

  /** Undelivered messages for a crew step, oldest first. */
  queued(memberId: string): Array<{ id: string; text: string }> {
    return this.all<{ id: string; text: string }>("select id, text from outbox where member_id = ? and delivered_at is null order by created_at, id", memberId);
  }

  /** Last running totals a runner reported for one native session (they survive resume). */
  nativeUsage(runner: RunnerId, sessionId: string): { tokensIn: number; tokensOut: number; cacheRead: number; costUsd: number | null } | null {
    const r = this.one<{ tokens_in: number; tokens_out: number; cache_read: number; cost_usd: number | null }>("select * from native_usage where runner = ? and session_id = ?", runner, sessionId);
    return r ? { tokensIn: r.tokens_in, tokensOut: r.tokens_out, cacheRead: r.cache_read, costUsd: r.cost_usd } : null;
  }

  setNativeUsage(runner: RunnerId, sessionId: string, u: { tokensIn: number; tokensOut: number; cacheRead: number; costUsd: number | null }, at: string): void {
    this.exec(
      `insert into native_usage (runner, session_id, tokens_in, tokens_out, cache_read, cost_usd, updated_at) values (?, ?, ?, ?, ?, ?, ?)
       on conflict (runner, session_id) do update set tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out, cache_read = excluded.cache_read, cost_usd = excluded.cost_usd, updated_at = excluded.updated_at`,
      runner,
      sessionId,
      u.tokensIn,
      u.tokensOut,
      u.cacheRead,
      u.costUsd,
      at,
    );
  }

  allowRules(projectId: string): string[] {
    return this.all<{ command: string }>("select command from allow_rules where project_id = ? order by command", projectId).map((r) => r.command);
  }

  /** Completed vs ended runs per runner and role in this project: the "accepted" history. */
  history(projectId: string, runner: RunnerId, role: RoleId): { accepted: number; total: number } {
    const r = this.one<{ accepted: number | null; total: number }>(
      `select sum(case when r.end_reason = 'completed' then 1 else 0 end) as accepted, count(*) as total
         from runs r join tasks t on t.id = r.task_id
        where t.project_id = ? and r.runner = ? and r.role = ? and r.ended_at is not null and r.end_reason <> 'interrupted'`,
      projectId,
      runner,
      role,
    );
    return { accepted: Number(r?.accepted ?? 0), total: Number(r?.total ?? 0) };
  }

  preference(projectId: string, role: RoleId, profileId: string): number {
    return Number(this.one<{ weight: number }>("select weight from role_prefs where project_id = ? and role = ? and profile_id = ?", projectId, role, profileId)?.weight ?? 0);
  }

  bumpPreference(projectId: string, role: RoleId, profileId: string, delta: number): void {
    this.exec(
      "insert into role_prefs (project_id, role, profile_id, weight) values (?, ?, ?, ?) on conflict (project_id, role, profile_id) do update set weight = weight + excluded.weight",
      projectId,
      role,
      profileId,
      delta,
    );
  }

  insertSample(s: LimitSample, runId: string | null): void {
    const res = this.db
      .prepare("insert into usage_samples (profile_id, limit_window, used_pct, resets_at, provenance, observed_at, run_id) values (?, ?, ?, ?, ?, ?, ?)")
      .run(s.profileId, s.window, s.usedPct, s.resetsAt, s.provenance, s.observedAt, runId);
    // The main limit has no bucket row (usage_samples_bucketed reads it as '').
    if (s.bucket) this.exec("insert into usage_sample_buckets (sample_id, bucket, label) values (?, ?, ?)", Number(res.lastInsertRowid), s.bucket, s.bucketLabel ?? null);
  }

  /** Samples of one window of one bucket, oldest first; with `resetsAt`, only the current window instance. */
  samples(profileId: string, window: LimitWindow, resetsAt: string | null, limit = 50, bucket: string | null = null): LimitSample[] {
    const rows = this.all<SampleRow>(
      `select * from (select * from usage_samples_bucketed where profile_id = ? and limit_window = ? and bucket = ? and (? is null or resets_at = ?) order by observed_at desc, id desc limit ?) order by observed_at`,
      profileId,
      window,
      bucket ?? "",
      resetsAt,
      resetsAt,
      limit,
    );
    return rows.map(toSample);
  }

  /** Latest sample per plan window and bucket of a profile; context and budget windows belong to runs and tasks. */
  private latestPlanWindows(profileId: string): SampleRow[] {
    return this.all<SampleRow>(
      `select * from (select s.*, row_number() over (partition by s.limit_window, s.bucket order by s.observed_at desc, s.id desc) as n
         from usage_samples_bucketed s where s.profile_id = ? and s.limit_window in ('5h', 'weekly', 'daily', 'monthly')) where n = 1`,
      profileId,
    );
  }

  /** Tightest plan window for a profile over every bucket, skipping windows that already reset. */
  headroom(profileId: string, now: Date): Headroom {
    let best: Headroom = { pct: null, window: null, provenance: "unknown" };
    for (const r of this.latestPlanWindows(profileId)) {
      if (r.used_pct === null || r.provenance === "unknown") continue;
      if (r.resets_at && Date.parse(r.resets_at) <= now.getTime()) continue;
      const pct = Math.max(0, 100 - r.used_pct);
      if (best.pct === null || pct < best.pct) best = { pct, window: r.limit_window, provenance: r.provenance };
    }
    return best;
  }

  /**
   * A plan window this profile has used up and that has not reset yet, by its latest sample, in any
   * bucket. A window without a known reset time is not reported: only trying again can tell.
   */
  reachedWindow(profileId: string, now: Date): { window: LimitWindow; resetsAt: string } | null {
    const hit = this.latestPlanWindows(profileId)
      .filter((r) => r.provenance !== "unknown" && (r.used_pct ?? 0) >= 100 && r.resets_at !== null && Date.parse(r.resets_at) > now.getTime())
      .sort((a, b) => b.resets_at!.localeCompare(a.resets_at!))[0];
    return hit ? { window: hit.limit_window, resetsAt: hit.resets_at! } : null;
  }

  /** Spend caps you approved going past for this run ("continue" on a budget request), and "unpriced" for spend without a price. */
  approvedCaps(runId: string): Set<string> {
    const rows = this.all<{ payload: string; answer: string | null }>("select payload, answer from requests where run_id = ? and kind = 'handoff' and answered_by = 'user'", runId);
    const out = new Set<string>();
    for (const r of rows) {
      const answer = json<RequestAnswer>(r.answer);
      const payload = JSON.parse(r.payload) as RequestPayload;
      if (answer?.kind !== "handoff" || answer.decision !== "continue" || payload.kind !== "handoff") continue;
      if (payload.cap) out.add(payload.cap.kind);
      if (payload.trigger === "unpriced") out.add("unpriced");
    }
    return out;
  }

  // ---- views ----

  facts(task: TaskRow, runs = this.runs(task.id)): TaskFacts {
    const crew = this.crew(task.id);
    const members = crew ? this.members(crew.id) : [];
    const open = new Set(this.all<{ run_id: string }>("select run_id from requests where task_id = ? and answered_at is null and run_id is not null", task.id).map((r) => r.run_id));
    const firstOpen = (runId: string) => (open.has(runId) ? (this.openRequestsForRun(runId)[0]?.id ?? null) : null);
    const openHandoff = this.one<{ id: string }>("select id from handoffs where task_id = ? and closed_at is null order by opened_at limit 1", task.id);
    const completed = (memberId: string) => runs.some((r) => r.member_id === memberId && r.end_reason === "completed");
    const writers = members.filter((m) => m.writes_code);
    return {
      kind: task.kind,
      crewApprovedAt: crew?.approved_at ?? null,
      cancelledAt: task.cancelled_at,
      openHandoffId: openHandoff?.id ?? null,
      implementationDone: writers.length > 0 && writers.every((m) => completed(m.id)),
      // PR facts are written by the GitHub work (table task_pulls); without one a finished code task reads "review".
      pullRequest: this.pullFact(task.id),
      runs: runs.map((r) => ({
        id: r.id,
        role: r.role,
        // A run superseded by a later run of the same step (resume, handoff) is no longer required.
        required: Boolean(members.find((m) => m.id === r.member_id)?.required ?? 1) && !runs.some((o) => o.resumed_from === r.id),
        startedAt: r.started_at,
        endedAt: r.ended_at,
        endReason: r.end_reason,
        pendingRequestId: firstOpen(r.id),
        limitReached: r.limit_reached === 1,
        // A run waiting for its own same-profile retry (resume_at on an ended run) is not failed yet.
        retryPending: runs.some((o) => o.resumed_from === r.id) || (r.ended_at !== null && r.resume_at !== null),
      })),
    };
  }

  private pullFact(taskId: string): TaskFacts["pullRequest"] {
    const row = this.one<{ state: string }>("select state from task_pulls where task_id = ?", taskId);
    if (!row) return null;
    return { state: row.state === "merged" ? "merged" : row.state === "closed" ? "closed" : "open" };
  }

  status(task: TaskRow): TaskStatus {
    return deriveTaskStatus(this.facts(task));
  }

  summary(task: TaskRow): TaskSummary {
    const runs = this.runs(task.id);
    const status = deriveTaskStatus(this.facts(task, runs));
    const openRequests = Number(this.one<{ n: number }>("select count(*) as n from requests where task_id = ? and answered_at is null", task.id)?.n ?? 0);
    const superseded = (r: RunRow) => runs.some((o) => o.resumed_from === r.id);
    return {
      id: task.id,
      projectId: task.project_id,
      title: task.title,
      kind: task.kind,
      size: task.size,
      status,
      fallback: task.fallback,
      budgetUsd: task.budget_usd,
      spend: this.spend(runs),
      createdAt: task.created_at,
      cancelledAt: task.cancelled_at,
      openRequests,
      activeRuns: runs.filter(isActive).length,
      resumableRunIds: task.cancelled_at ? [] : runs.filter((r) => r.end_reason !== null && RESUMABLE.includes(r.end_reason) && !superseded(r)).map((r) => r.id),
    };
  }

  spend(runs: RunRow[]): CostEstimate {
    // A run that has not used a token yet costs nothing; one with tokens but no price is Unknown.
    return sumEstimates(runs.map((r) => (r.tokens_in + r.tokens_out === 0 && r.cost_usd === null ? { usd: 0, provenance: "estimated" } : { usd: r.cost_usd, provenance: r.cost_provenance })));
  }

  detail(task: TaskRow, blocked: Map<string, Reason>): TaskDetail {
    const crew = this.crew(task.id);
    const wt = this.worktree(task.id);
    return {
      ...this.summary(task),
      description: task.description,
      baseBranch: task.base_branch,
      waitResetMinutes: task.wait_reset_minutes,
      classification: JSON.parse(task.classification) as Reason[],
      crew: crew ? this.crewView(crew, blocked) : null,
      runs: this.runs(task.id).map((r) => this.runView(r)),
      worktree: wt ? worktreeView(wt) : null,
      handoffs: this.handoffs(task.id).map(handoffView),
    };
  }

  crewView(crew: CrewRow, blocked: Map<string, Reason>): CrewView {
    return {
      id: crew.id,
      proposedAt: crew.proposed_at,
      approvedAt: crew.approved_at,
      estimate: { usd: crew.estimate_usd, provenance: crew.estimate_provenance },
      members: this.members(crew.id).map((m) => memberView(m, blocked.get(m.id) ?? null)),
    };
  }

  runView(r: RunRow): RunView {
    const pending = this.openRequestsForRun(r.id)[0] ?? null;
    const openHandoff = this.one<{ id: string }>("select id from handoffs where from_run_id = ? and closed_at is null", r.id);
    let state: RunView["state"];
    if (r.ended_at) state = "ended";
    else if (pending?.kind === "question") state = "waiting_input";
    else if (pending?.kind === "approval") state = "waiting_approval";
    else if (openHandoff) state = "handing_off";
    else if (r.limit_reached) state = "rate_limited";
    else if (r.paused_at) state = "paused";
    else state = r.last_state ?? "starting";
    return {
      id: r.id,
      taskId: r.task_id,
      memberId: r.member_id,
      role: r.role,
      profileId: r.profile_id,
      runner: r.runner,
      model: r.model,
      state,
      cwd: r.cwd,
      worktreeId: r.worktree_id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      endReason: r.end_reason,
      endDetail: r.end_detail,
      lastActivityAt: r.last_activity_at,
      pausedAt: r.paused_at,
      resumeAt: r.resume_at,
      limitReached: r.limit_reached === 1,
      pendingRequestId: pending?.id ?? null,
      handoffId: r.handoff_id,
      resumedFrom: r.resumed_from,
      nativeSessionId: r.native_session_id,
      queuedMessages: this.queued(r.member_id).length,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      cost: { usd: r.cost_usd, provenance: r.cost_provenance },
      plan: json(r.plan),
      diff: json(r.diff),
    };
  }

  requestView(q: RequestRow): RequestView {
    const t = this.task(q.task_id);
    return {
      id: q.id,
      taskId: q.task_id,
      projectId: t.project_id,
      runId: q.run_id,
      sessionId: q.run_id ? (this.one<{ s: string | null }>("select native_session_id as s from runs where id = ?", q.run_id)?.s ?? null) : null,
      kind: q.kind,
      risk: q.risk,
      payload: JSON.parse(q.payload) as RequestPayload,
      createdAt: q.created_at,
      answeredAt: q.answered_at,
      answer: json<RequestAnswer>(q.answer),
      answeredBy: q.answered_by,
    };
  }
}

export const memberView = (m: MemberRow, blockedBy: Reason | null): CrewMemberView => ({
  id: m.id,
  step: m.step,
  role: m.role,
  dependsOn: JSON.parse(m.depends_on) as string[],
  required: m.required === 1,
  writesCode: m.writes_code === 1,
  chosen: json<CandidateView>(m.chosen),
  standby: JSON.parse(m.standby) as CandidateView[],
  reasons: JSON.parse(m.reasons) as Reason[],
  edited: m.edited === 1,
  blockedBy,
});

export const worktreeView = (w: WorktreeRow): WorktreeView => ({
  id: w.id,
  path: w.path,
  branch: w.branch,
  baseSha: w.base_sha,
  ownerRunId: w.owner_run_id,
  createdAt: w.created_at,
});

export const handoffView = (h: HandoffRow): HandoffView => ({
  id: h.id,
  fromRunId: h.from_run_id,
  toRunId: h.to_run_id,
  targetProfileId: h.target_profile_id,
  mode: h.mode,
  kind: h.kind,
  trigger: h.trigger_kind,
  phase: h.phase,
  packagePath: h.package_path,
  checkpointSha: h.checkpoint_sha,
  openedAt: h.opened_at,
  closedAt: h.closed_at,
  outcome: h.outcome,
  detail: h.detail,
});
