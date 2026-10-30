import { basename } from "node:path";
import type { DaemonStatus, IpcMessage, IpcMethods, IpcResponse } from "@crewyard/core";
import { createCrewHandlers } from "./handlers/crew.ts";
import { createGithubHandlers } from "./handlers/github.ts";
import { createMcpHandlers } from "./handlers/mcp.ts";
import { createPreviewHandlers } from "./handlers/preview.ts";
import { createProvidersHandlers } from "./handlers/providers.ts";
import { createSettingsHandlers } from "./handlers/settings.ts";
import { createSetupHandlers } from "./handlers/setup.ts";
import { createTasksHandlers } from "./handlers/tasks.ts";
import { createWorktreesHandlers } from "./handlers/worktrees.ts";
import { createUsageHandlers } from "./handlers/usage.ts";
import type { HandlerContext, HandlerMap } from "./handlers/types.ts";
import { checkDefender, checkEnv, checkMachine, checkTool, TOOL_BINS } from "./machine.ts";
import { assertFolder, scanForRepos } from "./projects.ts";
import { readProjectConfig } from "./setup/config.ts";
import { defaultWorktreeRoot } from "./setup/detect.ts";

export type Handlers = HandlerMap<IpcMethods>;

// Base handlers live here; every area brings its own from ./handlers/<area>.ts.
export function createHandlers(ctx: HandlerContext): Handlers {
  const { store, info } = ctx;
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
    "machine.defender": ({ scanRoot }) => checkDefender(store.listProjects().map((p) => readProjectConfig(p.path)?.worktreeRoot ?? defaultWorktreeRoot(p.path)), scanRoot),
    "projects.list": () => store.listProjects(),
    "projects.scan": ({ root }) => scanForRepos(root, store.knownPaths()),
    "projects.add": ({ path, name }) => {
      const abs = assertFolder(path);
      return store.addProject(abs, name ?? basename(abs));
    },
    "projects.open": ({ projectId }) => store.markOpened(projectId),
    ...createTasksHandlers(ctx),
    ...createProvidersHandlers(ctx),
    ...createGithubHandlers(ctx),
    ...createSetupHandlers(ctx),
    ...createCrewHandlers(ctx),
    ...createSettingsHandlers(ctx),
    ...createWorktreesHandlers(ctx),
    ...createUsageHandlers(ctx),
    ...createMcpHandlers(ctx),
    ...createPreviewHandlers(ctx),
  };
}

/** Handles one request message; anything that is not a known request is ignored. */
export async function handleMessage(handlers: Handlers, msg: IpcMessage): Promise<IpcResponse | null> {
  if (msg.kind !== "request") return null;
  const handler = (handlers as Record<string, ((p: unknown) => unknown) | undefined>)[msg.method];
  if (!handler) return { kind: "response", id: msg.id, ok: false, error: `Unknown method: ${msg.method}` };
  try {
    return { kind: "response", id: msg.id, ok: true, result: await handler(msg.params) };
  } catch (err) {
    return { kind: "response", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
