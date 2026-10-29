import type { HandlerContext } from "../handlers/types.ts";
import { Orchestrator, type OrchestratorOptions } from "./orchestrator.ts";

export { Orchestrator, type OrchestratorOptions } from "./orchestrator.ts";
export { AdapterRegistry, ADAPTER_FACTORIES, type AdapterFactory } from "./adapters.ts";
export { EMPTY_DIRECTORY, type Candidate, type ProfileDirectory } from "./directory.ts";
export { OrchestratorError } from "./errors.ts";
export { classifyTask } from "./classify.ts";
export { proposeCrew } from "./crew.ts";
export { ROLES, planFor } from "./roles.ts";

// One orchestrator per store, so other areas reach the same instance from their own handlers,
// e.g. the providers work calls `orchestratorFor(ctx).setDirectory(...)` and `.ingestSample(...)`.
const instances = new WeakMap<object, Orchestrator>();

export function orchestratorFor(ctx: HandlerContext, overrides: Partial<OrchestratorOptions> = {}): Orchestrator {
  const existing = instances.get(ctx.store);
  if (existing) return existing;
  const orchestrator = new Orchestrator({ store: ctx.store, dataDir: ctx.info.dataDir, emit: ctx.emit, ...overrides });
  instances.set(ctx.store, orchestrator);
  orchestrator.start();
  return orchestrator;
}
