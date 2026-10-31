import type { DatabaseSync } from "node:sqlite";
import type { Catalog, PriceCheckView, PriceDiff, PriceField } from "@crewyard/core";

// PLAN.md §6.1: catalog prices are cross-checked against LiteLLM's community price table and
// differences above 10% are listed in diagnostics. Only shown; nothing here ever changes a price.
// File format (per-token USD, `litellm_provider`, `mode`): docs.litellm.ai/docs/completion/token_usage.

export const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const THRESHOLD_PCT = 10;
const CHECK_EVERY_MS = 24 * 60 * 60_000;
const TIMEOUT_MS = 30_000;

/**
 * Catalog provider id → LiteLLM's `litellm_provider` and the key prefix it files that provider's models
 * under. Explicit on purpose: guessing by name would compare, say, the China endpoints' prices with
 * the global ones. Left out: the `-cn` endpoints and Zhipu (priced in CNY upstream), coding plans
 * (billed per plan, not per token), OpenRouter, SiliconFlow and StepFun (no LiteLLM entries for them),
 * and local runners.
 */
export const LITELLM_PROVIDERS: Readonly<Record<string, { provider: string; prefix: string }>> = {
  anthropic: { provider: "anthropic", prefix: "" },
  openai: { provider: "openai", prefix: "openai/" },
  google: { provider: "gemini", prefix: "gemini/" },
  deepseek: { provider: "deepseek", prefix: "deepseek/" },
  moonshotai: { provider: "moonshot", prefix: "moonshot/" },
  zai: { provider: "zai", prefix: "zai/" },
  minimax: { provider: "minimax", prefix: "minimax/" },
  alibaba: { provider: "dashscope", prefix: "dashscope/" },
  xiaomi: { provider: "xiaomi_mimo", prefix: "xiaomi_mimo/" },
  mistral: { provider: "mistral", prefix: "mistral/" },
  xai: { provider: "xai", prefix: "xai/" },
  groq: { provider: "groq", prefix: "groq/" },
  "fireworks-ai": { provider: "fireworks_ai", prefix: "fireworks_ai/" },
  deepinfra: { provider: "deepinfra", prefix: "deepinfra/" },
  togetherai: { provider: "together_ai", prefix: "together_ai/" },
  vercel: { provider: "vercel_ai_gateway", prefix: "vercel_ai_gateway/" },
  "novita-ai": { provider: "novita", prefix: "novita/" },
  nvidia: { provider: "nvidia_nim", prefix: "nvidia_nim/" },
};

/** The part of a LiteLLM entry we keep, converted to USD per million tokens like the catalog. */
export interface LitellmPrice {
  provider: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
}

interface RawEntry {
  litellm_provider?: unknown;
  mode?: unknown;
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
  cache_read_input_token_cost?: unknown;
}

const MAPPED = new Set(Object.values(LITELLM_PROVIDERS).map((m) => m.provider));
// Six decimals per million tokens is a millionth of a cent per token: enough, and it drops float noise.
const perMillion = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 1e12) / 1e6 : null);

/** Keeps the chat entries of mapped providers only, so the stored copy is a small slice of the file. */
export function parseLitellm(raw: string): Record<string, LitellmPrice> {
  const json = JSON.parse(raw) as Record<string, RawEntry>;
  const out: Record<string, LitellmPrice> = {};
  for (const [key, e] of Object.entries(json)) {
    if (key === "sample_spec" || !e || typeof e !== "object") continue;
    if (typeof e.litellm_provider !== "string" || !MAPPED.has(e.litellm_provider)) continue;
    if (e.mode !== undefined && e.mode !== "chat" && e.mode !== "responses") continue;
    out[key] = { provider: e.litellm_provider, input: perMillion(e.input_cost_per_token), output: perMillion(e.output_cost_per_token), cacheRead: perMillion(e.cache_read_input_token_cost) };
  }
  return out;
}

/** The LiteLLM key for a catalog model: prefixed first, then bare, and only under the mapped provider. */
export function matchKey(prices: Record<string, LitellmPrice>, providerId: string, model: string): string | null {
  const map = LITELLM_PROVIDERS[providerId];
  if (!map) return null;
  for (const key of new Set([`${map.prefix}${model}`, model])) {
    if (prices[key]?.provider === map.provider) return key;
  }
  return null;
}

/**
 * Percent difference from LiteLLM's price, or undefined when it is within the threshold. Rounded to
 * 1e-6 % first so exactly 10% (1.1 against 1.0 is 10.000000000000009% in floating point) is not flagged.
 */
export function overThreshold(ours: number, theirs: number, thresholdPct = THRESHOLD_PCT): number | null | undefined {
  if (theirs === 0) return ours === 0 ? undefined : null;
  const pct = Math.round(((ours - theirs) / theirs) * 100 * 1e6) / 1e6;
  return Math.abs(pct) > thresholdPct ? pct : undefined;
}

const FIELDS: PriceField[] = ["input", "output", "cacheRead"];

export function comparePrices(catalog: Catalog, prices: Record<string, LitellmPrice>, thresholdPct = THRESHOLD_PCT): { matched: number; diffs: PriceDiff[] } {
  let matched = 0;
  const diffs: PriceDiff[] = [];
  for (const p of catalog.providers) {
    if (!LITELLM_PROVIDERS[p.id]) continue;
    for (const m of p.models) {
      const key = matchKey(prices, p.id, m.id);
      if (!key) continue;
      matched++;
      const theirs = prices[key] as LitellmPrice;
      for (const field of FIELDS) {
        const a = m.cost?.[field] ?? null;
        const b = theirs[field];
        if (a === null || b === null) continue;
        const deltaPct = overThreshold(a, b, thresholdPct);
        if (deltaPct !== undefined) diffs.push({ providerId: p.id, model: m.id, litellmKey: key, field, ours: a, theirs: b, deltaPct });
      }
    }
  }
  // Largest gaps first; a zero on LiteLLM's side (null %) sorts to the top.
  diffs.sort((x, y) => Math.abs(y.deltaPct ?? Infinity) - Math.abs(x.deltaPct ?? Infinity) || x.providerId.localeCompare(y.providerId) || x.model.localeCompare(y.model));
  return { matched, diffs };
}

const setting = (db: DatabaseSync, key: string): string | null => (db.prepare("select value from settings where key = ?").get(key) as { value: string } | undefined)?.value ?? null;
const setSetting = (db: DatabaseSync, key: string, value: string | null) => {
  if (value === null) db.prepare("delete from settings where key = ?").run(key);
  else db.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, value);
};

/**
 * Downloads LiteLLM's table at most daily (or by hand) with If-None-Match, keeps the mapped slice in
 * settings so a 304 or a pin change can be compared again without a download, and computes the
 * differences on read against whichever catalog version is active.
 */
export class PriceCheckService {
  private inflight: Promise<PriceCheckView> | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly active: () => { hash: string; catalog: Catalog },
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  view(): PriceCheckView {
    const { hash, catalog } = this.active();
    const base = {
      catalogHash: hash,
      checkedAt: setting(this.db, "litellm.checkedAt"),
      error: setting(this.db, "litellm.lastError"),
      sourceUrl: LITELLM_URL,
      thresholdPct: THRESHOLD_PCT,
      mappedProviders: catalog.providers.filter((p) => LITELLM_PROVIDERS[p.id]).map((p) => p.id),
    };
    const stored = setting(this.db, "litellm.prices");
    // A failed download is Unknown, never "no differences": an older table could hide a new gap.
    if (!stored || base.error) return { ...base, status: "unknown", matched: null, diffs: null };
    const { matched, diffs } = comparePrices(catalog, JSON.parse(stored) as Record<string, LitellmPrice>);
    return { ...base, status: "ok", matched, diffs };
  }

  due(): boolean {
    const checked = setting(this.db, "litellm.checkedAt");
    return !checked || this.now().getTime() - Date.parse(checked) >= CHECK_EVERY_MS;
  }

  run(force = false): Promise<PriceCheckView> {
    if (!force && !this.due() && !setting(this.db, "litellm.lastError")) return Promise.resolve(this.view());
    this.inflight ??= this.fetchNow().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async fetchNow(): Promise<PriceCheckView> {
    // Without a stored slice a 304 would leave nothing to compare, so only send the ETag with one.
    const etag = setting(this.db, "litellm.prices") ? setting(this.db, "litellm.etag") : null;
    try {
      const res = await this.fetchFn(LITELLM_URL, { headers: etag ? { "If-None-Match": etag } : {}, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status !== 304) {
        if (!res.ok) throw new Error(`LiteLLM's price table answered HTTP ${res.status}`);
        setSetting(this.db, "litellm.prices", JSON.stringify(parseLitellm(await res.text())));
        setSetting(this.db, "litellm.etag", res.headers.get("etag"));
      }
      setSetting(this.db, "litellm.checkedAt", this.now().toISOString());
      setSetting(this.db, "litellm.lastError", null);
    } catch (err) {
      setSetting(this.db, "litellm.lastError", err instanceof Error ? err.message : String(err));
    }
    return this.view();
  }
}
