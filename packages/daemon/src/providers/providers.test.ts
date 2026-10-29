import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogProvider } from "@crewyard/core";
import { Store } from "../store.ts";
import { balanceKind, fetchBalance, parseBalance } from "./balances.ts";
import { buildCatalog, CatalogService, curated } from "./catalog.ts";
import { dpapi, type Protector } from "./dpapi.ts";
import { checkBudget, recordSpend, setThresholds, spendSummary } from "./ledger.ts";
import { SecretStore } from "./secrets.ts";
import { ProvidersService } from "./service.ts";
import { checkAlias, validateProfile } from "./validate.ts";

const temps: string[] = [];
// Spaces on purpose: every Windows path we create must survive them.
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "crewyard providers "));
  temps.push(d);
  return d;
};
const stores: Store[] = [];
const newStore = () => {
  const s = new Store(join(tempDir(), "t.db"));
  stores.push(s);
  return s;
};
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** Reversible stand-in for DPAPI so the service can be tested off Windows. Not encryption. */
const fakeProtector: Protector = {
  protect: async (b) => Buffer.from(b.toString("base64").split("").reverse().join("")),
  unprotect: async (b) => Buffer.from(b.toString().split("").reverse().join(""), "base64"),
};

/** A models.dev api.json with one tool-capable model per curated provider. */
function modelsDevFixture(price = 1, drop: string[] = []): string {
  const out: Record<string, unknown> = {};
  for (const c of curated.providers) {
    if (c.manual || drop.includes(c.id)) continue;
    out[c.id] = {
      name: c.id.toUpperCase(),
      env: [`${c.id.toUpperCase().replace(/-/g, "_")}_API_KEY`],
      api: `https://${c.id}.example/v1`,
      ...(c.id === "anthropic" ? { npm: "@ai-sdk/anthropic" } : {}),
      models: {
        [`${c.id}-model`]: { id: `${c.id}-model`, name: "Model", tool_call: true, limit: { context: 1000, output: 100 }, cost: { input: price, output: price * 2 }, release_date: "2026-10-01" },
        [`${c.id}-old`]: { id: `${c.id}-old`, name: "Old", tool_call: true, status: "deprecated" },
        [`${c.id}-chat`]: { id: `${c.id}-chat`, name: "Chat only", tool_call: false },
      },
    };
  }
  return JSON.stringify(out);
}

const response = (status: number, body = "", headers: Record<string, string> = {}) => new Response(status === 304 ? null : body, { status, headers });

describe("catalog", () => {
  it("builds the same shape as sync-catalog.mjs", () => {
    const { catalog, missing } = buildCatalog(modelsDevFixture());
    expect(missing).toEqual([]);
    const ds = catalog.providers.find((p) => p.id === "deepseek");
    expect(ds?.models.map((m) => m.id)).toEqual(["deepseek-model"]);
    expect(ds?.runners).toEqual({ claudeCode: "direct", codex: "config", geminiCli: "none", opencode: "native" });
    expect(ds?.balance).toBe("https://api.deepseek.com/user/balance");
    expect(catalog.providers.find((p) => p.id === "groq")?.openaiBase).toBe("https://api.groq.com/openai/v1");
    expect(catalog.providers.find((p) => p.id === "ollama-local")?.runners.opencode).toBe("config");
  });

  it("seeds the bundled snapshot, refreshes with ETag at most daily and keeps the last good one offline", async () => {
    const store = newStore();
    let now = new Date("2026-10-30T10:00:00Z");
    const fetchFn = vi.fn<typeof fetch>();
    const svc = new CatalogService(store.db, fetchFn, () => now);

    const bundled = svc.info();
    expect(bundled.origin).toBe("bundled");
    expect(bundled.providerCount).toBeGreaterThan(30);

    fetchFn.mockResolvedValueOnce(response(200, modelsDevFixture(), { etag: '"v1"' }));
    const fresh = await svc.refresh();
    expect(fresh.origin).toBe("models.dev");
    expect(fresh.hash).not.toBe(bundled.hash);
    expect(fresh.checkedAt).toBe(now.toISOString());

    // Within 24 h nothing is fetched.
    now = new Date("2026-10-30T20:00:00Z");
    await svc.refresh();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // After 24 h it asks with If-None-Match; 304 keeps the snapshot and moves checkedAt.
    now = new Date("2026-10-31T11:00:00Z");
    fetchFn.mockResolvedValueOnce(response(304));
    const same = await svc.refresh();
    expect(fetchFn.mock.calls[1]?.[1]?.headers).toEqual({ "If-None-Match": '"v1"' });
    expect(same.hash).toBe(fresh.hash);
    expect(same.checkedAt).toBe(now.toISOString());

    // Offline: the error is recorded and the last good snapshot keeps serving.
    fetchFn.mockRejectedValueOnce(new TypeError("fetch failed"));
    const offline = await svc.refresh(true);
    expect(offline.hash).toBe(fresh.hash);
    expect(offline.lastError).toContain("fetch failed");

    // A provider vanishing upstream is refused rather than silently dropped.
    fetchFn.mockResolvedValueOnce(response(200, modelsDevFixture(2, ["deepseek"]), { etag: '"v2"' }));
    const partial = await svc.refresh(true);
    expect(partial.hash).toBe(fresh.hash);
    expect(partial.lastError).toContain("deepseek");

    // New prices make a new version; the old one stays stored for spend rows that cite it.
    fetchFn.mockResolvedValueOnce(response(200, modelsDevFixture(3), { etag: '"v3"' }));
    const priced = await svc.refresh(true);
    expect(priced.hash).not.toBe(fresh.hash);
    expect(priced.lastError).toBeNull();
    expect(svc.provider("deepseek")?.models[0]?.cost?.input).toBe(3);
    const hashes = (store.db.prepare("select hash from catalog_snapshots").all() as Array<{ hash: string }>).map((r) => r.hash);
    expect(hashes).toEqual(expect.arrayContaining([bundled.hash, fresh.hash, priced.hash]));

    // A restart serves the stored current snapshot, not the bundled one.
    expect(new CatalogService(store.db, fetchFn, () => now).info().hash).toBe(priced.hash);
  });
});

describe("secrets", () => {
  it.runIf(process.platform === "win32")("round-trips a key through DPAPI and never writes it in the clear", { timeout: 30_000 }, async () => {
    const secrets = new SecretStore(tempDir(), dpapi);
    const id = "8f0c2f7e-6c1e-4c2a-9d7e-0a1b2c3d4e5f";
    const key = "sk-test-çalışma 0123456789";
    await secrets.set(id, key);
    expect(secrets.has(id)).toBe(true);
    const file = readFileSync(join(secrets["dir"], `${id}.bin`));
    expect(file.includes(Buffer.from(key))).toBe(false);
    expect(file.includes(Buffer.from("0123456789"))).toBe(false);
    expect(await secrets.get(id)).toBe(key);
    secrets.remove(id);
    expect(await secrets.get(id)).toBeNull();
  });

  it("refuses ids that could escape the secrets folder", async () => {
    const secrets = new SecretStore(tempDir(), fakeProtector);
    await expect(secrets.set("..\\evil", "x")).rejects.toThrow("Invalid credential id");
  });
});

describe("profile validation", () => {
  const { catalog } = buildCatalog(modelsDevFixture());
  const p = (id: string) => catalog.providers.find((x) => x.id === id) as CatalogProvider;
  const key = (providerId: string, isSet = true) => ({ id: "c", alias: "k", providerId, kind: "api_key" as const, isSet, caps: { dailyUsd: null, taskUsd: null }, createdAt: "" });

  it("accepts direct, config and native routes", () => {
    expect(() => validateProfile({ alias: "ds", runner: "claude-code", providerId: "deepseek", credentialId: "c", defaultModel: "deepseek-model" }, p("deepseek"), key("deepseek"))).not.toThrow();
    expect(() => validateProfile({ alias: "ds", runner: "codex", providerId: "deepseek", credentialId: "c", defaultModel: null }, p("deepseek"), key("deepseek"))).not.toThrow();
    // Codex on OpenAI may sign in through its own login instead of a key.
    expect(() => validateProfile({ alias: "work", runner: "codex", providerId: "openai", credentialId: null, defaultModel: null }, p("openai"), null)).not.toThrow();
    expect(() => validateProfile({ alias: "local", runner: "claude-code", providerId: "ollama-local", credentialId: null, defaultModel: "llama" }, p("ollama-local"), null)).not.toThrow();
  });

  it("rejects converter routes, missing keys and foreign credentials", () => {
    expect(() => validateProfile({ alias: "x", runner: "claude-code", providerId: "openai", credentialId: "c", defaultModel: null }, p("openai"), key("openai"))).toThrow(/converter/);
    expect(() => validateProfile({ alias: "x", runner: "codex", providerId: "anthropic", credentialId: "c", defaultModel: null }, p("anthropic"), key("anthropic"))).toThrow(/cannot use/);
    expect(() => validateProfile({ alias: "x", runner: "claude-code", providerId: "anthropic", credentialId: null, defaultModel: null }, p("anthropic"), null)).toThrow(/API key/);
    expect(() => validateProfile({ alias: "x", runner: "codex", providerId: "deepseek", credentialId: null, defaultModel: null }, p("deepseek"), null)).toThrow(/only with an API key/);
    expect(() => validateProfile({ alias: "x", runner: "claude-code", providerId: "deepseek", credentialId: "c", defaultModel: null }, p("deepseek"), key("moonshotai"))).toThrow(/belongs to/);
    expect(() => validateProfile({ alias: "x", runner: "claude-code", providerId: "deepseek", credentialId: "c", defaultModel: null }, p("deepseek"), key("deepseek", false))).toThrow(/no key/);
    expect(() => validateProfile({ alias: "x", runner: "claude-code", providerId: "deepseek", credentialId: "c", defaultModel: "gpt-9" }, p("deepseek"), key("deepseek"))).toThrow(/no model/);
    expect(() => validateProfile({ alias: "x", runner: "claude-code", providerId: "nope", credentialId: null, defaultModel: null }, undefined, null)).toThrow(/Unknown provider/);
  });

  it("keeps aliases safe as Windows folder names", () => {
    expect(checkAlias(" work-1 ")).toBe("work-1");
    for (const bad of ["", "..", "a/b", "a\\b", "con", "LPT1", "trailing.", "-lead", "x".repeat(41)]) expect(() => checkAlias(bad), bad).toThrow();
  });
});

describe("balances", () => {
  const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8")) as unknown;

  it("maps every curated balance endpoint to a parser", () => {
    for (const c of curated.providers.filter((x) => x.balance)) expect(balanceKind(c.balance as string), c.id).not.toBeNull();
    expect(balanceKind("https://evil.example/api.deepseek.com")).toBeNull();
  });

  it("parses the documented response shapes", () => {
    // DeepSeek lists a CNY and a USD wallet; the empty one is hidden when the other has money.
    expect(parseBalance("deepseek", fixture("deepseek"))).toEqual([{ amount: 23.1, currency: "USD" }]);
    expect(parseBalance("deepseek", { balance_infos: [{ currency: "CNY", total_balance: "0.00" }] })).toEqual([{ amount: 0, currency: "CNY" }]);
    expect(parseBalance("openrouter", fixture("openrouter"))).toEqual([{ amount: 11.1235, currency: "USD" }]);
    expect(parseBalance("novita", fixture("novita"))).toEqual([{ amount: 12.3456, currency: "USD" }]);
    expect(parseBalance("stepfun", fixture("stepfun"))).toEqual([{ amount: 42.5, currency: "CNY" }]);
    expect(parseBalance("siliconflow", fixture("siliconflow"))).toEqual([{ amount: 88.88, currency: "USD" }]);
    expect(parseBalance("siliconflow-cn", fixture("siliconflow"))).toEqual([{ amount: 88.88, currency: "CNY" }]);
    expect(() => parseBalance("openrouter", { data: {} })).toThrow(/missing/);
  });

  it("sends the key only in the Authorization header and keeps it out of errors", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(401, "{}"));
    const err = await fetchBalance("https://api.deepseek.com/user/balance", "sk-secret-value", fetchFn).catch((e: Error) => e);
    expect(String(err)).toContain("HTTP 401");
    expect(String(err)).not.toContain("sk-secret-value");
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("sk-secret");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-secret-value");
  });
});

describe("providers service", () => {
  const setup = () => {
    const store = newStore();
    const dataDir = tempDir();
    const fetchFn = vi.fn<typeof fetch>();
    const svc = new ProvidersService({ db: store.db, dataDir, protector: fakeProtector, fetchFn, now: () => new Date("2026-10-30T12:00:00") });
    return { store, dataDir, fetchFn, svc };
  };

  it("stores keys outside the database and exposes only aliases", async () => {
    const { store, svc } = setup();
    const c = await svc.addCredential("ds-main", "deepseek", "sk-abc");
    expect(c).toMatchObject({ alias: "ds-main", isSet: true, kind: "api_key" });
    expect(JSON.stringify(svc.listCredentials())).not.toContain("sk-abc");
    expect(JSON.stringify(store.db.prepare("select * from credentials").all())).not.toContain("sk-abc");
    expect(await svc.secrets.get(c.id)).toBe("sk-abc");
    await expect(svc.addCredential("DS-MAIN", "deepseek", "sk-x")).rejects.toThrow(/already exists/);
    await expect(svc.addCredential("empty", "deepseek", "  ")).rejects.toThrow(/API key/);
  });

  it("creates, renames and deletes profiles with their own config folder", async () => {
    const { dataDir, svc } = setup();
    const c = await svc.addCredential("ds-main", "deepseek", "sk-abc");
    const model = svc.catalog.provider("deepseek")?.models[0]?.id ?? null;
    const p = svc.createProfile({ alias: "ds", runner: "claude-code", providerId: "deepseek", credentialId: c.id, defaultModel: model });
    expect(p.configDir).toBe(join(dataDir, "profiles", "claude-code", "ds"));
    expect(existsSync(p.configDir)).toBe(true);
    expect(() => svc.removeCredential(c.id)).toThrow(/Still used/);
    const renamed = svc.updateProfile(p.id, { alias: "ds-2" });
    expect(existsSync(p.configDir)).toBe(false);
    expect(existsSync(renamed.configDir)).toBe(true);
    svc.deleteProfile(p.id);
    expect(existsSync(renamed.configDir)).toBe(false);
    svc.removeCredential(c.id);
    expect(svc.listCredentials()).toEqual([]);
  });

  it("fetches balances on demand, keeps the last amount on failure and skips fresh ones", async () => {
    const { fetchFn, svc } = setup();
    const c = await svc.addCredential("or", "openrouter", "sk-or");
    await svc.addCredential("kimi", "moonshotai", "sk-k");
    fetchFn.mockResolvedValueOnce(response(200, JSON.stringify({ data: { total_credits: 10, total_usage: 4 } })));
    const [b] = await svc.refreshBalances();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ credentialId: c.id, wallets: [{ amount: 6, currency: "USD" }], provenance: "reported", error: null });
    expect(await svc.refreshBalances(undefined, true)).toEqual([]);
    fetchFn.mockResolvedValueOnce(response(500, ""));
    const [failed] = await svc.refreshBalances(c.id);
    expect(failed).toMatchObject({ wallets: [{ amount: 6, currency: "USD" }], provenance: "reported", error: "Balance endpoint answered HTTP 500" });
    // Providers without an endpoint never get a balance row.
    expect(svc.listBalances().map((x) => x.credentialId)).toEqual([c.id]);
  });

  it("checks daily and per-task caps and sorts accounts most urgent first", async () => {
    const { store, svc } = setup();
    const a = await svc.addCredential("anthropic-main", "anthropic", "sk-a");
    const d = await svc.addCredential("ds", "deepseek", "sk-d");
    svc.setCaps(a.id, 10, 2);
    svc.setCaps(d.id, 5, null);
    const at = new Date("2026-10-30T11:00:00");
    const base = { profileId: null, runId: null, model: null, tokensIn: 0, tokensOut: 0, tokensCache: 0, tokensReasoning: 0, source: "estimated" as const, catalogVersion: null };
    recordSpend(store.db, { ...base, credentialId: a.id, taskId: "t1", providerId: "anthropic", costUsd: 1.5 }, at);
    recordSpend(store.db, { ...base, credentialId: d.id, taskId: "t1", providerId: "deepseek", costUsd: 4.2 }, at);
    // Yesterday's spend does not count against today's cap.
    recordSpend(store.db, { ...base, credentialId: d.id, taskId: "t0", providerId: "deepseek", costUsd: 9 }, new Date("2026-10-29T23:00:00"));
    const now = new Date("2026-10-30T12:00:00");
    expect(checkBudget(store.db, a.id, "t1", 0.4, now)).toMatchObject({ ok: true, todayUsd: 1.5, taskUsd: 1.5 });
    expect(checkBudget(store.db, a.id, "t1", 0.6, now)).toMatchObject({ ok: false, reason: "task_cap" });
    expect(checkBudget(store.db, d.id, null, 1, now)).toMatchObject({ ok: false, reason: "daily_cap" });
    expect(() => svc.setCaps(a.id, -1, null)).toThrow();

    const rows = svc.accounts();
    expect(rows.map((r) => r.label)).toEqual(["ds", "anthropic-main"]);
    expect(rows[0]).toMatchObject({ pct: 84, provenance: "estimated", value: { kind: "usd", usd: 4.2, capUsd: 5 } });

    const sum = spendSummary(store.db, 7, now);
    expect(sum.totalUsd).toBeCloseTo(14.7);
    expect(sum.byProvider.map((s) => s.key)).toEqual(["deepseek", "anthropic"]);
    expect(sum.todayByCredential.find((s) => s.key === d.id)?.usd).toBeCloseTo(4.2);
  });

  it("reads plan windows only when usage_samples exists, and validates thresholds", () => {
    const { store, svc } = setup();
    const p = svc.createProfile({ alias: "work", runner: "codex", providerId: "openai", credentialId: null, defaultModel: null });
    expect(svc.accounts()[0]).toMatchObject({ kind: "plan", pct: null, provenance: "unknown" });
    store.db.exec("create table usage_samples (profile_id text, window text, used_pct real, resets_at text, provenance text, observed_at text)");
    const ins = store.db.prepare("insert into usage_samples values (?, ?, ?, ?, ?, ?)");
    ins.run(p.id, "5h", 40, "2026-10-30T16:40:00Z", "reported", "2026-10-30T10:00:00Z");
    ins.run(p.id, "5h", 86, "2026-10-30T16:40:00Z", "reported", "2026-10-30T11:00:00Z");
    ins.run(p.id, "weekly", 41, null, "reported", "2026-10-30T11:00:00Z");
    expect(svc.accounts()[0]).toMatchObject({ pct: 86, window: "5h", provenance: "reported", value: { kind: "pct", pct: 86 } });
    expect(setThresholds(store.db, 75, 90)).toEqual({ warn: 75, critical: 90, rearm: 65 });
    expect(() => setThresholds(store.db, 90, 80)).toThrow();
  });
});
