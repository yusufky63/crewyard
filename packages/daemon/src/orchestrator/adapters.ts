import type { AgentAdapter, RunnerId } from "@crewyard/core";
import { createAdapter as createAcpAdapter, gemini } from "@crewyard/adapter-acp";
import { createAdapter as createClaudeAdapter } from "@crewyard/adapter-claude";
import { createAdapter as createCodexAdapter } from "@crewyard/adapter-codex";
import { FakeAdapter } from "@crewyard/adapter-fake";
import { createAdapter as createOpenCodeAdapter } from "@crewyard/adapter-opencode";

// One adapter instance per runner, shared by all runs of that runner. Each real adapter package
// exports `createAdapter(): AgentAdapter`; wiring one is a single line here.
// A runner missing from this map is shown as `admission.no_adapter` and never started.

export type AdapterFactory = () => AgentAdapter;

export const ADAPTER_FACTORIES: Partial<Record<RunnerId, AdapterFactory>> = {
  "claude-code": () => createClaudeAdapter(),
  codex: () => createCodexAdapter(),
  opencode: () => createOpenCodeAdapter(),
  // Gemini CLI profiles run through the ACP driver with the Gemini agent spec.
  "gemini-cli": () => createAcpAdapter({ agent: gemini }),
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
