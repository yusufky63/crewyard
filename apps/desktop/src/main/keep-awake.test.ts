import { describe, expect, it } from "vitest";
import type { KeepAwakeState } from "../shared/api.ts";
import { batteryPct, KeepAwake, keepAwakeState, type Blocker } from "./keep-awake.ts";

const on = { enabled: true, minBatteryPct: 30 };
const ac = { onBattery: false, batteryPct: 80 };

describe("keepAwakeState", () => {
  it("is off when the setting is off and idle without runs", () => {
    expect(keepAwakeState({ ...on, enabled: false }, 3, ac).state).toBe("off");
    expect(keepAwakeState(on, 0, ac).state).toBe("idle");
    expect(keepAwakeState(on, 2, ac).state).toBe("active");
  });

  it("holds on AC whatever the charge", () => {
    expect(keepAwakeState(on, 1, { onBattery: false, batteryPct: 5 }).state).toBe("active");
    expect(keepAwakeState(on, 1, { onBattery: false, batteryPct: null }).state).toBe("active");
  });

  it("lets the machine sleep on battery at or below the threshold, or with an unknown charge", () => {
    expect(keepAwakeState(on, 1, { onBattery: true, batteryPct: 31 }).state).toBe("active");
    expect(keepAwakeState(on, 1, { onBattery: true, batteryPct: 30 }).state).toBe("battery");
    expect(keepAwakeState(on, 1, { onBattery: true, batteryPct: 12 }).state).toBe("battery");
    expect(keepAwakeState(on, 1, { onBattery: true, batteryPct: null }).state).toBe("battery");
  });
});

describe("batteryPct", () => {
  it("accepts only a 0–1 level from the renderer", () => {
    expect(batteryPct({ charging: false, level: 0.426 })).toBe(43);
    expect(batteryPct({ level: 1.5 })).toBeNull();
    expect(batteryPct({ level: "0.5" })).toBeNull();
    expect(batteryPct(null)).toBeNull();
  });
});

function harness() {
  const log: string[] = [];
  let next = 1;
  const blocker: Blocker = {
    start: (type) => {
      log.push(`start ${type}`);
      return next++;
    },
    stop: (id) => log.push(`stop ${id}`),
  };
  const states: KeepAwakeState["state"][] = [];
  const k = new KeepAwake({ blocker, onChange: (s) => states.push(s.state) });
  return { k, log, states };
}

describe("KeepAwake", () => {
  it("starts with the first run and stops with the last, once each", () => {
    const { k, log } = harness();
    k.setSettings(on);
    k.setRuns(1);
    k.setRuns(3);
    k.setRuns(1);
    k.setRuns(0);
    expect(log).toEqual(["start prevent-app-suspension", "stop 1"]);
  });

  it("never starts while the setting is off, and releases when it is switched off", () => {
    const { k, log } = harness();
    k.setRuns(2);
    expect(log).toEqual([]);
    k.setSettings(on);
    k.setSettings({ ...on, enabled: false });
    expect(log).toEqual(["start prevent-app-suspension", "stop 1"]);
  });

  it("releases on low battery and takes hold again back on AC", () => {
    const { k, log, states } = harness();
    k.setSettings(on);
    k.setBatteryPct(25);
    k.setRuns(1);
    k.setOnBattery(true);
    k.setOnBattery(false);
    expect(log).toEqual(["start prevent-app-suspension", "stop 1", "start prevent-app-suspension"]);
    // The charge reading is part of the state the status bar shows, so it is reported too.
    expect(states).toEqual(["idle", "idle", "active", "battery", "active"]);
  });

  it("stops on dispose and reports only real changes", () => {
    const { k, log, states } = harness();
    k.setSettings(on);
    k.setRuns(1);
    k.setRuns(1);
    k.dispose();
    k.dispose();
    expect(log).toEqual(["start prevent-app-suspension", "stop 1"]);
    expect(states).toEqual(["idle", "active"]);
  });
});
