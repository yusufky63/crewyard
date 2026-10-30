import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IpcMessage } from "@crewyard/core";
import { createHandlers, handleMessage } from "./server.ts";
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
const dbPath = join(dataDir, "crewyard.db");
// A restore chosen in Settings is swapped in here, before anything opens the database.
applyStagedRestore(dataDir, dbPath);
const store = new Store(dbPath);
const emit = (topic: string, payload: unknown) => parentPort.postMessage({ kind: "event", topic, payload } satisfies IpcMessage);
const handlers = createHandlers({ store, info: { startedAt: new Date().toISOString(), dbPath, dataDir }, emit });

parentPort.on("message", async ({ data }) => {
  const res = await handleMessage(handlers, data as IpcMessage);
  if (res) parentPort.postMessage(res);
});

process.on("exit", () => store.close());
emit("daemon.ready", { pid: process.pid });
