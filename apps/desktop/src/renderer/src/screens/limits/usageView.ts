import { totalTokens, type UsageGroup } from "@crewyard/core";

// Display rules for the usage view that the core rules leave to the screen: which number a bar
// measures, how many slices a segmented bar gets, and how the ledger is cut for long lists.

export type UsageMetric = "tokens" | "usd";

export const metricOf = (g: UsageGroup, m: UsageMetric): number => (m === "usd" ? (g.usd ?? 0) : totalTokens(g));

export interface Slice {
  key: string;
  value: number;
  /** The groups summed into this slice; more than one only for the "other" slice. */
  keys: string[];
}

export const OTHER = "\u0000other";

/** At most `max` slices; past that the tail is summed so the legend stays readable. Zero groups are left out. */
export function slices(groups: UsageGroup[], metric: UsageMetric, max = 4): Slice[] {
  const parts = groups
    .map((g) => ({ key: g.key, value: metricOf(g, metric), keys: [g.key] }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  if (parts.length <= max) return parts;
  const head = parts.slice(0, max - 1);
  const tail = parts.slice(max - 1);
  return [...head, { key: OTHER, value: tail.reduce((n, s) => n + s.value, 0), keys: tail.map((s) => s.key) }];
}

/** Ledger rows shown before "Show all"; a range of days always shows every day. */
export const LEDGER_ROWS = 12;

/** Compact token counts: 950, 12.4k, 3.1M. Locale-aware through Intl. */
export function compact(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: n >= 1000 ? 1 : 0 }).format(n);
}
