import { STALL_LIMITS, type AppSettings, type NotificationSettings, type SettingsPatch, type StallSettings } from "@crewyard/core";

// App settings live in the `settings` table, one JSON value per key, so a damaged or older entry
// only falls back for that key. Every write goes through `applyPatch`, which refuses anything a
// correct renderer never sends instead of storing it.

export const NOTIFICATIONS_KEY = "app.notifications";
export const STALLS_KEY = "app.stalls";

export const DEFAULT_SETTINGS: AppSettings = {
  notifications: {
    enabled: true,
    quietHours: { enabled: false, start: "22:00", end: "08:00" },
    mutedProjects: [],
    approveFromToast: true,
    limitActions: true,
  },
  // Long enough that a slow build or a model thinking hard is not a stall; short enough to catch a hang overnight.
  stalls: { noEventsMinutes: 10, sameFailureCount: 3, requestMinutes: 30, cooldownMinutes: 60 },
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_MUTED = 500;

const invalid = (): never => {
  throw new Error("settings.invalid");
};

const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : invalid());
const time = (v: unknown): string => (typeof v === "string" && HHMM.test(v) ? v : invalid());

function projectIds(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > MAX_MUTED) return invalid();
  const ids = v.map((x) => (typeof x === "string" && x.length > 0 && x.length <= 64 ? x : invalid()));
  return [...new Set(ids)];
}

/** Merges a patch into the current value; throws `settings.invalid` on any malformed field. */
export function applyPatch(current: AppSettings, patch: SettingsPatch): AppSettings {
  if (typeof patch !== "object" || patch === null) return invalid();
  let next = current;
  if (patch.notifications !== undefined) next = { ...next, notifications: patchNotifications(next.notifications, patch.notifications) };
  if (patch.stalls !== undefined) next = { ...next, stalls: patchStalls(next.stalls, patch.stalls) };
  return next;
}

/** A whole number of minutes or runs inside the rule's bounds. */
const bounded = (key: keyof StallSettings, v: unknown): number => {
  const { min, max } = STALL_LIMITS[key];
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : invalid();
};

const STALL_KEYS = Object.keys(STALL_LIMITS) as Array<keyof StallSettings>;

function patchStalls(cur: StallSettings, p: unknown): StallSettings {
  if (typeof p !== "object" || p === null) return invalid();
  const patch = p as Partial<Record<keyof StallSettings, unknown>>;
  const next = { ...cur };
  for (const key of STALL_KEYS) if (patch[key] !== undefined) next[key] = bounded(key, patch[key]);
  return next;
}

/** Reads the stored stall rules leniently, like readNotifications. */
export function readStalls(raw: string | undefined): StallSettings {
  const base = DEFAULT_SETTINGS.stalls;
  let parsed: unknown;
  try {
    parsed = raw === undefined ? {} : JSON.parse(raw);
  } catch {
    return base;
  }
  if (typeof parsed !== "object" || parsed === null) return base;
  const p = parsed as Record<string, unknown>;
  const out = { ...base };
  for (const key of STALL_KEYS) {
    try {
      out[key] = bounded(key, p[key]);
    } catch {
      // Missing or out of bounds: the default stays.
    }
  }
  return out;
}

function patchNotifications(cur: NotificationSettings, n: SettingsPatch["notifications"]): NotificationSettings {
  if (typeof n !== "object" || n === null) return invalid();
  const q = n.quietHours;
  if (q !== undefined && (typeof q !== "object" || q === null)) return invalid();
  const next: NotificationSettings = {
    enabled: n.enabled === undefined ? cur.enabled : bool(n.enabled),
    quietHours: {
      enabled: q?.enabled === undefined ? cur.quietHours.enabled : bool(q.enabled),
      start: q?.start === undefined ? cur.quietHours.start : time(q.start),
      end: q?.end === undefined ? cur.quietHours.end : time(q.end),
    },
    mutedProjects: n.mutedProjects === undefined ? cur.mutedProjects : projectIds(n.mutedProjects),
    approveFromToast: n.approveFromToast === undefined ? cur.approveFromToast : bool(n.approveFromToast),
    limitActions: n.limitActions === undefined ? cur.limitActions : bool(n.limitActions),
  };
  return next;
}

/** Reads a stored value leniently: every field that does not validate keeps its default. */
export function readNotifications(raw: string | undefined): NotificationSettings {
  const base = DEFAULT_SETTINGS.notifications;
  if (raw === undefined) return base;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return base;
  }
  if (typeof parsed !== "object" || parsed === null) return base;
  const p = parsed as Record<string, unknown>;
  const q = (typeof p.quietHours === "object" && p.quietHours !== null ? p.quietHours : {}) as Record<string, unknown>;
  const pick = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  return {
    enabled: pick(() => bool(p.enabled), base.enabled),
    quietHours: {
      enabled: pick(() => bool(q.enabled), base.quietHours.enabled),
      start: pick(() => time(q.start), base.quietHours.start),
      end: pick(() => time(q.end), base.quietHours.end),
    },
    mutedProjects: pick(() => projectIds(p.mutedProjects), base.mutedProjects),
    approveFromToast: pick(() => bool(p.approveFromToast), base.approveFromToast),
    limitActions: pick(() => bool(p.limitActions), base.limitActions),
  };
}
