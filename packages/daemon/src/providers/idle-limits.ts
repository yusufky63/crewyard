import type { LimitSample, LimitWindow, Profile } from "@crewyard/core";

// Keeps ChatGPT plan windows fresh while no run reports them (PLAN.md §7). A Codex run sends
// `account/rateLimits/updated` on its own; between runs nothing does, so this asks codex
// `account/rateLimits/read` for signed-in profiles that are in use, and feeds the samples through
// the orchestrator so Limits and the 80/95% notices work between runs too.
//
// Polling a subscription's quota is something users switch off when they worry about the
// provider's risk controls (cc-switch made it opt-in), so it is a visible setting, it only touches
// profiles a task uses, and it asks gently: one scheduler, a per-profile TTL with jitter, start-up
// reads spread out instead of in a burst, a shorter TTL only while a window is rising, and a
// growing backoff after failures.

export interface IdleLimitsDeps {
  /** The setting on the Limits screen; when off, nothing is read in the background. */
  enabled(): boolean;
  /** Signed-in ChatGPT profiles (Codex). */
  candidates(): Profile[];
  /** Profiles a task still needs or that ran recently; the rest are left alone. */
  inUse(): Set<string>;
  /** A live run reports this profile's windows itself. */
  reporting(profileId: string): boolean;
  /** Something else holds the profile folder right now (a sign-in). */
  held(profileId: string): boolean;
  /** Latest stored sample per plan window of the profile, from runs or from here. */
  latest(profileId: string): LimitSample[];
  fetch(profile: Profile): Promise<LimitSample[]>;
  ingest(sample: LimitSample): void;
  changed(): void;
  /** After a failed read: lets the sign-in probe show an expired or removed sign-in at once. */
  failed?(profileId: string): void;
  now?: () => Date;
  random?: () => number;
  everyMs?: number;
  maxBackoffMs?: number;
}

export const IDLE_EVERY_MS = 5 * 60_000;
export const IDLE_MAX_BACKOFF_MS = 60 * 60_000;
/** Spacing of start-up reads, so opening the app never fires every profile at once. */
const STARTUP_SPREAD_MS = 20_000;
const JITTER = 0.1;
const PLAN_WINDOWS: LimitWindow[] = ["5h", "weekly", "daily", "monthly"];

/** One limit of an account: a window of a bucket. Two buckets can both have a weekly window. */
export const windowKey = (s: Pick<LimitSample, "window" | "bucket">): string => `${s.bucket ?? ""}|${s.window}`;

/**
 * A reading older than what we already hold for the same window: its reset is earlier, or the
 * reset is the same and less is used (usage within one window only grows). Storing it would
 * re-arm the 80/95% notices and show a step backwards.
 */
export function isStale(next: LimitSample, last: LimitSample | undefined): boolean {
  if (!last || last.usedPct === null || last.provenance === "unknown" || next.usedPct === null) return false;
  if (next.resetsAt && last.resetsAt) {
    if (next.resetsAt < last.resetsAt) return true;
    if (next.resetsAt === last.resetsAt) return next.usedPct < last.usedPct;
  }
  return false;
}

export class IdleLimits {
  private readonly deps: IdleLimitsDeps;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly everyMs: number;
  private readonly maxBackoffMs: number;
  /** Per profile: when it is next due, and failures in a row. */
  private readonly due = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  /** When we last read each profile, to tell our own samples from a run's. */
  private readonly lastRead = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(deps: IdleLimitsDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
    this.everyMs = deps.everyMs ?? IDLE_EVERY_MS;
    this.maxBackoffMs = deps.maxBackoffMs ?? IDLE_MAX_BACKOFF_MS;
  }

  get intervalMs(): number {
    return this.everyMs;
  }

  /** Checks every few seconds which profiles are due; unref'd so it never keeps the daemon alive. */
  start(checkMs = 10_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), checkMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass; overlapping calls share the pass in flight. A pass that throws (the store already
   * closed while the daemon shuts down) is dropped: it runs from a timer, where a rejection would
   * be unhandled, and the next tick tries again.
   */
  tick(): Promise<void> {
    this.running ??= this.pass()
      .catch(() => undefined)
      .finally(() => (this.running = null));
    return this.running;
  }

  /** Reads one profile now (a sign-in just finished): an action of the user, so the setting does not apply. */
  async refreshNow(profileId: string): Promise<boolean> {
    const profile = this.deps.candidates().find((p) => p.id === profileId);
    if (!profile || this.deps.reporting(profileId) || this.deps.held(profileId)) return false;
    return this.read(profile);
  }

  private jittered(ms: number): number {
    return ms * (1 - JITTER + 2 * JITTER * this.random());
  }

  private async pass(): Promise<void> {
    if (!this.deps.enabled()) return;
    const candidates = this.deps.candidates();
    if (candidates.length === 0) return;
    const now = this.now().getTime();
    // First sight of a profile (the app just opened, or it just signed in): one read soon, spread out.
    let slot = 0;
    for (const p of candidates) if (!this.due.has(p.id)) this.due.set(p.id, now + slot++ * STARTUP_SPREAD_MS + this.random() * STARTUP_SPREAD_MS);
    const ready = candidates.filter((p) => (this.due.get(p.id) ?? 0) <= now);
    if (ready.length === 0) return;
    const inUse = this.deps.inUse();
    for (const profile of ready) {
      if (!inUse.has(profile.id) || this.deps.held(profile.id)) continue;
      // A run reports this profile itself, or did so lately: look again one TTL after its newest sample.
      const newest = this.deps.latest(profile.id).reduce<number>((max, s) => Math.max(max, Date.parse(s.observedAt)), 0);
      const fromRun = newest > (this.lastRead.get(profile.id) ?? 0);
      if (this.deps.reporting(profile.id) || (fromRun && !this.failures.has(profile.id) && now - newest < this.everyMs)) {
        this.due.set(profile.id, Math.max(now, newest) + this.jittered(this.everyMs));
        continue;
      }
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
    const now = this.now().getTime();
    this.lastRead.set(profile.id, now);
    if (samples.length === 0) {
      const failures = (this.failures.get(profile.id) ?? 0) + 1;
      this.failures.set(profile.id, failures);
      this.due.set(profile.id, now + this.jittered(Math.min(this.maxBackoffMs, this.everyMs * 2 ** failures)));
      this.deps.failed?.(profile.id);
      return false;
    }
    this.failures.delete(profile.id);
    const last = new Map(this.deps.latest(profile.id).map((s) => [windowKey(s), s]));
    const fresh = samples.filter((s) => !isStale(s, last.get(windowKey(s))));
    // Rising since the last reading: look twice as often until it settles.
    const rising = fresh.some((s) => {
      const prev = last.get(windowKey(s));
      return PLAN_WINDOWS.includes(s.window) && prev?.usedPct != null && prev.resetsAt === s.resetsAt && (s.usedPct ?? 0) > prev.usedPct;
    });
    this.due.set(profile.id, now + this.jittered(rising ? this.everyMs / 2 : this.everyMs));
    for (const s of fresh) this.deps.ingest({ ...s, profileId: profile.id, provenance: "reported" });
    if (fresh.length) this.deps.changed();
    return true;
  }
}
