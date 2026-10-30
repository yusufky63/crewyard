import type { DatabaseSync } from "node:sqlite";
import { ACTIVITY_PAGE, ACTIVITY_PREVIEW, type ActivityEventFilter, type ActivityFacets, type ActivityPage } from "@crewyard/core";

// The Activity drawer's change feed: the project's rows of the event log, newest first, paged on
// `seq` so a page never shifts while new events arrive. Read-only.

/** Streamed text arrives a few words per event; the feed leaves it out unless asked. */
export const STREAM_KINDS = ["run.message.delta", "run.thought.delta"];

/** Keys whose string value says the most about an event, best first. */
const READABLE = ["text", "prompt", "command", "title", "detail", "message", "error", "output", "reason", "path", "state", "status"];

/**
 * The most readable text of a payload: the first readable string found breadth-first, otherwise the
 * JSON itself. Returned as plain text; the window never renders it as markup.
 */
export function previewOf(payload: string, max = ACTIVITY_PREVIEW): string {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return cut(payload, max);
  }
  const queue: unknown[] = [value];
  while (queue.length) {
    const v = queue.shift();
    if (!v || typeof v !== "object") continue;
    const rec = v as Record<string, unknown>;
    for (const k of READABLE) {
      const s = rec[k];
      if (typeof s === "string" && s.trim()) return cut(s, max);
    }
    queue.push(...Object.values(rec).filter((x) => x && typeof x === "object"));
  }
  return cut(typeof value === "string" ? value : payload, max);
}

const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function listActivity(db: DatabaseSync, f: ActivityEventFilter & { before?: number | null; limit?: number; stream?: boolean }): ActivityPage {
  const limit = Math.max(1, Math.min(200, Math.floor(f.limit ?? ACTIVITY_PAGE)));
  const where = ["project_id = ?"];
  const args: Array<string | number> = [f.projectId];
  if (f.taskId) {
    where.push("task_id = ?");
    args.push(f.taskId);
  }
  if (f.runId) {
    where.push("run_id = ?");
    args.push(f.runId);
  }
  if (f.kind) {
    if (f.kind.endsWith(".")) {
      where.push("kind like ? escape '\\'");
      args.push(`${likeEscape(f.kind)}%`);
    } else {
      where.push("kind = ?");
      args.push(f.kind);
    }
  }
  // Asking for a streamed kind by name shows it; otherwise it would drown everything else.
  if (!f.stream && !(f.kind && STREAM_KINDS.includes(f.kind))) {
    where.push(`kind not in (${STREAM_KINDS.map(() => "?").join(", ")})`);
    args.push(...STREAM_KINDS);
  }
  if (f.before != null) {
    where.push("seq < ?");
    args.push(f.before);
  }
  const rows = db
    .prepare(`select seq, at, kind, source, task_id, run_id, payload from events where ${where.join(" and ")} order by seq desc limit ?`)
    .all(...args, limit + 1) as Array<{ seq: number; at: string; kind: string; source: string; task_id: string | null; run_id: string | null; payload: string }>;
  const page = rows.slice(0, limit);
  return {
    events: page.map((r) => ({ seq: Number(r.seq), at: r.at, kind: r.kind, source: r.source, taskId: r.task_id, runId: r.run_id, preview: previewOf(r.payload), size: r.payload.length })),
    older: rows.length > limit ? Number(page[page.length - 1]!.seq) : null,
  };
}

/** The stored payload, pretty-printed; scoped to the project so a seq from elsewhere reads nothing. */
export function activityEvent(db: DatabaseSync, projectId: string, seq: number): { seq: number; text: string } {
  const row = db.prepare("select payload from events where seq = ? and project_id = ?").get(seq, projectId) as { payload: string } | undefined;
  if (!row) throw new Error("activity.not_found");
  let text = row.payload;
  try {
    text = JSON.stringify(JSON.parse(row.payload), null, 2);
  } catch {
    // stored as text already
  }
  return { seq, text };
}

export function activityFacets(db: DatabaseSync, projectId: string): ActivityFacets {
  const kinds = db.prepare("select kind, count(*) as n from events where project_id = ? group by kind order by n desc, kind").all(projectId) as Array<{ kind: string; n: number }>;
  const runs = db
    .prepare(
      `select r.id, r.task_id, r.role, r.runner, r.started_at from runs r join tasks t on t.id = r.task_id
       where t.project_id = ? and exists (select 1 from events e where e.run_id = r.id) order by r.started_at desc limit 200`,
    )
    .all(projectId) as Array<{ id: string; task_id: string; role: string; runner: string; started_at: string }>;
  return {
    kinds: kinds.map((k) => ({ kind: k.kind, count: Number(k.n) })),
    runs: runs.map((r) => ({ runId: r.id, taskId: r.task_id, role: r.role, runner: r.runner, startedAt: r.started_at })),
  };
}
