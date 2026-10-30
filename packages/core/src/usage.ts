import type { Provenance } from "./events.ts";
import type { UsageRecord, UsageReport } from "./ipc/usage.ts";

// The usage view's rules (PLAN.md §7, M5): how tokens and dollars group, which rows may carry
// dollars at all, how provenance combines, and the CSV and JSON exports. Pure, so the screen, the
// export and the tests agree on every number.

/**
 * `per_token`: a pay-as-you-go API key, the only kind that shows dollars. `plan`: a subscription
 * you signed in to, or a coding-plan key whose quota is a window, not a bill. `local`: no bill.
 */
export type Billing = "per_token" | "plan" | "local";

export type ProviderGroup = "first-party" | "coding-plan" | "aggregator" | "local";

export function billingOf(r: Pick<UsageRecord, "credentialKind">, group: ProviderGroup | undefined): Billing {
  if (r.credentialKind === "local" || group === "local") return "local";
  if (r.credentialKind === "api_key" && group !== "coding-plan") return "per_token";
  return "plan";
}

const RANK: Record<Provenance, number> = { unknown: 0, estimated: 1, reported: 2 };

/** The weakest label of the parts: one estimate makes the sum an estimate. */
export function weakestProvenance(parts: Provenance[]): Provenance {
  if (parts.length === 0) return "unknown";
  return parts.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

export type UsageDimension = "day" | "model" | "provider" | "task";

export interface UsageGroup {
  key: string;
  tokensIn: number;
  tokensOut: number;
  /** Cache reads that were reported; `cacheUnknown` says some part of the group had no split. */
  cacheRead: number;
  cacheUnknown: boolean;
  reasoning: number;
  tokensProvenance: Provenance;
  /** Dollars of per-token keys only; null when the group has none. */
  usd: number | null;
  usdProvenance: Provenance;
  /** Tokens on plans and local models, which never become dollars. */
  unbilledTokens: number;
}

export const NO_KEY = "";

const keyOf = (r: UsageRecord, by: UsageDimension): string =>
  by === "day" ? r.day : by === "model" ? (r.model ?? NO_KEY) : by === "provider" ? r.providerId : (r.taskId ?? NO_KEY);

/** Groups records by one dimension, largest first (by day: oldest first). */
export function groupUsage(records: UsageRecord[], by: UsageDimension, groupOf: (providerId: string) => ProviderGroup | undefined): UsageGroup[] {
  const acc = new Map<string, { g: UsageGroup; tp: Provenance[]; up: Provenance[] }>();
  for (const r of records) {
    const key = keyOf(r, by);
    let a = acc.get(key);
    if (!a) {
      a = { g: { key, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheUnknown: false, reasoning: 0, tokensProvenance: "unknown", usd: null, usdProvenance: "unknown", unbilledTokens: 0 }, tp: [], up: [] };
      acc.set(key, a);
    }
    const g = a.g;
    g.tokensIn += r.tokensIn;
    g.tokensOut += r.tokensOut;
    g.reasoning += r.reasoning;
    if (r.cacheRead === null) g.cacheUnknown = true;
    else g.cacheRead += r.cacheRead;
    a.tp.push(r.tokensProvenance);
    if (billingOf(r, groupOf(r.providerId)) === "per_token" && r.usd !== null) {
      g.usd = (g.usd ?? 0) + r.usd;
      a.up.push(r.usdProvenance);
    } else {
      g.unbilledTokens += r.tokensIn + r.tokensOut;
    }
  }
  const out = [...acc.values()].map(({ g, tp, up }) => ({ ...g, usd: g.usd === null ? null : round6(g.usd), tokensProvenance: weakestProvenance(tp), usdProvenance: weakestProvenance(up) }));
  if (by === "day") return out.sort((a, b) => a.key.localeCompare(b.key));
  return out.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || totalTokens(b) - totalTokens(a) || a.key.localeCompare(b.key));
}

export const totalTokens = (g: Pick<UsageGroup, "tokensIn" | "tokensOut">) => g.tokensIn + g.tokensOut;

const round6 = (x: number) => Math.round(x * 1_000_000) / 1_000_000;

/** Every local day from `from` to `to` (YYYY-MM-DD, inclusive), so empty days still get a column. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  if (!fy || !fm || !fd || !ty || !tm || !td) return out;
  const d = new Date(Date.UTC(fy, fm - 1, fd));
  const end = Date.UTC(ty, tm - 1, td);
  while (d.getTime() <= end && out.length < 366) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Day groups with an empty group for each day that had nothing. */
export function dailySeries(report: UsageReport, groupOf: (providerId: string) => ProviderGroup | undefined): UsageGroup[] {
  const have = new Map(groupUsage(report.records, "day", groupOf).map((g) => [g.key, g]));
  return daysBetween(report.from, report.to).map(
    (day) => have.get(day) ?? { key: day, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheUnknown: false, reasoning: 0, tokensProvenance: "unknown", usd: null, usdProvenance: "unknown", unbilledTokens: 0 },
  );
}

export interface UsageTotals {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheUnknown: boolean;
  tokensProvenance: Provenance;
  usd: number;
  usdProvenance: Provenance;
  /** Whether any per-token key spent in the range; without one there is no dollar figure to show. */
  hasDollars: boolean;
  unbilledTokens: number;
}

export function usageTotals(records: UsageRecord[], groupOf: (providerId: string) => ProviderGroup | undefined): UsageTotals {
  const all = groupUsage(
    records.map((r) => ({ ...r, day: "all" })),
    "day",
    groupOf,
  )[0];
  if (!all) return { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheUnknown: false, tokensProvenance: "unknown", usd: 0, usdProvenance: "estimated", hasDollars: false, unbilledTokens: 0 };
  return {
    tokensIn: all.tokensIn,
    tokensOut: all.tokensOut,
    cacheRead: all.cacheRead,
    cacheUnknown: all.cacheUnknown,
    tokensProvenance: all.tokensProvenance,
    usd: all.usd ?? 0,
    usdProvenance: all.usd === null ? "estimated" : all.usdProvenance,
    hasDollars: all.usd !== null,
    unbilledTokens: all.unbilledTokens,
  };
}

/** Share of a total in whole percent; never rounds a non-zero part down to 0. */
export function sharePct(part: number, total: number): number {
  if (total <= 0 || part <= 0) return 0;
  return Math.max(1, Math.round((100 * part) / total));
}

// ---- export

export const USAGE_COLUMNS = [
  "day",
  "provider",
  "model",
  "runner",
  "task_id",
  "task_title",
  "billing",
  "tokens_in",
  "tokens_out",
  "cache_read",
  "reasoning",
  "tokens_provenance",
  "usd",
  "usd_provenance",
  "catalog_versions",
] as const;

/** One CSV field: quoted when needed, and a leading = + - @ is defused so a spreadsheet never runs it. */
export function csvField(v: string | number | null): string {
  if (v === null) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ExportRow {
  day: string;
  provider: string;
  model: string | null;
  runner: string | null;
  task_id: string | null;
  task_title: string | null;
  billing: Billing;
  tokens_in: number;
  tokens_out: number;
  cache_read: number | null;
  reasoning: number;
  tokens_provenance: Provenance;
  /** Dollars only for per-token keys; plans and local models export null. */
  usd: number | null;
  usd_provenance: Provenance;
  catalog_versions: string;
}

export function exportRows(report: UsageReport, groupOf: (providerId: string) => ProviderGroup | undefined): ExportRow[] {
  return [...report.records]
    .sort((a, b) => a.day.localeCompare(b.day) || a.providerId.localeCompare(b.providerId) || (a.model ?? "").localeCompare(b.model ?? "") || (a.taskId ?? "").localeCompare(b.taskId ?? ""))
    .map((r) => {
      const billing = billingOf(r, groupOf(r.providerId));
      const dollars = billing === "per_token" ? r.usd : null;
      return {
        day: r.day,
        provider: r.providerId,
        model: r.model,
        runner: r.runner,
        task_id: r.taskId,
        task_title: r.taskTitle,
        billing,
        tokens_in: r.tokensIn,
        tokens_out: r.tokensOut,
        cache_read: r.cacheRead,
        reasoning: r.reasoning,
        tokens_provenance: r.tokensProvenance,
        usd: dollars,
        usd_provenance: dollars === null ? "unknown" : r.usdProvenance,
        catalog_versions: r.catalogVersions.join(" "),
      };
    });
}

/** CSV with a header row and CRLF line ends, which Excel on Windows expects. */
export function usageCsv(report: UsageReport, groupOf: (providerId: string) => ProviderGroup | undefined): string {
  const rows = exportRows(report, groupOf);
  const lines = [USAGE_COLUMNS.join(","), ...rows.map((r) => USAGE_COLUMNS.map((c) => csvField(r[c])).join(","))];
  return `${lines.join("\r\n")}\r\n`;
}

export function usageJson(report: UsageReport, groupOf: (providerId: string) => ProviderGroup | undefined): string {
  return `${JSON.stringify({ from: report.from, to: report.to, days: report.days, generatedAt: report.generatedAt, rows: exportRows(report, groupOf) }, null, 2)}\n`;
}
