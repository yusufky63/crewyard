import { homedir } from "node:os";
import type { AgentFilesIpc } from "@crewyard/core";
import { bridgeDecorator } from "../agentfiles/bridge.ts";
import { userBases, type ScanBases } from "../agentfiles/scan.ts";
import { AgentFilesService } from "../agentfiles/service.ts";
import { adapterRegistryFor } from "../orchestrator/index.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Settings → Instructions and skills (docs/adr/0015). Owned by the agent files work. The bridge
// wraps this store's adapters once, so every run start and resume can carry the project's bridged
// instruction files.

export interface AgentFilesHandlerOptions {
  bases?: () => ScanBases;
  env?: NodeJS.ProcessEnv;
}

const services = new WeakMap<object, AgentFilesService>();

/**
 * Your home, unless an e2e run points discovery at a temp folder: CREWYARD_E2E_HOME is read only
 * together with CREWYARD_E2E=1, which the main process deletes in a packaged build.
 */
export function homeFor(env: NodeJS.ProcessEnv): string {
  return env.CREWYARD_E2E === "1" && env.CREWYARD_E2E_HOME ? env.CREWYARD_E2E_HOME : homedir();
}

/** In an e2e run the tools' own override variables of the test machine are ignored too. */
function basesFor(env: NodeJS.ProcessEnv): ScanBases {
  const e2e = env.CREWYARD_E2E === "1" && Boolean(env.CREWYARD_E2E_HOME);
  return userBases(homeFor(env), e2e ? {} : env);
}

export function agentFilesServiceFor(ctx: HandlerContext, opts: AgentFilesHandlerOptions = {}): AgentFilesService {
  const existing = services.get(ctx.store);
  if (existing) return existing;
  const env = opts.env ?? process.env;
  const service = new AgentFilesService({ db: ctx.store.db, bases: opts.bases ?? (() => basesFor(env)), emit: ctx.emit });
  services.set(ctx.store, service);
  adapterRegistryFor(ctx).decorate(bridgeDecorator((runner, cwd) => service.instructionFilesFor(runner, cwd)));
  return service;
}

export function createAgentFilesHandlers(ctx: HandlerContext, opts: AgentFilesHandlerOptions = {}): HandlerMap<AgentFilesIpc> {
  const svc = agentFilesServiceFor(ctx, opts);
  return {
    "agentfiles.scan": ({ projectId }) => svc.scan(projectId ?? null),
    "agentfiles.shares": () => svc.shares(),
    "agentfiles.share": (p) => svc.share(p),
    "agentfiles.unshare": ({ shareId }) => svc.unshare(shareId),
    "agentfiles.sync": ({ shareId }) => svc.sync(shareId),
    "agentfiles.bridge": ({ projectId }) => svc.bridge(projectId),
    "agentfiles.bridgeSet": ({ projectId, enabled, chosen }) => svc.bridgeSet(projectId, enabled, chosen),
    "agentfiles.forSteps": ({ projectId, profileIds }) => svc.forSteps(projectId, profileIds),
  };
}
