import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { MAX_EVENT_JSON, utf8Length, type ProjectSummary } from "@crewyard/core";

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
  // Providers: last sign-in probe per profile that signs in on its own (PLAN.md §6). Only what the
  // UI shows: state, plan label, CLI version, a problem line and the probe time. Never a token or email.
  {
    id: "profile-signin",
    sql: `create table if not exists profile_signin (
     profile_id text primary key references profiles(id) on delete cascade,
     state text not null,
     plan text,
     cli_version text,
     problem text,
     update_min text,
     update_command text,
     probed_at text not null
   );`,
  },
  // GitHub pull requests per task (PLAN.md §10, §13): facts GitHub reported, the feedback routed
  // to the owning run (deduplicated by key), and the per-project routing opt-in.
  {
    id: "github-pulls",
    sql: `create table if not exists task_pulls (
     task_id text primary key references tasks(id),
     project_id text not null references projects(id),
     number integer not null,
     url text not null,
     head text not null,
     base text not null,
     head_sha text not null,
     state text not null,
     origin text not null,
     created_at text not null,
     merged_at text,
     merged_sha text,
     synced_at text not null,
     worktree_removed_at text
   );
   create index if not exists task_pulls_project on task_pulls(project_id, number);
   create table if not exists pull_feedback (
     id text primary key,
     task_id text not null references tasks(id),
     dedupe_key text not null,
     kind text not null,
     source text not null,
     excerpt text not null,
     url text,
     path text,
     line integer,
     observed_at text not null,
     state text not null,
     run_id text,
     sent_at text,
     unique (task_id, dedupe_key)
   );
   create index if not exists pull_feedback_task on pull_feedback(task_id, observed_at);
   create table if not exists github_projects (
     project_id text primary key references projects(id),
     route_feedback integer not null default 0
   );`,
  },
  // Worktree bootstrap (feature scan A1): setup and cleanup commands approved by the sha256 of
  // their exact text, and per task worktree its port, setup state, last failure and park record.
  {
    id: "worktree-bootstrap",
    sql: `create table if not exists bootstrap_approvals (
     project_id text not null references projects(id),
     hash text not null,
     phase text not null,
     command text not null,
     approved_at text not null,
     primary key (project_id, hash)
   );
   create table if not exists worktree_bootstrap (
     task_id text primary key references tasks(id),
     state text not null,
     port integer,
     setup_hash text,
     failure text,
     parked_at text,
     parked_sha text,
     updated_at text not null
   );`,
  },
  // Orchestrator safety (feature scan F3, F8): each paid run's estimate is held against its key's
  // caps until the run ends and settles to what it spent, and same-profile retries after a
  // transient error are recorded so a step stops retrying on its own after a few.
  {
    id: "orchestrator-safety",
    sql: `create table if not exists spend_reservations (
     run_id text primary key,
     task_id text not null,
     credential_id text,
     amount_usd real not null,
     created_at text not null,
     settled_at text,
     actual_usd real
   );
   create index if not exists spend_reservations_open on spend_reservations(settled_at, credential_id, task_id);
   create table if not exists run_retries (
     run_id text primary key,
     from_run_id text not null,
     attempt integer not null,
     failure text not null,
     status integer,
     delay_ms integer not null,
     created_at text not null
   );`,
  },
  // Diff review drafts (line comments kept until the owning run accepted them) and the GitHub
  // issue a task was imported from.
  {
    id: "github-review",
    sql: `create table if not exists review_drafts (
     id text primary key,
     task_id text not null references tasks(id),
     dedupe_key text not null,
     path text not null,
     line integer not null,
     side text not null,
     body text not null,
     hunk text not null,
     created_at text not null,
     unique (task_id, dedupe_key)
   );
   create index if not exists review_drafts_task on review_drafts(task_id, created_at);
   create table if not exists task_issues (
     task_id text primary key references tasks(id),
     number integer not null,
     url text not null,
     title text not null,
     linked_at text not null
   );`,
  },
  // Limit buckets (PLAN.md §7.2): an account can have several limits with the same window (Codex
  // `rateLimitsByLimitId`, a coding plan's MCP quota). A side table rather than a new column, so
  // the migration stays idempotent (SQLite has no "add column if not exists"); samples without a
  // row are the account's main limit, bucket ''. Read through the view.
  {
    id: "limit-buckets",
    sql: `create table if not exists usage_sample_buckets (
     sample_id integer primary key references usage_samples(id) on delete cascade,
     bucket text not null,
     label text
   );
   create view if not exists usage_samples_bucketed as
     select s.*, coalesce(b.bucket, '') as bucket, b.label as bucket_label
       from usage_samples s left join usage_sample_buckets b on b.sample_id = s.id;`,
  },
  // Coding-plan quota (PLAN.md §6.1): the last answer per key, so "no coding plan" (pay as you go)
  // and a failed or changed response show as such instead of as an empty meter.
  {
    id: "plan-quota",
    sql: `create table if not exists plan_quota (
     credential_id text primary key references credentials(id) on delete cascade,
     state text not null,
     problem text,
     checked_at text not null
   );`,
  },
  // Key checks and model discovery (feature scan A6): the last answer per key, with the models the
  // provider listed and the last reachability check. Profile presets (A16) sit in a side table so
  // the migration stays idempotent; a profile without a row has no presets.
  {
    id: "key-checks-presets",
    sql: `create table if not exists key_checks (
     credential_id text primary key references credentials(id) on delete cascade,
     provider_id text not null,
     state text,
     reason text,
     status integer,
     endpoint text,
     models text not null default '[]',
     checked_at text,
     latency_ms integer,
     latency_class text,
     latency_status integer,
     latency_url text,
     latency_at text
   );
   create table if not exists profile_presets (
     profile_id text primary key references profiles(id) on delete cascade,
     note text,
     effort text,
     read_only integer not null default 0,
     model_slots text
   );`,
  },
  // Turn control (feature scan A7, A10, A13, A18). Side tables, as for limit buckets, so nothing
  // alters an existing table. Outbox rows without a queue row sort first, by creation time.
  {
    id: "turn-control",
    sql: `create table if not exists outbox_queue (
     outbox_id text primary key references outbox(id) on delete cascade,
     position real not null,
     edited_at text,
     steered_at text,
     kind text not null default 'user'
   );
   create table if not exists turns (
     id text primary key,
     run_id text not null references runs(id),
     task_id text not null references tasks(id),
     member_id text not null references crew_members(id),
     started_at text not null,
     ended_at text,
     worktree_path text,
     checkpoint_sha text,
     head_sha text,
     turn_ref text,
     undone_at text,
     backup_sha text
   );
   create index if not exists turns_member on turns(member_id, started_at);
   create table if not exists stall_alerts (
     id text primary key,
     rule text not null,
     subject text not null,
     project_id text not null,
     task_id text not null references tasks(id),
     run_id text,
     request_id text,
     minutes integer,
     count integer,
     detail text,
     created_at text not null,
     dismissed_at text,
     cleared_at text
   );
   create index if not exists stall_alerts_subject on stall_alerts(rule, subject, created_at);
   create table if not exists run_transcripts (
     run_id text primary key references runs(id),
     path text not null,
     source_bytes integer not null,
     copied_bytes integer not null,
     truncated integer not null default 0,
     copied_at text not null
   );`,
  },
  // Crew loops (feature scan A9, A11, A12) and handoff hardening. Side tables only: loop decisions,
  // test results, verdicts pinned to a commit, the detached review checkouts, run epochs that
  // fence a source after its handoff, and how each handoff stopped and continued its source.
  {
    id: "crew-loops",
    sql: `create table if not exists loop_decisions (
     id text primary key,
     task_id text not null references tasks(id),
     member_id text not null references crew_members(id),
     run_id text,
     iteration integer not null,
     max_iterations integer not null,
     kind text not null,
     reason text not null,
     at text not null
   );
   create index if not exists loop_decisions_task on loop_decisions(task_id, at);
   create table if not exists test_results (
     id text primary key,
     task_id text not null references tasks(id),
     member_id text not null references crew_members(id),
     run_id text not null,
     command text not null,
     exit_code integer,
     passed integer not null,
     tail text not null,
     tree_sha text,
     head_sha text,
     duration_ms integer not null,
     at text not null
   );
   create index if not exists test_results_member on test_results(member_id, at);
   create table if not exists review_verdicts (
     run_id text primary key,
     task_id text not null references tasks(id),
     member_id text not null references crew_members(id),
     verdict text not null,
     summary text not null,
     comments text not null,
     head_sha text,
     native integer not null default 0,
     at text not null
   );
   create index if not exists review_verdicts_task on review_verdicts(task_id, at);
   create table if not exists review_checkouts (
     run_id text primary key,
     task_id text not null references tasks(id),
     repo_path text not null,
     path text not null,
     sha text not null,
     created_at text not null,
     removed_at text
   );
   create table if not exists run_epochs (
     run_id text primary key,
     member_id text not null,
     epoch integer not null
   );
   create table if not exists step_epochs (
     member_id text primary key,
     epoch integer not null
   );
   create table if not exists handoff_extras (
     handoff_id text primary key,
     stop text not null default 'interrupt',
     forked integer not null default 0
   );`,
  },
  // MCP (docs/adr/0007): reports and follow-up proposals agents send through the report server,
  // the user's own stdio servers (secret env values live in DPAPI blobs, only their ids here), and
  // which servers each run was given.
  {
    id: "mcp",
    sql: `create table if not exists crew_reports (
     id text primary key,
     project_id text not null,
     task_id text not null references tasks(id),
     run_id text not null,
     member_id text not null,
     type text not null,
     text text not null,
     title text,
     artifacts text not null default '[]',
     created_at text not null,
     closed_at text,
     closed_by text,
     task_created text
   );
   create index if not exists crew_reports_task on crew_reports(task_id, created_at);
   create index if not exists crew_reports_open on crew_reports(project_id, closed_at);
   create index if not exists crew_reports_run on crew_reports(run_id, type);
   create table if not exists mcp_servers (
     id text primary key,
     scope text not null,
     project_id text,
     name text not null,
     command text not null,
     args text not null default '[]',
     enabled integer not null default 1,
     read_only_access text not null default 'marked',
     tools text,
     checked_at text,
     check_error text,
     created_at text not null,
     updated_at text not null
   );
   create unique index if not exists mcp_servers_name on mcp_servers(scope, coalesce(project_id, ''), name);
   create table if not exists mcp_server_env (
     server_id text not null references mcp_servers(id) on delete cascade,
     name text not null,
     secret integer not null,
     value text,
     secret_id text,
     primary key (server_id, name)
   );
   create table if not exists mcp_run_servers (
     run_id text primary key,
     task_id text not null,
     project_id text not null,
     servers text not null,
     skipped text not null default '[]',
     at text not null
   );
   create index if not exists mcp_run_servers_project on mcp_run_servers(project_id, at);`,
  },
  // Best of N (feature scan A8): the implement step of a task as 2 to 4 variants. Each variant is
  // a hidden task of its own (its own crew of one, worktree, bootstrap and loops); the kept one's
  // worktree moves to the parent task, and the others are stopped and parked.
  {
    id: "best-of",
    sql: `create table if not exists best_of_groups (
     id text primary key,
     task_id text not null unique references tasks(id),
     member_id text not null references crew_members(id),
     started_at text,
     kept_variant_id text,
     kept_at text
   );
   create table if not exists best_of_variants (
     id text primary key,
     group_id text not null references best_of_groups(id),
     position integer not null,
     candidate text not null,
     task_id text unique references tasks(id),
     outcome text,
     diff_stat text,
     parked_at text,
     park_error text
   );
   create index if not exists best_of_variants_group on best_of_variants(group_id, position);`,
  },
  // Scheduled tasks: templates that propose a task on a daily or weekly slot, with an optional
  // precheck command whose exit code gates the run. The daemon's own timer reads these.
  {
    id: "schedules",
    sql: `create table if not exists schedules (
     id text primary key,
     project_id text not null references projects(id),
     title text not null,
     description text not null,
     kind text,
     size text,
     fallback text,
     budget_usd real,
     best_of integer,
     cadence text not null,
     time text not null,
     weekday integer,
     time_zone text not null,
     precheck text,
     precheck_timeout_sec integer not null default 60,
     auto_approve integer not null default 0,
     enabled integer not null default 0,
     cursor_at text,
     created_at text not null,
     updated_at text not null
   );
   create index if not exists schedules_project on schedules(project_id);
   create table if not exists schedule_runs (
     id text primary key,
     schedule_id text not null references schedules(id) on delete cascade,
     slot_at text,
     started_at text not null,
     finished_at text,
     outcome text not null,
     precheck_exit integer,
     precheck_tail text,
     task_id text references tasks(id),
     count integer not null default 1,
     detail text,
     manual integer not null default 0
   );
   create index if not exists schedule_runs_schedule on schedule_runs(schedule_id, started_at);
   create index if not exists schedule_runs_task on schedule_runs(task_id);`,
  },
  // Hibernation: an idle run whose process was stopped to free memory and its admission slot. The
  // run stays open; a row without woke_at means it is asleep now.
  {
    id: "hibernation",
    sql: `create table if not exists run_hibernation (
     id text primary key,
     run_id text not null references runs(id),
     hibernated_at text not null,
     idle_since text not null,
     request_id text,
     approved_call text,
     approved_until text,
     woke_at text,
     woke_by text
   );
   create index if not exists run_hibernation_run on run_hibernation(run_id, hibernated_at);`,
  },
  // The reasoning total last seen per native session, so the ledger records its growth like the
  // other counts instead of the running total on every report. A table of its own: SQLite has no
  // idempotent `add column`, and every migration here must be safe to run twice.
  {
    id: "native-usage-reasoning",
    sql: `create table if not exists native_usage_reasoning (
     runner text not null,
     session_id text not null,
     reasoning integer not null,
     primary key (runner, session_id)
   );`,
  },
  // The server-side web search and fetch totals last seen per native session, so a run is charged
  // only for the requests it added (DeepSeek bills them per request). Its own table for the same
  // reason as native_usage_reasoning.
  {
    id: "native-usage-requests",
    sql: `create table if not exists native_usage_requests (
     runner text not null,
     session_id text not null,
     web_search integer not null,
     web_fetch integer not null,
     primary key (runner, session_id)
   );`,
  },
  // Automatic switches to another account of the same provider (docs/adr/0009), and the tasks that
  // hold themselves out of them. `from_account` is the account the step left (a credential id or a
  // profile id), so a step never switches back to it.
  {
    id: "account-switch",
    sql: `create table if not exists account_switches (
     id text primary key,
     task_id text not null references tasks(id),
     member_id text not null,
     from_run_id text not null references runs(id),
     handoff_id text,
     runner text not null,
     provider_id text not null,
     from_profile_id text not null,
     from_alias text not null,
     from_account text not null,
     to_profile_id text not null,
     to_alias text not null,
     trigger_kind text not null,
     source text not null,
     headroom text not null,
     estimate text not null,
     skipped text not null,
     created_at text not null,
     dismissed_at text
   );
   create index if not exists account_switches_task on account_switches(task_id, created_at);
   create index if not exists account_switches_member on account_switches(member_id);
   create table if not exists task_account_switch (
     task_id text primary key references tasks(id),
     enabled integer not null,
     updated_at text not null
   );`,
  },
  // "Send failing checks to the agent" (PLAN.md §10): the check run a check feedback item came
  // from, so a manual send skips exactly the runs already sent for a head and a re-run is new. A
  // table of its own for the same reason as native_usage_reasoning.
  {
    id: "pull-feedback-check-run",
    sql: `create table if not exists pull_feedback_runs (
     feedback_id text primary key references pull_feedback(id),
     check_run_id integer not null
   );`,
  },
  // The role a crew member was proposed with when it came from a role file (PLAN.md §9.1): the
  // resolved template as JSON, so what you approved is what runs even if the file changes later.
  // Plain built-in roles have no row.
  {
    id: "role-snapshots",
    sql: `create table if not exists crew_member_roles (
     member_id text primary key references crew_members(id),
     template text not null,
     source text not null,
     path text
   );`,
  },
];

/** What the positional scheme applied: a database at `user_version` N has the first N of these. */
const LEGACY_IDS = ["core", "providers", "orchestrator"];

/**
 * The migration ids a database has, under either scheme: the `applied_migrations` records, or for
 * a database from the positional scheme, the first `user_version` legacy ids. Restore uses it to
 * tell a Crewyard database, and one from a newer build, from anything else.
 */
export function appliedMigrationIds(db: DatabaseSync): string[] {
  const table = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'applied_migrations'").get();
  if (table) return (db.prepare("select id from applied_migrations order by rowid").all() as Array<{ id: string }>).map((r) => r.id);
  const version = Number((db.prepare("pragma user_version").get() as { user_version: number }).user_version);
  return LEGACY_IDS.slice(0, version);
}

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

  /**
   * Appends an event; a repeated dedupe key is ignored so replays never double-count. A payload
   * past MAX_EVENT_JSON is stored as a marker only: one runaway event must not bloat the log or
   * every later read of it. Agent events are capped field by field before they get here.
   */
  appendEvent(e: EventInput): number | null {
    let payload = JSON.stringify(e.payload) ?? "null";
    if (payload.length > MAX_EVENT_JSON / 3 && utf8Length(payload) > MAX_EVENT_JSON) payload = JSON.stringify({ truncated: true, bytes: utf8Length(payload) });
    const res = this.db
      .prepare("insert or ignore into events (at, project_id, task_id, run_id, kind, source, payload, dedupe_key) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), e.projectId ?? null, e.taskId ?? null, e.runId ?? null, e.kind, e.source, payload, e.dedupeKey ?? null);
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
