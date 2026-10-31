import { posix, win32 } from "node:path";
import type { FolderProblem, OpenFolderRequest } from "../shared/api.ts";

// "Open in Crewyard" (PLAN.md §12): a folder arrives on the command line (`Crewyard.exe <folder>`, the
// Explorer verb the installer registers), from a second start through `second-instance`, or from a
// drop on the window. Every source ends in `checkFolder`, so nothing reaches the renderer unchecked.

export interface ArgvContext {
  /** The folder relative paths resolve against: the caller's, not necessarily this process's. */
  cwd: string;
  platform: NodeJS.Platform;
  /** Entries before the user's own: the exe, and in a development run (`electron .`) the app folder. */
  skip: number;
}

/**
 * The first positional argument as an absolute path, or null. Chromium and Electron switches (`--x`,
 * `-x`, and on Windows `/x`) are skipped wherever they appear: Chromium adds its own
 * (`--original-process-start-time`) and a toast press starts the app with `-ToastActivated`.
 */
export function folderArg(argv: readonly string[], ctx: ArgvContext): string | null {
  const win = ctx.platform === "win32";
  const path = win ? win32 : posix;
  let switches = true;
  for (const raw of argv.slice(ctx.skip)) {
    if (switches && raw === "--") {
      switches = false;
      continue;
    }
    if (switches && (raw.startsWith("-") || (win && raw.startsWith("/")))) continue;
    let arg = raw.trim();
    // Windows reads `"C:\"` as `C:"`: the backslash escapes the closing quote. Explorer's `"%V"` gives
    // exactly that on a drive root, and a typed `"C:\My folder\"` does the same.
    if (win && arg.endsWith('"') && !arg.startsWith('"')) arg = `${arg.slice(0, -1)}\\`;
    arg = arg.replace(/^"+|"+$/g, "");
    if (!arg) continue;
    return path.resolve(ctx.cwd, arg);
  }
  return null;
}

/** What `checkFolder` needs from the disk; injected so every rule is tested without real folders. */
export type StatFn = (path: string) => { isDirectory(): boolean } | null;

const MAX_PATH_CHARS = 32_767;

/**
 * Validates a folder to open. WSL and other UNC paths are refused for Windows-native runs (PLAN.md
 * §12), and so are device paths; a `\\?\` long-path prefix on a drive path is accepted and dropped.
 */
export function checkFolder(raw: string, platform: NodeJS.Platform, stat: StatFn): OpenFolderRequest {
  const refuse = (problem: FolderProblem, path = raw): OpenFolderRequest => ({ path, problem });
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
  if (!raw || raw.length > MAX_PATH_CHARS || /[\u0000-\u001f]/.test(raw)) return refuse("invalid", raw.slice(0, 260));
  let path: string;
  if (platform === "win32") {
    let p = raw.replace(/\//g, "\\");
    if (/^\\\\\?\\UNC\\/i.test(p)) return refuse("unc");
    if (/^\\\\\?\\[A-Za-z]:\\/.test(p)) p = p.slice(4);
    if (/^\\\\(wsl\$|wsl\.localhost)(\\|$)/i.test(p)) return refuse("wsl");
    if (/^\\\\[.?]\\/.test(p)) return refuse("invalid");
    if (p.startsWith("\\\\")) return refuse("unc");
    if (!/^[A-Za-z]:\\/.test(p)) return refuse("invalid");
    path = win32.normalize(p);
    // `C:\` keeps its separator; everywhere else the trailing one goes.
    if (path.length > 3) path = path.replace(/\\+$/, "");
  } else {
    if (!raw.startsWith("/")) return refuse("invalid");
    path = posix.normalize(raw);
    if (path.length > 1) path = path.replace(/\/+$/, "");
  }
  const s = stat(path);
  if (!s) return refuse("missing", path);
  if (!s.isDirectory()) return refuse("notFolder", path);
  return { path, problem: null };
}
