import { splitCommand, type FallbackMode, type ScheduleCadence, type ScheduleInput, type ScheduleView, type TaskKind, type TaskSize } from "@crewyard/core";

// The schedule form's draft and its checks. The daemon checks the same fields again
// (validateSchedule); this only keeps Save disabled with the reason next to the field.

export interface ScheduleDraft {
  id: string | null;
  title: string;
  description: string;
  kind: TaskKind | "auto";
  size: TaskSize | "auto";
  fallback: FallbackMode | "default";
  budget: string;
  bestOf: number;
  cadence: ScheduleCadence;
  time: string;
  weekday: number;
  timeZone: string;
  precheck: string;
  precheckTimeoutSec: string;
  autoApprove: boolean;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The system's IANA time zone, the default for a new schedule. */
export const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function emptyDraft(timeZone = systemTimeZone()): ScheduleDraft {
  return { id: null, title: "", description: "", kind: "auto", size: "auto", fallback: "default", budget: "", bestOf: 0, cadence: "daily", time: "09:00", weekday: 1, timeZone, precheck: "", precheckTimeoutSec: "60", autoApprove: false };
}

export function draftFrom(s: ScheduleView): ScheduleDraft {
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    kind: s.kind,
    size: s.size,
    fallback: s.fallback,
    budget: s.budgetUsd === null ? "" : String(s.budgetUsd),
    bestOf: s.bestOf ?? 0,
    cadence: s.cadence,
    time: s.time,
    weekday: s.weekday ?? 1,
    timeZone: s.timeZone,
    precheck: s.precheck ?? "",
    precheckTimeoutSec: String(s.precheckTimeoutSec),
    autoApprove: s.autoApprove,
  };
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
}

/** The first field that would be refused, by its key under `schedules.invalid`; null when Save may go. */
export function draftProblem(d: ScheduleDraft): string | null {
  if (!d.title.trim()) return "title";
  if (!HHMM.test(d.time)) return "time";
  if (!validZone(d.timeZone.trim())) return "timeZone";
  const budget = d.budget.trim();
  if (budget && !(Number.isFinite(Number(budget)) && Number(budget) > 0)) return "budgetUsd";
  // One program with plain arguments, the same rule as a setup step: no shell syntax.
  if (d.precheck.trim() && "problem" in splitCommand(d.precheck.trim())) return "precheck";
  const timeout = Number(d.precheckTimeoutSec);
  if (!(Number.isInteger(timeout) && timeout >= 5 && timeout <= 600)) return "precheckTimeoutSec";
  return null;
}

export function toInput(projectId: string, d: ScheduleDraft): ScheduleInput & { id?: string } {
  return {
    ...(d.id ? { id: d.id } : {}),
    projectId,
    title: d.title.trim(),
    description: d.description,
    ...(d.kind !== "auto" ? { kind: d.kind } : {}),
    ...(d.size !== "auto" ? { size: d.size } : {}),
    ...(d.fallback !== "default" ? { fallback: d.fallback } : {}),
    budgetUsd: d.budget.trim() ? Number(d.budget) : null,
    bestOf: d.bestOf > 0 ? d.bestOf : null,
    cadence: d.cadence,
    time: d.time,
    weekday: d.cadence === "weekly" ? d.weekday : null,
    timeZone: d.timeZone.trim(),
    precheck: d.precheck.trim() || null,
    precheckTimeoutSec: Number(d.precheckTimeoutSec),
    autoApprove: d.autoApprove,
  };
}

/** Weekday names in the UI language, Sunday first (0 = Sunday, as the daemon counts). */
export function weekdayNames(lang: string): string[] {
  // 2026-11-01 is a Sunday.
  return Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(lang, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 10, 1 + i))));
}

/** A slot as the schedule's own zone writes it, e.g. "Mon 09:00". */
export function slotText(iso: string, timeZone: string, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { timeZone, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  } catch {
    return iso;
  }
}
