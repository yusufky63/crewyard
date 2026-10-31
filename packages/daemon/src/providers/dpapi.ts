import { join } from "node:path";
import { start } from "@crewyard/proc";

// Electron's safeStorage exists only in the main process; inside the daemon (a utility process)
// require("electron") exposes net and systemPreferences only (checked on Electron 45.1.0). So the
// daemon calls Windows DPAPI itself through .NET ProtectedData in Windows PowerShell 5.1, which
// ships with every Windows 10/11. See docs/adr/0002-dpapi-secrets.md. Linux and macOS go through
// the main process's safeStorage instead (host-protector.ts, docs/adr/0010-linux-macos-groundwork.md).
//
// The script is passed with -EncodedCommand and contains no secret. The secret travels on stdin
// and the result on stdout, both base64, so it never shows up on a command line or in a process list.

export interface Protector {
  protect(plain: Buffer): Promise<Buffer>;
  unprotect(blob: Buffer): Promise<Buffer>;
}

// Entropy binds blobs to this app: another program running as the same user cannot unprotect them
// with a plain CryptUnprotectData call unless it also knows this value.
const ENTROPY = "crewyard/secret/v1";

const script = (method: "Protect" | "Unprotect") =>
  [
    "$ErrorActionPreference = 'Stop'",
    // Otherwise the first run per user writes a "Preparing modules" CLIXML record to stderr.
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Security",
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
    "$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    `$out = [Security.Cryptography.ProtectedData]::${method}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join("; ");

const encoded = (method: "Protect" | "Unprotect") => Buffer.from(script(method), "utf16le").toString("base64");

/** Absolute path, so a powershell.exe earlier on PATH or in the working folder is never picked up. */
export const powershellPath = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** PowerShell may wrap stderr in CLIXML when it is redirected; keep one readable line. */
function summarize(stderr: string): string {
  const line = stderr
    .replace(/<[^>]+>/g, " ")
    .replace(/_x000D__x000A_/g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l && !l.startsWith("#<"));
  return line ? `: ${line.slice(0, 200)}` : "";
}

const TIMED_OUT = "DPAPI helper timed out";

function runDpapi(method: "Protect" | "Unprotect", input: Buffer, timeoutMs = 20_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = start(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded(method)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(TIMED_OUT));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`DPAPI helper could not start: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // stderr never contains the secret (it is only ever on stdin), but keep the message short.
      if (code !== 0) return reject(new Error(`DPAPI ${method.toLowerCase()} failed${summarize(err)}`));
      resolve(Buffer.from(out.trim(), "base64"));
    });
    child.stdin?.end(input.toString("base64"));
  });
}

/**
 * Runs at most `max` jobs at once, in arrival order. A finished job hands its slot straight to the
 * next waiter, so a newcomer can never slip in between and push the count over `max`.
 */
export function helperQueue(max: number): <T>(job: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (job) => {
    if (running < max) running++;
    else await new Promise<void>((resume) => waiting.push(resume));
    try {
      return await job();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

/**
 * Each helper is a fresh Windows PowerShell, slow to start on a loaded machine. A burst of them
 * (every run's transcript copy at the end of a crew, while tests ran elsewhere) missed the 20 s
 * deadline, so at most two start at once, the deadline counts only from the start, and a helper
 * that timed out is tried once more with a longer one. Protect and unprotect are pure, so a retry
 * is safe.
 */
export function withRetry(queue: ReturnType<typeof helperQueue>, run: (timeoutMs: number) => Promise<Buffer>): Promise<Buffer> {
  return queue(() => run(20_000)).catch((err: unknown) => {
    if (err instanceof Error && err.message === TIMED_OUT) return queue(() => run(45_000));
    throw err;
  });
}

const helpers = helperQueue(2);

export const dpapi: Protector = {
  protect: (plain) => withRetry(helpers, (ms) => runDpapi("Protect", plain, ms)),
  unprotect: (blob) => withRetry(helpers, (ms) => runDpapi("Unprotect", blob, ms)),
};

/**
 * The daemon refuses to store keys where no system encryption is reachable, instead of writing
 * them in the clear: off Windows when it runs without the app (tests, live scripts), or when the
 * app found no keychain.
 */
export const unsupportedProtector: Protector = {
  protect: () => Promise.reject(new Error("Encrypted key storage needs Windows (DPAPI) or the app's system keychain")),
  unprotect: () => Promise.reject(new Error("Encrypted key storage needs Windows (DPAPI) or the app's system keychain")),
};

let hostSecrets: Protector | null = null;

/**
 * Linux and macOS: the daemon's entry hands in the main process's safeStorage
 * (host-protector.ts, docs/adr/0010-linux-macos-groundwork.md). Never used on Windows.
 */
export function useHostProtector(protector: Protector | null): void {
  hostSecrets = protector;
}

export const defaultProtector = (platform: NodeJS.Platform = process.platform): Protector => (platform === "win32" ? dpapi : (hostSecrets ?? unsupportedProtector));
