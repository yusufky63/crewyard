import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import spawn from "cross-spawn";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { findOnPosixPath, isExecutableFile, isWindows, killTreePosix, posixSearchDirs, systemEnvVars, type Platform } from "./platform.ts";

export * from "./platform.ts";

// Windows rules from PLAN.md §12: resolve npm .cmd shims to real paths, never use a shell,
// never flash a console window, and always kill the whole process tree. The Linux and macOS
// branches live in platform.ts (docs/adr/0010-linux-macos-groundwork.md).

const isWin = process.platform === "win32";
/**
 * On Linux and macOS every child leads its own process group, so killTree can signal the whole
 * group. On Windows `detached` means a new console, so it is never set there.
 */
const ownGroup = (opts: { detached?: boolean } = {}) => opts.detached ?? !isWin;

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
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, shell: false, windowsHide: true, detached: ownGroup() });
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

/**
 * Finds an executable on PATH, never in the current folder, so a git.exe planted in a repo is never
 * picked up. Every platform searches in-process: Windows used to ask where.exe, but under load that
 * child could miss its 5-second limit and every installed CLI then read as not found until the
 * next check (owner, 2026-11-01: all four agents showed "bulunamadı" while each was on PATH).
 */
export async function which(name: string, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<string | null> {
  if (!isWin) return findOnPosixPath(name, { pathValue: (opts.env ?? process.env).PATH });
  return pickWindowsHit(await pathHits(name, opts.env));
}

/**
 * Every startable copy of a command on PATH, in PATH order and without repeats. A CLI installed
 * twice (`claude update` warns about an npm copy beside the native one) shows up as two entries.
 */
export async function whichAll(name: string, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<string[]> {
  const hits = isWin ? (await pathHits(name, opts.env)).filter((p) => SPAWNABLE.test(p)) : await allOnPosixPath(name, (opts.env ?? process.env).PATH);
  const seen = new Set<string>();
  return hits.filter((p) => {
    const key = isWin ? p.toLowerCase() : p;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** where.exe's hits in PATH order (Windows), found in-process: see windowsPathHits. */
async function pathHits(name: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
  const vars = env ?? process.env;
  return windowsPathHits(name, envValue(vars, "PATH"), envValue(vars, "PATHEXT"));
}

/** A variable from an env object, by any casing: Windows spells it Path, a copied object keeps that. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * What `where.exe $PATH:<name>` lists, without starting it: each PATH folder in order, the name as
 * given and then with each PATHEXT extension, files only, no repeats. The current folder is never
 * searched, and a name with a folder in it is refused.
 */
export function windowsPathHits(name: string, pathValue: string | undefined, pathext: string | undefined, exists: (p: string) => boolean = isFile): string[] {
  if (!name || /[\\/:]/.test(name) || !pathValue) return [];
  const exts = (pathext || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim()).filter((e) => e.startsWith("."));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of pathValue.split(";")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !win32.isAbsolute(dir)) continue;
    for (const candidate of [name, ...exts.map((e) => name + e.toLowerCase())]) {
      const full = win32.join(dir, candidate);
      const key = full.toLowerCase();
      if (seen.has(key) || !exists(full)) continue;
      seen.add(key);
      out.push(full);
    }
  }
  return out;
}

/** Every executable of that name on the POSIX search path, never the current folder (as findOnPosixPath). */
async function allOnPosixPath(name: string, pathValue: string | undefined): Promise<string[]> {
  if (!name || name.includes("/")) return [];
  const out: string[] = [];
  for (const dir of posixSearchDirs(pathValue, process.platform, homedir())) {
    const candidate = posix.join(dir, name);
    if (await isExecutableFile(candidate)) out.push(candidate);
  }
  return out;
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
  return spawn(command, args, { ...opts, shell: false, windowsHide: true, detached: ownGroup(opts) });
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

/**
 * Kills a process and everything it started. On Windows a plain kill() leaves grandchildren
 * running, so taskkill walks the tree; Linux and macOS signal the process group (killTreePosix).
 */
export function killTree(pid: number): Promise<void> {
  if (!isWin) return killTreePosix(pid);
  return new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 }, () => resolve());
  });
}

/**
 * Copies every system variable that `env` lacks from `source` (systemEnvVars). On Windows names
 * compare without case, as Windows does: a copied process.env has "Path", and adding "PATH" next
 * to it would give the child two entries of which only one wins. Linux and macOS names are exact.
 * Values already in `env` are kept, so an adapter's own override (a profile USERPROFILE or HOME,
 * say) stays.
 */
export function ensureSystemEnv<T extends Record<string, string | undefined>>(env: T, source: NodeJS.ProcessEnv = process.env, platform: Platform = process.platform): T {
  const fold = isWindows(platform) ? (k: string) => k.toUpperCase() : (k: string) => k;
  const present = new Set(Object.keys(env).filter((k) => env[k] !== undefined).map(fold));
  const sourceKeys = Object.keys(source);
  for (const name of systemEnvVars(platform)) {
    if (present.has(fold(name))) continue;
    const key = sourceKeys.find((k) => fold(k) === fold(name) && source[k] !== undefined);
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
