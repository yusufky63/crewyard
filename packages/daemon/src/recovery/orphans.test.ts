import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { killTree, run, start } from "@crewyard/proc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanTemps, tempDir } from "../orchestrator/testing.ts";
import { Store } from "../store.ts";
import { cleanOrphans, listWindowsProcesses, recordDaemonStart, verifyOrphan, type OpenRunProcess, type ProcessInfo } from "./orphans.ts";

vi.setConfig({ testTimeout: 60_000 });

const win = process.platform === "win32";
const stores: Store[] = [];
const pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) await killTree(pid);
  stores.splice(0).forEach((s) => s.close());
  cleanTemps();
});

const T0 = "2026-10-30T10:00:00.000Z";
const later = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const WT = "C:\\Users\\me\\Crewyard worktrees\\demo repo\\task-1";

const runRow = (over: Partial<OpenRunProcess> = {}): OpenRunProcess => ({ runId: "r1", taskId: "t1", runner: "codex", pid: 4242, cwd: WT, configDir: "C:\\Users\\me\\AppData\\Roaming\\Crewyard\\profiles\\codex-work", startedAt: T0, ...over });
const proc = (over: Partial<ProcessInfo> = {}): ProcessInfo => ({ pid: 4242, parentPid: 900, name: "cmd.exe", commandLine: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "codex.cmd app-server --disable plugins"', createdAt: later(500), ...over });
const owner = { pid: 900, startedAt: later(-60_000) };

describe("verifyOrphan", () => {
  it("kills a child of the dead daemon that owned the run", () => {
    expect(verifyOrphan(runRow(), proc(), owner, undefined)).toEqual({ action: "kill", by: "parent" });
  });

  it("kills a process whose command line names the run's folder, in any case and slash style", () => {
    const cmd = `"C:\\Program Files\\nodejs\\node.exe" agent.js --cwd ${WT.replace(/\\/g, "/").toUpperCase()}`;
    expect(verifyOrphan(runRow(), proc({ parentPid: 1, name: "node.exe", commandLine: cmd }), null, undefined)).toEqual({ action: "kill", by: "command_line" });
    const profile = "claude.exe --settings C:\\Users\\me\\AppData\\Roaming\\Crewyard\\profiles\\codex-work\\settings.json";
    expect(verifyOrphan(runRow({ runner: "claude-code" }), proc({ parentPid: 1, name: "claude.exe", commandLine: profile }), null, undefined)).toEqual({ action: "kill", by: "command_line" });
  });

  it("reports a pid that is not running as gone", () => {
    expect(verifyOrphan(runRow(), undefined, owner, undefined)).toEqual({ action: "gone" });
  });

  it("never touches anything while the owning daemon is still alive", () => {
    expect(verifyOrphan(runRow(), proc(), owner, proc({ pid: 900, createdAt: later(-61_000) }))).toEqual({ action: "skip", reason: "owner_alive" });
  });

  it("skips images the runner does not start", () => {
    expect(verifyOrphan(runRow(), proc({ name: "chrome.exe" }), owner, undefined)).toEqual({ action: "skip", reason: "image_mismatch" });
    expect(verifyOrphan(runRow({ runner: "codex" }), proc({ name: "opencode.exe" }), owner, undefined)).toEqual({ action: "skip", reason: "image_mismatch" });
  });

  it("skips a reused pid whose process is older than the run", () => {
    expect(verifyOrphan(runRow(), proc({ createdAt: later(-5_000) }), owner, undefined)).toEqual({ action: "skip", reason: "created_before_run" });
  });

  it("skips a child of whatever reused the daemon's pid", () => {
    // pid 900 now belongs to a process created before the agent: that process is the agent's parent, not the old daemon.
    // An agent older than the new holder of pid 900 is the real orphan.
    expect(verifyOrphan(runRow(), proc({ createdAt: later(2_000) }), owner, proc({ pid: 900, createdAt: later(1_000) }))).toEqual({ action: "skip", reason: "parent_reused" });
    expect(verifyOrphan(runRow(), proc({ createdAt: later(500) }), owner, proc({ pid: 900, createdAt: later(9_000) }))).toEqual({ action: "kill", by: "parent" });
  });

  it("skips what it cannot tie to the run, and ignores relative or tiny folders", () => {
    expect(verifyOrphan(runRow(), proc({ parentPid: 1 }), owner, undefined)).toEqual({ action: "skip", reason: "identity_unverified" });
    expect(verifyOrphan(runRow({ cwd: ".", configDir: "C:\\" }), proc({ parentPid: 1, commandLine: "cmd.exe /c . C:\\" }), null, undefined)).toEqual({ action: "skip", reason: "identity_unverified" });
  });
});

/** A project, task and crew step with one open run, the way the orchestrator writes them. */
function seed(store: Store, r: { id?: string; pid: number; runner?: string; cwd: string; startedAt: string; profileDir?: string }): string {
  const db = store.db;
  const id = r.id ?? "run-1";
  db.exec(`insert or ignore into projects (id, name, path, added_at) values ('p1', 'demo', '${r.cwd.replace(/'/g, "''")}', '${T0}')`);
  db.exec(
    `insert or ignore into tasks (id, project_id, title, description, kind, size, fallback, wait_reset_minutes, classification, created_at) values ('t1', 'p1', 'x', '', 'code', 'S', 'ask', 0, '{}', '${T0}')`,
  );
  db.exec(`insert or ignore into crews (id, task_id, proposed_at, estimate_provenance) values ('c1', 't1', '${T0}', 'unknown')`);
  db.exec(
    `insert or ignore into crew_members (id, crew_id, position, step, role, depends_on, required, writes_code, standby, reasons) values ('m1', 'c1', 0, 'implement', 'implementer', '[]', 1, 1, '[]', '[]')`,
  );
  if (r.profileDir) db.prepare("insert or ignore into profiles (id, alias, runner, provider_id, config_dir, created_at, updated_at) values ('prof', 'prof', ?, 'openai', ?, ?, ?)").run(r.runner ?? "codex", r.profileDir, T0, T0);
  db.prepare("insert into runs (id, task_id, member_id, role, profile_id, runner, cwd, started_at, pid) values (?, 't1', 'm1', 'implementer', 'prof', ?, ?, ?, ?)").run(id, r.runner ?? "codex", r.cwd, r.startedAt, r.pid);
  return id;
}

function newStore(): { store: Store; root: string } {
  const root = tempDir("crewyard orphans-");
  const store = new Store(join(root, "crewyard.db"));
  stores.push(store);
  return { store, root };
}

const events = (store: Store, kind: string) => (store.db.prepare("select payload from events where kind = ?").all(kind) as Array<{ payload: string }>).map((e) => JSON.parse(e.payload));

describe("cleanOrphans", () => {
  it("kills verified trees, logs every skip, and does nothing without open runs", async () => {
    const { store } = newStore();
    expect(await cleanOrphans(store, { list: async () => [], kill: async () => {} })).toMatchObject({ checked: 0 });

    recordDaemonStart(store, owner);
    seed(store, { id: "a", pid: 4242, cwd: WT, startedAt: T0 });
    seed(store, { id: "b", pid: 5151, cwd: WT, startedAt: T0 });
    seed(store, { id: "c", pid: 6262, cwd: WT, startedAt: T0 });
    const killed: number[] = [];
    let alive = new Set([4242, 5151]);
    const list = async (ids: number[]) => [proc(), proc({ pid: 5151, name: "explorer.exe" })].filter((p) => ids.includes(p.pid) && alive.has(p.pid));
    const report = await cleanOrphans(store, {
      list,
      kill: async (pid) => {
        killed.push(pid);
        alive = new Set([...alive].filter((p) => p !== pid));
      },
    });
    expect(killed).toEqual([4242]);
    expect(report).toMatchObject({ checked: 3, killed: [{ runId: "a", pid: 4242, by: "parent" }], gone: [{ runId: "c", pid: 6262 }], skipped: [{ runId: "b", pid: 5151, reason: "image_mismatch" }], survivors: [] });
    expect(events(store, "recovery.orphan_killed")).toEqual([{ runId: "a", pid: 4242, by: "parent", survived: false }]);
    expect(events(store, "recovery.orphan_skipped")).toEqual([{ runId: "b", pid: 5151, reason: "image_mismatch" }]);
  });

  it("kills nothing when the process query fails or the platform has no lister", async () => {
    const { store } = newStore();
    seed(store, { pid: 4242, cwd: WT, startedAt: T0 });
    const kill = vi.fn(async () => {});
    const failed = await cleanOrphans(store, {
      list: async () => {
        throw new Error("CIM unavailable");
      },
      kill,
    });
    expect(failed.skipped).toEqual([{ runId: "run-1", pid: 4242, reason: "process_query_failed" }]);
    expect((await cleanOrphans(store, { platform: "linux", kill })).skipped[0]!.reason).toBe("unsupported_platform");
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills each pid once, at most 16 per start, and stops after a kill that hangs", async () => {
    const { store } = newStore();
    recordDaemonStart(store, owner);
    for (let i = 0; i < 18; i++) seed(store, { id: `r${String(i).padStart(2, "0")}`, pid: 7000 + i, cwd: WT, startedAt: T0 });
    seed(store, { id: "s-dup", pid: 7000, cwd: WT, startedAt: T0 });
    const list = async (ids: number[]) => ids.filter((p) => p >= 7000).map((pid) => proc({ pid }));
    const killed: number[] = [];
    const report = await cleanOrphans(store, { list, kill: async (pid) => void killed.push(pid) });
    expect(killed).toHaveLength(16);
    expect(new Set(killed).size).toBe(16);
    expect(report.killed.filter((k) => k.pid === 7000).map((k) => k.runId)).toEqual(["r00", "s-dup"]);
    expect(report.skipped).toEqual([
      { runId: "r16", pid: 7016, reason: "kill_limit" },
      { runId: "r17", pid: 7017, reason: "kill_limit" },
    ]);

    const { store: s2 } = newStore();
    recordDaemonStart(s2, owner);
    for (let i = 0; i < 3; i++) seed(s2, { id: `q${i}`, pid: 7100 + i, cwd: WT, startedAt: T0 });
    let clock = 0;
    const slow = await cleanOrphans(s2, {
      list: async (ids) => ids.filter((p) => p >= 7000).map((pid) => proc({ pid })),
      kill: async () => void (clock += 6_000),
      now: () => clock,
    });
    expect(slow.killed.map((k) => k.pid)).toEqual([7100]);
    expect(slow.skipped.map((s) => s.reason)).toEqual(["kill_stalled", "kill_stalled"]);
  });

  it("keeps a bounded history of daemon starts", () => {
    const { store } = newStore();
    for (let i = 0; i < 230; i++) recordDaemonStart(store, { pid: 1000 + i, startedAt: later(i * 1000) });
    recordDaemonStart(store, { pid: 1229, startedAt: later(229 * 1000) });
    expect((store.db.prepare("select count(*) n from daemon_sessions").get() as { n: number }).n).toBe(200);
  });
});

/** Same shape as a crash: the "daemon" (launcher) spawns an agent and dies, the agent lives on. */
async function orphanedAgent(dir: string): Promise<{ daemonPid: number; agentPid: number }> {
  const launcher = join(dir, "fake daemon.cjs");
  writeFileSync(
    launcher,
    [
      'const { spawn } = require("node:child_process");',
      'const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", windowsHide: true });',
      'process.stdout.write(process.pid + " " + c.pid);',
      "c.unref();",
    ].join("\n"),
  );
  const res = await run(process.execPath, [launcher], { timeoutMs: 20_000 });
  const [daemonPid, agentPid] = res.stdout.trim().split(" ").map(Number);
  if (!daemonPid || !agentPid) throw new Error(`launcher failed: ${res.stderr}`);
  pids.push(agentPid);
  return { daemonPid, agentPid };
}

// Signal 0 only checks for existence; cheaper than a CIM query, which matters under the full suite.
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!running(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

describe.runIf(win)("cleanOrphans on Windows", () => {
  it("reads image, parent, command line and creation time of real processes", async () => {
    const [me] = await listWindowsProcesses([process.pid]);
    expect(me).toMatchObject({ pid: process.pid, parentPid: process.ppid, name: "node.exe" });
    expect(Date.parse(me!.createdAt)).toBeLessThan(Date.now());
    expect(await listWindowsProcesses([])).toEqual([]);
  });

  it("kills the agent a killed daemon left behind, matched by its dead parent", async () => {
    const { store, root } = newStore();
    const startedAt = new Date(Date.now() - 2_000).toISOString();
    const { daemonPid, agentPid } = await orphanedAgent(root);
    recordDaemonStart(store, { pid: daemonPid, startedAt: new Date(Date.now() - 10_000).toISOString() });
    seed(store, { pid: agentPid, runner: "codex", cwd: join(root, "demo repo"), startedAt });
    expect(running(agentPid)).toBe(true);

    const report = await cleanOrphans(store);
    expect(report.killed).toEqual([{ runId: "run-1", pid: agentPid, by: "parent" }]);
    expect(report.survivors).toEqual([]);
    expect(await gone(agentPid)).toBe(true);
  });

  it("kills an agent whose command line names the worktree, and leaves unverified processes alone", async () => {
    const { store, root } = newStore();
    const worktree = join(root, "worktrees", "demo repo", "task 1");
    mkdirSync(worktree, { recursive: true });
    const startedAt = new Date(Date.now() - 2_000).toISOString();
    const agent = start(process.execPath, ["-e", "setInterval(() => {}, 1000)", worktree], { cwd: worktree, stdio: "ignore" });
    const stranger = start(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    pids.push(agent.pid!, stranger.pid!);
    seed(store, { id: "agent", pid: agent.pid!, cwd: worktree, startedAt });
    seed(store, { id: "stranger", pid: stranger.pid!, cwd: worktree, startedAt });
    // A run that started after this process existed: the pid must have been reused.
    seed(store, { id: "reused", pid: process.pid, cwd: worktree, startedAt: new Date(Date.now() + 5_000).toISOString() });

    const report = await cleanOrphans(store);
    expect(report.killed).toEqual([{ runId: "agent", pid: agent.pid, by: "command_line" }]);
    expect(report.skipped).toEqual([
      { runId: "stranger", pid: stranger.pid, reason: "identity_unverified" },
      { runId: "reused", pid: process.pid, reason: "created_before_run" },
    ]);
    expect(await gone(agent.pid!)).toBe(true);
    expect(running(stranger.pid!)).toBe(true);
  });
});
