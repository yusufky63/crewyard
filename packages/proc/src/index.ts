import { execFile } from "node:child_process";
import spawn from "cross-spawn";
import type { ChildProcess, SpawnOptions } from "node:child_process";

// Windows rules from PLAN.md §12: resolve npm .cmd shims to real paths, never use a shell,
// never flash a console window, and always kill the whole process tree.

const isWin = process.platform === "win32";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Runs a short command and collects its output. Times out instead of hanging the daemon.
 * Goes through cross-spawn because Node refuses to start .cmd/.bat files without a shell
 * (EINVAL), and every npm-installed agent CLI on Windows is a .cmd shim.
 */
export function run(command: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: RunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, shell: false, windowsHide: true });
    child.stdout?.setEncoding("utf8").on("data", (d: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += d;
    });
    const timer = setTimeout(() => {
      if (child.pid) void killTree(child.pid);
      finish({ code: null, stdout, stderr: stderr || "timed out" });
    }, opts.timeoutMs ?? 10_000);
    child.on("error", (err) => finish({ code: null, stdout, stderr: stderr || String(err) }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

/** Finds an executable on PATH. On Windows this prefers .exe, then .cmd/.bat shims. */
export async function which(name: string): Promise<string | null> {
  const res = await run(isWin ? "where.exe" : "which", [name], { timeoutMs: 5_000 });
  if (res.code !== 0) return null;
  const hits = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!isWin) return hits[0] ?? null;
  const rank = (p: string) => (/\.exe$/i.test(p) ? 0 : /\.(cmd|bat)$/i.test(p) ? 1 : 2);
  return hits.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** Starts a long-running child (an agent CLI). cross-spawn handles .cmd shims without shell: true. */
export function start(command: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn(command, args, { ...opts, shell: false, windowsHide: true });
}

/** Kills a process and everything it started. On Windows a plain kill() leaves grandchildren running. */
export function killTree(pid: number): Promise<void> {
  if (!isWin) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 }, () => resolve());
  });
}

/**
 * Windows system variables every child needs. Without SystemRoot, Winsock and crypto fail; without
 * SystemDrive or ProgramData, Node and git pick wrong paths (emdash #3315). Adapters build their
 * own child env, so each one passes it through ensureSystemEnv as the last step.
 */
export const WINDOWS_SYSTEM_VARS = ["SystemRoot", "SystemDrive", "ProgramData", "windir", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATH", "PATHEXT", "COMSPEC"] as const;

/**
 * Copies every Windows system variable that `env` lacks from `source`. Names compare without
 * case, as Windows does: a copied process.env has "Path", and adding "PATH" next to it would give
 * the child two entries of which only one wins. Values already in `env` are kept, so an
 * adapter's own override (a profile USERPROFILE, say) stays.
 */
export function ensureSystemEnv<T extends Record<string, string | undefined>>(env: T, source: NodeJS.ProcessEnv = process.env): T {
  const present = new Set(Object.keys(env).filter((k) => env[k] !== undefined).map((k) => k.toUpperCase()));
  const sourceKeys = Object.keys(source);
  for (const name of WINDOWS_SYSTEM_VARS) {
    if (present.has(name.toUpperCase())) continue;
    const key = sourceKeys.find((k) => k.toUpperCase() === name.toUpperCase() && source[k] !== undefined);
    if (key) (env as Record<string, string>)[key] = source[key] as string;
  }
  return env;
}

/** First "x.y.z"-looking token in a --version output, e.g. "codex-cli 0.166.0" -> "0.166.0". */
export function parseVersion(text: string): string | null {
  return text.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)?.[0] ?? null;
}

/**
 * Exit status Windows gives processes it ends at shutdown, restart or sign-out
 * (DBG_TERMINATE_PROCESS, 0x40010004). Children often get it before the app hears about the
 * session ending, so a run that dies with it was interrupted, not failed (orca #33536).
 */
export const WINDOWS_SHUTDOWN_EXIT = 0x40010004;

export function isShutdownExit(code: number | null | undefined): boolean {
  return code === WINDOWS_SHUTDOWN_EXIT;
}

/** Resolves with a child's exit code, or null when it has not exited within `ms`. */
export function exitCodeWithin(child: Pick<ChildProcess, "exitCode" | "once">, ms: number): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
