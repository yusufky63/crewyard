import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IpcMessage } from "@crewyard/core";
import { createHandlersForEnv } from "./e2e/index.ts";
import { acquireDataDirLock, cleanOrphans, DataDirLockedError, recordDaemonStart, type DataDirLock } from "./recovery/index.ts";
import { createHandlers, handleMessage, type Handlers } from "./server.ts";
import { applyStagedRestore } from "./settings/data.ts";
import { Store } from "./store.ts";

// Runs as an Electron utility process. The main process relays renderer requests here and
// forwards responses and events back; it never touches agent processes itself.

interface ParentPort {
  on(event: "message", listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) throw new Error("The daemon must run as an Electron utility process");

const dataDir = process.env.CREWYARD_DATA_DIR;
if (!dataDir) throw new Error("CREWYARD_DATA_DIR is not set");
mkdirSync(dataDir, { recursive: true });
const emit = (topic: string, payload: unknown) => parentPort.postMessage({ kind: "event", topic, payload } satisfies IpcMessage);

const dbPath = join(dataDir, "crewyard.db");
const startedAt = new Date().toISOString();
let lock: DataDirLock | null = null;
let store: Store | null = null;

// The message listener is registered before any await: a utility process with no listener can
// exit with code 0 while startup is still awaiting, and requests sent meanwhile would be lost.
// Startup order: own the data folder, swap in a staged restore, open the database, kill the agent trees a killed daemon
// left behind, and only then create the handlers, which start the orchestrator and label those
// runs interrupted. Requests wait for all of it.
const ready: Promise<Handlers> = (async () => {
  try {
    lock = await acquireDataDirLock(dataDir);
  } catch (err) {
    // Another daemon owns the folder. Exit; the host restarts with backoff, which also covers an
    // old daemon that is still shutting down.
    if (err instanceof DataDirLockedError) emit("daemon.locked", { dataDir });
    throw err;
  }
  if (lock.unsupported) console.warn(`Data folder lock unavailable, running without it: ${lock.unsupported}`);
  // A restore chosen in Settings is swapped in here, with the folder locked and before anything
  // opens the database.
  applyStagedRestore(dataDir, dbPath);
  const s = new Store(dbPath);
  store = s;
  const orphans = await cleanOrphans(s);
  if (orphans.checked) emit("daemon.recovered", orphans);
  recordDaemonStart(s, { pid: process.pid, startedAt });
  return createHandlersForEnv({ store: s, info: { startedAt, dbPath, dataDir }, emit }, process.env, createHandlers);
})();

parentPort.on("message", async ({ data }) => {
  const res = await handleMessage(await ready, data as IpcMessage);
  if (res) parentPort.postMessage(res);
});

process.on("exit", () => {
  store?.close();
  lock?.release();
});
ready.then(
  () => emit("daemon.ready", { pid: process.pid }),
  (err: unknown) => {
    // Same as a throw at startup: exit, and the host restarts the daemon with backoff.
    console.error(err);
    process.exit(1);
  },
);
