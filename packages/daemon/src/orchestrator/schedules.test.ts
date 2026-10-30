import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScheduleInput } from "@crewyard/core";
import type { FakeStep } from "@crewyard/adapter-fake";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store.ts";
import { AdapterRegistry } from "./adapters.ts";
import { Orchestrator } from "./orchestrator.ts";
import { validateSchedule } from "./schedules.ts";
import { CANDIDATES, cleanTemps, ScriptedAdapter, tempDir, tempRepo, waitFor } from "./testing.ts";

// Scheduled tasks: the daemon's own timer, driven here by a test clock and direct check() calls.

vi.setConfig({ testTimeout: 30_000 });

const open: Array<{ o: Orchestrator; store: Store }> = [];
afterEach(async () => {
  const all = open.splice(0);
  all.forEach(({ o }) => o.shutdown());
  for (const { o } of all) await o.settle();
  new Set(all.map((x) => x.store)).forEach((s) => s.close());
  cleanTemps();
});

const running: FakeStep = { emit: { type: "run.state", state: "running" } };

async function setup() {
  const root = tempDir("crewyard sched-");
  const repo = await tempRepo(root);
  const store = new Store(join(root, "t.db"));
  const project = store.addProject(repo, "demo repo");
  const adapter = new ScriptedAdapter((role) => [running, { emit: { type: "message.delta", text: `${role} done` } }]);
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const cands = CANDIDATES();
  const clock = { at: Date.parse("2026-11-02T08:00:00Z") };
  const o = new Orchestrator({
    store,
    dataDir: join(root, "data"),
    emit: () => undefined,
    adapters,
    directory: { candidates: () => cands, envFor: () => ({}) },
    tickMs: 0,
    scheduleCheckMs: 0,
    hibernateCheckMs: 0,
    freeMemoryMb: () => 64_000,
    stopTimeoutMs: 2_000,
    now: () => new Date(clock.at),
  });
  o.start();
  open.push({ o, store });
  // A precheck that exits with the number in `exit.txt` (0 when the file says so).
  const exitFile = join(root, "exit.txt");
  const script = join(root, "pre check.mjs");
  writeFileSync(script, `import { readFileSync } from "node:fs";\nconsole.log("checked");\nprocess.exit(Number(readFileSync(${JSON.stringify(exitFile)}, "utf8")));\n`);
  writeFileSync(exitFile, "0");
  const base: ScheduleInput = { projectId: project.id, title: "Nightly dependency check", description: "List outdated packages.", kind: "research", size: "S", cadence: "daily", time: "09:00", timeZone: "UTC" };
  return { o, store, project, adapter, clock, base, precheck: `node "${script}"`, setExit: (n: number) => writeFileSync(exitFile, String(n)) };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("schedule templates", () => {
  it("checks every field, and keeps a precheck to one plain command", () => {
    const ok: ScheduleInput = { projectId: "p", title: "x", description: "", cadence: "weekly", time: "07:30", weekday: 1, timeZone: "Europe/Istanbul" };
    expect(validateSchedule(ok)).toMatchObject({ cadence: "weekly", weekday: 1, precheck_timeout_sec: 60, auto_approve: 0 });
    const field = (p: Partial<ScheduleInput>) => {
      try {
        validateSchedule({ ...ok, ...p });
        return null;
      } catch (err) {
        return (err as { params?: { field?: string } }).params?.field ?? String(err);
      }
    };
    expect(field({ time: "24:00" })).toBe("time");
    expect(field({ weekday: 7 })).toBe("weekday");
    expect(field({ timeZone: "Mars/Olympus" })).toBe("timeZone");
    expect(field({ precheck: "gh pr list | wc -l" })).toBe("precheck");
    expect(field({ precheckTimeoutSec: 2 })).toBe("precheckTimeoutSec");
    expect(field({ bestOf: 5 })).toBe("bestOf");
    expect(field({ title: "  " })).toBe("title");
    // A daily schedule ignores a weekday.
    expect(validateSchedule({ ...ok, cadence: "daily", weekday: 9 }).weekday).toBeNull();
  });

  it("starts disabled, and counts slots only from the moment you enable it", async () => {
    const { o, base, clock } = await setup();
    const s = o.schedules.save(base);
    expect(s).toMatchObject({ enabled: false, nextAt: null, pending: 0 });
    clock.at += 2 * DAY;
    await o.schedules.check();
    expect(o.schedules.runs(s.id)).toEqual([]);
    const on = o.schedules.setEnabled(s.id, true);
    // Enabled at 08:00 on the 4th: the next slot is 09:00 that day; the two before are never caught up.
    expect(on.nextAt).toBe("2026-11-04T09:00:00.000Z");
    expect(on.pending).toBe(0);
  });
});

describe("schedule runs", () => {
  it("skips a run for free when the precheck fails, and proposes when it passes", async () => {
    const { o, project, adapter, clock, base, precheck, setExit } = await setup();
    const s = o.schedules.save({ ...base, precheck });
    o.schedules.setEnabled(s.id, true);
    setExit(3);
    clock.at += 1.1 * HOUR;
    await o.schedules.check();
    const [skipped] = o.schedules.runs(s.id);
    expect(skipped).toMatchObject({ outcome: "skipped_precheck", precheckExit: 3, taskId: null, slotAt: "2026-11-02T09:00:00.000Z" });
    expect(skipped!.precheckTail).toContain("checked");
    // Nothing was proposed and no agent started.
    expect(o.list(project.id)).toEqual([]);
    expect(adapter.started).toEqual([]);

    setExit(0);
    clock.at += DAY;
    await o.schedules.check();
    const [proposed] = o.schedules.runs(s.id);
    expect(proposed).toMatchObject({ outcome: "proposed", precheckExit: 0, slotAt: "2026-11-03T09:00:00.000Z" });
    const task = o.get(proposed!.taskId!);
    // It waits for your approval like any task, and says where it came from.
    expect(task.status).toBe("proposed");
    expect(task.scheduled).toEqual({ scheduleId: s.id, title: base.title, autoApproved: false });
  });

  it("never overlaps its own previous run: a due slot waits until that task is done", async () => {
    const { o, clock, base } = await setup();
    const s = o.schedules.save(base);
    o.schedules.setEnabled(s.id, true);
    clock.at += 1.1 * HOUR;
    await o.schedules.check();
    const first = o.schedules.runs(s.id)[0]!;
    // The next day's slot comes while the first task still waits for approval.
    clock.at += DAY;
    await o.schedules.check();
    expect(o.schedules.runs(s.id)).toHaveLength(1);
    expect(o.schedules.get(s.id).pending).toBe(1);
    await expect(o.schedules.runNow(s.id)).rejects.toThrow("schedule.busy");
    await o.approve({ taskId: first.taskId! });
    await waitFor(() => o.get(first.taskId!).status === "done");
    await o.schedules.check();
    const runs = o.schedules.runs(s.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ outcome: "proposed", slotAt: "2026-11-03T09:00:00.000Z" });
  });

  it("catches up at most three missed slots after sleep, one at a time, oldest first", async () => {
    const { o, clock, base } = await setup();
    const s = o.schedules.save(base);
    o.schedules.setEnabled(s.id, true);
    // Asleep for six days: slots on the 2nd to the 7th were missed.
    clock.at += 5 * DAY + 2 * HOUR;
    await o.schedules.check();
    const [ran, missed] = o.schedules.runs(s.id);
    expect(missed).toMatchObject({ outcome: "skipped_missed", count: 3, slotAt: "2026-11-04T09:00:00.000Z" });
    expect(ran).toMatchObject({ outcome: "proposed", slotAt: "2026-11-05T09:00:00.000Z" });
    expect(o.schedules.get(s.id).pending).toBe(2);
    // The next caught-up slot waits for that task; once it is gone, the next one runs.
    await o.cancel(ran!.taskId!);
    await o.schedules.check();
    expect(o.schedules.runs(s.id)[0]).toMatchObject({ outcome: "proposed", slotAt: "2026-11-06T09:00:00.000Z" });
  });

  it("auto-approves the crew only when the template says so, and records that", async () => {
    const { o, store, clock, base } = await setup();
    const s = o.schedules.save({ ...base, autoApprove: true });
    o.schedules.setEnabled(s.id, true);
    clock.at += 1.1 * HOUR;
    await o.schedules.check();
    const run = o.schedules.runs(s.id)[0]!;
    expect(run.outcome).toBe("approved");
    await waitFor(() => o.get(run.taskId!).status === "done");
    expect(o.get(run.taskId!).scheduled?.autoApproved).toBe(true);
    const audit = store.db.prepare("select payload from events where kind = 'schedule.auto_approved'").all() as Array<{ payload: string }>;
    expect(audit.map((a) => JSON.parse(a.payload).scheduleId)).toEqual([s.id]);
  });

  it("runs now without the precheck, and marks a precheck the last daemon left running as failed", async () => {
    const { o, store, base, precheck, setExit } = await setup();
    setExit(1);
    const s = o.schedules.save({ ...base, precheck });
    const now = await o.schedules.runNow(s.id);
    expect(now).toMatchObject({ outcome: "proposed", manual: true, precheckExit: null, slotAt: null });
    store.db.prepare("insert into schedule_runs (id, schedule_id, started_at, outcome) values ('stale', ?, '2026-11-01T00:00:00Z', 'running_precheck')").run(s.id);
    o.schedules.start(0);
    expect(o.schedules.runs(s.id).find((r) => r.id === "stale")).toMatchObject({ outcome: "failed", detail: "precheck.interrupted" });
  });
});
