import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { UpdateState } from "../../shared/api.ts";
import { createEngine } from "./engine.ts";
import { decideFeed, releaseInfo } from "./feed.ts";
import { Updater, type UpdatePrefs } from "./updater.ts";

// Wires the updater to this Electron app: what the build says about itself, the feed electron-builder
// wrote, the automatic-check switch (kept in the profile, since it belongs to this installation and
// not to a database you might restore), and the engine. See docs/adr/0011-signing-and-auto-update.md.

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function prefsAt(path: string): UpdatePrefs {
  return {
    read: () => {
      try {
        return { autoCheck: (JSON.parse(readText(path) ?? "{}") as { autoCheck?: unknown }).autoCheck === true };
      } catch {
        return { autoCheck: false };
      }
    },
    write: (p) => {
      // Written beside the target and renamed, so a crash never leaves half a file; antivirus may hold it briefly.
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(p));
      for (let attempt = 0; ; attempt++) {
        try {
          renameSync(tmp, path);
          return;
        } catch (err) {
          if (attempt >= 4) throw err;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
        }
      }
    },
  };
}

export function createUpdater(onChange: (s: UpdateState) => void): Updater {
  const pkg = (() => {
    try {
      return JSON.parse(readText(join(app.getAppPath(), "package.json")) ?? "null") as unknown;
    } catch {
      return null;
    }
  })();
  const release = releaseInfo(pkg);
  const installed = existsSync(join(dirname(process.execPath), `Uninstall ${app.getName()}.exe`));
  const yml = app.isPackaged ? readText(join(process.resourcesPath, "app-update.yml")) : null;
  const decision = decideFeed({ platform: process.platform, packaged: app.isPackaged, installed }, release, yml);
  const userData = app.getPath("userData");
  const engine = decision.ok
    ? createEngine({ policy: { publisherNames: decision.feed.publisherNames, testRoot: release.testRoot }, signed: release.signed, logPath: join(userData, "logs", "updater.log") })
    : null;
  return new Updater({
    engine,
    off: decision.ok ? null : decision.off,
    current: app.getVersion(),
    feed: decision.ok ? decision.feed.url : null,
    signed: release.signed,
    publisher: decision.ok ? (decision.feed.publisherNames.join(" | ") || null) : null,
    prefs: prefsAt(join(userData, "updates.json")),
    now: () => new Date(),
    onChange,
  });
}
