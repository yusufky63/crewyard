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

/**
 * Caps a credential has reached for this task, daily first. A credential the ledger does not know
 * (removed since the crew was proposed) has no caps to enforce.
 */
export function reachedCaps(db: DatabaseSync, credentialId: string | null, taskId: string, now: Date): SpendCap[] {
  if (!credentialId) return [];
  let check: ReturnType<typeof checkBudget>;
  try {
    check = checkBudget(db, credentialId, taskId, ANY_SPEND, now);
  } catch {
    return [];
  }
  const out: SpendCap[] = [];
  const { dailyUsd, taskUsd } = check.caps;
  if (dailyUsd !== null && check.todayUsd + ANY_SPEND > dailyUsd) out.push({ kind: "daily_cap", spentUsd: check.todayUsd, capUsd: dailyUsd, credentialId });
  if (taskUsd !== null && check.taskUsd !== null && check.taskUsd + ANY_SPEND > taskUsd) out.push({ kind: "task_cap", spentUsd: check.taskUsd, capUsd: taskUsd, credentialId });
  return out;
}

export const capWindow = (cap: SpendCap): LimitWindow => (cap.kind === "daily_cap" ? "budget-day" : "budget-task");

/** A daily cap resets at local midnight, which makes "wait for reset" possible for it. */
export function capResetsAt(cap: SpendCap, now: Date): string | null {
  if (cap.kind !== "daily_cap") return null;
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}
