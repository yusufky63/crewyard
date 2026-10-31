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

/**
 * Wraps an adapter, for another area to adjust what a run is started with (the project bridge of
 * docs/adr/0015 adds StartRequest.instructionFiles) without touching the orchestrator.
 */
export type AdapterDecorator = (runner: RunnerId, adapter: AgentAdapter) => AgentAdapter;

export class AdapterRegistry {
  private readonly instances = new Map<RunnerId, AgentAdapter>();
  private readonly decorators: AdapterDecorator[] = [];

  constructor(private readonly factories: Partial<Record<RunnerId, AdapterFactory>> = ADAPTER_FACTORIES) {}

  /** Applies `fn` to every adapter, the ones already made and the ones made later. */
  decorate(fn: AdapterDecorator): void {
    this.decorators.push(fn);
    for (const [runner, adapter] of this.instances) this.instances.set(runner, fn(runner, adapter));
  }

  private wrap(runner: RunnerId, adapter: AgentAdapter): AgentAdapter {
    return this.decorators.reduce((a, fn) => fn(runner, a), adapter);
  }

  has(runner: RunnerId): boolean {
    return this.instances.has(runner) || runner in this.factories;
  }

  get(runner: RunnerId): AgentAdapter | null {
    const existing = this.instances.get(runner);
    if (existing) return existing;
    const factory = this.factories[runner];
    if (!factory) return null;
    const adapter = this.wrap(runner, factory());
    this.instances.set(runner, adapter);
    return adapter;
  }

  /** Registers a ready-made instance, used by tests and by adapters that need setup first. */
  set(runner: RunnerId, adapter: AgentAdapter): void {
    this.instances.set(runner, this.wrap(runner, adapter));
  }
}
