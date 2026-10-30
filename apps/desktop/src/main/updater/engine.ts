import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { CancellationToken, NsisUpdater, type ProgressInfo } from "electron-updater";
import { verifyInstaller, type Policy, type Verdict } from "./signature.ts";
import { classifyError, UpdateError, type UpdateEngine } from "./updater.ts";

// electron-updater behind the UpdateEngine interface (docs/adr/0011-signing-and-auto-update.md).
// It reads the feed from resources\app-update.yml. Everything that would act on its own is off:
// no download after a check, no install on quit, no prereleases, no downgrades, no web installer.
// Every downloaded installer passes our Authenticode check (signature.ts) before electron-updater
// keeps it, and again before it is offered, because a copy cached by an earlier session skips
// electron-updater's own check.

const LOG_MAX = 1024 * 1024;

/** electron-updater's log, kept next to the profile for diagnostics. It holds versions, URLs and paths, never secrets. */
export function fileLogger(path: string) {
  const write = (level: string, args: unknown[]) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      try {
        if (statSync(path).size > LOG_MAX) renameSync(path, `${path}.old`);
      } catch {
        // no log yet
      }
      appendFileSync(path, `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")}\r\n`);
    } catch {
      // logging must never break an update
    }
  };
  return {
    info: (...a: unknown[]) => write("info", a),
    warn: (...a: unknown[]) => write("warn", a),
    error: (...a: unknown[]) => write("error", a),
    debug: (...a: unknown[]) => write("debug", a),
  };
}

export function createEngine(opts: { policy: Policy; signed: boolean; logPath: string }): UpdateEngine {
  const updater = new NsisUpdater();
  const log = fileLogger(opts.logPath);
  updater.logger = log;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  updater.fullChangelog = false;

  let lastVerdict: Verdict | null = null;
  const verify = async (file: string): Promise<Verdict> => {
    const verdict = await verifyInstaller(file, opts.policy);
    lastVerdict = verdict;
    log.info(`signature check ${verdict.ok ? `passed: ${verdict.signer}` : `refused (${verdict.problem}): ${verdict.detail}`}`);
    return verdict;
  };
  const lastProblem = () => (lastVerdict && !lastVerdict.ok ? lastVerdict.problem : null);
  // Called by electron-updater only when app-update.yml names a publisher, which a signed build always does (feed.ts).
  updater.verifyUpdateCodeSignature = async (_names: string[], file: string) => {
    const v = await verify(file);
    return v.ok ? null : `${v.problem}: ${v.detail}`;
  };
  // Errors also arrive as rejected promises below; without a listener the emitter would throw.
  updater.on("error", () => undefined);

  let token: CancellationToken | null = null;
  return {
    async check() {
      try {
        const res = await updater.checkForUpdates();
        if (!res?.isUpdateAvailable) return null;
        const info = res.updateInfo;
        const size = info.files.reduce((n, f) => n + (f.size ?? 0), 0);
        return { version: info.version, releaseDate: info.releaseDate || null, size: size > 0 ? size : null };
      } catch (err) {
        throw classifyError(err, null);
      }
    },
    async download(onProgress) {
      lastVerdict = null;
      token = new CancellationToken();
      const listener = (p: ProgressInfo) => onProgress({ percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond });
      updater.on("download-progress", listener);
      try {
        const files = await updater.downloadUpdate(token);
        if (!opts.signed) return { verifiedBy: null };
        const file = files.find((f) => f.toLowerCase().endsWith(".exe"));
        if (!file) throw new UpdateError("unknown", null, "the download produced no installer");
        const v = await verify(file);
        if (!v.ok) {
          // Otherwise electron-updater would hand out the same cached file again next time.
          rmSync(file, { force: true });
          throw new UpdateError("signature", v.problem, v.detail);
        }
        return { verifiedBy: v.signer };
      } catch (err) {
        throw classifyError(err, lastProblem());
      } finally {
        updater.off("download-progress", listener);
        token = null;
      }
    },
    cancel() {
      token?.cancel();
    },
    install() {
      // Silent, and Crewyard starts again when the installer is done.
      updater.quitAndInstall(true, true);
    },
  };
}
