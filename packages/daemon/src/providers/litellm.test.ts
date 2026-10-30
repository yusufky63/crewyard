import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Catalog } from "@crewyard/core";
import { Store } from "../store.ts";
import { buildCatalog, curated } from "./catalog.ts";
import { comparePrices, LITELLM_PROVIDERS, LITELLM_URL, matchKey, overThreshold, parseLitellm, PriceCheckService } from "./litellm.ts";

const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures", "litellm-prices.json"), "utf8");

const temps: string[] = [];
const stores: Store[] = [];
const newStore = () => {
  const d = mkdtempSync(join(tmpdir(), "crewyard litellm "));
  temps.push(d);
  const s = new Store(join(d, "t.db"));
  stores.push(s);
  return s;
};
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** One model per curated provider, priced 1 / 2 / 0.1 USD per million (input / output / cache read). */
const catalog = (input = 1): Catalog =>
  buildCatalog(
    JSON.stringify(
      Object.fromEntries(
        curated.providers
          .filter((c) => !c.manual)
          .map((c) => [c.id, { name: c.id, models: { [`${c.id}-model`]: { id: `${c.id}-model`, name: "M", tool_call: true, cost: { input, output: 2, cache_read: 0.1 } } } }]),
      ),
    ),
  ).catalog;

describe("LiteLLM mapping", () => {
  it("maps only catalog providers that exist, each to a distinct LiteLLM provider", () => {
    const ids = new Set(curated.providers.map((c) => c.id));
    for (const id of Object.keys(LITELLM_PROVIDERS)) expect(ids.has(id), id).toBe(true);
    const targets = Object.values(LITELLM_PROVIDERS).map((m) => m.provider);
    expect(new Set(targets).size).toBe(targets.length);
    // China endpoints and coding plans are priced differently upstream and stay out on purpose.
    for (const id of ["moonshotai-cn", "alibaba-cn", "minimax-cn", "zhipuai", "zai-coding-plan", "opencode-go", "ollama-local"]) expect(LITELLM_PROVIDERS[id]).toBeUndefined();
  });

  it("keeps chat entries of mapped providers and converts per-token prices to per million", () => {
    const prices = parseLitellm(FIXTURE);
    expect(prices["sample_spec"]).toBeUndefined();
    expect(prices["moonshot/moonshotai-model"]).toBeUndefined(); // embedding
    expect(prices["gemini-model"]).toBeUndefined(); // vertex, not mapped
    expect(prices["deepseek/deepseek-model"]).toEqual({ provider: "deepseek", input: 1, output: 2.2, cacheRead: 0.1 });
    expect(prices["openai-model"]?.output).toBe(1.8);
    expect(prices["mistral/mistral-model"]?.input).toBeNull(); // not a number
  });

  it("matches the prefixed key first, then the bare id, and only under the mapped provider", () => {
    const prices = parseLitellm(FIXTURE);
    expect(matchKey(prices, "deepseek", "deepseek-model")).toBe("deepseek/deepseek-model");
    expect(matchKey(prices, "openai", "openai-model")).toBe("openai-model");
    expect(matchKey(prices, "google", "google-model")).toBe("gemini/google-model");
    // The bare id exists, but under the wrong provider for this mapping.
    expect(matchKey({ "google-model": { provider: "vertex_ai-language-models", input: 1, output: 1, cacheRead: null } }, "google", "google-model")).toBeNull();
    expect(matchKey(prices, "alibaba-cn", "alibaba-cn-model")).toBeNull();
  });
});

describe("price threshold", () => {
  it("flags only differences strictly above 10%, in either direction", () => {
    expect(overThreshold(1.1, 1)).toBeUndefined(); // exactly 10%, despite 1.1 - 1 rounding above 0.1
    expect(overThreshold(0.9, 1)).toBeUndefined();
    expect(overThreshold(1.100001, 1)).toBeCloseTo(10.0001, 6);
    expect(overThreshold(0.899999, 1)).toBeCloseTo(-10.0001, 6);
    expect(overThreshold(3, 3)).toBeUndefined();
  });

  it("reports a price LiteLLM lists as zero without a percentage, and two zeros as equal", () => {
    expect(overThreshold(1, 0)).toBeNull();
    expect(overThreshold(0, 0)).toBeUndefined();
  });

  it("compares input, output and cache read prices and sorts the largest gaps first", () => {
    const { matched, diffs } = comparePrices(catalog(), parseLitellm(FIXTURE));
    expect(matched).toBe(5); // deepseek, openai, anthropic, google, mistral
    expect(diffs.map((d) => [d.providerId, d.field, d.deltaPct])).toEqual([
      ["anthropic", "input", null],
      ["openai", "output", 11.111111],
    ]);
    expect(diffs[1]).toMatchObject({ model: "openai-model", litellmKey: "openai-model", ours: 2, theirs: 1.8 });
  });
});

describe("PriceCheckService", () => {
  const ok = (etag: string) => new Response(FIXTURE, { status: 200, headers: { etag } });

  it("shows Unknown before the first download and after a failed one, never zero differences", async () => {
    const store = newStore();
    const fetchFn = vi.fn<typeof fetch>();
    const svc = new PriceCheckService(store.db, () => ({ hash: "h1", catalog: catalog() }), fetchFn);
    expect(svc.view()).toMatchObject({ status: "unknown", matched: null, diffs: null, error: null });

    fetchFn.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const failed = await svc.run(true);
    expect(failed).toMatchObject({ status: "unknown", matched: null, diffs: null });
    expect(failed.error).toContain("timeout");
    expect(fetchFn.mock.calls[0]?.[0]).toBe(LITELLM_URL);
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    fetchFn.mockResolvedValueOnce(new Response("", { status: 503 }));
    expect((await svc.run(true)).error).toContain("HTTP 503");
  });

  it("asks with If-None-Match, compares against the active catalog on read and goes Unknown when a later download fails", async () => {
    const store = newStore();
    let now = new Date("2026-10-31T10:00:00Z");
    let active = { hash: "h1", catalog: catalog() };
    const fetchFn = vi.fn<typeof fetch>();
    const svc = new PriceCheckService(store.db, () => active, fetchFn, () => now);

    fetchFn.mockResolvedValueOnce(ok('"e1"'));
    const first = await svc.run();
    expect(first).toMatchObject({ status: "ok", catalogHash: "h1", matched: 5, checkedAt: now.toISOString(), thresholdPct: 10 });
    expect(first.diffs).toHaveLength(2);

    // Within a day nothing is fetched; a pin change is compared again from the stored slice.
    now = new Date("2026-10-31T20:00:00Z");
    active = { hash: "h2", catalog: catalog(1.5) };
    const repriced = await svc.run();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(repriced.catalogHash).toBe("h2");
    expect(repriced.diffs?.filter((d) => d.field === "input").length).toBeGreaterThan(1);

    // After a day it revalidates; 304 keeps the stored slice.
    now = new Date("2026-11-01T11:00:00Z");
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 304 }));
    const same = await svc.run();
    expect(fetchFn.mock.calls[1]?.[1]?.headers).toEqual({ "If-None-Match": '"e1"' });
    expect(same).toMatchObject({ status: "ok", checkedAt: now.toISOString() });

    fetchFn.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await svc.run(true)).toMatchObject({ status: "unknown", diffs: null, error: "fetch failed" });
  });
});
