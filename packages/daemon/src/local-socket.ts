import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";

// Where the daemon listens for local connections (docs/adr/0010-linux-macos-groundwork.md). Never
// a TCP port (AGENTS.md): on Windows a named pipe, on Linux and macOS a Unix domain socket in a
// folder only this user can open.
//
// On POSIX the folder is what keeps other users out: macOS does not check a socket file's own
// mode on connect, and Node creates the file with the process umask before we can chmod it. So
// the folder is created 0700 (or must already be ours, 0700, and not a symlink) before listen,
// and the socket is chmod 0600 after it.

export type Platform = NodeJS.Platform;

/** sun_path minus its NUL: 104 bytes on macOS, 108 on Linux (Node's net docs). */
export const SOCKET_PATH_MAX: Partial<Record<Platform, number>> = { darwin: 103, linux: 107 };
const DEFAULT_MAX = 103;

export interface EndpointEnv {
  platform?: Platform;
  /** XDG_RUNTIME_DIR: per user, 0700, removed at logout (XDG Base Directory spec). Linux only. */
  runtimeDir?: string;
  tmp?: string;
  uid?: number;
}

const own = (e: EndpointEnv) => ({
  platform: e.platform ?? process.platform,
  runtimeDir: e.runtimeDir ?? process.env.XDG_RUNTIME_DIR,
  tmp: e.tmp ?? tmpdir(),
  uid: e.uid ?? process.getuid?.() ?? 0,
});

/**
 * Private socket folders, best first. The uid in the name keeps two users on one machine from
 * meeting in a shared temp folder; /tmp is last, for a TMPDIR too long for sun_path.
 */
export function socketDirs(env: EndpointEnv = {}): string[] {
  const e = own(env);
  const dirs: string[] = [];
  if (e.platform === "linux" && e.runtimeDir && posix.isAbsolute(e.runtimeDir)) dirs.push(posix.join(e.runtimeDir, "crewyard"));
  if (posix.isAbsolute(e.tmp)) dirs.push(posix.join(e.tmp, `crewyard-${e.uid}`));
  dirs.push(`/tmp/crewyard-${e.uid}`);
  return [...new Set(dirs)];
}

/**
 * The address for a local endpoint called `name`: `\\.\pipe\<name>` on Windows, otherwise
 * `<private folder>/<name>.sock` in the first folder whose path fits sun_path.
 */
export function endpointPath(name: string, env: EndpointEnv = {}): string {
  const e = own(env);
  if (e.platform === "win32") return `\\\\.\\pipe\\${name}`;
  const max = SOCKET_PATH_MAX[e.platform] ?? DEFAULT_MAX;
  for (const dir of socketDirs(env)) {
    const path = posix.join(dir, `${name}.sock`);
    if (Buffer.byteLength(path) <= max) return path;
  }
  throw new Error(`No socket folder short enough for ${name} (limit ${max} bytes)`);
}

export interface PrivateDirFs {
  mkdir(path: string, mode: number): void;
  lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number };
  chmod(path: string, mode: number): void;
}

const realFs: PrivateDirFs = {
  mkdir: (path, mode) => mkdirSync(path, { mode }),
  lstat: (path) => lstatSync(path),
  chmod: (path, mode) => chmodSync(path, mode),
};

/**
 * Creates the socket folder 0700, or checks the one there: a symlink, someone else's folder or a
 * file in its place is refused, because another local user could have made it first in /tmp. Our
 * own folder with a looser mode is tightened. Windows pipes need nothing.
 */
export function ensurePrivateDir(socketPath: string, env: EndpointEnv = {}, fs: PrivateDirFs = realFs): void {
  const e = own(env);
  if (e.platform === "win32") return;
  const dir = posix.dirname(socketPath);
  try {
    fs.mkdir(dir, 0o700);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const s = fs.lstat(dir);
  if (s.isSymbolicLink() || !s.isDirectory()) throw new Error(`${dir} is not a plain folder; refusing to listen there`);
  if (s.uid !== e.uid) throw new Error(`${dir} belongs to another user; refusing to listen there`);
  if ((s.mode & 0o077) !== 0) fs.chmod(dir, 0o700);
}

/** Owner read and write only, after listen created the socket file. */
export function restrictSocket(socketPath: string, env: EndpointEnv = {}, fs: Pick<PrivateDirFs, "chmod"> = realFs): void {
  if (own(env).platform === "win32") return;
  fs.chmod(socketPath, 0o600);
}
