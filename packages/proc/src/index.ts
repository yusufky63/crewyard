import { execFile } from "node:child_process";
import { join } from "node:path";
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

const isShim = (command: string) => isWin && /\.(cmd|bat)$/i.test(command);

/**
 * A .cmd/.bat shim runs through cmd.exe, which ends the command line at the first line break:
 * everything after it, including later arguments, is silently dropped (verified with Git for
 * Windows 2.56 and cross-spawn 7.0.6). Refusing is better than running a cut-down command, so
 * multi-line text (prompts) must go over stdin or a file instead.
 */
export function shimArgsProblem(command: string, args: readonly string[]): string | null {
  if (!isShim(command)) return null;
  const i = args.findIndex((a) => /[\r\n]/.test(a));
  return i < 0 ? null : `argument ${i + 1} contains a line break, which cmd.exe cannot pass to ${command}`;
}

/**
 * Runs a short command and collects its output. Times out instead of hanging the daemon.
 * Goes through cross-spawn because Node refuses to start .cmd/.bat files without a shell
 * (EINVAL), and every npm-installed agent CLI on Windows is a .cmd shim.
 */
export function run(command: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  const refused = shimArgsProblem(command, args);
  if (refused) return Promise.resolve({ code: null, stdout: "", stderr: refused });
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

// Only these can be started without a shell. npm also drops an extensionless sh script and a .ps1
// next to every .cmd shim; where.exe lists them, but neither runs here.
const SPAWNABLE = /\.(exe|com|cmd|bat)$/i;
const winRank = (p: string) => (/\.(exe|com)$/i.test(p) ? 0 : 1);

/**
 * Picks the binary from where.exe's hits (PATH order): a real .exe beats a .cmd shim anywhere on
 * PATH, because the shim re-parses its arguments through cmd.exe (agent-orchestrator #3409).
 */
export function pickWindowsHit(hits: readonly string[]): string | null {
  return hits.filter((p) => SPAWNABLE.test(p)).sort((a, b) => winRank(a) - winRank(b))[0] ?? null;
}

// By full path: cross-spawn's own lookup of a bare "where.exe" would search the current folder first.
const WHERE = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");

/**
 * Finds an executable on PATH. On Windows `$PATH:` keeps where.exe from also searching the current
 * folder, so a git.exe planted in a repo is never picked up.
 */
export async function which(name: string, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<string | null> {
  const hits = await pathHits(name, opts.env);
  return isWin ? pickWindowsHit(hits) : (hits[0] ?? null);
}

/**
 * Every startable copy of a command on PATH, in PATH order and without repeats. A CLI installed
 * twice (`claude update` warns about an npm copy beside the native one) shows up as two entries.
 */
export async function whichAll(name: string, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<string[]> {
  const hits = (await pathHits(name, opts.env)).filter((p) => !isWin || SPAWNABLE.test(p));
  const seen = new Set<string>();
  return hits.filter((p) => {
    const key = isWin ? p.toLowerCase() : p;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function pathHits(name: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
  const res = await run(isWin ? WHERE : "which", isWin ? [`$PATH:${name}`] : ["-a", name], { timeoutMs: 5_000, env });
  if (res.code !== 0) return [];
  return res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Remembers async answers (probes, binary lookups) per key. Callers that arrive while one is in
 * flight share it, so a burst of screens asking at once starts one probe (agent-orchestrator
 * #6444, #5887). Each caller says how old an answer it accepts; failures are never kept.
 */
export class ProbeCache<T> {
  private readonly done = new Map<string, { at: number; value: T }>();
  private readonly flying = new Map<string, Promise<T>>();

  private readonly now: () => number;

  // Plain fields, not parameter properties: live scripts run this file through Node's type stripping.
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get(key: string, maxAgeMs: number, probe: () => Promise<T>): Promise<T> {
    const hit = this.done.get(key);
    if (hit && this.now() - hit.at <= maxAgeMs) return Promise.resolve(hit.value);
    const pending = this.flying.get(key);
    if (pending) return pending;
    const p = probe().then(
      (value) => {
        this.done.set(key, { at: this.now(), value });
        this.flying.delete(key);
        return value;
      },
      (err: unknown) => {
        this.flying.delete(key);
        throw err;
      },
    );
    this.flying.set(key, p);
    return p;
  }

  clear(): void {
    this.done.clear();
  }
}

const bins = new ProbeCache<string | null>();

/**
 * which() through a shared cache keyed by PATH, so the machine check and the adapter that spawns
 * resolve the same file (agent-orchestrator #6468). A PATH change misses the cache at once.
 */
export function resolveBin(name: string, maxAgeMs = 30_000): Promise<string | null> {
  return bins.get(`${name}\0${process.env.PATH ?? ""}`, maxAgeMs, () => which(name));
}

/** Starts a long-running child (an agent CLI). cross-spawn handles .cmd shims without shell: true. */
export function start(command: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const refused = shimArgsProblem(command, args);
  if (refused) throw new Error(refused);
  return spawn(command, args, { ...opts, shell: false, windowsHide: true });
}

/**
 * Splits child output into lines without letting one line grow without bound. A line longer than
 * `maxBytes` (UTF-16 units, close enough for a cap) is dropped while it streams in and reported
 * once with its size, so a runaway JSONL record cannot hold the daemon's memory (Agent Monitor
 * #341). Only the new chunk is scanned for newlines, so long lines stay linear.
 */
export class LineSplitter {
  private parts: string[] = [];
  private size = 0;
  private dropping = false;

  private readonly maxBytes: number;
  private readonly onOversize: (bytes: number) => void;

  constructor(maxBytes = 16 * 1024 * 1024, onOversize: (bytes: number) => void = () => {}) {
    this.maxBytes = maxBytes;
    this.onOversize = onOversize;
  }

  push(chunk: string): string[] {
    const out: string[] = [];
    let from = 0;
    for (let nl = chunk.indexOf("\n"); nl >= 0; nl = chunk.indexOf("\n", from)) {
      this.add(chunk.slice(from, nl));
      const line = this.take();
      if (line !== null) out.push(line);
      from = nl + 1;
    }
    this.add(chunk.slice(from));
    return out;
  }

  /** Whatever is left when the stream ends without a trailing newline. */
  flush(): string[] {
    const line = this.take();
    return line === null ? [] : [line];
  }

  private add(piece: string): void {
    if (piece === "") return;
    this.size += piece.length;
    if (this.dropping) return;
    if (this.size > this.maxBytes) {
      this.dropping = true;
      this.parts = [];
    } else this.parts.push(piece);
  }

  private take(): string | null {
    const size = this.size;
    const line = this.dropping ? null : this.parts.join("").replace(/\r$/, "");
    if (this.dropping) this.onOversize(size);
    this.parts = [];
    this.size = 0;
    this.dropping = false;
    return line === null || line.trim() === "" ? null : line;
  }
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
