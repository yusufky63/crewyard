import type { LimitSample, Profile } from "@crewyard/core";

// Keeps ChatGPT plan windows fresh while no run reports them (PLAN.md §7). A Codex run sends
// `account/rateLimits/updated` on its own; between runs nothing does, so every few minutes this
// asks codex `account/rateLimits/read` for signed-in profiles that are in use, and feeds the
// samples through the orchestrator so Limits and the 80/95% notices work between runs too.

export interface IdleLimitsDeps {
  /** Signed-in ChatGPT profiles (Codex). */
  candidates(): Profile[];
  /** Profiles a task still needs or that ran recently; the rest are left alone. */
  inUse(): Set<string>;
  /** A live run reports this profile's windows itself. */
  reporting(profileId: string): boolean;
  /** Something else holds the profile folder right now (a sign-in). */
  held(profileId: string): boolean;
  /** Newest plan-window sample of the profile, from runs or from here. */
  lastSampleAt(profileId: string): string | null;
  fetch(profile: Profile): Promise<LimitSample[]>;
  ingest(sample: LimitSample): void;
  changed(): void;
  now?: () => Date;
  everyMs?: number;
  maxBackoffMs?: number;
}

export const IDLE_EVERY_MS = 5 * 60_000;
export const IDLE_MAX_BACKOFF_MS = 60 * 60_000;

export class IdleLimits {
  private readonly deps: IdleLimitsDeps;
  private readonly now: () => Date;
  private readonly everyMs: number;
  private readonly maxBackoffMs: number;
  /** Per profile: failures in a row and the earliest next try. */
  private readonly backoff = new Map<string, { failures: number; nextAt: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(deps: IdleLimitsDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.everyMs = deps.everyMs ?? IDLE_EVERY_MS;
    this.maxBackoffMs = deps.maxBackoffMs ?? IDLE_MAX_BACKOFF_MS;
  }

  /** Checks once a minute which profiles are due; unref'd so it never keeps the daemon alive. */
  start(checkMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), checkMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass; overlapping calls share the pass in flight. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => (this.running = null));
    return this.running;
  }

  /** Reads one profile now, e.g. right after it signed in, whether or not it is in use yet. */
  async refreshNow(profileId: string): Promise<boolean> {
    const profile = this.deps.candidates().find((p) => p.id === profileId);
    if (!profile || this.deps.reporting(profileId) || this.deps.held(profileId)) return false;
    return this.read(profile);
  }

  private async pass(): Promise<void> {
    const now = this.now().getTime();
    const candidates = this.deps.candidates();
    if (candidates.length === 0) return;
    const inUse = this.deps.inUse();
    for (const profile of candidates) {
      if (!inUse.has(profile.id) || this.deps.reporting(profile.id) || this.deps.held(profile.id)) continue;
      const wait = this.backoff.get(profile.id);
      if (wait && wait.nextAt > now) continue;
      const last = this.deps.lastSampleAt(profile.id);
      if (!wait && last && now - Date.parse(last) < this.everyMs) continue;
      await this.read(profile);
    }
  }

  /** Only reported windows are stored: an Unknown reading would hide the last real one. */
  private async read(profile: Profile): Promise<boolean> {
    let samples: LimitSample[];
    try {
      samples = (await this.deps.fetch(profile)).filter((s) => s.provenance === "reported" && s.usedPct !== null);
    } catch {
      samples = [];
    }
    if (samples.length === 0) {
      const failures = (this.backoff.get(profile.id)?.failures ?? 0) + 1;
      const delay = Math.min(this.maxBackoffMs, this.everyMs * 2 ** failures);
      this.backoff.set(profile.id, { failures, nextAt: this.now().getTime() + delay });
      return false;
    }
    this.backoff.delete(profile.id);
    for (const s of samples) this.deps.ingest({ ...s, profileId: profile.id, provenance: "reported" });
    this.deps.changed();
    return true;
  }
}
