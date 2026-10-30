import { join } from "node:path";
import type { FakeStep } from "@crewyard/adapter-fake";
import { AdapterRegistry } from "../orchestrator/adapters.ts";
import { Orchestrator } from "../orchestrator/orchestrator.ts";
import { CANDIDATES, ScriptedAdapter } from "../orchestrator/testing.ts";
import { Store } from "../store.ts";

// Test fixture for crash.test.ts, started as its own Node process: a daemon with the fake runner
// that keeps one run streaming and keeps writing deduplicated events, until the test kills it.
// Prints one JSON line once the run is live. Nothing in production imports this file.

const [dbPath, repo, dataDir] = process.argv.slice(2);
if (!dbPath || !repo || !dataDir) throw new Error("usage: crash-child <db> <repo> <dataDir>");

const store = new Store(dbPath);
const project = store.addProject(repo, "demo repo");
const chatter: FakeStep[] = Array.from({ length: 5_000 }, (_, i) => [{ emit: { type: "message.delta" as const, text: `step ${i} ` } }, { wait: 5 }]).flat();
const adapter = new ScriptedAdapter(() => [{ emit: { type: "run.state", state: "running" } }, ...chatter]);
const adapters = new AdapterRegistry({});
adapters.set("fake", adapter);
const o = new Orchestrator({
  store,
  dataDir: join(dataDir, "data"),
  emit: () => {},
  adapters,
  directory: { candidates: () => CANDIDATES(), envFor: () => ({}) },
  tickMs: 0,
  freeMemoryMb: () => 64_000,
});
o.start();

// Keeps the process alive and the WAL busy right up to the kill.
let n = 0;
setInterval(() => {
  store.appendEvent({ kind: "test.tick", source: "crash-child", payload: { n }, dedupeKey: `tick-${n}` });
  n++;
}, 2);

const task = await o.propose({ projectId: project.id, title: "Research the session store options" });
await o.approve({ taskId: task.id });
const end = Date.now() + 20_000;
for (;;) {
  const run = o.get(task.id).runs[0];
  const deltas = run ? (store.db.prepare("select count(*) n from events where run_id = ? and kind = 'run.message.delta'").get(run.id) as { n: number }).n : 0;
  if (run && deltas >= 20) {
    process.stdout.write(`${JSON.stringify({ taskId: task.id, runId: run.id, pid: process.pid })}\n`);
    break;
  }
  if (Date.now() > end) throw new Error("run never went live");
  await new Promise((r) => setTimeout(r, 20));
}
