import type { SignatureProblem, UpdateErrorCode, UpdateOff, UpdateState } from "../../shared/api.ts";

// The update flow the Settings screen and the status bar show (docs/adr/0011-signing-and-auto-update.md).
// It only ever checks on its own, and only when you turned automatic checks on; downloading and
// installing each wait for a click. electron-updater sits behind UpdateEngine (engine.ts), so this
// file is plain logic with tests.

export interface Available {
  version: string;
  releaseDate: string | null;
  size: number | null;
}

export interface Progress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export class UpdateError extends Error {
  constructor(
    readonly code: UpdateErrorCode,
    readonly problem: SignatureProblem | null,
    detail: string,
  ) {
    super(detail);
  }
}

export interface UpdateEngine {
  /** The newer version the feed offers, or null when this one is current. */
  check(): Promise<Available | null>;
  /** Downloads and verifies; resolves with the verified signer (null for an unsigned test build). */
  download(onProgress: (p: Progress) => void): Promise<{ verifiedBy: string | null }>;
  cancel(): void;
  /** Starts the installer for the downloaded update and quits. */
  install(): void;
}

export interface UpdatePrefs {
  read(): { autoCheck: boolean };
  write(p: { autoCheck: boolean }): void;
}

export interface UpdaterDeps {
  engine: UpdateEngine | null;
  off: UpdateOff | null;
  current: string;
  feed: string | null;
  signed: boolean;
  publisher: string | null;
  prefs: UpdatePrefs;
  now: () => Date;
  onChange: (s: UpdateState) => void;
}

/** Progress events come many times a second; the window hears about them this often at most. */
export const PROGRESS_EVERY_MS = 250;
export const FIRST_CHECK_MS = 60_000;
export const CHECK_EVERY_MS = 6 * 60 * 60_000;

const BUSY = new Set(["checking", "downloading"]);

export class Updater {
  private s: UpdateState;
  private lastProgress = 0;
  private timers: Array<ReturnType<typeof setTimeout>> = [];

  constructor(private readonly deps: UpdaterDeps) {
    const enabled = deps.engine !== null && deps.off === null;
    this.s = {
      phase: enabled ? "idle" : "off",
      off: enabled ? null : (deps.off ?? "no_feed"),
      current: deps.current,
      feed: deps.feed,
      signed: deps.signed,
      publisher: deps.publisher,
      // Off until a feed is configured, whatever was stored.
      autoCheck: enabled && deps.prefs.read().autoCheck,
      checkedAt: null,
      available: null,
      progress: null,
      verifiedBy: null,
      error: null,
    };
  }

  state(): UpdateState {
    return this.s;
  }

  private set(patch: Partial<UpdateState>): void {
    this.s = { ...this.s, ...patch };
    this.deps.onChange(this.s);
  }

  private fail(err: unknown, back: Partial<UpdateState> = {}): void {
    const e = err instanceof UpdateError ? err : new UpdateError("unknown", null, err instanceof Error ? err.message : String(err));
    this.set({ ...back, phase: "error", progress: null, error: { code: e.code, problem: e.problem, detail: e.message } });
  }

  async check(): Promise<UpdateState> {
    const engine = this.deps.engine;
    if (!engine || this.s.phase === "off" || BUSY.has(this.s.phase) || this.s.phase === "downloaded") return this.s;
    this.set({ phase: "checking", error: null });
    try {
      const found = await engine.check();
      const checkedAt = this.deps.now().toISOString();
      if (found) this.set({ phase: "available", available: found, checkedAt, verifiedBy: null });
      else this.set({ phase: "current", available: null, checkedAt });
    } catch (err) {
      this.fail(err);
    }
    return this.s;
  }

  async download(): Promise<UpdateState> {
    const engine = this.deps.engine;
    // A refused download can be tried again; the refusal names the version it was about.
    const retry = this.s.phase === "error" && this.s.available !== null;
    if (!engine || (this.s.phase !== "available" && !retry)) return this.s;
    this.lastProgress = 0;
    this.set({ phase: "downloading", error: null, progress: { percent: 0, transferred: 0, total: this.s.available?.size ?? 0, bytesPerSecond: 0 } });
    try {
      const { verifiedBy } = await engine.download((p) => this.onProgress(p));
      if (this.s.phase !== "downloading") return this.s;
      this.set({ phase: "downloaded", progress: null, verifiedBy });
    } catch (err) {
      // Cancelling ends the download with an error too; that one is not a failure.
      if (this.s.phase === "available") return this.s;
      this.fail(err);
    }
    return this.s;
  }

  private onProgress(p: Progress): void {
    if (this.s.phase !== "downloading") return;
    const t = this.deps.now().getTime();
    if (p.percent < 100 && t - this.lastProgress < PROGRESS_EVERY_MS) return;
    this.lastProgress = t;
    this.set({ progress: p });
  }

  cancel(): UpdateState {
    if (this.s.phase !== "downloading") return this.s;
    this.set({ phase: "available", progress: null });
    this.deps.engine?.cancel();
    return this.s;
  }

  /** Only a downloaded and verified update; the caller has already asked about running agents. */
  install(): boolean {
    if (this.s.phase !== "downloaded" || !this.deps.engine) return false;
    this.deps.engine.install();
    return true;
  }

  setAutoCheck(on: boolean): UpdateState {
    if (this.s.phase === "off" || this.s.autoCheck === on) return this.s;
    this.deps.prefs.write({ autoCheck: on });
    this.set({ autoCheck: on });
    if (on) this.schedule();
    else this.unschedule();
    return this.s;
  }

  /** Automatic checks: once shortly after start, then every few hours; only while the switch is on. */
  schedule(): void {
    this.unschedule();
    if (!this.s.autoCheck || this.s.phase === "off") return;
    const tick = () => {
      if (this.s.autoCheck) void this.check();
    };
    const first = setTimeout(tick, FIRST_CHECK_MS);
    const every = setInterval(tick, CHECK_EVERY_MS);
    first.unref?.();
    every.unref?.();
    this.timers = [first, every];
  }

  unschedule(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

/** electron-updater's errors, in words the window can translate. Unknown codes stay "unknown" with their text. */
export function classifyError(err: unknown, problem: SignatureProblem | null): UpdateError {
  if (err instanceof UpdateError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  const detail = message.split("\n")[0]?.slice(0, 500) ?? "";
  if (code === "ERR_UPDATER_INVALID_SIGNATURE") return new UpdateError("signature", problem ?? "check_failed", detail);
  if (code === "ERR_CHECKSUM_MISMATCH" || /sha512 checksum mismatch/i.test(message)) return new UpdateError("checksum", null, detail);
  if (typeof code === "string" && /^(ENOSPC|EPERM|EACCES|EBUSY|EROFS)$/.test(code)) return new UpdateError("disk", null, detail);
  if (
    code === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" ||
    code === "ERR_UPDATER_INVALID_UPDATE_INFO" ||
    code === "ERR_UPDATER_NO_FILES_PROVIDED" ||
    code === "ERR_UPDATER_INVALID_VERSION" ||
    code === "HTTP_ERROR_404"
  ) {
    return new UpdateError("feed", null, detail);
  }
  if ((typeof code === "string" && /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)$/.test(code)) || /net::ERR_|HttpError|status code/i.test(message)) {
    return new UpdateError("network", null, detail);
  }
  return new UpdateError("unknown", null, detail);
}
