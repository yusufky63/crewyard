import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IpcMessage } from "@crewyard/core";
import { cleanOrphans, recordDaemonStart } from "./recovery/index.ts";
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
const dbPath = join(dataDir, "crewyard.db");
const store = new Store(dbPath);
const startedAt = new Date().toISOString();
const emit = (topic: string, payload: unknown) => parentPort.postMessage({ kind: "event", topic, payload } satisfies IpcMessage);

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

process.on("exit", () => store.close());
ready.then(
  () => emit("daemon.ready", { pid: process.pid }),
  (err: unknown) => {
    // Same as a throw at startup: exit, and the host restarts the daemon with backoff.
    console.error(err);
    process.exit(1);
  },
);
