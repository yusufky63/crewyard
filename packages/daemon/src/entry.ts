import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IpcMessage } from "@crewyard/core";
import { acquireDataDirLock, cleanOrphans, DataDirLockedError, recordDaemonStart } from "./recovery/index.ts";
import { createHandlers, handleMessage, type Handlers } from "./server.ts";
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

// Nothing touches the database before this daemon owns the folder. If another daemon holds it,
// exit: the host restarts with backoff, which also covers an old daemon that is still dying.
let lock: Awaited<ReturnType<typeof acquireDataDirLock>>;
try {
  lock = await acquireDataDirLock(dataDir);
} catch (err) {
  if (err instanceof DataDirLockedError) emit("daemon.locked", { dataDir });
  console.error(err);
  process.exit(3);
}
if (lock.unsupported) console.warn(`Data folder lock unavailable, running without it: ${lock.unsupported}`);

const dbPath = join(dataDir, "crewyard.db");
const store = new Store(dbPath);
const startedAt = new Date().toISOString();

// Agent trees left by a killed daemon go first: creating the handlers starts the orchestrator,
// which labels those runs interrupted. Requests that arrive meanwhile wait for this.
const ready: Promise<Handlers> = (async () => {
  const orphans = await cleanOrphans(store);
  if (orphans.checked) emit("daemon.recovered", orphans);
  recordDaemonStart(store, { pid: process.pid, startedAt });
  return createHandlers({ store, info: { startedAt, dbPath, dataDir }, emit });
})();

parentPort.on("message", async ({ data }) => {
  const res = await handleMessage(await ready, data as IpcMessage);
  if (res) parentPort.postMessage(res);
});

process.on("exit", () => {
  store.close();
  lock.release();
});
ready.then(
  () => emit("daemon.ready", { pid: process.pid }),
  (err: unknown) => {
    // Same as a throw at startup: exit, and the host restarts the daemon with backoff.
    console.error(err);
    process.exit(1);
  },
);
