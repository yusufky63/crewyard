import { isAbsolute, join } from "node:path";
import { killTree, run } from "@crewyard/proc";
import type { Store } from "../store.ts";

// Agent processes are children of the daemon. When the app or the daemon is killed hard, Windows
// does not take the children with it, so on the next start the daemon finds the pids it recorded
// for open runs (runs.pid) and kills those trees, before the orchestrator labels the runs
// interrupted (PLAN.md M2: "killing the app leaves no agent processes").
//
// Windows reuses pids quickly, so a recorded pid alone proves nothing. A process is killed only
// when all of these hold:
//   - its image is one the run's runner starts (cmd.exe for .cmd shims, node.exe, the runner's exe);
//   - it was created after the run row was written (the row is written before the spawn);
//   - the daemon that spawned it is gone;
//   - its command line names the run's folder or profile folder, or its parent pid is the dead
//     daemon that owned the run and it is older than whatever holds that pid now.
// Anything else is left alone and logged. Codex and OpenCode take their folders from the cwd and
// the environment, which another process cannot read, so the parent check is what identifies them.

export interface ProcessInfo {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string | null;
  /** ISO time, UTC. */
  createdAt: string;
}

export type ProcessLister = (pids: number[]) => Promise<ProcessInfo[]>;

export interface OpenRunProcess {
  runId: string;
  taskId: string;
  runner: string;
  pid: number;
  cwd: string;
  configDir: string | null;
  startedAt: string;
}

export interface DaemonSession {
  pid: number;
  startedAt: string;
}

export type Verdict =
  | { action: "kill"; by: "command_line" | "parent" }
  | { action: "gone" }
  | { action: "skip"; reason: SkipReason };

export type SkipReason = "owner_alive" | "image_mismatch" | "created_before_run" | "parent_reused" | "identity_unverified" | "process_query_failed" | "unsupported_platform" | "kill_limit" | "kill_stalled";

export interface OrphanReport {
  checked: number;
  killed: Array<{ runId: string; pid: number; by: "command_line" | "parent" }>;
  gone: Array<{ runId: string; pid: number }>;
  skipped: Array<{ runId: string; pid: number; reason: SkipReason }>;
  /** Killed trees whose root was still there afterwards; logged, the orchestrator still labels the run. */
  survivors: number[];
}

/** Images each runner can leave behind. cmd.exe is the parent cross-spawn uses for npm .cmd shims. */
const SHIM = ["cmd.exe", "node.exe"];
export const RUNNER_IMAGES: Record<string, readonly string[]> = {
  codex: [...SHIM, "codex.exe"],
  "claude-code": [...SHIM, "claude.exe", "bun.exe"],
  opencode: [...SHIM, "opencode.exe", "bun.exe"],
  "gemini-cli": [...SHIM, "gemini.exe"],
  acp: [...SHIM, "gemini.exe"],
};

/** Clock granularity between SQLite ISO strings and the Windows creation time. */
const CLOCK_SLACK_MS = 1_000;
/**
 * Kills run one at a time, at most this many per start, and stop after one that hangs: each
 * taskkill /T walks the whole process table, and during a filesystem stall unbounded kills feed
 * the stall (orca #24829). What is left over is logged as skipped with the pid, so it can be
 * ended by hand; the runs are labelled interrupted either way.
 */
const MAX_KILLS = 16;
const STALLED_KILL_MS = 5_000;
/** daemon_sessions keeps this many starts; older runs fall back to the command-line check. */
const KEEP_SESSIONS = 200;

const image = (name: string) => {
  const n = name.toLowerCase();
  return n.endsWith(".exe") ? n : `${n}.exe`;
};

const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

/** Whether a command line names a folder. Relative or tiny paths never count. */
function namesFolder(commandLine: string, folder: string | null): boolean {
  if (!folder || !isAbsolute(folder)) return false;
  const f = norm(folder);
  return f.length >= 4 && norm(commandLine).includes(f);
}

/** Pure decision for one recorded pid; every rule from the header has a test. */
export function verifyOrphan(run: OpenRunProcess, proc: ProcessInfo | undefined, owner: DaemonSession | null, ownerProc: ProcessInfo | undefined): Verdict {
  if (!proc) return { action: "gone" };
  // The owning daemon still runs when its pid is held by a process at least as old as its start.
  const ownerAlive = Boolean(owner && ownerProc && Date.parse(ownerProc.createdAt) <= Date.parse(owner.startedAt) + CLOCK_SLACK_MS);
  if (ownerAlive) return { action: "skip", reason: "owner_alive" };
  if (!(RUNNER_IMAGES[run.runner] ?? SHIM).includes(image(proc.name))) return { action: "skip", reason: "image_mismatch" };
  const created = Date.parse(proc.createdAt);
  if (!Number.isFinite(created) || created < Date.parse(run.startedAt) - CLOCK_SLACK_MS) return { action: "skip", reason: "created_before_run" };
  if (proc.commandLine && (namesFolder(proc.commandLine, run.cwd) || namesFolder(proc.commandLine, run.configDir))) return { action: "kill", by: "command_line" };
  if (owner && proc.parentPid === owner.pid) {
    // A child of the old daemon was created while that daemon lived, so before anything reused its pid.
    if (ownerProc && Date.parse(ownerProc.createdAt) < created) return { action: "skip", reason: "parent_reused" };
    return { action: "kill", by: "parent" };
  }
  return { action: "skip", reason: "identity_unverified" };
}

function powershell(): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Reads image, parent, command line and creation time through CIM (wmic is gone from Windows 11). */
export const listWindowsProcesses: ProcessLister = async (pids) => {
  const ids = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  if (ids.length === 0) return [];
  const filter = ids.map((p) => `ProcessId=${p}`).join(" OR ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    `$p = @(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = [string]$_.Name; commandLine = $_.CommandLine; createdAt = $_.CreationDate.ToUniversalTime().ToString('o') } })`,
    "ConvertTo-Json -Compress -Depth 2 -InputObject $p",
  ].join("; ");
  const res = await run(powershell(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeoutMs: 30_000 });
  if (res.code !== 0) throw new Error(`process query failed: ${res.stderr.trim().slice(0, 300)}`);
  const text = res.stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as ProcessInfo | ProcessInfo[];
  return Array.isArray(parsed) ? parsed : [parsed];
};

/** Records this daemon's start, so runs it spawns can be traced back to it after a crash. */
export function recordDaemonStart(store: Store, session: DaemonSession): void {
  store.db.prepare("insert or ignore into daemon_sessions (pid, started_at) values (?, ?)").run(session.pid, session.startedAt);
  store.db.prepare("delete from daemon_sessions where started_at not in (select started_at from daemon_sessions order by started_at desc limit ?)").run(KEEP_SESSIONS);
}

function openRunProcesses(store: Store): OpenRunProcess[] {
  return (
    store.db
      .prepare(
        `select r.id, r.task_id, r.runner, r.pid, r.cwd, r.started_at, p.config_dir
         from runs r left join profiles p on p.id = r.profile_id
         where r.ended_at is null and r.pid is not null order by r.started_at`,
      )
      .all() as Array<{ id: string; task_id: string; runner: string; pid: number; cwd: string; started_at: string; config_dir: string | null }>
  ).map((r) => ({ runId: r.id, taskId: r.task_id, runner: r.runner, pid: Number(r.pid), cwd: r.cwd, configDir: r.config_dir, startedAt: r.started_at }));
}

function ownerOf(sessions: DaemonSession[], startedAt: string): DaemonSession | null {
  let owner: DaemonSession | null = null;
  for (const s of sessions) if (s.startedAt <= startedAt) owner = s;
  return owner;
}

export interface CleanupDeps {
  list?: ProcessLister;
  kill?: (pid: number) => Promise<void>;
  platform?: NodeJS.Platform;
  now?: () => number;
}

/**
 * Kills the verified agent process trees of runs the last daemon left open. Must run before the
 * orchestrator starts, which then labels those runs interrupted. Never throws: a failed query
 * skips everything, because killing on a guess is worse than leaving a process behind.
 */
export async function cleanOrphans(store: Store, deps: CleanupDeps = {}): Promise<OrphanReport> {
  const report: OrphanReport = { checked: 0, killed: [], gone: [], skipped: [], survivors: [] };
  const runs = openRunProcesses(store);
  report.checked = runs.length;
  if (runs.length === 0) return report;

  const skipAll = (reason: SkipReason) => runs.forEach((r) => report.skipped.push({ runId: r.runId, pid: r.pid, reason }));
  const platform = deps.platform ?? process.platform;
  const list = deps.list ?? (platform === "win32" ? listWindowsProcesses : null);
  if (!list) {
    skipAll("unsupported_platform");
    return log(store, runs, report);
  }

  const sessions = (store.db.prepare("select pid, started_at from daemon_sessions order by started_at").all() as Array<{ pid: number; started_at: string }>).map((s) => ({ pid: Number(s.pid), startedAt: s.started_at }));
  const owners = new Map(runs.map((r) => [r.runId, ownerOf(sessions, r.startedAt)]));
  let procs: Map<number, ProcessInfo>;
  try {
    const pids = [...runs.map((r) => r.pid), ...[...owners.values()].flatMap((o) => (o ? [o.pid] : []))];
    procs = new Map((await list(pids)).map((p) => [Number(p.pid), p]));
  } catch {
    skipAll("process_query_failed");
    return log(store, runs, report);
  }

  const kill = deps.kill ?? killTree;
  const now = deps.now ?? Date.now;
  const killedPids = new Set<number>();
  let stalled = false;
  for (const r of runs) {
    const owner = owners.get(r.runId) ?? null;
    const verdict = verifyOrphan(r, procs.get(r.pid), owner, owner ? procs.get(owner.pid) : undefined);
    if (verdict.action === "gone") report.gone.push({ runId: r.runId, pid: r.pid });
    else if (verdict.action === "skip") report.skipped.push({ runId: r.runId, pid: r.pid, reason: verdict.reason });
    else if (killedPids.has(r.pid)) report.killed.push({ runId: r.runId, pid: r.pid, by: verdict.by });
    else if (stalled) report.skipped.push({ runId: r.runId, pid: r.pid, reason: "kill_stalled" });
    else if (killedPids.size >= MAX_KILLS) report.skipped.push({ runId: r.runId, pid: r.pid, reason: "kill_limit" });
    else {
      const t0 = now();
      await kill(r.pid);
      stalled = now() - t0 > STALLED_KILL_MS;
      killedPids.add(r.pid);
      report.killed.push({ runId: r.runId, pid: r.pid, by: verdict.by });
    }
  }

  if (report.killed.length) {
    try {
      // Only a process that is still the one we killed counts as a survivor, not a fresh reuse of its pid.
      const after = await list([...killedPids]);
      report.survivors = after.filter((p) => procs.get(Number(p.pid))?.createdAt === p.createdAt).map((p) => Number(p.pid));
    } catch {
      // The kill already ran; a failed re-check only loses the survivor count.
    }
  }
  return log(store, runs, report);
}

function log(store: Store, runs: OpenRunProcess[], report: OrphanReport): OrphanReport {
  const task = new Map(runs.map((r) => [r.runId, r.taskId]));
  for (const k of report.killed) store.appendEvent({ kind: "recovery.orphan_killed", source: "recovery", runId: k.runId, taskId: task.get(k.runId), payload: { ...k, survived: report.survivors.includes(k.pid) } });
  for (const s of report.skipped) store.appendEvent({ kind: "recovery.orphan_skipped", source: "recovery", runId: s.runId, taskId: task.get(s.runId), payload: s });
  return report;
}
