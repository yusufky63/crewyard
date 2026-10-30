import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Catalog, PeakPricing, RequestPricing, type CatalogInfo, type CatalogModel, type CatalogProvider, type RunnerSupport } from "@crewyard/core";
import bundledJson from "../../../../catalog/providers.json" with { type: "json" };
import curatedJson from "../../../../catalog/curated.json" with { type: "json" };

// TypeScript port of catalog/sync-catalog.mjs (the build-time script), so the daemon can refresh the
// bundled snapshot from models.dev at runtime. Keep the two in step when the merge rules change.

export interface CuratedEntry {
  id: string;
  group: CatalogProvider["group"];
  claudeCode: RunnerSupport;
  codex?: RunnerSupport;
  geminiCli?: RunnerSupport;
  manual?: boolean;
  name?: string;
  api?: string;
  env?: string[];
  anthropicBase?: string;
  balance?: string;
  quota?: string;
  peak?: unknown;
  requests?: unknown;
  ref?: string;
  note?: string;
}

export interface Curated {
  checked: string;
  sources: { modelsDev: { url: string } };
  providers: CuratedEntry[];
}

interface DevModel {
  id: string;
  name: string;
  family?: string;
  tool_call?: boolean;
  status?: string;
  reasoning?: boolean;
  open_weights?: boolean;
  release_date?: string;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number };
}

interface DevProvider {
  name?: string;
  env?: string[];
  doc?: string;
  api?: string;
  npm?: string;
  models?: Record<string, DevModel>;
}

export const curated = curatedJson as unknown as Curated;
export const MODELS_DEV_URL = curated.sources.modelsDev.url;

// Read from curated.json at run time rather than from the snapshot, so a models.dev refresh
// stored before this field existed still prices DeepSeek's peak hours.
const PEAK = new Map(curated.providers.filter((c) => c.peak !== undefined).map((c) => [c.id, PeakPricing.parse(c.peak)]));

/** The provider's time-of-use pricing, or null when it bills one rate all day. */
export const peakPricingFor = (providerId: string): PeakPricing | null => PEAK.get(providerId) ?? null;

const REQUESTS = new Map(curated.providers.filter((c) => c.requests !== undefined).map((c) => [c.id, RequestPricing.parse(c.requests)]));

/** The provider's price for server-side web search and fetch requests, or null when it bills none apart from tokens. */
export const requestPricingFor = (providerId: string): RequestPricing | null => REQUESTS.get(providerId) ?? null;

// Codex reaches non-OpenAI providers through `model_providers` in a per-profile config.toml.
// These bases are not in models.dev; they come from cc-switch src/config/codexProviderPresets.ts.
const OPENAI_BASE_OVERRIDES: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  deepinfra: "https://api.deepinfra.com/v1",
};

const pickModel = (m: DevModel): CatalogModel => ({
  id: m.id,
  name: m.name,
  family: m.family ?? null,
  context: m.limit?.context ?? null,
  output: m.limit?.output ?? null,
  // models.dev prices are USD per million tokens
  cost: m.cost ? { input: m.cost.input ?? null, output: m.cost.output ?? null, cacheRead: m.cost.cache_read ?? null } : null,
  reasoning: Boolean(m.reasoning),
  openWeights: Boolean(m.open_weights),
  released: m.release_date ?? null,
});

/** Merges models.dev's api.json with curated.json. `missing` lists curated ids models.dev no longer has. */
export function buildCatalog(raw: string, cur: Curated = curated, now = new Date()): { catalog: Catalog; missing: string[] } {
  const modelsDev = JSON.parse(raw) as Record<string, DevProvider>;
  const sha = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const missing: string[] = [];
  const providers = cur.providers.map((c): CatalogProvider => {
    const src = c.manual ? undefined : modelsDev[c.id];
    if (!c.manual && !src) missing.push(c.id);
    // Coding agents need tool calls; models without them are left out.
    const models = src ? Object.values(src.models ?? {}).filter((m) => m.tool_call && m.status !== "deprecated").map(pickModel) : [];
    const openaiBase = c.api ?? OPENAI_BASE_OVERRIDES[c.id] ?? (src?.npm === "@ai-sdk/anthropic" ? null : (src?.api ?? null));
    return {
      id: c.id,
      name: c.name ?? src?.name ?? c.id,
      group: c.group,
      env: c.env ?? src?.env ?? [],
      docs: src?.doc ?? null,
      openaiBase,
      anthropicBase: c.anthropicBase ?? null,
      runners: {
        claudeCode: c.claudeCode,
        codex: c.codex ?? (openaiBase ? "config" : "none"),
        geminiCli: c.geminiCli ?? "none",
        opencode: c.manual ? "config" : "native",
      },
      balance: c.balance ?? null,
      quota: c.quota ?? null,
      ref: c.ref ?? null,
      note: c.note ?? null,
      modelCount: models.length,
      models,
    };
  });
  const catalog = Catalog.parse({
    generatedAt: now.toISOString(),
    source: { url: MODELS_DEV_URL, sha256: sha, license: "MIT" },
    curatedChecked: cur.checked,
    providers,
  });
  return { catalog, missing };
}

/** Version of a snapshot: hash of its provider data, so the same data fetched twice keeps one version. */
export const catalogHash = (c: Catalog) => createHash("sha256").update(JSON.stringify(c.providers)).digest("hex").slice(0, 16);

export const bundledCatalog = (): Catalog => Catalog.parse(bundledJson);

const REFRESH_EVERY_MS = 24 * 60 * 60_000;
const KEEP_SNAPSHOTS = 5;

type Fetch = typeof fetch;

interface SnapshotRow {
  hash: string;
  origin: "bundled" | "models.dev";
  body: string;
}

const setting = (db: DatabaseSync, key: string): string | null => (db.prepare("select value from settings where key = ?").get(key) as { value: string } | undefined)?.value ?? null;
const setSetting = (db: DatabaseSync, key: string, value: string | null) => {
  if (value === null) db.prepare("delete from settings where key = ?").run(key);
  else db.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, value);
};

/**
 * Serves the newest good snapshot. The bundled one is seeded on first use; refreshes ask models.dev
 * at most every 24 h with If-None-Match, and any failure keeps the last good snapshot in service.
 */
export class CatalogService {
  private cache: { hash: string; catalog: Catalog; origin: SnapshotRow["origin"] } | null = null;
  private inflight: Promise<CatalogInfo> | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly fetchFn: Fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  current(): { hash: string; catalog: Catalog; origin: SnapshotRow["origin"] } {
    const hash = setting(this.db, "catalog.current");
    if (this.cache && this.cache.hash === hash) return this.cache;
    const row = hash ? (this.db.prepare("select hash, origin, body from catalog_snapshots where hash = ?").get(hash) as SnapshotRow | undefined) : undefined;
    if (row) {
      this.cache = { hash: row.hash, origin: row.origin, catalog: Catalog.parse(JSON.parse(row.body)) };
      return this.cache;
    }
    const catalog = bundledCatalog();
    const seeded = this.save(catalog, "bundled");
    this.cache = { hash: seeded, catalog, origin: "bundled" };
    return this.cache;
  }

  info(): CatalogInfo {
    const { hash, catalog, origin } = this.current();
    return {
      hash,
      generatedAt: catalog.generatedAt,
      sourceSha: catalog.source.sha256,
      origin,
      providerCount: catalog.providers.length,
      modelCount: catalog.providers.reduce((n, p) => n + p.modelCount, 0),
      checkedAt: setting(this.db, "catalog.checkedAt"),
      lastError: setting(this.db, "catalog.lastError"),
    };
  }

  provider(id: string): CatalogProvider | undefined {
    return this.current().catalog.providers.find((p) => p.id === id);
  }

  /** True when the last answer from models.dev is older than 24 h (or there never was one). */
  due(): boolean {
    const checked = setting(this.db, "catalog.checkedAt");
    return !checked || this.now().getTime() - Date.parse(checked) >= REFRESH_EVERY_MS;
  }

  refresh(force = false): Promise<CatalogInfo> {
    if (!force && !this.due()) return Promise.resolve(this.info());
    this.inflight ??= this.doRefresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async doRefresh(): Promise<CatalogInfo> {
    this.current();
    const etag = setting(this.db, "catalog.etag");
    try {
      const res = await this.fetchFn(MODELS_DEV_URL, { headers: etag ? { "If-None-Match": etag } : {}, signal: AbortSignal.timeout(30_000) });
      if (res.status === 304) {
        this.markChecked(etag);
        return this.info();
      }
      if (!res.ok) throw new Error(`models.dev answered HTTP ${res.status}`);
      const { catalog, missing } = buildCatalog(await res.text(), curated, this.now());
      // A provider vanishing upstream would silently drop its models; keep the last good snapshot.
      if (missing.length) throw new Error(`models.dev no longer lists: ${missing.join(", ")}`);
      const hash = this.save(catalog, "models.dev");
      setSetting(this.db, "catalog.current", hash);
      this.markChecked(res.headers.get("etag"));
      return this.info();
    } catch (err) {
      setSetting(this.db, "catalog.lastError", err instanceof Error ? err.message : String(err));
      return this.info();
    }
  }

  private markChecked(etag: string | null): void {
    setSetting(this.db, "catalog.checkedAt", this.now().toISOString());
    setSetting(this.db, "catalog.etag", etag);
    setSetting(this.db, "catalog.lastError", null);
  }

  /** Stores a snapshot under its hash, makes it current when none is, and prunes old ones. */
  private save(catalog: Catalog, origin: SnapshotRow["origin"]): string {
    const hash = catalogHash(catalog);
    this.db
      .prepare("insert or ignore into catalog_snapshots (hash, origin, generated_at, source_sha, created_at, body) values (?, ?, ?, ?, ?, ?)")
      .run(hash, origin, catalog.generatedAt, catalog.source.sha256, this.now().toISOString(), JSON.stringify(catalog));
    if (!setting(this.db, "catalog.current")) setSetting(this.db, "catalog.current", hash);
    // Spend rows keep the hash as their price version; the newest few bodies are enough to show them.
    this.db
      .prepare(
        `delete from catalog_snapshots where hash not in (select hash from catalog_snapshots order by created_at desc limit ?)
           and hash <> coalesce((select value from settings where key = 'catalog.current'), '')`,
      )
      .run(KEEP_SNAPSHOTS);
    return hash;
  }
}
