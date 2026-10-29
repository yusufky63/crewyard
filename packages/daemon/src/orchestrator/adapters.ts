import type { AgentAdapter, RunnerId } from "@crewyard/core";
import { FakeAdapter } from "@crewyard/adapter-fake";

// One adapter instance per runner, shared by all runs of that runner. Each real adapter package
// exports `createAdapter(): AgentAdapter`; wiring one is a single line here, e.g.
//   codex: () => createCodexAdapter(),
// A runner missing from this map is shown as `admission.no_adapter` and never started.

export type AdapterFactory = () => AgentAdapter;

export const ADAPTER_FACTORIES: Partial<Record<RunnerId, AdapterFactory>> = {
  // An empty script finishes at once; tests pass their own scripted adapters instead.
  fake: () => new FakeAdapter([]),
};

export class AdapterRegistry {
  private readonly instances = new Map<RunnerId, AgentAdapter>();

  constructor(private readonly factories: Partial<Record<RunnerId, AdapterFactory>> = ADAPTER_FACTORIES) {}

  has(runner: RunnerId): boolean {
    return this.instances.has(runner) || runner in this.factories;
  }

  get(runner: RunnerId): AgentAdapter | null {
    const existing = this.instances.get(runner);
    if (existing) return existing;
    const factory = this.factories[runner];
    if (!factory) return null;
    const adapter = factory();
    this.instances.set(runner, adapter);
    return adapter;
  }

  /** Registers a ready-made instance, used by tests and by adapters that need setup first. */
  set(runner: RunnerId, adapter: AgentAdapter): void {
    this.instances.set(runner, adapter);
  }
}
