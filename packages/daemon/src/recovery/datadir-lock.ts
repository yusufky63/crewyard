import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// One daemon per data folder. The single-instance lock in main covers one Electron app, but not
// a second copy started another way (a dev build and the installed app on the same profile, a
// daemon restarted while the old one is still dying). Two daemons on one database would both
// migrate it and both recover its runs (agent-orchestrator #3805, #3633).
//
// The lock is an OS file lock, so a crashed or killed holder releases it with no pid bookkeeping.
// It is taken through SQLite instead of a native module: in exclusive locking mode a connection
// keeps the lock of its first write until it closes, and on Windows SQLite locks with LockFileEx.
// SQLite opens files without handle inheritance, so agent processes never carry the lock.

export const LOCK_FILE = "daemon.lock";

export class DataDirLockedError extends Error {
  constructor(readonly dataDir: string) {
    super(`Another Crewyard daemon is using ${dataDir}`);
    this.name = "DataDirLockedError";
  }
}

export interface DataDirLock {
  /** Null when the folder's file system cannot lock; the daemon then runs unguarded, as before. */
  readonly unsupported: string | null;
  release(): void;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

function busy(err: unknown): boolean {
  const code = (err as { errcode?: number }).errcode;
  return code === SQLITE_BUSY || code === SQLITE_LOCKED || /database is locked|SQLITE_BUSY/i.test(String(err));
}

function tryLock(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec("pragma busy_timeout = 0; pragma locking_mode = exclusive");
    db.exec("begin exclusive");
    db.exec("create table if not exists holder (pid integer not null, at text not null)");
    db.exec("delete from holder");
    db.prepare("insert into holder (pid, at) values (?, ?)").run(process.pid, new Date().toISOString());
    db.exec("commit");
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Takes the data folder's lock, retrying for `waitMs` while another process holds it (a daemon
 * that is still shutting down). Throws DataDirLockedError if it stays held.
 */
export async function acquireDataDirLock(dataDir: string, opts: { waitMs?: number; retryMs?: number } = {}): Promise<DataDirLock> {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, LOCK_FILE);
  const end = Date.now() + (opts.waitMs ?? 3_000);
  for (;;) {
    let db: DatabaseSync;
    try {
      db = tryLock(path);
    } catch (err) {
      if (!busy(err)) return { unsupported: err instanceof Error ? err.message : String(err), release: () => {} };
      if (Date.now() >= end) throw new DataDirLockedError(dataDir);
      await new Promise((r) => setTimeout(r, opts.retryMs ?? 200));
      continue;
    }
    let held = true;
    return {
      unsupported: null,
      release: () => {
        if (!held) return;
        held = false;
        db.close();
      },
    };
  }
}
