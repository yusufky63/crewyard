import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultProjectConfig, type ProjectConfig } from "@crewyard/core";
import type { FakeStep } from "@crewyard/adapter-fake";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { AdapterRegistry } from "./adapters.ts";
import { Orchestrator } from "./orchestrator.ts";
import { globalRolesDir, repoRolesDir } from "./role-files.ts";
import { CANDIDATES, cleanTemps, ScriptedAdapter, tempDir, tempRepo, waitFor } from "./testing.ts";

// Role files through a whole task (PLAN.md §9.1): a project opts a custom role into its template,
// the proposal snapshots it, and the run gets what was approved, narrowed by the project's rules.

const open: Array<{ o: Orchestrator; store: Store }> = [];
afterEach(async () => {
  const all = open.splice(0);
  all.forEach(({ o }) => o.shutdown());
  for (const { o } of all) await o.settle();
  all.forEach(({ store }) => store.close());
  cleanTemps();
});

const running: FakeStep = { emit: { type: "run.state", state: "running" } };
const PERF = "---\ntitle: Perf check\npolicy:\n  allowCommands: [pnpm bench, pnpm test]\n  network: allowed\nindependentOf: [implementer]\n---\nBenchmark numbers before and after, with the machine they ran on.\n";

async function setup(config: (c: ProjectConfig) => void) {
  const root = tempDir("crewyard role files ");
  const repo = await tempRepo(root, "my repo");
  const cfg = defaultProjectConfig("my repo", join(root, ".crewyard", "worktrees", "my repo"));
  // An allowed command rather than the test command, which would start the run-until-green loop.
  cfg.rules.allowCommands = [...cfg.rules.allowCommands, "pnpm test"];
  config(cfg);
  mkdirSync(repoRolesDir(repo), { recursive: true });
  writeFileSync(join(repo, ".crewyard", "project.json"), JSON.stringify(cfg));
  const store = new Store(join(root, "t.db"));
  const project = store.addProject(repo, "my repo");
  const adapter = new ScriptedAdapter(() => [running, { emit: { type: "message.delta", text: "done" } }]);
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const dataDir = join(root, "data dir");
  const o = new Orchestrator({ store, dataDir, emit: () => {}, adapters, directory: { candidates: () => CANDIDATES(), envFor: () => ({}) }, tickMs: 0, freeMemoryMb: () => 64_000, stopTimeoutMs: 2_000 });
  o.start();
  open.push({ o, store });
  return { o, project, adapter, repo, dataDir };
}

const TASK = { title: "Implement rate limiting for the login endpoint", description: "Five attempts per minute per account, a clear error message, and tests for the limiter and the handler." };

describe("role files in a task", () => {
  it("runs a listed custom role as approved, with its policy narrowed by the project", async () => {
    const { o, project, adapter, repo } = await setup((c) => {
      c.customRoles = [{ role: "perf", kinds: ["code"], after: ["implementer"] }];
    });
    writeFileSync(join(repoRolesDir(repo), "perf.md"), PERF);
    const proposed = await o.propose({ projectId: project.id, ...TASK });
    const perf = proposed.crew!.members.find((m) => m.role === "perf")!;
    expect(perf).toMatchObject({ step: "perf", roleTitle: "Perf check", dependsOn: ["implementer"], writesCode: false });
    expect(perf.reasons[0]).toEqual({ code: "role.file", params: { path: join(repoRolesDir(repo), "perf.md") } });
    const impl = proposed.crew!.members.find((m) => m.role === "implementer")!;
    expect(perf.chosen?.model).not.toBe(impl.chosen?.model);

    // A change to the file after the proposal does not reach the approved crew.
    writeFileSync(join(repoRolesDir(repo), "perf.md"), PERF.replace("Benchmark numbers", "Anything you like"));
    await o.approve({ taskId: proposed.id });
    await waitFor(() => adapter.started.some((s) => s.role === "perf"), 45_000);
    const req = adapter.started.find((s) => s.role === "perf")!.req;
    expect(req.prompt).toContain("Your output: Benchmark numbers before and after");
    // Only the commands the project also allows, and the project's "ask" over the file's "allowed".
    expect(req.policy).toEqual({ writes: "none", allowCommands: ["pnpm test"], network: "ask" });
  }, 90_000);

  it("keeps the built-in templates when the project lists no custom role", async () => {
    const { o, project, repo, dataDir } = await setup(() => {});
    writeFileSync(join(repoRolesDir(repo), "perf.md"), PERF);
    mkdirSync(globalRolesDir(dataDir), { recursive: true });
    writeFileSync(join(globalRolesDir(dataDir), "reviewer.md"), "---\ntitle: House reviewer\n---\nA verdict that cites the house style guide.\n");
    const proposed = await o.propose({ projectId: project.id, ...TASK });
    expect(proposed.crew!.members.map((m) => m.role)).toEqual(["planner", "implementer", "tester", "reviewer"]);
    // A file override of a built-in applies without opting in; it can only narrow.
    const reviewer = proposed.crew!.members.find((m) => m.role === "reviewer")!;
    expect(reviewer.reasons[0]?.code).toBe("role.file");
    expect(reviewer.roleTitle).toBeUndefined();
  });
});
