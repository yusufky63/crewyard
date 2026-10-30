import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultProjectConfig } from "@crewyard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store.ts";
import { applyStagedRestore, STAGED_RESTORE } from "../settings/data.ts";
import { DEFAULT_SETTINGS } from "../settings/values.ts";
import { createSettingsHandlers } from "./settings.ts";

const temps: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => {
    try {
      s.close();
    } catch {
      // already closed by the test
    }
  });
  temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function setup() {
  // A space in the folder name, as on many Windows profiles.
  const dir = mkdtempSync(join(tmpdir(), "crewyard settings-"));
  temps.push(dir);
  const dbPath = join(dir, "crewyard.db");
  const store = new Store(dbPath);
  stores.push(store);
  const events: Array<{ topic: string; payload: unknown }> = [];
  const restart = vi.fn();
  const h = createSettingsHandlers({ store, info: { startedAt: "now", dbPath, dataDir: dir }, emit: (topic, payload) => events.push({ topic, payload }) }, { restart });
  return { dir, dbPath, store, h, events, restart };
}

/** Handlers may throw synchronously; this turns that into a rejection for `rejects`. */
const attempt = (f: () => unknown) => Promise.resolve().then(f);

/** A run that has not ended, without building a whole task and crew around it. */
function insertOpenRun(store: Store): void {
  store.db.exec("pragma foreign_keys = off");
  store.db.prepare("insert into runs (id, task_id, member_id, role, profile_id, runner, cwd, started_at) values ('r1', 't1', 'm1', 'implementer', 'p1', 'codex', 'C:\\x', ?)").run(new Date().toISOString());
  store.db.exec("pragma foreign_keys = on");
}

describe("settings values", () => {
  it("returns the defaults until something is saved, then round-trips a patch", async () => {
    const { h, events } = setup();
    expect(await h["settings.get"]()).toEqual(DEFAULT_SETTINGS);
    const next = await h["settings.update"]({ notifications: { quietHours: { enabled: true, start: "23:30" }, mutedProjects: ["a", "a", "b"] } });
    expect(next.notifications.quietHours).toEqual({ enabled: true, start: "23:30", end: "08:00" });
    expect(next.notifications.mutedProjects).toEqual(["a", "b"]);
    expect(await h["settings.get"]()).toEqual(next);
    expect(events).toEqual([{ topic: "settings.changed", payload: next }]);
  });

  it("refuses malformed values and keeps the stored ones", async () => {
    const { h } = setup();
    await expect(attempt(() => h["settings.update"]({ notifications: { quietHours: { start: "24:00" } } }))).rejects.toThrow("settings.invalid");
    await expect(attempt(() => h["settings.update"]({ notifications: { quietHours: { end: "7:00" } } }))).rejects.toThrow("settings.invalid");
    await expect(attempt(() => h["settings.update"]({ notifications: { enabled: "yes" as unknown as boolean } }))).rejects.toThrow("settings.invalid");
    await expect(attempt(() => h["settings.update"]({ notifications: { mutedProjects: [""] } }))).rejects.toThrow("settings.invalid");
    expect(await h["settings.get"]()).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps the machine-awake switch off by default and checks the battery threshold", async () => {
    const { h, store } = setup();
    expect((await h["settings.get"]()).keepAwake).toEqual({ enabled: false, minBatteryPct: 30 });
    const next = await h["settings.update"]({ keepAwake: { enabled: true, minBatteryPct: 20 } });
    expect(next.keepAwake).toEqual({ enabled: true, minBatteryPct: 20 });
    expect(next.notifications).toEqual(DEFAULT_SETTINGS.notifications);
    for (const bad of [0, 100, 22, 1.5]) await expect(attempt(() => h["settings.update"]({ keepAwake: { minBatteryPct: bad } }))).rejects.toThrow("settings.invalid");
    store.db.prepare("update settings set value = ? where key = 'app.keepAwake'").run(JSON.stringify({ enabled: true, minBatteryPct: "low" }));
    expect((await h["settings.get"]()).keepAwake).toEqual({ enabled: true, minBatteryPct: 30 });
  });

  it("keeps same-provider account switching off by default and turns it on only once the terms note is accepted", async () => {
    const { h, store } = setup();
    expect((await h["settings.get"]()).accountSwitch).toEqual({ enabled: false, termsAcceptedAt: null });
    await expect(attempt(() => h["settings.update"]({ accountSwitch: { enabled: true } }))).rejects.toThrow("settings.terms");
    expect((await h["settings.get"]()).accountSwitch.enabled).toBe(false);
    await expect(attempt(() => h["settings.update"]({ accountSwitch: { enabled: "on" as unknown as boolean, acceptTerms: true } }))).rejects.toThrow("settings.invalid");

    const on = await h["settings.update"]({ accountSwitch: { enabled: true, acceptTerms: true } });
    expect(on.accountSwitch.enabled).toBe(true);
    const accepted = on.accountSwitch.termsAcceptedAt!;
    expect(Number.isNaN(Date.parse(accepted))).toBe(false);
    // Off and on again needs no second note, and keeps the first acceptance.
    expect((await h["settings.update"]({ accountSwitch: { enabled: false } })).accountSwitch).toEqual({ enabled: false, termsAcceptedAt: accepted });
    expect((await h["settings.update"]({ accountSwitch: { enabled: true, acceptTerms: true } })).accountSwitch).toEqual({ enabled: true, termsAcceptedAt: accepted });
    // A stored "on" without an accepted note reads as off.
    store.db.prepare("update settings set value = ? where key = 'app.accountSwitch'").run(JSON.stringify({ enabled: true, termsAcceptedAt: "not a date" }));
    expect((await h["settings.get"]()).accountSwitch).toEqual({ enabled: false, termsAcceptedAt: null });
  });

  it("falls back per field when the stored value is damaged", async () => {
    const { h, store } = setup();
    store.db.prepare("insert into settings (key, value) values ('app.notifications', ?)").run(JSON.stringify({ enabled: false, quietHours: { start: "nope" }, approveFromToast: 3 }));
    const s = await h["settings.get"]();
    expect(s.notifications.enabled).toBe(false);
    expect(s.notifications.quietHours.start).toBe("22:00");
    expect(s.notifications.approveFromToast).toBe(true);
  });

  it("stores stall rules apart from notifications, inside their bounds", async () => {
    const { h, store } = setup();
    const next = await h["settings.update"]({ stalls: { noEventsMinutes: 0, sameFailureCount: 5 } });
    expect(next.stalls).toEqual({ ...DEFAULT_SETTINGS.stalls, noEventsMinutes: 0, sameFailureCount: 5 });
    expect(next.notifications).toEqual(DEFAULT_SETTINGS.notifications);
    expect(store.db.prepare("select count(*) as n from settings where key = 'app.notifications'").get()).toEqual({ n: 0 });
    await expect(attempt(() => h["settings.update"]({ stalls: { cooldownMinutes: 0 } }))).rejects.toThrow("settings.invalid");
    await expect(attempt(() => h["settings.update"]({ stalls: { requestMinutes: 2.5 } }))).rejects.toThrow("settings.invalid");
    store.db.prepare("update settings set value = ? where key = 'app.stalls'").run(JSON.stringify({ noEventsMinutes: 999, sameFailureCount: 4 }));
    expect((await h["settings.get"]()).stalls).toEqual({ ...DEFAULT_SETTINGS.stalls, sameFailureCount: 4 });
  });
});

describe("toast policy", () => {
  it("reads the project's toast rule and defaults to low without a config", async () => {
    const { h, store, dir } = setup();
    const repo = join(dir, "my repo");
    mkdirSync(join(repo, ".crewyard"), { recursive: true });
    const project = store.addProject(repo, "my repo");
    expect(await h["settings.toastPolicy"]({ projectId: project.id })).toEqual({ toastApprovals: "low" });
    const cfg = defaultProjectConfig("my repo", join(dir, "wt"));
    cfg.rules.toastApprovals = "none";
    writeFileSync(join(repo, ".crewyard", "project.json"), JSON.stringify(cfg));
    expect(await h["settings.toastPolicy"]({ projectId: project.id })).toEqual({ toastApprovals: "none" });
    await expect(attempt(() => h["settings.toastPolicy"]({ projectId: "nope" }))).rejects.toThrow("project.not_found");
  });
});

describe("backup and export", () => {
  it("writes a consistent snapshot that lists newest first", async () => {
    const { h, store } = setup();
    store.addProject("C:\\Projeler\\one app", "one app");
    const a = await h["settings.backup"]();
    const b = await h["settings.backup"]();
    expect(a.origin).toBe("manual");
    expect(a.name).toMatch(/^crewyard-manual-\d{8}-\d{6}(-\d+)?\.db$/);
    expect(b.path).not.toBe(a.path);
    const data = await h["settings.data"]();
    expect(data.backups.map((x) => x.path).sort()).toEqual([a.path, b.path].sort());
    const copy = new DatabaseSync(a.path, { readOnly: true });
    expect(copy.prepare("select name from projects").all()).toEqual([{ name: "one app" }]);
    copy.close();
  });

  it("exports only to an absolute .db path that is not the live database", async () => {
    const { h, dir, dbPath } = setup();
    await expect(attempt(() => h["settings.export"]({ path: dbPath }))).rejects.toThrow("data.path");
    await expect(attempt(() => h["settings.export"]({ path: "relative.db" }))).rejects.toThrow("data.path");
    await expect(attempt(() => h["settings.export"]({ path: join(dir, "notes.txt") }))).rejects.toThrow("data.path");
    const target = join(dir, "my export.db");
    expect((await h["settings.export"]({ path: target })).origin).toBe("export");
    await expect(attempt(() => h["settings.export"]({ path: target }))).rejects.toThrow("data.exists");
    expect((await h["settings.export"]({ path: target, overwrite: true })).path).toBe(target);
  });
});

describe("restore", () => {
  it("never runs while a run is open", async () => {
    const { h, store } = setup();
    const backup = await h["settings.backup"]();
    insertOpenRun(store);
    await expect(attempt(() => h["settings.restore"]({ path: backup.path }))).rejects.toThrow("restore.agents_running");
  });

  it("refuses files that are not a healthy Crewyard database of this or an older schema", async () => {
    const { h, dir, dbPath } = setup();
    const junk = join(dir, "junk.db");
    writeFileSync(junk, "not a database at all, just text".repeat(200));
    await expect(attempt(() => h["settings.restore"]({ path: junk }))).rejects.toThrow("restore.not_database");

    const other = join(dir, "other.db");
    const o = new DatabaseSync(other);
    o.exec("create table notes (x text); pragma user_version = 1;");
    o.close();
    await expect(attempt(() => h["settings.restore"]({ path: other }))).rejects.toThrow("restore.not_crewyard");

    const newer = join(dir, "newer.db");
    const n = new DatabaseSync(newer);
    // A newer build records a migration id this one has never heard of.
    n.exec(
      "create table projects (id text); create table events (seq integer); create table settings (key text); " +
        "create table applied_migrations (id text primary key, applied_at text not null); " +
        "insert into applied_migrations values ('core', 'x'), ('from-a-newer-build', 'x');",
    );
    n.close();
    await expect(attempt(() => h["settings.restore"]({ path: newer }))).rejects.toThrow("restore.newer_schema");

    await expect(attempt(() => h["settings.restore"]({ path: dbPath }))).rejects.toThrow("data.path");
    expect(existsSync(join(dir, STAGED_RESTORE))).toBe(false);
    expect((await h["settings.data"]()).backups).toEqual([]);
  });

  it("takes a safety snapshot, stages the file, restarts, and the next start swaps it in", async () => {
    const { h, store, dir, dbPath, restart, events } = setup();
    store.addProject("C:\\Projeler\\kept", "kept");
    const backup = await h["settings.backup"]();
    store.addProject("C:\\Projeler\\later", "later");

    const res = await h["settings.restore"]({ path: backup.path });
    expect(res.safetyBackup.origin).toBe("safety");
    expect(restart).toHaveBeenCalledOnce();
    expect(events.some((e) => e.topic === "settings.restoring")).toBe(true);
    expect(existsSync(join(dir, STAGED_RESTORE))).toBe(true);

    // What the daemon does on its next start.
    store.close();
    expect(applyStagedRestore(dir, dbPath)).toBe(true);
    const reopened = new Store(dbPath);
    stores.push(reopened);
    expect(reopened.listProjects().map((p) => p.name)).toEqual(["kept"]);
    expect(existsSync(join(dir, STAGED_RESTORE))).toBe(false);
    // The safety snapshot still holds what was replaced.
    const safety = new DatabaseSync(res.safetyBackup.path, { readOnly: true });
    expect((safety.prepare("select name from projects order by name").all() as Array<{ name: string }>).map((r) => r.name)).toEqual(["kept", "later"]);
    safety.close();
  });

  it("does nothing at start when no restore is staged", () => {
    const { dir, dbPath } = setup();
    expect(applyStagedRestore(dir, dbPath)).toBe(false);
  });
});
