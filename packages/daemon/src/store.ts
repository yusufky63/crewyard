import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ProjectSummary } from "@crewyard/core";

// SQLite through node:sqlite (built into Node 24 and Electron 45), so there is no native module to
// rebuild on Windows. Facts and an append-only event log; status is derived elsewhere (PLAN.md D5).

const MIGRATIONS: string[] = [
  `create table projects (
     id text primary key,
     name text not null,
     path text not null unique collate nocase,
     added_at text not null,
     last_opened_at text
   );
   create table events (
     seq integer primary key autoincrement,
     at text not null,
     project_id text,
     task_id text,
     run_id text,
     kind text not null,
     source text not null,
     payload text not null,
     dedupe_key text unique
   );
   create index events_run on events(run_id, seq);
   create table settings (key text primary key, value text not null);`,
];

export interface EventInput {
  kind: string;
  source: string;
  payload: unknown;
  projectId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  dedupeKey?: string | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const current = Number((this.db.prepare("pragma user_version").get() as { user_version: number }).user_version);
    MIGRATIONS.slice(current).forEach((sql, i) => {
      this.db.exec("begin");
      try {
        this.db.exec(sql);
        this.db.exec(`pragma user_version = ${current + i + 1}`);
        this.db.exec("commit");
      } catch (err) {
        this.db.exec("rollback");
        throw err;
      }
    });
  }

  /** Appends an event; a repeated dedupe key is ignored so replays never double-count. */
  appendEvent(e: EventInput): number | null {
    const res = this.db
      .prepare("insert or ignore into events (at, project_id, task_id, run_id, kind, source, payload, dedupe_key) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), e.projectId ?? null, e.taskId ?? null, e.runId ?? null, e.kind, e.source, JSON.stringify(e.payload), e.dedupeKey ?? null);
    return res.changes ? Number(res.lastInsertRowid) : null;
  }

  eventsSince(seq: number, limit = 500): Array<{ seq: number; kind: string; payload: unknown }> {
    return (this.db.prepare("select seq, kind, payload from events where seq > ? order by seq limit ?").all(seq, limit) as Array<{ seq: number; kind: string; payload: string }>).map((r) => ({
      seq: Number(r.seq),
      kind: r.kind,
      payload: JSON.parse(r.payload),
    }));
  }

  addProject(path: string, name: string): ProjectSummary {
    const existing = this.db.prepare("select id, name, path, last_opened_at from projects where path = ?").get(path) as Row | undefined;
    if (existing) return toSummary(existing);
    const id = randomUUID();
    this.db.prepare("insert into projects (id, name, path, added_at) values (?, ?, ?, ?)").run(id, name, path, new Date().toISOString());
    this.appendEvent({ kind: "project.added", source: "daemon", payload: { id, name, path }, projectId: id });
    return { id, name, path, lastOpenedAt: null };
  }

  listProjects(): ProjectSummary[] {
    return (this.db.prepare("select id, name, path, last_opened_at from projects order by coalesce(last_opened_at, added_at) desc").all() as unknown as Row[]).map(toSummary);
  }

  knownPaths(): Set<string> {
    return new Set((this.db.prepare("select path from projects").all() as Array<{ path: string }>).map((r) => r.path.toLowerCase()));
  }

  markOpened(projectId: string): ProjectSummary {
    const now = new Date().toISOString();
    const res = this.db.prepare("update projects set last_opened_at = ? where id = ?").run(now, projectId);
    if (!res.changes) throw new Error(`Unknown project: ${projectId}`);
    const row = this.db.prepare("select id, name, path, last_opened_at from projects where id = ?").get(projectId) as unknown as Row;
    return toSummary(row);
  }

  close(): void {
    this.db.close();
  }
}

interface Row {
  id: string;
  name: string;
  path: string;
  last_opened_at: string | null;
}

const toSummary = (r: Row): ProjectSummary => ({ id: r.id, name: r.name, path: r.path, lastOpenedAt: r.last_opened_at });
