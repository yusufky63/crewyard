import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, SettingsPatch } from "@crewyard/core";
import type { KeepAwakeState } from "../../../../shared/api.ts";
import { Row, Toggle } from "./parts.tsx";

// Keep the machine awake while runs are active (feature scan A15). The main process decides and
// holds the blocker; this file shows its state and feeds it the battery charge, which only a
// renderer can read.

const STATES: ReadonlyArray<KeepAwakeState["state"]> = ["off", "idle", "active", "battery"];

/** Screenshot runs can show a state with `keepAwake=<state>` (CREWYARD_SHOT_QUERY); a normal run has no query. */
function fixtureState(): KeepAwakeState | null {
  const q = new URLSearchParams(window.location.search);
  const s = q.get("keepAwake") as KeepAwakeState["state"] | null;
  if (!s || !STATES.includes(s)) return null;
  return { state: s, runs: s === "idle" ? 0 : 2, onBattery: s === "battery", batteryPct: s === "battery" ? 18 : null, minBatteryPct: 30 };
}

export function useKeepAwake(): KeepAwakeState | null {
  const [state, setState] = useState<KeepAwakeState | null>(fixtureState);
  useEffect(() => {
    if (fixtureState()) return;
    let live = true;
    void window.crewyard.keepAwake().then((s) => live && setState(s));
    const off = window.crewyard.on("keepAwake.changed", (p) => setState(p as KeepAwakeState));
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

interface BatteryManagerLike extends EventTarget {
  charging: boolean;
  level: number;
}

/** Reports the battery to the main process now and on every change; null where there is none to read. */
export function useBatteryReport(): void {
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
    if (!nav.getBattery) {
      window.crewyard.reportBattery(null);
      return;
    }
    let battery: BatteryManagerLike | null = null;
    const report = () => battery && window.crewyard.reportBattery({ charging: battery.charging, level: battery.level });
    void nav.getBattery().then(
      (b) => {
        battery = b;
        report();
        b.addEventListener("levelchange", report);
        b.addEventListener("chargingchange", report);
      },
      () => window.crewyard.reportBattery(null),
    );
    return () => {
      battery?.removeEventListener("levelchange", report);
      battery?.removeEventListener("chargingchange", report);
    };
  }, []);
}

/** One line on what the guard does right now, shared by Settings and the status bar tooltip. */
export function useKeepAwakeLine(): (s: KeepAwakeState) => string {
  const { t } = useTranslation("settings");
  return (s) => {
    if (s.state === "active") return t("keepAwake.now.active", { count: s.runs });
    if (s.state === "battery") return s.batteryPct === null ? t("keepAwake.now.batteryUnknown") : t("keepAwake.now.battery", { pct: s.batteryPct, min: s.minBatteryPct });
    if (s.state === "idle") return t("keepAwake.now.idle");
    return t("keepAwake.now.off");
  };
}

const THRESHOLDS = [10, 15, 20, 25, 30, 40, 50];

export function KeepAwakeRows({ settings, save }: { settings: AppSettings; save: (patch: SettingsPatch) => void }) {
  const { t } = useTranslation("settings");
  const state = useKeepAwake();
  const line = useKeepAwakeLine();
  const k = settings.keepAwake;
  const options = THRESHOLDS.includes(k.minBatteryPct) ? THRESHOLDS : [...THRESHOLDS, k.minBatteryPct].sort((a, b) => a - b);
  return (
    <>
      <Row label={t("keepAwake.label")} hint={t("keepAwake.hint")}>
        <Toggle label={t("keepAwake.label")} value={k.enabled} onChange={(v) => save({ keepAwake: { enabled: v } })} />
      </Row>
      <Row label={t("keepAwake.battery")} hint={t("keepAwake.batteryHint")}>
        <select className="pv-input mono" aria-label={t("keepAwake.battery")} value={k.minBatteryPct} disabled={!k.enabled} onChange={(e) => save({ keepAwake: { minBatteryPct: Number(e.target.value) } })}>
          {options.map((pct) => (
            <option key={pct} value={pct}>
              {t("keepAwake.pct", { pct })}
            </option>
          ))}
        </select>
      </Row>
      {state && (
        <p className="st-note" role="status">
          {line(state)}
        </p>
      )}
    </>
  );
}
