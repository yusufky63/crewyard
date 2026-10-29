import { join } from "node:path";
import type { FakeStep } from "@crewyard/adapter-fake";
import { afterAll, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../orchestrator/adapters.ts";
import type { Candidate } from "../orchestrator/directory.ts";
import { Orchestrator } from "../orchestrator/orchestrator.ts";
import { candidate, cleanTemps, model, ScriptedAdapter, tempDir, tempRepo, waitFor } from "../orchestrator/testing.ts";
import { Store } from "../store.ts";

// `pnpm stress` (PLAN.md M6): 20 runs at once through admission control with the fake runner,
// three rounds on one daemon. Four projects with one profile each, 5 tasks per project, so both
// caps bind: per profile (2) holds each project to 2 runs and the global cap (6) holds the 8 that
// would otherwise fit. Memory is measured after a forced GC, so it shows what stays retained.

const ROUNDS = 3;
const PROJECTS = 4;
const TASKS_PER_PROJECT = 5;
const LIMITS = { perProfile: 2, globalSlots: 6, minFreeMb: 1024 };

const gc = (globalThis as { gc?: () => void }).gc;
const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;
const retained = () => {
  gc?.();
  gc?.();
  return process.memoryUsage();
};

// Each run streams 40 deltas with short waits, so runs overlap for a few hundred milliseconds.
const script: FakeStep[] = [
  { emit: { type: "run.state", state: "running" } },
  ...Array.from({ length: 40 }, (_, i): FakeStep[] => [{ emit: { type: "message.delta", text: `chunk ${i} `.repeat(20) } }, { wait: 8 }]).flat(),
  { emit: { type: "usage.update", tokensIn: 1200, tokensOut: 800, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, costProvenance: "unknown", contextUsed: null, contextSize: null } },
];

describe("admission under load", () => {
  const store: Store[] = [];
  afterAll(() => {
    store.forEach((s) => s.close());
    cleanTemps();
  });

  it(`keeps the caps with ${PROJECTS * TASKS_PER_PROJECT} runs at once, ${ROUNDS} rounds, and memory stays flat`, async () => {
    expect(gc, "run through `pnpm stress` (needs --expose-gc)").toBeTypeOf("function");
    const root = tempDir("crewyard stress-");
    const s = new Store(join(root, "crewyard.db"));
    store.push(s);
    const projects = [];
    const byProject = new Map<string, Candidate[]>();
    for (let p = 0; p < PROJECTS; p++) {
      const repo = await tempRepo(root, `project ${p}`);
      const project = s.addProject(repo, `project ${p}`);
      projects.push(project);
      byProject.set(project.id, [candidate(`profile-${p}`, `provider-${p}`, model(`model-${p}`))]);
    }
    const adapter = new ScriptedAdapter(() => script);
    const adapters = new AdapterRegistry({});
    adapters.set("fake", adapter);
    const o = new Orchestrator({
      store: s,
      dataDir: join(root, "data"),
      emit: () => {},
      adapters,
      directory: { candidates: (id) => byProject.get(id) ?? [], envFor: () => ({}) },
      tickMs: 25,
      freeMemoryMb: () => 64_000,
      limits: LIMITS,
    });
    o.start();

    const baseline = retained();
    const rounds: Array<{ round: number; ms: number; peakGlobal: number; peakPerProfile: number; heapMb: number; rssMb: number }> = [];
    let peakHeap = baseline.heapUsed;
    try {
      for (let round = 1; round <= ROUNDS; round++) {
        let peakGlobal = 0;
        let peakPerProfile = 0;
        const sampler = setInterval(() => {
          const c = o.db.activeCounts();
          peakGlobal = Math.max(peakGlobal, c.total);
          for (const n of c.byProfile.values()) peakPerProfile = Math.max(peakPerProfile, n);
          peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        }, 2);
        const t0 = Date.now();
        const ids: string[] = [];
        for (const project of projects) {
          for (let i = 0; i < TASKS_PER_PROJECT; i++) {
            const t = await o.propose({ projectId: project.id, title: `Research option ${round}.${i} for the session store` });
            await o.approve({ taskId: t.id });
            ids.push(t.id);
          }
        }
        await waitFor(() => ids.every((id) => o.get(id).status === "done"), 240_000);
        clearInterval(sampler);
        const m = retained();
        rounds.push({ round, ms: Date.now() - t0, peakGlobal, peakPerProfile, heapMb: mb(m.heapUsed), rssMb: mb(m.rss) });
        expect(peakGlobal).toBeLessThanOrEqual(LIMITS.globalSlots);
        expect(peakPerProfile).toBeLessThanOrEqual(LIMITS.perProfile);
      }
    } finally {
      o.shutdown();
      await o.settle();
    }

    const events = Number((s.db.prepare("select count(*) n from events").get() as { n: number }).n);
    const runs = Number((s.db.prepare("select count(*) n from runs").get() as { n: number }).n);
    const report = { baselineHeapMb: mb(baseline.heapUsed), baselineRssMb: mb(baseline.rss), peakHeapMb: mb(peakHeap), runs, events, limits: LIMITS, rounds };
    console.log(`stress report ${JSON.stringify(report, null, 2)}`);

    expect(runs).toBe(ROUNDS * PROJECTS * TASKS_PER_PROJECT);
    // Both caps were reached, so the test really pushed against them.
    expect(Math.max(...rounds.map((r) => r.peakGlobal))).toBe(LIMITS.globalSlots);
    expect(Math.max(...rounds.map((r) => r.peakPerProfile))).toBe(LIMITS.perProfile);
    // Flat means the last round retains about what the first one did: nothing per run piles up in memory.
    const growth = rounds[ROUNDS - 1]!.heapMb - rounds[0]!.heapMb;
    expect(growth).toBeLessThan(16);
  });
});
