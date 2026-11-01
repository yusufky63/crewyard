import { create } from "zustand";
import { useNav } from "../../nav.ts";

// Settings is a launch screen, so the sidebar hides while it shows; it remembers where it was
// opened from so Back returns there, and which section to scroll to.

export const SECTIONS = ["general", "projects", "notifications", "startup", "fallback", "orchestra", "autopilot", "mcp", "roles", "agentfiles", "data", "updates", "about"] as const;
export type SectionId = (typeof SECTIONS)[number];

interface SettingsNav {
  from: string | null;
  section: SectionId | null;
  clearSection(): void;
}

export const useSettingsNav = create<SettingsNav>()((set) => ({
  from: null,
  section: null,
  clearSection: () => set({ section: null }),
}));

export function openSettings(section: SectionId | null = null): void {
  const nav = useNav.getState();
  if (nav.screen !== "settings") useSettingsNav.setState({ from: nav.screen });
  useSettingsNav.setState({ section });
  nav.go("settings");
}

/** Where Back goes: the screen Settings was opened from, else the project home or Start. */
export function backTarget(from: string | null, projectId: string | null): string {
  if (from && from !== "settings") return from;
  return projectId ? "tasks" : "start";
}

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;

export function formatBytes(bytes: number, locale: string): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return new Intl.NumberFormat(locale, { style: "unit", unit: UNITS[unit], unitDisplay: "short", maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
}

const KNOWN_ERRORS = new Set(["settings.invalid", "settings.terms", "data.path", "data.exists", "restore.agents_running", "restore.not_database", "restore.integrity", "restore.not_crewyard", "restore.newer_schema"]);

/** The daemon throws codes; Electron wraps them as "Error invoking remote method ...: Error: <code>". */
export function errorCode(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  const code = msg.match(/([a-z]+\.[a-z_]+)\s*$/)?.[1];
  return code && KNOWN_ERRORS.has(code) ? code : null;
}

/** A file name for an export, sorted by date: crewyard-2026-10-30.db. */
export function exportName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `crewyard-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.db`;
}
