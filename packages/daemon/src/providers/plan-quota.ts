import type { LimitWindow, PlanQuotaEndpoint } from "@crewyard/core";

// Coding-plan quota for Kimi Code, Z.ai, MiniMax and OpenCode Go (PLAN.md §6.1, feature scan A5).
// Only facts were taken from elsewhere: endpoint URLs, auth headers, field names and units, read
// in cc-switch `src-tauri/src/services/coding_plan.rs` (MIT, opened 2026-10-30), Z.ai's own
// glm-plan-usage plugin (zai-org/zai-coding-plugins, Apache-2.0) and Kimi's CLI usage command
// (MoonshotAI/kimi-cli, Apache-2.0). None of these endpoints is documented by its provider, so
// every parser checks the shape and throws when it is not what we know: the caller then shows
// Unknown, never 0. Only one GET with the provider's own key, never anything that could spend.

export type PlanQuotaKind = "kimi" | "zhipu" | "minimax" | "opencode-go";

export interface PlanQuotaTarget extends PlanQuotaEndpoint {
  kind: PlanQuotaKind;
}

/** Catalog provider id → quota endpoint. Only the plans in catalog/curated.json with a `quota` note. */
export const PLAN_QUOTA: Record<string, PlanQuotaTarget> = {
  // The global host; cc-switch's own default is api.kimi.com, and its query_kimi_at names
  // api.kimi.ai/coding/v1 for global accounts, the host our catalog entry uses.
  "kimi-code-plan-global": { providerId: "kimi-code-plan-global", kind: "kimi", url: "https://api.kimi.ai/coding/v1/usages", auth: "bearer" },
  // Z.ai takes the key without "Bearer" (cc-switch and Z.ai's own plugin both send it bare).
  "zai-coding-plan": { providerId: "zai-coding-plan", kind: "zhipu", url: "https://api.z.ai/api/monitor/usage/quota/limit", auth: "raw" },
  "minimax-coding-plan": { providerId: "minimax-coding-plan", kind: "minimax", url: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains", auth: "bearer" },
  "opencode-go": { providerId: "opencode-go", kind: "opencode-go", url: "https://opencode.ai/zen/go/v1/usage", auth: "bearer" },
};

export const planQuotaTarget = (providerId: string): PlanQuotaTarget | null => PLAN_QUOTA[providerId] ?? null;

export interface PlanWindow {
  window: LimitWindow;
  /** Set for a limit apart from the plan's main one (Z.ai's monthly MCP calls). */
  bucket?: string;
  /** Used share, 0–100, whichever direction the provider reports in. */
  usedPct: number;
  resetsAt: string | null;
}

export type PlanQuota = { state: "ok"; windows: PlanWindow[] } | { state: "no_plan" };

/** A response we cannot read as quota. The message never carries the key. */
export class PlanQuotaError extends Error {}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Kimi sends some numbers as strings. */
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const clampPct = (n: number): number => Math.min(100, Math.max(0, n));

/** ISO text, or a Unix time in seconds or milliseconds; zero and negative mean "no reset". */
export function resetIso(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") {
    const asNum = num(v);
    if (asNum === null) {
      const t = Date.parse(v);
      return Number.isFinite(t) ? new Date(t).toISOString() : null;
    }
    v = asNum;
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return new Date(v < 1e12 ? v * 1000 : v).toISOString();
}

/** Window lengths in minutes, matched with 2% tolerance: a month may be 28 to 31 days, so it gets a range. */
const WINDOW_MINUTES: Array<[number, LimitWindow]> = [
  [300, "5h"],
  [1_440, "daily"],
  [10_080, "weekly"],
];

export function windowOfMinutes(mins: number | null): LimitWindow | null {
  if (mins === null || mins <= 0) return null;
  const hit = WINDOW_MINUTES.find(([m]) => Math.abs(mins - m) <= m * 0.02);
  if (hit) return hit[1];
  if (mins >= 28 * 1_440 && mins <= 31 * 1_440) return "monthly";
  return null;
}

const UNIT_MINUTES: Array<[string, number]> = [
  ["SECOND", 1 / 60],
  ["MINUTE", 1],
  ["HOUR", 60],
  ["DAY", 1_440],
  ["WEEK", 10_080],
];

// ── Kimi Code ───────────────────────────────────────────────────────────────────────────────
// { usage: { limit, remaining|used, resetTime }, limits: [{ window: { duration, timeUnit }, detail: { limit, remaining|used, resetTime } }] }
// `usage` is the weekly limit; each `limits[]` entry carries its own window length.

function kimiUsed(d: Record<string, unknown>): number | null {
  const limit = num(d.limit);
  if (limit === null || limit <= 0) return null;
  const used = num(d.used);
  const remaining = num(d.remaining);
  const u = used ?? (remaining === null ? null : limit - remaining);
  return u === null ? null : clampPct((u / limit) * 100);
}

function kimiMinutes(item: Record<string, unknown>, detail: Record<string, unknown>): number | null {
  const w = obj(item.window) ?? {};
  const duration = num(w.duration ?? item.duration ?? detail.duration);
  const unit = String(w.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? "").toUpperCase();
  if (duration === null) return null;
  const factor = UNIT_MINUTES.find(([u]) => unit.includes(u))?.[1];
  return factor === undefined ? null : duration * factor;
}

export function parseKimi(body: unknown): PlanQuota {
  const b = obj(body);
  if (!b) throw new PlanQuotaError("Kimi usage response is not an object");
  const out: PlanWindow[] = [];
  const limits = Array.isArray(b.limits) ? b.limits : [];
  for (const raw of limits) {
    const item = obj(raw);
    if (!item) continue;
    const detail = obj(item.detail) ?? item;
    const usedPct = kimiUsed(detail);
    if (usedPct === null) continue;
    // By its stated length; a lone entry without one is the 5-hour limit, the meaning cc-switch
    // gives `limits[]`. With several and no lengths there is nothing safe to call them.
    const mins = kimiMinutes(item, detail);
    const window = mins !== null ? windowOfMinutes(mins) : limits.length === 1 ? "5h" : null;
    if (window) out.push({ window, usedPct, resetsAt: resetIso(detail.resetTime ?? detail.resetAt) });
  }
  const usage = obj(b.usage);
  if (usage) {
    const usedPct = kimiUsed(usage);
    if (usedPct !== null) out.push({ window: "weekly", usedPct, resetsAt: resetIso(usage.resetTime ?? usage.resetAt) });
  }
  if (out.length === 0) throw new PlanQuotaError("Kimi usage response has no limit we recognise");
  return { state: "ok", windows: dedupe(out) };
}

// ── Z.ai / Zhipu ────────────────────────────────────────────────────────────────────────────
// { success, msg, data: { limits: [{ type: TOKENS_LIMIT|TIME_LIMIT, unit, number, percentage, nextResetTime }] } }
// `percentage` is the used share. `unit` 3 is hours (number 5: the 5-hour window) and 6 the
// weekly window; TIME_LIMIT is the monthly MCP tool quota, which Z.ai's plugin labels "1 Month".

/** Pay-as-you-go keys get HTTP 200 with success:false and a message saying there is no coding plan. */
export function zhipuNoPlan(b: Record<string, unknown>): boolean {
  if (b.success !== false) return false;
  const msg = String(b.msg ?? b.message ?? "").toLowerCase();
  const compact = msg.replace(/[\s_-]/g, "");
  return compact.includes("codingplan") && ["不存在", "没有", "未开通", "not exist", "not found", "not have", "doesn't have", "no coding plan", "not subscribed"].some((k) => msg.includes(k));
}

function zhipuWindow(item: Record<string, unknown>): LimitWindow | null {
  const unit = num(item.unit);
  const n = num(item.number);
  if (unit === 3) return windowOfMinutes((n ?? 5) * 60);
  if (unit === 6) return "weekly";
  return null;
}

export function parseZhipu(body: unknown): PlanQuota {
  const b = obj(body);
  if (!b) throw new PlanQuotaError("Z.ai quota response is not an object");
  if (zhipuNoPlan(b)) return { state: "no_plan" };
  if (b.success === false) throw new PlanQuotaError(`Z.ai answered: ${String(b.msg ?? "no message").slice(0, 160)}`);
  const data = obj(b.data);
  const limits = data && Array.isArray(data.limits) ? data.limits : null;
  if (!limits) throw new PlanQuotaError("Z.ai quota response has no data.limits");
  const out: PlanWindow[] = [];
  for (const raw of limits) {
    const item = obj(raw);
    const pct = item ? num(item.percentage) : null;
    if (!item || pct === null) continue;
    const type = String(item.type ?? "").toUpperCase();
    const resetsAt = resetIso(item.nextResetTime);
    if (type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") {
      const window = zhipuWindow(item);
      if (window) out.push({ window, usedPct: clampPct(pct), resetsAt });
    } else if (type === "TIME_LIMIT") {
      out.push({ window: "monthly", bucket: "mcp", usedPct: clampPct(pct), resetsAt });
    }
  }
  if (out.length === 0) throw new PlanQuotaError("Z.ai quota response has no limit we recognise");
  return { state: "ok", windows: dedupe(out) };
}

// ── MiniMax ─────────────────────────────────────────────────────────────────────────────────
// { base_resp: { status_code, status_msg }, model_remains: [{ model_name: "general",
//   start_time, end_time, current_interval_remaining_percent,
//   weekly_start_time, weekly_end_time, current_weekly_status, current_weekly_remaining_percent }] }
// Percentages are the share *remaining*. Weekly status 1 counts, 2 is used up, 3 means the plan
// has no weekly limit (its percent then stays 100 and means nothing).

function minimaxWindow(start: unknown, end: unknown, named: LimitWindow): LimitWindow | null {
  const s = num(start);
  const e = num(end);
  if (s === null || e === null || e <= s) return named;
  // Both ends present: trust the length over the field name. Seconds or milliseconds, as for resets.
  const ms = (e - s) * (e < 1e12 ? 1000 : 1);
  return windowOfMinutes(ms / 60_000);
}

export function parseMinimax(body: unknown): PlanQuota {
  const b = obj(body);
  if (!b) throw new PlanQuotaError("MiniMax response is not an object");
  const base = obj(b.base_resp);
  const code = base ? num(base.status_code) : 0;
  if (code !== 0) throw new PlanQuotaError(`MiniMax answered code ${code ?? "?"}: ${String(base?.status_msg ?? "no message").slice(0, 160)}`);
  const remains = Array.isArray(b.model_remains) ? b.model_remains : null;
  if (!remains) throw new PlanQuotaError("MiniMax response has no model_remains");
  const general = remains.map(obj).find((m) => m?.model_name === "general");
  if (!general) throw new PlanQuotaError("MiniMax response has no general coding-plan entry");
  const out: PlanWindow[] = [];
  const interval = num(general.current_interval_remaining_percent);
  const iw = interval === null ? null : minimaxWindow(general.start_time, general.end_time, "5h");
  if (interval !== null && iw) out.push({ window: iw, usedPct: clampPct(100 - interval), resetsAt: resetIso(general.end_time) });
  const status = num(general.current_weekly_status);
  const weekly = num(general.current_weekly_remaining_percent);
  const ww = weekly === null ? null : minimaxWindow(general.weekly_start_time, general.weekly_end_time, "weekly");
  if ((status === 1 || status === 2) && weekly !== null && ww) out.push({ window: ww, usedPct: clampPct(100 - weekly), resetsAt: resetIso(general.weekly_end_time) });
  if (out.length === 0) throw new PlanQuotaError("MiniMax response has no window we recognise");
  return { state: "ok", windows: dedupe(out) };
}

// ── OpenCode Go ─────────────────────────────────────────────────────────────────────────────
// { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }, percent used. `rolling`
// is the 5-hour window. The shape changed on 2026-08-11 (flat rollingUsage/usagePercent before),
// so each window is read on its own and an old or unknown shape reads as no windows at all.

const OPENCODE_WINDOWS: Array<[string, LimitWindow]> = [
  ["rolling", "5h"],
  ["weekly", "weekly"],
  ["monthly", "monthly"],
];

export function parseOpencodeGo(body: unknown): PlanQuota {
  const usage = obj(obj(body)?.usage);
  if (!usage) throw new PlanQuotaError("OpenCode Go usage response has no usage object");
  const out: PlanWindow[] = [];
  for (const [key, window] of OPENCODE_WINDOWS) {
    const w = obj(usage[key]);
    const pct = w ? num(w.percent) : null;
    if (!w || pct === null) continue;
    // At 0% the reset is a placeholder (now plus the window length), not a real reset time.
    out.push({ window, usedPct: clampPct(pct), resetsAt: pct > 0 ? resetIso(w.resetsAt) : null });
  }
  if (out.length === 0) throw new PlanQuotaError("OpenCode Go usage response has no window we recognise");
  return { state: "ok", windows: out };
}

/** Two entries for the same window of the same bucket: keep the fuller one rather than guess. */
function dedupe(ws: PlanWindow[]): PlanWindow[] {
  const by = new Map<string, PlanWindow>();
  for (const w of ws) {
    const k = `${w.bucket ?? ""}|${w.window}`;
    const prev = by.get(k);
    if (!prev || w.usedPct > prev.usedPct) by.set(k, w);
  }
  return [...by.values()];
}

export function parsePlanQuota(kind: PlanQuotaKind, body: unknown): PlanQuota {
  switch (kind) {
    case "kimi":
      return parseKimi(body);
    case "zhipu":
      return parseZhipu(body);
    case "minimax":
      return parseMinimax(body);
    case "opencode-go":
      return parseOpencodeGo(body);
  }
}

/** One GET with the key in the Authorization header. Errors never include the key or the response body. */
export async function fetchPlanQuota(target: PlanQuotaTarget, key: string, fetchFn: typeof fetch = fetch): Promise<PlanQuota> {
  const res = await fetchFn(target.url, {
    headers: { Authorization: target.auth === "raw" ? key : `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  // OpenCode Go: the workspace key is valid for Zen but has no Go subscription.
  if (res.status === 403 && target.kind === "opencode-go") return { state: "no_plan" };
  if (res.status === 401 || res.status === 403) throw new PlanQuotaError(`The key was rejected (HTTP ${res.status})`);
  if (!res.ok) throw new PlanQuotaError(`Quota endpoint answered HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new PlanQuotaError("Quota endpoint returned something that is not JSON");
  }
  return parsePlanQuota(target.kind, body);
}
