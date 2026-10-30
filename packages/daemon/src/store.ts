import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ProjectSummary } from "@crewyard/core";

// SQLite through node:sqlite (built into Node 24 and Electron 45), so there is no native module to
// rebuild on Windows. Facts and an append-only event log; status is derived elsewhere (PLAN.md D5).

/**
 * Schema changes, applied once each and recorded by id in `applied_migrations`, so branches that
 * add migrations in parallel can merge in any order without a database skipping one
 * (agent-orchestrator #3476 lost a migration to positional versions). To add one, append
 * `{ id, sql }` with a new id; never edit or reorder an entry that has shipped. Entries after
 * LEGACY_IDS must be idempotent (`create ... if not exists`): a database from the positional
 * scheme may already have them without a record.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: "core",
    sql: `create table projects (
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
  },
  // Providers: catalog snapshots, credentials (keys live DPAPI-encrypted in files, never here),
  // profiles, last balance per credential and the spend ledger with its caps (PLAN.md §4.3, §6).
  {
    id: "providers",
    sql: `create table catalog_snapshots (
     hash text primary key,
     origin text not null,
     generated_at text not null,
     source_sha text not null,
     created_at text not null,
     body text not null
   );
   create table credentials (
     id text primary key,
     alias text not null unique collate nocase,
     provider_id text not null,
     kind text not null check (kind in ('api_key', 'local')),
     daily_cap_usd real,
     task_cap_usd real,
     created_at text not null
   );
   create table profiles (
     id text primary key,
     alias text not null,
     runner text not null,
     provider_id text not null,
     credential_id text references credentials(id) on delete restrict,
     default_model text,
     config_dir text not null,
     created_at text not null,
     updated_at text not null,
     unique (runner, alias collate nocase)
   );
   create table balances (
     credential_id text primary key references credentials(id) on delete cascade,
     provider_id text not null,
     wallets text not null,
     fetched_at text,
     error text
   );
   create table spend (
     id integer primary key autoincrement,
     at text not null,
     credential_id text,
     profile_id text,
     task_id text,
     run_id text,
     provider_id text not null,
     model text,
     tokens_in integer not null default 0,
     tokens_out integer not null default 0,
     tokens_cache integer not null default 0,
     tokens_reasoning integer not null default 0,
     cost_usd real not null,
     source text not null check (source in ('estimated', 'billed')),
     catalog_version text
   );
   create index spend_credential_at on spend(credential_id, at);
   create index spend_task on spend(task_id, credential_id);`,
  },
  // Orchestrator (PLAN.md §4.3): facts only; task and run status are derived on read.
  {
    id: "orchestrator",
    sql: `create table tasks (
     id text primary key,
     project_id text not null references projects(id),
     title text not null,
     description text not null,
     kind text not null,
     size text not null,
     base_branch text,
     fallback text not null,
     wait_reset_minutes integer not null,
     budget_usd real,
     classification text not null,
     created_at text not null,
     cancelled_at text
   );
   create index tasks_project on tasks(project_id, created_at);
   create table crews (
     id text primary key,
     task_id text not null unique references tasks(id),
     proposed_at text not null,
     approved_at text,
     estimate_usd real,
     estimate_provenance text not null
   );
   create table crew_members (
     id text primary key,
     crew_id text not null references crews(id),
     position integer not null,
     step text not null,
     role text not null,
     depends_on text not null,
     required integer not null,
     writes_code integer not null,
     chosen text,
     standby text not null,
     reasons text not null,
     edited integer not null default 0
   );
   create index crew_members_crew on crew_members(crew_id, position);
   create table worktrees (
     id text primary key,
     task_id text not null unique references tasks(id),
     repo_path text not null,
     path text not null,
     branch text not null,
     base_sha text not null,
     owner_run_id text,
     created_at text not null,
     last_heartbeat_at text
   );
   create table runs (
     id text primary key,
     task_id text not null references tasks(id),
     member_id text not null references crew_members(id),
     role text not null,
     profile_id text not null,
     runner text not null,
     model text,
     cwd text not null,
     worktree_id text references worktrees(id),
     native_session_id text,
     pid integer,
     resumed_from text,
     handoff_id text,
     started_at text not null,
     ended_at text,
     end_reason text,
     end_detail text,
     last_state text,
     last_activity_at text,
     paused_at text,
     resume_at text,
     limit_reached integer not null default 0,
     tokens_in integer not null default 0,
     tokens_out integer not null default 0,
     cost_usd real,
     cost_provenance text not null default 'unknown',
     plan text,
     diff text
   );
   create index runs_task on runs(task_id, started_at);
   create index runs_open on runs(ended_at);
   create table requests (
     id text primary key,
     task_id text not null references tasks(id),
     run_id text references runs(id),
     native_id text,
     kind text not null,
     risk text,
     payload text not null,
     created_at text not null,
     answered_at text,
     answer text,
     answered_by text
   );
   create index requests_open on requests(answered_at, task_id);
   create table usage_samples (
     id integer primary key autoincrement,
     profile_id text not null,
     limit_window text not null,
     used_pct real,
     resets_at text,
     provenance text not null,
     observed_at text not null,
     run_id text
   );
   create index usage_samples_profile on usage_samples(profile_id, limit_window, observed_at);
   create table handoffs (
     id text primary key,
     task_id text not null references tasks(id),
     from_run_id text not null references runs(id),
     to_run_id text,
     target_profile_id text,
     mode text not null,
     kind text,
     trigger_kind text not null,
     package_path text,
     checkpoint_sha text,
     phase text not null,
     opened_at text not null,
     closed_at text,
     outcome text,
     detail text
   );
   create index handoffs_task on handoffs(task_id, opened_at);
   create unique index handoffs_one_open on handoffs(from_run_id) where closed_at is null;
   create table outbox (
     id text primary key,
     task_id text not null references tasks(id),
     member_id text not null references crew_members(id),
     text text not null,
     created_at text not null,
     delivered_at text,
     delivered_run_id text
   );
   create index outbox_pending on outbox(member_id, delivered_at);
   create table native_usage (
     runner text not null,
     session_id text not null,
     tokens_in integer not null,
     tokens_out integer not null,
     cache_read integer not null,
     cost_usd real,
     updated_at text not null,
     primary key (runner, session_id)
   );
   create table allow_rules (
     project_id text not null references projects(id),
     command text not null,
     added_at text not null,
     primary key (project_id, command)
   );
   create table role_prefs (
     project_id text not null references projects(id),
     role text not null,
     profile_id text not null,
     weight integer not null,
     primary key (project_id, role, profile_id)
   );`,
  },
  // Recovery: which daemon process (pid, start time) was running when, so a run's agent process
  // can be matched to the daemon that spawned it after a crash (recovery/orphans.ts).
  {
    id: "daemon-sessions",
    sql: `create table if not exists daemon_sessions (
     pid integer not null,
     started_at text not null,
     primary key (started_at, pid)
   );`,
  },
];

/** What the positional scheme applied: a database at `user_version` N has the first N of these. */
const LEGACY_IDS = ["core", "providers", "orchestrator"];

/** Applies every migration whose id is not recorded yet, each in its own transaction; returns the ids it ran. */
export function applyMigrations(db: DatabaseSync, migrations: readonly Migration[]): string[] {
  const ids = migrations.map((m) => m.id);
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate migration id in ${ids.join(", ")}`);
  db.exec("create table if not exists applied_migrations (id text primary key, applied_at text not null)");
  const applied = new Set((db.prepare("select id from applied_migrations").all() as Array<{ id: string }>).map((r) => r.id));
  if (applied.size === 0) {
    // A database from before ids existed: trust user_version for the migrations it covered.
    const version = Number((db.prepare("pragma user_version").get() as { user_version: number }).user_version);
    const insert = db.prepare("insert into applied_migrations (id, applied_at) values (?, ?)");
    for (const id of LEGACY_IDS.slice(0, version)) {
      insert.run(id, "legacy");
      applied.add(id);
    }
  }
  const ran: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.exec("begin");
    try {
      db.exec(m.sql);
      db.prepare("insert into applied_migrations (id, applied_at) values (?, ?)").run(m.id, new Date().toISOString());
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
    ran.push(m.id);
  }
  return ran;
}

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
    applyMigrations(this.db, MIGRATIONS);
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
