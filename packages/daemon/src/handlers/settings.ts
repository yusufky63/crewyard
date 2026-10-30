import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppSettings, DataInfo, SettingsIpc, SettingsPatch } from "@crewyard/core";
import { orchestratorFor } from "../orchestrator/index.ts";
import { readProjectConfig } from "../setup/config.ts";
import { backupsDir, backupTo, commitStaged, exportTo, listBackups, stageRestore } from "../settings/data.ts";
import { applyPatch, NOTIFICATIONS_KEY, readNotifications } from "../settings/values.ts";
import { appliedMigrationIds, MIGRATIONS } from "../store.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for the Settings screen and the desktop shell. Owned by the desktop settings work.
// Values live in the settings table under `app.*`; backups under <dataDir>/backups.

export interface SettingsOptions {
  /** Ends the daemon so the host starts it again with the staged database. Replaced in tests. */
  restart?: () => void;
}

/** The host restarts the utility process when it exits; outside one (tests) there is nothing to restart. */
function exitForRestart(): void {
  if (!(process as unknown as { parentPort?: unknown }).parentPort) return;
  // Let the response reach the host first.
  setTimeout(() => process.exit(0), 100);
}

const size = (path: string) => (existsSync(path) ? statSync(path).size : 0);

export function createSettingsHandlers(ctx: HandlerContext, opts: SettingsOptions = {}): HandlerMap<SettingsIpc> {
  const { store, info } = ctx;
  const db = store.db;
  const restart = opts.restart ?? exitForRestart;

  const read = (): AppSettings => {
    const row = db.prepare("select value from settings where key = ?").get(NOTIFICATIONS_KEY) as { value: string } | undefined;
    return { notifications: readNotifications(row?.value) };
  };
  // How many migrations the live database has; restore accepts only files whose ids this build knows.
  const schemaVersion = () => appliedMigrationIds(db).length;
  const knownIds = MIGRATIONS.map((m) => m.id);
  const activeRuns = () => Number((db.prepare("select count(*) as n from runs where ended_at is null").get() as { n: number }).n);

  return {
    "settings.get": () => read(),
    "settings.update": (patch: SettingsPatch) => {
      const next = applyPatch(read(), patch);
      db.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(NOTIFICATIONS_KEY, JSON.stringify(next.notifications));
      ctx.emit("settings.changed", next);
      return next;
    },
    "settings.data": (): DataInfo => ({
      dataDir: info.dataDir,
      dbPath: info.dbPath,
      dbBytes: size(info.dbPath),
      walBytes: size(`${info.dbPath}-wal`),
      backupsDir: backupsDir(info.dataDir),
      secretsDir: join(info.dataDir, "secrets"),
      schemaVersion: schemaVersion(),
      activeRuns: activeRuns(),
      backups: listBackups(info.dataDir),
    }),
    "settings.backup": () => backupTo(db, info.dataDir, "manual"),
    "settings.export": ({ path, overwrite }) => exportTo(db, path, info.dbPath, overwrite === true),
    "settings.restore": ({ path }) => {
      if (activeRuns() > 0) throw new Error("restore.agents_running");
      const { staged, version } = stageRestore(path, info.dataDir, info.dbPath, knownIds);
      // Taken after the check, so a file that cannot be restored leaves no extra snapshot behind.
      const safetyBackup = backupTo(db, info.dataDir, "safety");
      commitStaged(staged, info.dataDir);
      // Nothing may start between here and the restart: the scheduler closes with the store's last writes.
      orchestratorFor(ctx).shutdown();
      ctx.emit("settings.restoring", { path });
      restart();
      return { restoredFrom: path, safetyBackup, schemaVersion: version };
    },
    "settings.toastPolicy": ({ projectId }) => {
      const row = db.prepare("select path from projects where id = ?").get(projectId) as { path: string } | undefined;
      if (!row) throw new Error("project.not_found");
      let config = null;
      try {
        config = readProjectConfig(row.path);
      } catch {
        // An unreadable file falls back to the default, as the orchestrator does.
      }
      return { toastApprovals: config?.rules.toastApprovals ?? "low" };
    },
    "app.shutdown": async () => {
      const stopped = activeRuns();
      const o = orchestratorFor(ctx);
      o.shutdown();
      await o.settle();
      return { stopped };
    },
  };
}
