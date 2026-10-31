import type { AccountMeter, AccountRow, LimitWindow, Provenance } from "@crewyard/core";

// What the accounts block draws (DESIGN.md §4). The sidebar is narrow, so only accounts in use get
// meters; the rest fold into one `+N not used` line. A meter row is label, meter, % and a one-letter
// provenance mark; reset times, ages and sources live in the row's hover and focus detail.

/** Short label of a meter row: a window (`5 h`, `weekly`), a bucket name, `cap`, or `quota` when unknown. */
export type ShortLabel = { kind: "window"; window: LimitWindow } | { kind: "bucket"; bucket: string; bucketLabel: string | null } | { kind: "cap" } | { kind: "quota" };

export interface MeterLine {
  key: string;
  label: ShortLabel;
  /** null draws the dashed Unknown meter and no percentage. */
  pct: number | null;
  provenance: Provenance;
}

/** What a one-line account shows where a meter would be. */
export type LineValue =
  | { kind: "pct"; pct: number; provenance: Provenance }
  | { kind: "usd"; usd: number; provenance: Provenance }
  | { kind: "signIn" }
  | { kind: "update" }
  | { kind: "local" }
  | { kind: "unknown" };

/** No accounts: the block is not drawn at all (the Start screen's checklist points to Providers). */
export const showAccounts = (rows: AccountRow[] | undefined): rows is AccountRow[] => rows !== undefined && rows.length > 0;

/** A profile that cannot be measured until it signs in, or until its CLI is updated. */
export function needsAction(row: AccountRow): "signIn" | "update" | null {
  if (row.signIn?.state === "signed_out") return "signIn";
  if (row.signIn?.state === "blocked") return "update";
  return null;
}

/** Every window and bucket the row has, falling back to its single worst window. */
export function allMeters(row: AccountRow): AccountMeter[] {
  if (row.meters && row.meters.length > 0) return row.meters;
  if (row.window && row.value.kind === "pct") return [{ window: row.window, bucket: null, bucketLabel: null, pct: row.value.pct, resetsAt: row.resetsAt, provenance: row.provenance, observedAt: "" }];
  return [];
}

/** A window whose reset time has passed says nothing about the current period. */
const current = (m: AccountMeter, now: Date) => m.resetsAt === null || Date.parse(m.resetsAt) > now.getTime();

/**
 * In use: a run that has not ended, a known window above 0% in its current period (near and over
 * the limit included), or spend today. A profile that must sign in or update first, a local
 * server and a plan with nothing reported are not, unless something runs on them.
 */
export function inUse(row: AccountRow, now: Date): boolean {
  if ((row.activeRuns ?? 0) > 0) return true;
  if (row.kind === "local" || needsAction(row)) return false;
  if (row.value.kind === "usd") return row.value.usd > 0;
  return allMeters(row).some((m) => m.pct !== null && m.pct > 0 && m.provenance !== "unknown" && current(m, now));
}

/** Keeps the daemon's most-urgent-first order inside both groups. */
export function splitAccounts(rows: AccountRow[], now: Date): { inUse: AccountRow[]; unused: AccountRow[] } {
  const used: AccountRow[] = [];
  const unused: AccountRow[] = [];
  for (const r of rows) (inUse(r, now) ? used : unused).push(r);
  return { inUse: used, unused };
}

/** Meter rows under an account in use; an empty list draws the name line alone. */
export function meterLines(row: AccountRow): MeterLine[] {
  if (row.kind === "local" || needsAction(row)) return [];
  if (row.value.kind === "usd") {
    // A key without a cap: today's spend is the whole story, there is nothing to fill.
    if (row.value.capUsd === null) return [];
    const pct = row.pct ?? (row.value.capUsd === 0 ? 100 : Math.min(100, (row.value.usd / row.value.capUsd) * 100));
    return [{ key: "cap", label: { kind: "cap" }, pct, provenance: row.provenance }];
  }
  const known = allMeters(row).filter((m) => m.pct !== null && m.provenance !== "unknown");
  if (known.length > 0) {
    // A bucket's row is named by the bucket; which window it is goes to the detail.
    return known.map((m) => ({ key: `${m.bucket ?? ""}|${m.window}`, label: m.bucket ? { kind: "bucket", bucket: m.bucket, bucketLabel: m.bucketLabel } : { kind: "window", window: m.window }, pct: m.pct, provenance: m.provenance }));
  }
  // Nothing known yet: one Unknown row for the account, never a row per window it might have.
  return [{ key: "unknown", label: { kind: "quota" }, pct: null, provenance: "unknown" }];
}

/** The single value of a folded account, or of the name line of an account in use without meters. */
export function lineValue(row: AccountRow): LineValue {
  if (row.kind === "local") return { kind: "local" };
  const action = needsAction(row);
  if (action) return { kind: action };
  if (row.value.kind === "usd") return { kind: "usd", usd: row.value.usd, provenance: row.provenance };
  if (row.value.kind === "pct" && row.provenance !== "unknown") return { kind: "pct", pct: row.value.pct, provenance: row.provenance };
  return { kind: "unknown" };
}

/** The newest reading among the row's windows, for the detail's "seen" age; null when none has one. */
export function newestReading(row: AccountRow): string | null {
  const seen = allMeters(row)
    .map((m) => m.observedAt)
    .filter((s) => s !== "");
  return seen.length > 0 ? seen.reduce((a, b) => (b > a ? b : a)) : null;
}
