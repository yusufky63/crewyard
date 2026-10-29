import { copyFileSync, existsSync, mkdirSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { killTree, start } from "@crewyard/proc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterRegistry } from "../orchestrator/adapters.ts";
import { Orchestrator, type OrchestratorOptions } from "../orchestrator/orchestrator.ts";
import { CANDIDATES, cleanTemps, ScriptedAdapter, tempDir, tempRepo, waitFor } from "../orchestrator/testing.ts";
import { Store } from "../store.ts";

// Crash and power-loss recovery (PLAN.md M6). A real daemon process with the fake runner is
// killed with taskkill /F in the middle of a streaming run, which is what a crash, an "End task"
// or a power cut looks like to SQLite: no shutdown code runs and the WAL holds the last commits.

vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });

const CHILD = join(import.meta.dirname, "crash-child.ts");
const stores: Store[] = [];
const orchestrators: Orchestrator[] = [];
const pids: number[] = [];

afterEach(async () => {
  orchestrators.splice(0).forEach((o) => o.shutdown());
  for (const pid of pids.splice(0)) await killTree(pid);
  stores.splice(0).forEach((s) => s.close());
  cleanTemps();
});

interface Live {
  taskId: string;
  runId: string;
  pid: number;
}

/** Starts the fixture daemon, waits until its run streams, then kills it hard. */
async function crashMidRun(root: string, repo: string, db: string): Promise<Live> {
  const child = start(process.execPath, ["--experimental-transform-types", "--no-warnings", CHILD, db, repo, root], { stdio: ["ignore", "pipe", "pipe"] });
  pids.push(child.pid!);
  let out = "";
  let err = "";
  child.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (err += d));
  const exited = new Promise<void>((r) => child.on("exit", () => r()));
  const live = await waitFor(() => (out.includes("\n") ? (JSON.parse(out.split("\n")[0]!) as Live) : null), 60_000).catch(() => {
    throw new Error(`fixture daemon never went live: ${err.slice(0, 2000)}`);
  });
  // Let it write for a moment longer, so the kill lands between and during commits.
  await new Promise((r) => setTimeout(r, 150));
  await killTree(child.pid!);
  await exited;
  return live;
}

function restart(store: Store, root: string, adapter: ScriptedAdapter): Orchestrator {
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const options: OrchestratorOptions = {
    store,
    dataDir: join(root, "data"),
    emit: () => {},
    adapters,
    directory: { candidates: () => CANDIDATES(), envFor: () => ({}) },
    tickMs: 0,
    freeMemoryMb: () => 64_000,
    stopTimeoutMs: 2_000,
  };
  const o = new Orchestrator(options);
  o.start();
  orchestrators.push(o);
  return o;
}

const open = (path: string) => {
  const s = new Store(path);
  stores.push(s);
  return s;
};
const one = <T>(s: Store, sql: string, ...args: Array<string | number>) => s.db.prepare(sql).get(...args) as T;
const count = (s: Store, sql: string, ...args: Array<string | number>) => Number(one<{ n: number }>(s, sql, ...args).n);
const integrity = (s: Store) => one<{ integrity_check: string }>(s, "pragma integrity_check").integrity_check;

/** Adapter events of a run that share a (run, seq) pair: a replay that slipped past dedupe. */
const duplicateSeqs = (s: Store) =>
  count(s, "select count(*) n from (select run_id, json_extract(payload, '$.seq') q from events where source = 'fake' group by run_id, q having count(*) > 1)");

describe.runIf(process.platform === "win32")("crash recovery", () => {
  it("labels a run killed with its daemon interrupted, resumes it once, and keeps the event log clean", async () => {
    const root = tempDir("crewyard crash-");
    const repo = await tempRepo(root);
    const db = join(root, "crewyard.db");
    const live = await crashMidRun(root, repo, db);
    // The kill skipped every close(): the last commits live only in the WAL.
    expect(existsSync(`${db}-wal`)).toBe(true);

    const store = open(db);
    expect(integrity(store)).toBe("ok");
    expect(one<{ ended_at: string | null }>(store, "select ended_at from runs where id = ?", live.runId).ended_at).toBeNull();
    const before = count(store, "select count(*) n from events where run_id = ?", live.runId);
    const ticks = count(store, "select count(*) n from events where kind = 'test.tick'");
    expect(before).toBeGreaterThanOrEqual(20);
    expect(ticks).toBeGreaterThan(0);

    // A replay of every tick the dead daemon wrote, plus one new one: only the new one lands.
    const maxTick = Number(one<{ n: number }>(store, "select max(json_extract(payload, '$.n')) n from events where kind = 'test.tick'").n);
    for (let n = 0; n <= maxTick + 1; n++) store.appendEvent({ kind: "test.tick", source: "replay", payload: { n }, dedupeKey: `tick-${n}` });
    expect(count(store, "select count(*) n from events where kind = 'test.tick'")).toBe(ticks + 1);

    const adapter = new ScriptedAdapter((_role, _req, resumed) => (resumed ? [{ emit: { type: "run.state", state: "running" } }, { emit: { type: "message.delta", text: "back" } }] : []));
    const o = restart(store, root, adapter);
    const run = o.get(live.taskId).runs[0]!;
    expect([run.id, run.endReason]).toEqual([live.runId, "interrupted"]);
    expect(run.endDetail).toMatch(/^process_(gone|orphaned)$/);
    expect(o.get(live.taskId).resumableRunIds).toEqual([live.runId]);
    expect(adapter.started).toEqual([]);
    // Recovery adds exactly one audit entry and never re-writes what the run already streamed.
    expect(count(store, "select count(*) n from events where run_id = ? and kind = 'run.recovered'", live.runId)).toBe(1);
    expect(count(store, "select count(*) n from events where run_id = ?", live.runId)).toBe(before + 1);
    expect(duplicateSeqs(store)).toBe(0);

    // A second restart finds nothing open and changes nothing.
    o.shutdown();
    await o.settle();
    const total = count(store, "select count(*) n from events");
    const o2 = restart(store, root, adapter);
    expect(count(store, "select count(*) n from events")).toBe(total);
    expect(o2.get(live.taskId).runs[0]!.endReason).toBe("interrupted");

    const resumed = await o2.resume(live.runId);
    expect(resumed.resumedFrom).toBe(live.runId);
    await waitFor(() => o2.get(live.taskId).status === "done", 20_000);
    expect(o2.get(live.taskId).resumableRunIds).toEqual([]);
    expect(adapter.started.map((s) => s.resumed)).toEqual([true]);
    expect(duplicateSeqs(store)).toBe(0);
  });

  it("recovers from a WAL torn mid-frame, as a power cut leaves it", async () => {
    const root = tempDir("crewyard power-");
    const repo = await tempRepo(root);
    const db = join(root, "crewyard.db");
    const live = await crashMidRun(root, repo, db);

    // Copy the files as the disk held them, then cut the WAL inside its last frame.
    const torn = join(root, "torn copy");
    mkdirSync(torn);
    const copy = join(torn, "crewyard.db");
    copyFileSync(db, copy);
    copyFileSync(`${db}-wal`, `${copy}-wal`);
    const size = statSync(`${copy}-wal`).size;
    expect(size).toBeGreaterThan(4096);
    truncateSync(`${copy}-wal`, size - 1000);

    const store = open(copy);
    expect(integrity(store)).toBe("ok");
    // The cut frame and anything after it are gone; every earlier commit is intact.
    const full = open(db);
    const kept = count(store, "select count(*) n from events");
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThanOrEqual(count(full, "select count(*) n from events"));

    const o = restart(store, root, new ScriptedAdapter(() => []));
    const task = o.get(live.taskId);
    // The run row was committed long before the cut, so it is there and gets labelled.
    expect(task.runs[0]).toMatchObject({ id: live.runId, endReason: "interrupted" });
    expect(task.resumableRunIds).toEqual([live.runId]);
    expect(duplicateSeqs(store)).toBe(0);
    // The checkpoint folds the recovered WAL into the database file.
    store.db.exec("pragma wal_checkpoint(truncate)");
    expect(integrity(store)).toBe("ok");
  });
});
