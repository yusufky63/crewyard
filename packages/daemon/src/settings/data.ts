import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BackupEntry } from "@crewyard/core";
import { appliedMigrationIds } from "../store.ts";

// Backup, export and restore of the SQLite database (PLAN.md M6). Snapshots use VACUUM INTO, which
// reads one consistent view through the WAL, so they are safe while agents write. A restore never
// replaces the open database: the checked file is staged next to it and swapped in by the next
// daemon start, before the store opens (applyStagedRestore, called from entry.ts).

export const STAGED_RESTORE = "restore-pending.db";
const BACKUP_FILE = /^crewyard-(manual|safety)-\d{8}-\d{6}(-\d+)?\.db$/;
const DB_EXT = new Set([".db", ".sqlite", ".sqlite3"]);
/** Tables every Crewyard database has had since the first migration. */
const REQUIRED_TABLES = ["projects", "events", "settings"];

export const backupsDir = (dataDir: string) => join(dataDir, "backups");

const fail = (code: string): never => {
  throw new Error(code);
};

/** Renames over an existing file, retrying while antivirus or indexing holds it (Windows). */
export function renameRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}

const removeWithSidecars = (path: string) => ["", "-wal", "-shm", "-journal"].forEach((s) => rmSync(path + s, { force: true }));

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function entry(path: string, origin: BackupEntry["origin"]): BackupEntry {
  const st = statSync(path);
  return { path, name: basename(path), bytes: st.size, createdAt: st.mtime.toISOString(), origin };
}

/** Writes a consistent copy of `db` to `target` through a temp name, so a half-written file never looks finished. */
export function snapshot(db: DatabaseSync, target: string): void {
  const tmp = `${target}.${process.pid}.tmp`;
  removeWithSidecars(tmp);
  try {
    db.prepare("vacuum into ?").run(tmp);
    renameRetry(tmp, target);
  } finally {
    removeWithSidecars(tmp);
  }
}

/** A snapshot under <dataDir>/backups with a name that sorts by time. */
export function backupTo(db: DatabaseSync, dataDir: string, origin: "manual" | "safety", now = new Date()): BackupEntry {
  const dir = backupsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const base = `crewyard-${origin}-${stamp(now)}`;
  let target = join(dir, `${base}.db`);
  for (let i = 2; existsSync(target); i++) target = join(dir, `${base}-${i}.db`);
  snapshot(db, target);
  return entry(target, origin);
}

export function listBackups(dataDir: string): BackupEntry[] {
  const dir = backupsDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .map((name) => entry(join(dir, name), name.startsWith("crewyard-safety-") ? "safety" : "manual"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
}

/** An absolute path to a database file that is not the live database or one of its sidecars. */
export function checkDbPath(path: unknown, liveDb: string): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024 || !isAbsolute(path)) return fail("data.path");
  const abs = resolve(path);
  if (!DB_EXT.has(extname(abs).toLowerCase())) return fail("data.path");
  const live = resolve(liveDb).toLowerCase();
  const lower = abs.toLowerCase();
  if (lower === live || lower === `${live}-wal` || lower === `${live}-shm`) return fail("data.path");
  return abs;
}

export function exportTo(db: DatabaseSync, path: string, liveDb: string, overwrite: boolean): BackupEntry {
  const target = checkDbPath(path, liveDb);
  if (!existsSync(dirname(target))) return fail("data.path");
  if (existsSync(target) && !overwrite) return fail("data.exists");
  snapshot(db, target);
  return entry(target, "export");
}

/**
 * Checks that `path` is a healthy Crewyard database no newer than this build understands.
 * Opened read-write on purpose: it is always a private staged copy, and a WAL-mode file needs
 * its shared-memory file to be readable at all.
 */
export function inspectDatabase(path: string, knownIds: readonly string[]): number {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch {
    return fail("restore.not_database");
  }
  try {
    let applied: string[];
    let tables: Set<string>;
    try {
      applied = appliedMigrationIds(db);
      tables = new Set((db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
    } catch {
      return fail("restore.not_database");
    }
    const check = db.prepare("pragma integrity_check").all() as Array<{ integrity_check: string }>;
    if (check.length !== 1 || check[0]?.integrity_check !== "ok") return fail("restore.integrity");
    if (applied.length === 0 || !REQUIRED_TABLES.every((t) => tables.has(t))) return fail("restore.not_crewyard");
    // A migration this build does not know means a newer build wrote the file.
    if (applied.some((id) => !knownIds.includes(id))) return fail("restore.newer_schema");
    return applied.length;
  } finally {
    db.close();
  }
}

/**
 * Copies `source` to a private staging file and checks the copy, so a file that changes after the
 * check can never be what gets restored. Returns the staged path and its schema version.
 */
export function stageRestore(source: string, dataDir: string, liveDb: string, knownIds: readonly string[]): { staged: string; version: number } {
  const abs = checkDbPath(source, liveDb);
  if (!existsSync(abs) || !statSync(abs).isFile()) return fail("data.path");
  const tmp = join(dataDir, `${STAGED_RESTORE}.${process.pid}.tmp`);
  removeWithSidecars(tmp);
  try {
    copyFileSync(abs, tmp);
    const version = inspectDatabase(tmp, knownIds);
    // Closing the check's connection checkpoints; any sidecar left is not part of the copy.
    ["-wal", "-shm", "-journal"].forEach((s) => rmSync(tmp + s, { force: true }));
    return { staged: tmp, version };
  } catch (err) {
    removeWithSidecars(tmp);
    throw err;
  }
}

/** Marks a staged copy as the database for the next start. */
export function commitStaged(staged: string, dataDir: string): void {
  renameRetry(staged, join(dataDir, STAGED_RESTORE));
}

/**
 * Runs at daemon start before the store opens. Replaces the database with a staged restore if one
 * is waiting. The old file is not kept here: the restore already took a safety snapshot of it.
 */
export function applyStagedRestore(dataDir: string, dbPath: string): boolean {
  const staged = join(dataDir, STAGED_RESTORE);
  if (!existsSync(staged)) return false;
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  renameRetry(staged, dbPath);
  return true;
}
