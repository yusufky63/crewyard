import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_THRESHOLDS, type LimitWindow, type Provenance, type SpendEntry, type SpendSlice, type SpendSummary, type Thresholds, type UsageWindowView } from "@crewyard/core";

// Spend ledger, budget caps and plan-window samples. The orchestrator writes spend through
// recordSpend() and asks checkBudget() before it lets a paid run continue (PLAN.md §7.3).

export const startOfLocalDay = (now: Date): string => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

export function recordSpend(db: DatabaseSync, e: SpendEntry, at = new Date()): number {
  if (!Number.isFinite(e.costUsd) || e.costUsd < 0) throw new Error("Spend must be a non-negative amount");
  const res = db
    .prepare(
      `insert into spend (at, credential_id, profile_id, task_id, run_id, provider_id, model, tokens_in, tokens_out, tokens_cache, tokens_reasoning, cost_usd, source, catalog_version)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(at.toISOString(), e.credentialId, e.profileId, e.taskId, e.runId, e.providerId, e.model, e.tokensIn, e.tokensOut, e.tokensCache, e.tokensReasoning, e.costUsd, e.source, e.catalogVersion);
  return Number(res.lastInsertRowid);
}

/** "billed" rows only → reported; any estimated row makes the sum estimated; nothing → estimated zero. */
const provenanceOf = (sources: string | null): Provenance => (sources === "billed" ? "reported" : "estimated");

export function spentToday(db: DatabaseSync, credentialId: string, now = new Date()): number {
  const row = db.prepare("select coalesce(sum(cost_usd), 0) as usd from spend where credential_id = ? and at >= ?").get(credentialId, startOfLocalDay(now)) as { usd: number };
  return row.usd;
}

export function spentOnTask(db: DatabaseSync, credentialId: string, taskId: string): number {
  const row = db.prepare("select coalesce(sum(cost_usd), 0) as usd from spend where credential_id = ? and task_id = ?").get(credentialId, taskId) as { usd: number };
  return row.usd;
}

export interface BudgetCheck {
  ok: boolean;
  /** Which cap would be passed; the run must pause and ask (PLAN.md §7.3). */
  reason: "daily_cap" | "task_cap" | null;
  todayUsd: number;
  taskUsd: number | null;
  caps: { dailyUsd: number | null; taskUsd: number | null };
}

/** Whether spending `addUsd` more keeps the credential inside its daily and per-task caps. */
export function checkBudget(db: DatabaseSync, credentialId: string, taskId: string | null, addUsd = 0, now = new Date()): BudgetCheck {
  const caps = db.prepare("select daily_cap_usd as d, task_cap_usd as t from credentials where id = ?").get(credentialId) as { d: number | null; t: number | null } | undefined;
  if (!caps) throw new Error(`Unknown credential: ${credentialId}`);
  const todayUsd = spentToday(db, credentialId, now);
  const taskUsd = taskId ? spentOnTask(db, credentialId, taskId) : null;
  let reason: BudgetCheck["reason"] = null;
  if (caps.d !== null && todayUsd + addUsd > caps.d) reason = "daily_cap";
  else if (caps.t !== null && taskUsd !== null && taskUsd + addUsd > caps.t) reason = "task_cap";
  return { ok: reason === null, reason, todayUsd, taskUsd, caps: { dailyUsd: caps.d, taskUsd: caps.t } };
}

export function spendSummary(db: DatabaseSync, days: number, now = new Date()): SpendSummary {
  const span = Math.max(1, Math.min(365, Math.round(days)));
  const start = new Date(now);
  start.setDate(start.getDate() - (span - 1));
  const from = startOfLocalDay(start);
  const slices = (sql: string, ...args: string[]): SpendSlice[] =>
    (db.prepare(sql).all(...args) as Array<{ key: string; usd: number; sources: string | null }>).map((r) => ({ key: r.key, usd: r.usd, provenance: provenanceOf(r.sources) }));
  const byProvider = slices(
    "select provider_id as key, sum(cost_usd) as usd, group_concat(distinct source) as sources from spend where at >= ? group by provider_id order by usd desc",
    from,
  );
  const todayByCredential = slices(
    "select credential_id as key, sum(cost_usd) as usd, group_concat(distinct source) as sources from spend where at >= ? and credential_id is not null group by credential_id",
    startOfLocalDay(now),
  );
  const totalUsd = byProvider.reduce((n, s) => n + s.usd, 0);
  const provenance: Provenance = byProvider.length > 0 && byProvider.every((s) => s.provenance === "reported") ? "reported" : "estimated";
  return { days: span, from, totalUsd, provenance, byProvider, todayByCredential };
}

// Alert thresholds live in the settings table; rearm stays 10 points under warn (PLAN.md §7.3).
export function getThresholds(db: DatabaseSync): Thresholds {
  const row = db.prepare("select value from settings where key = 'limits.thresholds'").get() as { value: string } | undefined;
  if (!row) return DEFAULT_THRESHOLDS;
  try {
    const t = JSON.parse(row.value) as Thresholds;
    return Number.isFinite(t.warn) && Number.isFinite(t.critical) && Number.isFinite(t.rearm) ? t : DEFAULT_THRESHOLDS;
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

export function setThresholds(db: DatabaseSync, warn: number, critical: number): Thresholds {
  if (!Number.isInteger(warn) || !Number.isInteger(critical) || warn < 10 || critical > 100 || warn >= critical) {
    throw new Error("Thresholds must be whole percentages with 10 ≤ warn < critical ≤ 100");
  }
  const t: Thresholds = { warn, critical, rearm: warn - 10 };
  db.prepare("insert into settings (key, value) values ('limits.thresholds', ?) on conflict(key) do update set value = excluded.value").run(JSON.stringify(t));
  return t;
}

/** Background plan-window reads between runs; on unless switched off on the Limits screen. */
export function getIdleRefresh(db: DatabaseSync): boolean {
  const row = db.prepare("select value from settings where key = 'limits.idleRefresh'").get() as { value: string } | undefined;
  return row ? row.value !== "false" : true;
}

export function setIdleRefresh(db: DatabaseSync, enabled: boolean): boolean {
  db.prepare("insert into settings (key, value) values ('limits.idleRefresh', ?) on conflict(key) do update set value = excluded.value").run(enabled ? "true" : "false");
  return enabled;
}

// usage_samples is written by the orchestrator (PLAN.md §4.3, its migration in store.ts). If its
// columns ever differ from what we read, plan windows are reported as Unknown rather than guessed.
const SAMPLE_COLUMNS = ["id", "profile_id", "limit_window", "used_pct", "resets_at", "provenance", "observed_at"];

export function usageSamplesAvailable(db: DatabaseSync): boolean {
  const cols = (db.prepare("select name from pragma_table_info('usage_samples')").all() as Array<{ name: string }>).map((c) => c.name);
  return SAMPLE_COLUMNS.every((c) => cols.includes(c));
}

/** Latest sample per profile and window; same tie-break as the orchestrator (observed_at, then id). */
export function latestWindows(db: DatabaseSync): UsageWindowView[] {
  if (!usageSamplesAvailable(db)) return [];
  const rows = db
    .prepare(
      `select s.profile_id, s.limit_window, s.used_pct, s.resets_at, s.provenance, s.observed_at from usage_samples s
       where s.id = (select x.id from usage_samples x where x.profile_id = s.profile_id and x.limit_window = s.limit_window
                     order by x.observed_at desc, x.id desc limit 1)`,
    )
    .all() as Array<{ profile_id: string; limit_window: string; used_pct: number | null; resets_at: string | null; provenance: string; observed_at: string }>;
  return rows.map((r) => {
    const provenance: Provenance = r.provenance === "reported" || r.provenance === "estimated" ? r.provenance : "unknown";
    return {
      profileId: r.profile_id,
      window: r.limit_window as LimitWindow,
      usedPct: provenance === "unknown" ? null : r.used_pct,
      resetsAt: r.resets_at,
      provenance,
      observedAt: r.observed_at,
    };
  });
}
