import type { KeepAwakeSettings } from "@crewyard/core";
import type { BatteryReading, KeepAwakeState } from "../shared/api.ts";

// Keep the machine awake while runs are active (feature scan A15), opt-in from Settings. Electron's
// powerSaveBlocker with "prevent-app-suspension" stops Windows from sleeping but lets the display
// turn off, so an overnight run keeps its network and processes without lighting the screen.
// electronjs.org/docs/latest/api/power-save-blocker and power-monitor, opened 2026-10-30.

export interface Power {
  onBattery: boolean;
  /** 0–100, or null when the charge is not known. */
  batteryPct: number | null;
}

/**
 * The guard. Off when the setting is off, idle without active runs; with runs it holds the machine
 * awake unless it runs on battery at or below the threshold, or on battery with an unknown charge,
 * because a laptop that dies mid-run loses more than one that sleeps.
 */
export function keepAwakeState(s: KeepAwakeSettings, runs: number, power: Power): KeepAwakeState {
  const base = { runs, onBattery: power.onBattery, batteryPct: power.batteryPct, minBatteryPct: s.minBatteryPct };
  if (!s.enabled) return { ...base, state: "off" };
  if (runs <= 0) return { ...base, state: "idle" };
  const low = power.onBattery && (power.batteryPct === null || power.batteryPct <= s.minBatteryPct);
  return { ...base, state: low ? "battery" : "active" };
}

/** A renderer reading, checked before it can move the guard: anything malformed counts as unknown. */
export function batteryPct(reading: unknown): number | null {
  if (!reading || typeof reading !== "object") return null;
  const level = (reading as Partial<BatteryReading>).level;
  return typeof level === "number" && Number.isFinite(level) && level >= 0 && level <= 1 ? Math.round(level * 100) : null;
}

/** The part of Electron's powerSaveBlocker we use, so tests can count starts and stops. */
export interface Blocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

export class KeepAwake {
  private id: number | null = null;
  private settings: KeepAwakeSettings = { enabled: false, minBatteryPct: 30 };
  private runs = 0;
  private power: Power = { onBattery: false, batteryPct: null };
  private last = "";

  constructor(private readonly deps: { blocker: Blocker; onChange: (s: KeepAwakeState) => void }) {}

  state(): KeepAwakeState {
    return keepAwakeState(this.settings, this.runs, this.power);
  }

  setSettings(s: KeepAwakeSettings): void {
    this.settings = s;
    this.apply();
  }

  setRuns(n: number): void {
    this.runs = n;
    this.apply();
  }

  setOnBattery(onBattery: boolean): void {
    this.power = { ...this.power, onBattery };
    this.apply();
  }

  setBatteryPct(pct: number | null): void {
    this.power = { ...this.power, batteryPct: pct };
    this.apply();
  }

  /** Releases the blocker; called on quit so nothing outlives the app. */
  dispose(): void {
    if (this.id !== null) this.deps.blocker.stop(this.id);
    this.id = null;
  }

  private apply(): void {
    const s = this.state();
    if (s.state === "active" && this.id === null) this.id = this.deps.blocker.start("prevent-app-suspension");
    else if (s.state !== "active") this.dispose();
    const key = JSON.stringify(s);
    if (key === this.last) return;
    this.last = key;
    this.deps.onChange(s);
  }
}
