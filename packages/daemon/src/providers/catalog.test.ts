import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store.ts";
import { CatalogService, curated } from "./catalog.ts";

const temps: string[] = [];
const stores: Store[] = [];
const newStore = () => {
  // Spaces on purpose: every Windows path we create must survive them.
  const d = mkdtempSync(join(tmpdir(), "crewyard catalog pin "));
  temps.push(d);
  const s = new Store(join(d, "t.db"));
  stores.push(s);
  return s;
};
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** models.dev api.json with one priced, tool-capable model per curated provider. */
const modelsDev = (price: number) =>
  JSON.stringify(
    Object.fromEntries(
      curated.providers
        .filter((c) => !c.manual)
        .map((c) => [c.id, { name: c.id, models: { [`${c.id}-model`]: { id: `${c.id}-model`, name: "Model", tool_call: true, cost: { input: price, output: price * 2 } } } }]),
    ),
  );

const ok = (price: number, etag: string) => new Response(modelsDev(price), { status: 200, headers: { etag } });
const priceOf = (svc: CatalogService) => svc.provider("deepseek")?.models[0]?.cost?.input;

describe("catalog pin", () => {
  it("keeps serving the pinned version while refreshes download newer ones, and unpinning switches to the newest", async () => {
    const store = newStore();
    let now = new Date("2026-10-30T10:00:00Z");
    const fetchFn = vi.fn<typeof fetch>();
    const svc = new CatalogService(store.db, fetchFn, () => now);

    fetchFn.mockResolvedValueOnce(ok(1, '"v1"'));
    const v1 = await svc.refresh(true);
    expect(v1).toMatchObject({ pinned: false, latestHash: v1.hash });

    const pinned = svc.pin(v1.hash);
    expect(pinned).toMatchObject({ hash: v1.hash, pinned: true });

    // The daily refresh still downloads and stores the new prices, but the pinned version stays active.
    now = new Date("2026-10-31T11:00:00Z");
    fetchFn.mockResolvedValueOnce(ok(2, '"v2"'));
    const afterRefresh = await svc.refresh();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(afterRefresh.hash).toBe(v1.hash);
    expect(afterRefresh.pinned).toBe(true);
    expect(afterRefresh.latestHash).not.toBe(v1.hash);
    expect(priceOf(svc)).toBe(1);

    // A restart keeps the pin.
    const restarted = new CatalogService(store.db, fetchFn, () => now);
    expect(restarted.info()).toMatchObject({ hash: v1.hash, pinned: true });

    const list = svc.snapshots();
    expect(list.find((s) => s.hash === v1.hash)).toMatchObject({ active: true, pinned: true, latest: false, origin: "models.dev" });
    expect(list.find((s) => s.hash === afterRefresh.latestHash)).toMatchObject({ active: false, pinned: false, latest: true });

    const unpinned = svc.pin(null);
    expect(unpinned).toMatchObject({ hash: afterRefresh.latestHash, pinned: false });
    expect(priceOf(svc)).toBe(2);
  });

  it("never prunes the pinned version, however many newer ones arrive", async () => {
    const store = newStore();
    let now = new Date("2026-10-30T10:00:00Z");
    const fetchFn = vi.fn<typeof fetch>();
    const svc = new CatalogService(store.db, fetchFn, () => now);
    const bundled = svc.info().hash;
    svc.pin(bundled);
    for (let i = 1; i <= 8; i++) {
      now = new Date(now.getTime() + 60_000);
      fetchFn.mockResolvedValueOnce(ok(i, `"v${i}"`));
      await svc.refresh(true);
    }
    const hashes = svc.snapshots().map((s) => s.hash);
    expect(hashes).toContain(bundled);
    expect(svc.info()).toMatchObject({ hash: bundled, pinned: true, origin: "bundled" });
    // Five newest plus the pinned one.
    expect(hashes).toHaveLength(6);
  });

  it("pins only stored versions, and unpinning with no download keeps the current one", () => {
    const svc = new CatalogService(newStore().db, vi.fn<typeof fetch>());
    const bundled = svc.info().hash;
    expect(() => svc.pin("0000000000000000")).toThrow(/Unknown catalog version/);
    svc.pin(bundled);
    expect(svc.pin(null)).toMatchObject({ hash: bundled, pinned: false });
  });
});

describe("bundled snapshot", () => {
  // Owner's "Yes, apply" on 2026-11-01 (PLAN.md §17): the models Antigravity serves on Google plans
  // are offered by API key instead. models.dev lists both under google, so they come from the
  // snapshot, not curated.json. Exact prices are not pinned: Google's pricing page schedules rises
  // (Argon from 2026-12-01, 3.8 Flash from 2027-01-01), and the next snapshot sync carries them.
  it("offers Gemini 4 Argon and Gemini 3.8 Flash by API key to Gemini CLI and OpenCode", () => {
    const svc = new CatalogService(newStore().db, vi.fn<typeof fetch>(), () => new Date("2026-11-01T00:00:00Z"));
    const google = svc.provider("google");
    expect(google?.runners).toMatchObject({ geminiCli: "native", opencode: "native" });
    expect(google?.env).toContain("GEMINI_API_KEY");
    for (const id of ["gemini-4-argon", "gemini-3.8-flash"]) {
      const cost = google?.models.find((m) => m.id === id)?.cost;
      // A listed price is what lets spend show as Estimated rather than Unknown (PLAN.md §7.1).
      expect(cost?.input, id).toBeGreaterThan(0);
      expect(cost?.output, id).toBeGreaterThan(0);
    }
  });
});
