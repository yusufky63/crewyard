import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";

// The platform seam for child processes (docs/adr/0010-linux-macos-groundwork.md). Windows keeps
// every rule it had in index.ts; Linux and macOS get their branch here. Each helper takes the
// platform (and its other inputs) as arguments, so both branches run under test on any machine.

export type Platform = NodeJS.Platform;

export const isWindows = (platform: Platform = process.platform): boolean => platform === "win32";

/**
 * Windows system variables every child needs. Without SystemRoot, Winsock and crypto fail; without
 * SystemDrive or ProgramData, Node and git pick wrong paths (emdash #3315). Adapters build their
 * own child env, so each one passes it through ensureSystemEnv as the last step.
 */
export const WINDOWS_SYSTEM_VARS = ["SystemRoot", "SystemDrive", "ProgramData", "windir", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATH", "PATHEXT", "COMSPEC"] as const;

/**
 * The POSIX counterpart. HOME and TMPDIR place config and temp files (macOS gives every user its
 * own TMPDIR); SHELL is the shell Codex runs commands in; the D-Bus address and XDG_RUNTIME_DIR
 * reach the Secret Service that Codex and Gemini CLI keep sign-ins in; DISPLAY and WAYLAND_DISPLAY
 * let a CLI's own sign-in open the browser.
 */
export const POSIX_SYSTEM_VARS = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY"] as const;

export function systemEnvVars(platform: Platform = process.platform): readonly string[] {
  return isWindows(platform) ? WINDOWS_SYSTEM_VARS : POSIX_SYSTEM_VARS;
}

/**
 * Folders where each runner's own installer puts its binary, searched after PATH. An app started
 * from the Dock, Finder or a desktop launcher gets a short PATH without the user's shell setup, so
 * a CLI that works in a terminal would read as "not installed" (checked against each project's
 * install docs on 2026-10-30, sources in ADR 0010):
 * - Claude Code's native installer: ~/.local/bin;
 * - OpenCode's install script: ~/.opencode/bin;
 * - Homebrew: /opt/homebrew/bin on Apple silicon and /home/linuxbrew/.linuxbrew/bin on Linux; npm's
 *   global prefix under Homebrew's Node lands there too;
 * - /usr/local/bin, /usr/bin and /bin, the standard folders a GUI launch may still lack.
 */
export function wellKnownBinDirs(platform: Platform, home: string): string[] {
  if (isWindows(platform)) return [];
  const user = home && posix.isAbsolute(home) ? [posix.join(home, ".local", "bin"), posix.join(home, ".opencode", "bin")] : [];
  const system = platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] : ["/usr/local/bin", "/usr/bin", "/bin", "/home/linuxbrew/.linuxbrew/bin", "/snap/bin"];
  return [...user, ...system];
}

/**
 * The folders a POSIX lookup searches: PATH in order, then the well-known folders. Empty and
 * relative PATH entries are dropped: POSIX reads them as the current folder, and a binary planted
 * in a repository must never be picked up (the same rule where.exe gets with `$PATH:` on Windows).
 */
export function posixSearchDirs(pathValue: string | undefined, platform: Platform, home: string): string[] {
  const dirs = (pathValue ?? "").split(":").filter((d) => d !== "" && posix.isAbsolute(d));
  return [...new Set([...dirs.map((d) => posix.normalize(d)), ...wellKnownBinDirs(platform, home)])];
}

/** A regular file this user may execute. */
export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a bare command name the way a POSIX shell would, without starting `which` (minimal
 * distributions and containers do not ship it). A name with a slash is not looked up.
 */
export async function findOnPosixPath(
  name: string,
  opts: { pathValue?: string; platform?: Platform; home?: string; isExecutable?: (path: string) => Promise<boolean> } = {},
): Promise<string | null> {
  if (!name || name.includes("/")) return null;
  const check = opts.isExecutable ?? isExecutableFile;
  for (const dir of posixSearchDirs(opts.pathValue, opts.platform ?? process.platform, opts.home ?? homedir())) {
    const candidate = posix.join(dir, name);
    if (await check(candidate)) return candidate;
  }
  return null;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
}

/** Parses `ps -A -o pid= -o ppid=`, which prints the same two columns on Linux (procps) and macOS. */
export function parsePsTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return rows;
}

/** Every process started under `root`, children first in breadth order; `root` itself is left out. */
export function descendantsOf(root: number, rows: readonly ProcessRow[]): number[] {
  const children = new Map<number, number[]>();
  for (const r of rows) {
    if (r.pid === r.ppid) continue;
    const list = children.get(r.ppid);
    if (list) list.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  const out: number[] = [];
  const seen = new Set([root]);
  for (let queue = [root]; queue.length > 0; ) {
    const next: number[] = [];
    for (const p of queue) {
      for (const c of children.get(p) ?? []) {
        if (seen.has(c)) continue;
        seen.add(c);
        out.push(c);
        next.push(c);
      }
    }
    queue = next;
  }
  return out;
}

/**
 * The process table from ps. execFile directly rather than run(): run() kills a timed-out child
 * with killTree, which would call this again.
 */
export function readPsTable(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-A", "-o", "pid=", "-o", "ppid="], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? [] : parsePsTable(String(stdout))));
  });
}

export interface PosixKillDeps {
  /** process.kill; a negative pid signals the whole process group. False when nothing received it. */
  signal(pid: number, sig: NodeJS.Signals | 0): boolean;
  table(): Promise<ProcessRow[]>;
  sleep(ms: number): Promise<void>;
  /** How long the tree gets to exit on SIGTERM before SIGKILL. */
  graceMs: number;
}

const send = (pid: number, sig: NodeJS.Signals | 0): boolean => {
  try {
    return process.kill(pid, sig);
  } catch (err) {
    // macOS answers EPERM for a group whose members are all zombies (agent-orchestrator
    // tree_unix.go), so for the liveness probe EPERM means "still there"; it never means gone.
    return sig === 0 && (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const defaultPosixKillDeps = (): PosixKillDeps => ({
  signal: send,
  table: readPsTable,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  graceMs: 2_000,
});

const POLL_MS = 100;

/**
 * Ends a process tree on Linux and macOS. Every child the daemon starts leads its own process
 * group (start() and run() pass `detached`), so signalling the group reaches what the runner
 * started; the descendants found through ps are signalled one by one as well, for the ones that
 * moved to a group of their own. SIGTERM first, so a runner can save its session, then SIGKILL for
 * whatever is still there after the grace period. Never throws.
 */
export async function killTreePosix(pid: number, deps: PosixKillDeps = defaultPosixKillDeps()): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) return;
  // Read before signalling: once the root exits, its children move to init and the links are lost.
  const tree = descendantsOf(pid, await deps.table().catch(() => []));
  const targets = [-pid, pid, ...tree];
  const alive = () => targets.filter((p) => deps.signal(p, 0));
  for (const p of targets) deps.signal(p, "SIGTERM");
  for (let waited = 0; waited < deps.graceMs; waited += POLL_MS) {
    if (alive().length === 0) return;
    await deps.sleep(POLL_MS);
  }
  for (const p of alive()) deps.signal(p, "SIGKILL");
}
