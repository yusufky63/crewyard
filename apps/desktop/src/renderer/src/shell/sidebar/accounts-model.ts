import type { AccountRow, LimitWindow, Provenance } from "@crewyard/core";

// What the accounts block draws under each account's name line (DESIGN.md §4). Only what the user
// added and what has something to compare against: a meter needs a window or a cap.

export type MeterLine =
  | { kind: "window"; key: string; window: LimitWindow | null; bucket: string | null; bucketLabel: string | null; pct: number | null; resetsAt: string | null; provenance: Provenance }
  | { kind: "cap"; key: "cap"; pct: number; capUsd: number; provenance: Provenance };

/** No accounts: the block is not drawn at all (the Start screen's checklist points to Providers). */
export const showAccounts = (rows: AccountRow[] | undefined): rows is AccountRow[] => rows !== undefined && rows.length > 0;

export function meterLines(row: AccountRow): MeterLine[] {
  if (row.kind === "local") return [];
  if (row.value.kind === "usd") {
    // A key without a cap: today's spend is the whole story, there is nothing to fill.
    if (row.value.capUsd === null) return [];
    const pct = row.pct ?? (row.value.capUsd === 0 ? 100 : Math.min(100, (row.value.usd / row.value.capUsd) * 100));
    return [{ kind: "cap", key: "cap", pct, capUsd: row.value.capUsd, provenance: row.provenance }];
  }
  // Nothing to measure until the profile can sign in; the name line says what is missing.
  if (row.signIn && (row.signIn.state === "signed_out" || row.signIn.state === "blocked")) return [];
  const meters = row.meters ?? (row.window && row.pct !== null ? [{ window: row.window, bucket: null, bucketLabel: null, pct: row.pct, resetsAt: row.resetsAt, provenance: row.provenance, observedAt: "" }] : []);
  const known = meters.filter((m) => m.pct !== null && m.provenance !== "unknown");
  const lines = known.map((m): MeterLine => ({ kind: "window", key: `${m.bucket ?? ""}|${m.window}`, window: m.window, bucket: m.bucket, bucketLabel: m.bucketLabel, pct: m.pct, resetsAt: m.resetsAt, provenance: m.provenance }));
  if (lines.length > 0) return lines;
  // Nothing known yet: one Unknown row for the account, never a row per window it might have.
  return [{ kind: "window", key: "unknown", window: meters[0]?.window ?? null, bucket: null, bucketLabel: null, pct: null, resetsAt: null, provenance: "unknown" }];
}
