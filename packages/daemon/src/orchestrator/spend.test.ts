import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordSpend } from "../providers/ledger.ts";
import { Store } from "../store.ts";
import { capResetsAt, capWindow, reachedCaps, recordRunSpend, spendCredential } from "./spend.ts";
import { candidate, cleanTemps, model, tempDir } from "./testing.ts";

const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  cleanTemps();
});

function db(caps: { daily?: number | null; task?: number | null } = {}) {
  const store = new Store(join(tempDir(), "spend.db"));
  stores.push(store);
  store.db
    .prepare("insert into credentials (id, alias, provider_id, kind, daily_cap_usd, task_cap_usd, created_at) values ('cred', 'ds', 'deepseek', 'api_key', ?, ?, '2026-10-30T00:00:00Z')")
    .run(caps.daily ?? null, caps.task ?? null);
  return store.db;
}

const paid = () => ({ ...candidate("ds", "deepseek", model("deepseek-chat")), credentialId: "cred", catalogVersion: "cat-1" });
const delta = { taskId: "t1", runId: "r1", profileId: "ds", model: "deepseek-chat", tokensIn: 1_000, tokensOut: 100, tokensCache: 0, tokensReasoning: 0, costUsd: 0.01 };
const NOW = new Date("2026-10-30T15:00:00");

describe("spend recording", () => {
  it("writes a catalog-priced delta as estimated with the catalog version, and a billed one without it", () => {
    const d = db();
    expect(recordRunSpend(d, paid(), { ...delta, billed: false, fromCatalog: true }, NOW)).toBe(true);
    expect(recordRunSpend(d, paid(), { ...delta, costUsd: 0.02, billed: true, fromCatalog: false }, NOW)).toBe(true);
    const rows = d.prepare("select credential_id, task_id, run_id, provider_id, cost_usd, source, catalog_version from spend order by id").all();
    expect(rows).toEqual([
      { credential_id: "cred", task_id: "t1", run_id: "r1", provider_id: "deepseek", cost_usd: 0.01, source: "estimated", catalog_version: "cat-1" },
      { credential_id: "cred", task_id: "t1", run_id: "r1", provider_id: "deepseek", cost_usd: 0.02, source: "billed", catalog_version: null },
    ]);
  });

  it("writes nothing for plans, keys it cannot name, or an empty delta", () => {
    const d = db();
    expect(spendCredential({ ...candidate("plan", "openai", null, "plan_signin"), credentialId: "cred" })).toBeNull();
    expect(recordRunSpend(d, { ...candidate("plan", "openai", null, "plan_signin"), credentialId: "cred" }, { ...delta, billed: false, fromCatalog: true }, NOW)).toBe(false);
    expect(recordRunSpend(d, candidate("nokey", "deepseek", null), { ...delta, billed: false, fromCatalog: true }, NOW)).toBe(false);
    expect(recordRunSpend(d, paid(), { ...delta, tokensIn: 0, tokensOut: 0, costUsd: 0, billed: false, fromCatalog: true }, NOW)).toBe(false);
    expect(d.prepare("select count(*) as n from spend").get()).toEqual({ n: 0 });
  });
});

describe("spend caps", () => {
  it("reports a used-up daily cap with its reset at local midnight, and the task cap per task", () => {
    const d = db({ daily: 0.5, task: 0.2 });
    expect(reachedCaps(d, "cred", "t1", NOW)).toEqual([]);
    recordSpend(d, { credentialId: "cred", profileId: "ds", taskId: "t1", runId: "r1", providerId: "deepseek", model: null, tokensIn: 0, tokensOut: 0, tokensCache: 0, tokensReasoning: 0, costUsd: 0.2, source: "estimated", catalogVersion: null }, NOW);
    // Exactly at the task cap counts: any further spend would pass it.
    expect(reachedCaps(d, "cred", "t1", NOW)).toEqual([{ kind: "task_cap", spentUsd: 0.2, capUsd: 0.2, credentialId: "cred" }]);
    expect(reachedCaps(d, "cred", "t2", NOW)).toEqual([]);
    recordSpend(d, { credentialId: "cred", profileId: "ds", taskId: "t2", runId: "r2", providerId: "deepseek", model: null, tokensIn: 0, tokensOut: 0, tokensCache: 0, tokensReasoning: 0, costUsd: 0.4, source: "estimated", catalogVersion: null }, NOW);
    const caps = reachedCaps(d, "cred", "t2", NOW);
    expect(caps.map((c) => c.kind)).toEqual(["daily_cap", "task_cap"]);
    expect(capWindow(caps[0]!)).toBe("budget-day");
    expect(capWindow(caps[1]!)).toBe("budget-task");
    const reset = new Date(capResetsAt(caps[0]!, NOW)!);
    expect([reset.getDate(), reset.getHours(), reset.getMinutes()]).toEqual([31, 0, 0]);
    expect(capResetsAt(caps[1]!, NOW)).toBeNull();
  });

  it("enforces nothing for an unknown or missing credential", () => {
    const d = db({ daily: 0 });
    expect(reachedCaps(d, null, "t1", NOW)).toEqual([]);
    expect(reachedCaps(d, "gone", "t1", NOW)).toEqual([]);
    expect(reachedCaps(d, "cred", "t1", NOW).map((c) => c.kind)).toEqual(["daily_cap"]);
  });
});
