import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../../shared/api.ts";
import { CHECK_EVERY_MS, classifyError, FIRST_CHECK_MS, PROGRESS_EVERY_MS, UpdateError, Updater, type Progress, type UpdateEngine } from "./updater.ts";

const AVAILABLE = { version: "0.1.1", releaseDate: "2026-10-30T12:00:00.000Z", size: 1000 };

function fakeEngine() {
  let finishDownload: ((v: { verifiedBy: string | null }) => void) | null = null;
  let failDownload: ((e: unknown) => void) | null = null;
  let progress: ((p: Progress) => void) | null = null;
  const engine = {
    check: vi.fn(async () => AVAILABLE as typeof AVAILABLE | null),
    download: vi.fn(
      (onProgress: (p: Progress) => void) =>
        new Promise<{ verifiedBy: string | null }>((resolve, reject) => {
          progress = onProgress;
          finishDownload = resolve;
          failDownload = reject;
        }),
    ),
    cancel: vi.fn(() => failDownload?.(new Error("cancelled"))),
    install: vi.fn(),
  } satisfies UpdateEngine;
  return {
    engine,
    progress: (p: Progress) => progress?.(p),
    finish: (verifiedBy: string | null) => finishDownload?.({ verifiedBy }),
    fail: (e: unknown) => failDownload?.(e),
  };
}

function make(engine: UpdateEngine | null, opts: { autoCheck?: boolean; now?: () => Date } = {}) {
  const changes: UpdateState[] = [];
  const stored = { autoCheck: opts.autoCheck ?? false };
  const updater = new Updater({
    engine,
    off: engine ? null : "no_feed",
    current: "0.1.0",
    feed: engine ? "https://updates.example.com/win" : null,
    signed: true,
    publisher: "CN=Crewyard",
    prefs: { read: () => stored, write: (p) => Object.assign(stored, p) },
    now: opts.now ?? (() => new Date("2026-10-30T18:00:00.000Z")),
    onChange: (s) => changes.push(s),
  });
  return { updater, changes, stored };
}


afterEach(() => vi.useRealTimers());

describe("Updater", () => {
  it("stays off without a feed: no checks, and the automatic switch cannot turn on", async () => {
    const { updater, stored } = make(null, { autoCheck: true });
    expect(updater.state()).toMatchObject({ phase: "off", off: "no_feed", autoCheck: false });
    await updater.check();
    expect(updater.setAutoCheck(true).autoCheck).toBe(false);
    expect(stored.autoCheck).toBe(true);
    expect(updater.state().phase).toBe("off");
  });

  it("checks, offers, downloads and verifies, then waits for a click to install", async () => {
    const f = fakeEngine();
    const { updater } = make(f.engine);
    await updater.check();
    expect(updater.state()).toMatchObject({ phase: "available", available: AVAILABLE, checkedAt: "2026-10-30T18:00:00.000Z" });
    expect(f.engine.download).not.toHaveBeenCalled();

    const done = updater.download();
    expect(updater.state().phase).toBe("downloading");
    f.finish("CN=Crewyard");
    await done;
    expect(updater.state()).toMatchObject({ phase: "downloaded", verifiedBy: "CN=Crewyard", progress: null });
    expect(f.engine.install).not.toHaveBeenCalled();

    // A check while an update waits would only drop it; it is ignored.
    await updater.check();
    expect(f.engine.check).toHaveBeenCalledTimes(1);
    expect(updater.install()).toBe(true);
    expect(f.engine.install).toHaveBeenCalledTimes(1);
  });

  it("says when this version is current", async () => {
    const f = fakeEngine();
    f.engine.check.mockResolvedValueOnce(null);
    const { updater } = make(f.engine);
    await updater.check();
    expect(updater.state()).toMatchObject({ phase: "current", available: null });
    expect(updater.install()).toBe(false);
  });

  it("keeps a refused update refused, with the reason, and installs nothing", async () => {
    const f = fakeEngine();
    const { updater } = make(f.engine);
    await updater.check();
    const done = updater.download();
    f.fail(new UpdateError("signature", "tampered", "the installer was changed after it was signed"));
    await done;
    expect(updater.state()).toMatchObject({ phase: "error", available: AVAILABLE, error: { code: "signature", problem: "tampered" } });
    expect(updater.install()).toBe(false);
    expect(f.engine.install).not.toHaveBeenCalled();
  });

  it("cancels back to the offer", async () => {
    const f = fakeEngine();
    const { updater } = make(f.engine);
    await updater.check();
    const done = updater.download();
    updater.cancel();
    await done;
    expect(updater.state()).toMatchObject({ phase: "available", progress: null, error: null });
  });

  it("passes progress on at most every 250 ms, and always the last step", async () => {
    let t = 0;
    const f = fakeEngine();
    const { updater, changes } = make(f.engine, { now: () => new Date(t) });
    await updater.check();
    void updater.download();
    const before = changes.length;
    for (let i = 1; i <= 10; i++) {
      t += 50;
      f.progress({ percent: i * 9, transferred: i * 90, total: 1000, bytesPerSecond: 10 });
    }
    f.progress({ percent: 100, transferred: 1000, total: 1000, bytesPerSecond: 10 });
    const sent = changes.slice(before).map((s) => s.progress?.percent);
    expect(sent).toEqual([45, 90, 100]);
    expect(PROGRESS_EVERY_MS).toBe(250);
  });

  it("checks on its own only while the switch is on, and never downloads", async () => {
    vi.useFakeTimers();
    const f = fakeEngine();
    const { updater, stored } = make(f.engine);
    updater.schedule();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS + CHECK_EVERY_MS);
    expect(f.engine.check).not.toHaveBeenCalled();

    updater.setAutoCheck(true);
    expect(stored.autoCheck).toBe(true);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(f.engine.check).toHaveBeenCalledTimes(1);
    expect(updater.state().phase).toBe("available");
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(f.engine.check).toHaveBeenCalledTimes(2);
    expect(f.engine.download).not.toHaveBeenCalled();

    updater.setAutoCheck(false);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(f.engine.check).toHaveBeenCalledTimes(2);
  });
});

describe("classifyError", () => {
  const err = (code: string, message = code) => Object.assign(new Error(message), { code });

  it("maps electron-updater's errors to what the window can say", () => {
    expect(classifyError(err("ERR_UPDATER_INVALID_SIGNATURE"), "wrong_publisher")).toMatchObject({ code: "signature", problem: "wrong_publisher" });
    expect(classifyError(err("ERR_UPDATER_INVALID_SIGNATURE"), null)).toMatchObject({ code: "signature", problem: "check_failed" });
    expect(classifyError(err("ERR_CHECKSUM_MISMATCH", "sha512 checksum mismatch, expected x, got y"), null).code).toBe("checksum");
    expect(classifyError(err("ERR_UPDATER_LATEST_VERSION_NOT_FOUND"), null).code).toBe("feed");
    expect(classifyError(err("ECONNREFUSED"), null).code).toBe("network");
    expect(classifyError(new Error("net::ERR_INTERNET_DISCONNECTED"), null).code).toBe("network");
    expect(classifyError(err("ENOSPC"), null).code).toBe("disk");
    expect(classifyError(new Error("something else\nwith a stack"), null)).toMatchObject({ code: "unknown", message: "something else" });
  });
});
