import { basename } from "node:path";
import type { DaemonStatus, IpcMessage, IpcMethod, IpcMethods, IpcResponse } from "@crewyard/core";
import { checkEnv, checkMachine, checkTool, TOOL_BINS } from "./machine.ts";
import { assertFolder, scanForRepos } from "./projects.ts";
import type { Store } from "./store.ts";

type Handlers = { [M in IpcMethod]: (params: IpcMethods[M]["params"]) => Promise<IpcMethods[M]["result"]> | IpcMethods[M]["result"] };

export function createHandlers(store: Store, info: { startedAt: string; dbPath: string }): Handlers {
  return {
    "daemon.status": (): DaemonStatus => ({
      state: "running",
      pid: process.pid,
      startedAt: info.startedAt,
      versions: { node: process.versions.node, sqlite: process.versions.sqlite ?? "unknown", electron: process.versions.electron ?? null },
      dbPath: info.dbPath,
    }),
    "machine.check": () => checkMachine(),
    "machine.tool": ({ id }) => {
      if (!(id in TOOL_BINS)) throw new Error(`Unknown tool: ${String(id)}`);
      return checkTool(id);
    },
    "machine.env": () => checkEnv(),
    "projects.list": () => store.listProjects(),
    "projects.scan": ({ root }) => scanForRepos(root, store.knownPaths()),
    "projects.add": ({ path, name }) => {
      const abs = assertFolder(path);
      return store.addProject(abs, name ?? basename(abs));
    },
  };
}

/** Handles one request message; anything that is not a known request is ignored. */
export async function handleMessage(handlers: Handlers, msg: IpcMessage): Promise<IpcResponse | null> {
  if (msg.kind !== "request") return null;
  const handler = handlers[msg.method] as ((p: unknown) => unknown) | undefined;
  if (!handler) return { kind: "response", id: msg.id, ok: false, error: `Unknown method: ${msg.method}` };
  try {
    return { kind: "response", id: msg.id, ok: true, result: await handler(msg.params) };
  } catch (err) {
    return { kind: "response", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
