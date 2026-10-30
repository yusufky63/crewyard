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
