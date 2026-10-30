import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Records every process the daemon starts, while still starting the real ones.
const spawned = vi.hoisted(() => [] as string[]);
vi.mock("@crewyard/proc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@crewyard/proc")>();
  return {
    ...real,
    run: (command: string, args: string[], opts?: Parameters<typeof real.run>[2]) => {
      spawned.push(`${command} ${args.join(" ")}`);
      return real.run(command, args, opts);
    },
    start: (command: string, args: string[], opts?: Parameters<typeof real.start>[2]) => {
      spawned.push(`${command} ${args.join(" ")}`);
      return real.start(command, args, opts);
    },
  };
});

const { cleanOrphans } = await import("./recovery/index.ts");
const { createHandlers, handleMessage } = await import("./server.ts");
const { orchestratorFor } = await import("./orchestrator/index.ts");
const { Store } = await import("./store.ts");

const temps: string[] = [];
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 })));

/** A database as a busy user leaves it: `n` projects, each with a task, a worktree and a run left open. */
function seed(n: number) {
  const dir = mkdtempSync(join(tmpdir(), "crewyard boot "));
  temps.push(dir);
  const store = new Store(join(dir, "crewyard.db"));
  const at = new Date().toISOString();
  for (let i = 0; i < n; i++) {
    const project = store.addProject(join(dir, `repo ${i}`), `repo ${i}`);
    const q = (sql: string, ...args: Array<string | number | null>) => store.db.prepare(sql).run(...args);
    q("insert into tasks (id, project_id, title, description, kind, size, fallback, wait_reset_minutes, classification, created_at) values (?, ?, ?, '', 'code', 'S', 'manual', 0, '{}', ?)", `t${i}`, project.id, `task ${i}`, at);
    q("insert into crews (id, task_id, proposed_at, approved_at, estimate_provenance) values (?, ?, ?, ?, 'unknown')", `c${i}`, `t${i}`, at, at);
    q("insert into crew_members (id, crew_id, position, step, role, depends_on, required, writes_code, standby, reasons) values (?, ?, 0, 'code', 'coder', '[]', 1, 1, '[]', '[]')", `m${i}`, `c${i}`);
    const path = join(dir, ".mc", "worktrees", `repo ${i}`, `task-${i}`);
    q("insert into worktrees (id, task_id, repo_path, path, branch, base_sha, created_at) values (?, ?, ?, ?, ?, ?, ?)", `w${i}`, `t${i}`, join(dir, `repo ${i}`), path, `crewyard/task-${i}`, "0".repeat(40), at);
    q("insert into runs (id, task_id, member_id, role, profile_id, runner, cwd, worktree_id, started_at) values (?, ?, ?, 'coder', 'p', 'fake', ?, ?, ?)", `r${i}`, `t${i}`, `m${i}`, path, `w${i}`, at);
  }
  return { dir, store };
}

/** entry.ts's startup order, then the first request the window sends. */
async function boot(n: number) {
  const { dir, store } = seed(n);
  spawned.length = 0;
  const t0 = performance.now();
  await cleanOrphans(store);
  const handlers = createHandlers({ store, info: { startedAt: "now", dbPath: join(dir, "crewyard.db"), dataDir: dir }, emit: () => {} });
  const res = await handleMessage(handlers, { kind: "request", id: "1", method: "tasks.list", params: {} });
  const ms = performance.now() - t0;
  const orchestrator = orchestratorFor({ store, info: { startedAt: "now", dbPath: "", dataDir: dir }, emit: () => {} });
  await orchestrator.settle();
  orchestrator.shutdown();
  const runs = store.db.prepare("select count(*) as n from runs where end_reason = 'interrupted'").get() as { n: number };
  store.close();
  return { ms, processes: [...spawned], listed: res?.ok ? (res.result as unknown[]).length : -1, interrupted: Number(runs.n) };
}

describe("daemon start", { timeout: 60_000 }, () => {
  it("starts the same processes with 40 worktrees as with none, and touches no worktree", async () => {
    const empty = await boot(0);
    const busy = await boot(40);
    expect(busy.listed).toBe(40);
    expect(busy.interrupted).toBe(40);
    // No git, no folder walk per worktree: only the one process listing for orphan checks, at most.
    expect(busy.processes.filter((p) => /\bgit(\.exe)?\b/i.test(p))).toEqual([]);
    expect(busy.processes.length).toBeLessThanOrEqual(empty.processes.length + 1);
    // Database work only; a generous bound that still catches a per-worktree git call (tens of ms each).
    expect(busy.ms).toBeLessThan(2_000);
  });
});
