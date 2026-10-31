import type { HandlerContext } from "../handlers/types.ts";
import { AdapterRegistry } from "./adapters.ts";
import { Orchestrator, type OrchestratorOptions } from "./orchestrator.ts";

export { Orchestrator, type OrchestratorOptions } from "./orchestrator.ts";
export { AdapterRegistry, ADAPTER_FACTORIES, type AdapterDecorator, type AdapterFactory } from "./adapters.ts";
export { EMPTY_DIRECTORY, type Candidate, type ProfileDirectory } from "./directory.ts";
export { OrchestratorError } from "./errors.ts";
export { classifyTask } from "./classify.ts";
export { proposeCrew } from "./crew.ts";
export { ROLES, planFor } from "./roles.ts";
export { loadRoleSet, projectRoles, ROLE_LIMITS } from "./role-files.ts";

// One orchestrator per store, so other areas reach the same instance from their own handlers,
// e.g. the providers work calls `orchestratorFor(ctx).setDirectory(...)` and `.ingestSample(...)`.
const instances = new WeakMap<object, Orchestrator>();
const registries = new WeakMap<object, AdapterRegistry>();

export function orchestratorFor(ctx: HandlerContext, overrides: Partial<OrchestratorOptions> = {}): Orchestrator {
  const existing = instances.get(ctx.store);
  if (existing) return existing;
  const adapters = overrides.adapters ?? new AdapterRegistry();
  const orchestrator = new Orchestrator({ store: ctx.store, dataDir: ctx.info.dataDir, emit: ctx.emit, ...overrides, adapters });
  instances.set(ctx.store, orchestrator);
  registries.set(ctx.store, adapters);
  orchestrator.start();
  return orchestrator;
}

/** The adapters of this store's orchestrator, so another area can decorate them (docs/adr/0015). */
export function adapterRegistryFor(ctx: HandlerContext): AdapterRegistry {
  orchestratorFor(ctx);
  return registries.get(ctx.store)!;
}
