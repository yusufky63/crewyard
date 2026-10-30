import type { ScheduleCadence } from "@crewyard/core";

// Wall-clock slots in an IANA time zone, without a date library: Intl tells us the zone's offset
// at an instant, and a local time maps back to an instant by trying the offsets around it.
// Daylight saving: a local time that does not exist (the spring gap) runs at the same distance
// after the gap starts, e.g. 02:30 becomes 03:30; a local time that happens twice runs the first time.

export interface SlotRule {
  cadence: ScheduleCadence;
  /** "HH:MM", 24-hour. */
  time: string;
  /** 0 = Sunday ... 6 = Saturday; weekly only. */
  weekday: number | null;
  timeZone: string;
}

const DAY_MS = 86_400_000;
/** At most this many days are walked through in one call (a laptop closed for years). */
const MAX_DAYS = 5_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timeZone, f);
  }
  return f;
}

export function validTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The local wall time at an instant, as if it were UTC (so plain arithmetic works on it). */
function wallAt(timeZone: string, t: number): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(t))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}

const offsetAt = (timeZone: string, t: number) => wallAt(timeZone, t) - Math.floor(t / 1000) * 1000;

/** The instant a local wall time (given as UTC fields) happens in the zone. */
export function zonedToInstant(wall: number, timeZone: string): number {
  // The offsets in force half a day before and after cover every DST change there is.
  const before = wall - offsetAt(timeZone, wall - DAY_MS / 2);
  const after = wall - offsetAt(timeZone, wall + DAY_MS / 2);
  const valid = [before, after].filter((t) => wallAt(timeZone, t) === wall).sort((a, b) => a - b);
  // In the spring gap neither maps back; the offset from before the gap lands just after it.
  return valid[0] ?? before;
}

const hours = (time: string) => Number(time.slice(0, 2));
const minutes = (time: string) => Number(time.slice(3, 5));

/** Slots in (after, until], oldest first. */
export function slotsBetween(rule: SlotRule, after: Date, until: Date): Date[] {
  const out: Date[] = [];
  if (until.getTime() <= after.getTime()) return out;
  // Walk local calendar days from the day before `after` (a slot can sit on either side of midnight
  // UTC). After a very long gap only the most recent MAX_DAYS are walked: older slots are history.
  const from = Math.max(after.getTime(), until.getTime() - MAX_DAYS * DAY_MS);
  const start = new Date(wallAt(rule.timeZone, from) - DAY_MS);
  const days = Math.ceil((until.getTime() - from) / DAY_MS) + 3;
  for (let i = 0; i <= days; i++) {
    const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i));
    if (rule.cadence === "weekly" && day.getUTCDay() !== rule.weekday) continue;
    const at = zonedToInstant(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hours(rule.time), minutes(rule.time)), rule.timeZone);
    if (at > until.getTime()) break;
    if (at > after.getTime()) out.push(new Date(at));
  }
  return out;
}

/** The first slot after `after`. */
export function nextSlot(rule: SlotRule, after: Date): Date {
  const week = slotsBetween(rule, after, new Date(after.getTime() + 8 * DAY_MS));
  return week[0]!;
}

/** The system's IANA time zone, which the UI offers by default. */
export const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
