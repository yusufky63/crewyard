import type { DatabaseSync } from "node:sqlite";
import { PROBLEMS_PER_SOURCE, type FailedEventSource, type FailedRunSource, type FailingCheckSource, type ProblemSources, type ProblemsIpc } from "@crewyard/core";
import { previewOf } from "../activity/events.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// The Problems tab's own sources (packages/core/src/ipc/problems.ts). Facts only, read from the
// tables that already hold them; nothing here writes or decides.

const PREVIEW = 300;

/** Steps whose newest run failed, in tasks you did not stop; a retry or handoff that started since clears it. */
export function failedRuns(db: DatabaseSync, projectId: string): FailedRunSource[] {
  return db
    .prepare(
      `select r.id as runId, r.task_id as taskId, t.title as taskTitle, r.member_id as memberId, r.role, r.runner, r.ended_at as endedAt, r.end_detail as detail
       from runs r join tasks t on t.id = r.task_id
       where t.project_id = ? and t.cancelled_at is null and r.end_reason = 'failed' and r.ended_at is not null
         and not exists (select 1 from runs n where n.member_id = r.member_id and n.started_at > r.started_at)
       order by r.ended_at desc limit ?`,
    )
    .all(projectId, PROBLEMS_PER_SOURCE) as unknown as FailedRunSource[];
}

/** Audit events whose kind ends in `failed`, newest first. */
export function failedEvents(db: DatabaseSync, projectId: string): FailedEventSource[] {
  const rows = db
    .prepare(
      `select e.seq, e.at, e.kind, e.task_id as taskId, t.title as taskTitle, e.run_id as runId, e.payload
       from events e left join tasks t on t.id = e.task_id
       where (e.project_id = ? or t.project_id = ?) and (e.kind like '%.failed' or e.kind like '%\\_failed' escape '\\')
       order by e.seq desc limit ?`,
    )
    .all(projectId, projectId, PROBLEMS_PER_SOURCE) as Array<Omit<FailedEventSource, "preview"> & { payload: string }>;
  return rows.map(({ payload, ...r }) => ({ ...r, seq: Number(r.seq), preview: previewOf(payload, PREVIEW) }));
}

/** Failing checks and statuses on the current head of each open task pull request. */
export function failingChecks(db: DatabaseSync, projectId: string): FailingCheckSource[] {
  return db
    .prepare(
      `select f.id as feedbackId, f.task_id as taskId, t.title as taskTitle, p.number as pr, f.source as name, f.excerpt, f.url, f.observed_at as observedAt, p.head_sha as headSha
       from pull_feedback f join task_pulls p on p.task_id = f.task_id join tasks t on t.id = f.task_id
       where p.project_id = ? and p.state = 'open' and f.kind = 'check'
         and (substr(f.dedupe_key, 1, length('check:' || p.head_sha || ':')) = 'check:' || p.head_sha || ':'
           or substr(f.dedupe_key, 1, length('status:' || p.head_sha || ':')) = 'status:' || p.head_sha || ':')
       order by f.observed_at desc limit ?`,
    )
    .all(projectId, PROBLEMS_PER_SOURCE) as unknown as FailingCheckSource[];
}

export function problemSources(db: DatabaseSync, projectId: string): ProblemSources {
  return { failedRuns: failedRuns(db, projectId), failedEvents: failedEvents(db, projectId), failingChecks: failingChecks(db, projectId) };
}

export function createProblemsHandlers(ctx: HandlerContext): HandlerMap<ProblemsIpc> {
  return {
    "problems.sources": ({ projectId }) => problemSources(ctx.store.db, projectId),
  };
}
