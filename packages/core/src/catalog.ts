import { z } from "zod";

// Shape of catalog/providers.json, produced by catalog/sync-catalog.mjs from models.dev + curated.json.

export const RunnerSupport = z.enum(["native", "direct", "config", "conversion", "none"]);
export type RunnerSupport = z.infer<typeof RunnerSupport>;

export const CatalogModel = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().nullable(),
  context: z.number().nullable(),
  output: z.number().nullable(),
  cost: z.object({ input: z.number().nullable(), output: z.number().nullable(), cacheRead: z.number().nullable() }).nullable(),
  reasoning: z.boolean(),
  openWeights: z.boolean(),
  released: z.string().nullable(),
});
export type CatalogModel = z.infer<typeof CatalogModel>;

export const CatalogProvider = z.object({
  id: z.string(),
  name: z.string(),
  group: z.enum(["first-party", "coding-plan", "aggregator", "local"]),
  env: z.array(z.string()),
  docs: z.string().nullable(),
  openaiBase: z.string().nullable(),
  anthropicBase: z.string().nullable(),
  runners: z.object({ claudeCode: RunnerSupport, codex: RunnerSupport, geminiCli: RunnerSupport, opencode: RunnerSupport }),
  balance: z.string().nullable(),
  quota: z.string().nullable(),
  ref: z.string().nullable(),
  note: z.string().nullable(),
  modelCount: z.number().int(),
  models: z.array(CatalogModel),
});
export type CatalogProvider = z.infer<typeof CatalogProvider>;

export const Catalog = z.object({
  generatedAt: z.string(),
  source: z.object({ url: z.string(), sha256: z.string(), license: z.string() }),
  curatedChecked: z.string(),
  providers: z.array(CatalogProvider),
});
export type Catalog = z.infer<typeof Catalog>;

/** "conversion" and "none" are not offered in v1 (PLAN.md §6.1). */
export const usableWith = (support: RunnerSupport) => support === "native" || support === "direct" || support === "config";

/**
 * Time-of-use pricing from curated.json. models.dev lists the standard rate; inside a peak window
 * the provider bills `factor` times that. Days and windows are UTC, windows end exclusive.
 */
export const PeakPricing = z.object({
  factor: z.number().positive(),
  /** 0 is Sunday, as Date.getUTCDay(). */
  days: z.array(z.number().int().min(0).max(6)),
  windows: z.array(z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)),
  ref: z.string(),
  checked: z.string(),
});
export type PeakPricing = z.infer<typeof PeakPricing>;

const minuteOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The multiplier on catalog prices for tokens used at `at`: the peak factor inside a window, else 1. */
export function peakFactor(peak: PeakPricing | null | undefined, at: Date): number {
  if (!peak || !peak.days.includes(at.getUTCDay())) return 1;
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  const inside = peak.windows.some((w) => minute >= minuteOf(w.slice(0, 5)) && minute < minuteOf(w.slice(6)));
  return inside ? peak.factor : 1;
}

/** Estimated cost in USD for a token count; models.dev prices are per million tokens. */
export function estimateCost(model: CatalogModel, tokensIn: number, tokensOut: number, cacheRead = 0): number | null {
  if (!model.cost || model.cost.input === null || model.cost.output === null) return null;
  const cache = model.cost.cacheRead ?? model.cost.input;
  return (tokensIn * model.cost.input + tokensOut * model.cost.output + cacheRead * cache) / 1_000_000;
}
