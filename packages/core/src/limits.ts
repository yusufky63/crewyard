import type { LimitSample } from "./adapter.ts";

// Notification rules from PLAN.md §7.3: warn once per window, re-arm after reset or a drop below
// the re-arm line, critical once, and an "ahead of pace" forecast from recent samples.

export interface Thresholds {
  warn: number;
  critical: number;
  rearm: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { warn: 80, critical: 95, rearm: 70 };

export type LimitLevel = "ok" | "warn" | "critical" | "reached" | "unknown";

export interface AlertState {
  warned: boolean;
  critical: boolean;
  resetsAt: string | null;
}

export const EMPTY_ALERT: AlertState = { warned: false, critical: false, resetsAt: null };

export type LimitNotice = { kind: "warn" | "critical"; sample: LimitSample };

export function levelOf(sample: LimitSample, t: Thresholds = DEFAULT_THRESHOLDS): LimitLevel {
  if (sample.provenance === "unknown" || sample.usedPct === null) return "unknown";
  if (sample.usedPct >= 100) return "reached";
  if (sample.usedPct >= t.critical) return "critical";
  if (sample.usedPct >= t.warn) return "warn";
  return "ok";
}

/** Returns the notices to send for this sample and the alert state to keep for the next one. */
export function evaluate(prev: AlertState, sample: LimitSample, t: Thresholds = DEFAULT_THRESHOLDS): { state: AlertState; notices: LimitNotice[] } {
  if (sample.usedPct === null || sample.provenance === "unknown") return { state: prev, notices: [] };
  let state = prev;
  const windowReset = prev.resetsAt !== null && sample.resetsAt !== null && sample.resetsAt !== prev.resetsAt;
  if (windowReset || sample.usedPct < t.rearm) state = { ...EMPTY_ALERT };
  state = { ...state, resetsAt: sample.resetsAt };
  const notices: LimitNotice[] = [];
  if (sample.usedPct >= t.critical && !state.critical) {
    notices.push({ kind: "critical", sample });
    state = { ...state, critical: true, warned: true };
  } else if (sample.usedPct >= t.warn && !state.warned) {
    notices.push({ kind: "warn", sample });
    state = { ...state, warned: true };
  }
  return { state, notices };
}

/**
 * Forecast when a window fills at the current burn rate, using the first and last usable samples
 * of the same window. Returns null when there is not enough data, usage is flat, or the forecast
 * lands after the reset.
 */
export function minutesUntilFull(samples: LimitSample[], now: Date): number | null {
  const usable = samples.filter((s) => s.usedPct !== null && s.provenance !== "unknown").sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const first = usable[0];
  const last = usable.at(-1);
  if (!first || !last || first === last) return null;
  const minutes = (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / 60_000;
  const gained = (last.usedPct ?? 0) - (first.usedPct ?? 0);
  if (minutes <= 0 || gained <= 0) return null;
  const left = Math.max(0, 100 - (last.usedPct ?? 0)) / (gained / minutes);
  const sinceLast = (now.getTime() - Date.parse(last.observedAt)) / 60_000;
  const eta = Math.max(0, left - sinceLast);
  if (last.resetsAt && now.getTime() + eta * 60_000 >= Date.parse(last.resetsAt)) return null;
  return Math.round(eta);
}
