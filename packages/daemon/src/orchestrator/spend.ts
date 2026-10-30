import type { DatabaseSync } from "node:sqlite";
import type { LimitWindow, SpendCap } from "@crewyard/core";
import { checkBudget, recordSpend } from "../providers/ledger.ts";
import type { Candidate } from "./directory.ts";

// The orchestrator's side of the spend ledger (PLAN.md §7.3, AGENTS.md "paid spend past a cap
// always goes through a user approval"): every usage delta on an API key becomes a spend row, and
// the key's daily and per-task caps are checked before a run starts and after every update.

/** Any further spend counts, so a cap that is exactly used up already holds a new run back. */
const ANY_SPEND = 1e-9;

export interface SpendDelta {
  taskId: string;
  runId: string;
  profileId: string;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  tokensCache: number;
  tokensReasoning: number;
  costUsd: number;
  /** True when the runner's figure came from the provider's bill rather than a price table. */
  billed: boolean;
  /** True when we priced the tokens from the catalog ourselves. */
  fromCatalog: boolean;
}

/** The credential a candidate spends on, or null for plans, local models and unknown keys. */
export const spendCredential = (c: Candidate | undefined): string | null => (c && c.profile.credential.kind === "api_key" ? (c.credentialId ?? null) : null);

/** Writes one usage delta to the ledger; nothing is written for a free or empty delta. */
export function recordRunSpend(db: DatabaseSync, c: Candidate, d: SpendDelta, at: Date): boolean {
  const credentialId = spendCredential(c);
  if (!credentialId) return false;
  if (d.costUsd <= 0 && d.tokensIn + d.tokensOut + d.tokensCache === 0) return false;
  recordSpend(
    db,
    {
      credentialId,
      profileId: d.profileId,
      taskId: d.taskId,
      runId: d.runId,
      providerId: c.profile.providerId,
      model: d.model,
      tokensIn: d.tokensIn,
      tokensOut: d.tokensOut,
      tokensCache: d.tokensCache,
      tokensReasoning: d.tokensReasoning,
      costUsd: Math.max(0, d.costUsd),
      source: d.billed ? "billed" : "estimated",
      catalogVersion: d.fromCatalog ? (c.catalogVersion ?? null) : null,
    },
    at,
  );
  return true;
}

export interface CapCheck {
  /** Spend about to be committed, e.g. a step's estimate before it starts. */
  addUsd?: number;
  /** The run being checked; its own reservation is not held against itself. */
  excludeRunId?: string | null;
}

const r6 = (x: number) => Math.round(x * 1_000_000) / 1_000_000;

/**
 * Whether committed spend passes a cap. Committed is the ledger plus what unfinished runs still
 * hold. A scope already used up holds back any further spend; otherwise `add` must fit in what is left.
 */
export function overCap(spentUsd: number, reservedUsd: number, addUsd: number, capUsd: number): boolean {
  return r6(spentUsd + reservedUsd) >= r6(capUsd) || r6(spentUsd + reservedUsd + addUsd) > r6(capUsd);
}

function capOf(kind: SpendCap["kind"], spentUsd: number, capUsd: number, credentialId: string | null, reservedUsd: number, addUsd: number): SpendCap {
  return { kind, spentUsd, capUsd, credentialId, ...(reservedUsd > 0 ? { reservedUsd: r6(reservedUsd) } : {}), ...(addUsd > 0 ? { estimateUsd: r6(addUsd) } : {}) };
}

/**
 * Caps a credential has reached for this task, daily first, counting the reservations of other
 * unfinished runs (feature scan F3). A credential the ledger does not know (removed since the crew
 * was proposed) has no caps to enforce.
 */
export function reachedCaps(db: DatabaseSync, credentialId: string | null, taskId: string, now: Date, opts: CapCheck = {}): SpendCap[] {
  if (!credentialId) return [];
  let check: ReturnType<typeof checkBudget>;
  try {
    check = checkBudget(db, credentialId, taskId, ANY_SPEND, now);
  } catch {
    return [];
  }
  const add = Math.max(0, opts.addUsd ?? 0);
  const out: SpendCap[] = [];
  const { dailyUsd, taskUsd } = check.caps;
  if (dailyUsd !== null) {
    const held = reservedUsd(db, { credentialId, excludeRunId: opts.excludeRunId ?? null });
    if (overCap(check.todayUsd, held, add, dailyUsd)) out.push(capOf("daily_cap", check.todayUsd, dailyUsd, credentialId, held, add));
  }
  if (taskUsd !== null && check.taskUsd !== null) {
    const held = reservedUsd(db, { credentialId, taskId, excludeRunId: opts.excludeRunId ?? null });
    if (overCap(check.taskUsd, held, add, taskUsd)) out.push(capOf("task_cap", check.taskUsd, taskUsd, credentialId, held, add));
  }
  return out;
}

/** A credential's caps, or null when the ledger does not know it. */
export function credentialCaps(db: DatabaseSync, credentialId: string | null): { dailyUsd: number | null; taskUsd: number | null } | null {
  if (!credentialId) return null;
  const row = db.prepare("select daily_cap_usd as d, task_cap_usd as t from credentials where id = ?").get(credentialId) as { d: number | null; t: number | null } | undefined;
  return row ? { dailyUsd: row.d, taskUsd: row.t } : null;
}

// ---------------------------------------------------------------- reservations (feature scan F3)
// Parallel steps (Test || Review) could each pass the cap check alone and overshoot together. So a
// paid run holds its estimate before it starts; what it still holds is the estimate minus what it
// has spent, never below zero. The hold ends when the run ends and settles to its actual spend.
// Estimates constrain admission only; they never cap a provider's bill, the per-update check does.

export interface Reservation {
  runId: string;
  taskId: string;
  credentialId: string | null;
  amountUsd: number;
}

/** Holds a run's estimate; a second call for the same run keeps the first hold. */
export function reserveSpend(db: DatabaseSync, r: Reservation, at: Date): void {
  db.prepare("insert or ignore into spend_reservations (run_id, task_id, credential_id, amount_usd, created_at) values (?, ?, ?, ?, ?)").run(
    r.runId,
    r.taskId,
    r.credentialId,
    r6(Math.max(0, r.amountUsd)),
    at.toISOString(),
  );
}

/** Ends a run's hold and records what it really spent; a no-op for a run without one. */
export function settleReservation(db: DatabaseSync, runId: string, at: Date): void {
  db.prepare(
    "update spend_reservations set settled_at = ?, actual_usd = (select coalesce(sum(cost_usd), 0) from spend where run_id = ?) where run_id = ? and settled_at is null",
  ).run(at.toISOString(), runId, runId);
}

/** What unfinished runs still hold, by credential and/or task, leaving one run out. */
export function reservedUsd(db: DatabaseSync, scope: { credentialId?: string | null; taskId?: string | null; excludeRunId?: string | null }): number {
  const row = db
    .prepare(
      `select coalesce(sum(max(0, r.amount_usd - coalesce((select sum(s.cost_usd) from spend s where s.run_id = r.run_id), 0))), 0) as usd
         from spend_reservations r
        where r.settled_at is null
          and (?1 is null or r.credential_id = ?1)
          and (?2 is null or r.task_id = ?2)
          and r.run_id <> coalesce(?3, '')`,
    )
    .get(scope.credentialId ?? null, scope.taskId ?? null, scope.excludeRunId ?? null) as { usd: number };
  return row.usd;
}

export const capWindow = (cap: SpendCap): LimitWindow => (cap.kind === "daily_cap" ? "budget-day" : "budget-task");

/** A daily cap resets at local midnight, which makes "wait for reset" possible for it. */
export function capResetsAt(cap: SpendCap, now: Date): string | null {
  if (cap.kind !== "daily_cap") return null;
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}
