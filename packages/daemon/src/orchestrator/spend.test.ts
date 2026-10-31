import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultProjectConfig } from "@crewyard/core";
import { afterEach, describe, expect, it } from "vitest";
import { recordSpend } from "../providers/ledger.ts";
import { Store } from "../store.ts";
import { capResetsAt, capWindow, projectDailyCap, projectDailyCapUsd, projectSpentToday, reachedCaps, recordRunSpend, reserveSpend, settleReservation, spendCredential } from "./spend.ts";
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

describe("project daily cap", () => {
  // Two projects, each with one task; the ledger rows name tasks, the cap sums them per project.
  function projects() {
    const d = db();
    const add = (id: string, path: string) => d.prepare("insert into projects (id, name, path, added_at) values (?, ?, ?, '2026-10-30T00:00:00Z')").run(id, id, path);
    add("p1", "C:\\work\\demo repo");
    add("p2", "C:\\work\\öteki proje");
    const task = (id: string, projectId: string) =>
      d
        .prepare("insert into tasks (id, project_id, title, description, kind, size, fallback, wait_reset_minutes, classification, created_at) values (?, ?, 'Görev', '', 'research', 'S', 'manual', 0, '{}', '2026-10-30T00:00:00Z')")
        .run(id, projectId);
    task("t1", "p1");
    task("t1b", "p1");
    task("t2", "p2");
    return d;
  }
  const spend = (d: ReturnType<typeof db>, taskId: string | null, runId: string | null, costUsd: number, at = NOW) =>
    recordSpend(d, { credentialId: "cred", profileId: "ds", taskId, runId, providerId: "deepseek", model: null, tokensIn: 0, tokensOut: 0, tokensCache: 0, tokensReasoning: 0, costUsd, source: "estimated", catalogVersion: null }, at);

  it("sums today's ledger spend over every task of the project, and nothing else", () => {
    const d = projects();
    spend(d, "t1", "r1", 0.25);
    spend(d, "t1b", "r2", 0.5);
    // Another project, an assistant chat (no task) and yesterday all stay out.
    spend(d, "t2", "r3", 4);
    spend(d, null, null, 3);
    spend(d, "t1", "r0", 7, new Date("2026-10-29T23:59:00"));
    expect(projectSpentToday(d, "p1", NOW)).toBe(0.75);
    expect(projectSpentToday(d, "p2", NOW)).toBe(4);
    expect(projectSpentToday(d, "nope", NOW)).toBe(0);
  });

  it("holds once committed spend reaches the cap, counting other runs' holds and the step's estimate", () => {
    const d = projects();
    expect(projectDailyCap(d, "p1", null, NOW)).toBeNull();
    expect(projectDailyCap(d, "p1", 1, NOW)).toBeNull();
    spend(d, "t1", "r1", 0.6);
    expect(projectDailyCap(d, "p1", 1, NOW)).toBeNull();
    // A step whose estimate does not fit in what is left is held before it starts.
    expect(projectDailyCap(d, "p1", 1, NOW, { addUsd: 0.5 })).toEqual({ kind: "project_daily", spentUsd: 0.6, capUsd: 1, credentialId: null, estimateUsd: 0.5 });
    expect(projectDailyCap(d, "p1", 1, NOW, { addUsd: 0.4 })).toBeNull();
    // A run of another task of the project holds $0.3 it has not spent yet (F3).
    reserveSpend(d, { runId: "r9", taskId: "t1b", credentialId: "cred", amountUsd: 0.3 }, NOW);
    expect(projectDailyCap(d, "p1", 1, NOW, { addUsd: 0.2 })).toEqual({ kind: "project_daily", spentUsd: 0.6, capUsd: 1, credentialId: null, reservedUsd: 0.3, estimateUsd: 0.2 });
    // Its own hold never counts against itself, and a hold in another project is not this one's.
    expect(projectDailyCap(d, "p1", 1, NOW, { addUsd: 0.2, excludeRunId: "r9" })).toBeNull();
    expect(projectDailyCap(d, "p2", 0.5, NOW, { addUsd: 0.2 })).toBeNull();
    settleReservation(d, "r9", NOW);
    expect(projectDailyCap(d, "p1", 1, NOW, { addUsd: 0.2 })).toBeNull();
    // Exactly at the cap counts: any further spend would pass it.
    spend(d, "t1b", "r2", 0.4);
    expect(projectDailyCap(d, "p1", 1, NOW)).toEqual({ kind: "project_daily", spentUsd: 1, capUsd: 1, credentialId: null });
    // A cap of zero holds every paid run.
    expect(projectDailyCap(d, "p2", 0, NOW)).toMatchObject({ kind: "project_daily", spentUsd: 0, capUsd: 0 });
  });

  it("is a daily window that resets at local midnight", () => {
    const cap = { kind: "project_daily" as const, spentUsd: 1, capUsd: 1, credentialId: null };
    expect(capWindow(cap)).toBe("budget-day");
    const reset = new Date(capResetsAt(cap, NOW)!);
    expect([reset.getDate(), reset.getHours(), reset.getMinutes()]).toEqual([31, 0, 0]);
  });

  it("comes from the project's file: none without one, its value with one, the default when the file is broken", () => {
    const root = join(tempDir(), "proje klasörü");
    mkdirSync(join(root, ".crewyard"), { recursive: true });
    const project = { path: root, name: "demo repo" };
    expect(projectDailyCapUsd({ path: join(root, "yok"), name: "x" })).toBeNull();
    const cfg = defaultProjectConfig("demo repo", join(root, "worktrees"));
    cfg.budget.dailyUsd = 2.5;
    writeFileSync(join(root, ".crewyard", "project.json"), JSON.stringify(cfg));
    expect(projectDailyCapUsd(project)).toBe(2.5);
    cfg.budget.dailyUsd = 0;
    writeFileSync(join(root, ".crewyard", "project.json"), JSON.stringify(cfg));
    expect(projectDailyCapUsd(project)).toBe(0);
    // A cap the user set is never dropped because its file stopped parsing.
    writeFileSync(join(root, ".crewyard", "project.json"), "{ not json");
    expect(projectDailyCapUsd(project)).toBe(defaultProjectConfig("x", "y").budget.dailyUsd);
  });
});
