import { describe, expect, it } from "vitest";
import { nextSlot, slotsBetween, validTimeZone, zonedToInstant, type SlotRule } from "./schedule-time.ts";

const daily = (time: string, timeZone: string): SlotRule => ({ cadence: "daily", time, weekday: null, timeZone });

describe("schedule slots", () => {
  it("places a daily slot at the local time of its zone", () => {
    // Istanbul has no DST: 09:00 local is 06:00 UTC every day.
    const slots = slotsBetween(daily("09:00", "Europe/Istanbul"), new Date("2026-10-30T00:00:00Z"), new Date("2026-11-01T23:00:00Z"));
    expect(slots.map((d) => d.toISOString())).toEqual(["2026-10-30T06:00:00.000Z", "2026-10-31T06:00:00.000Z", "2026-11-01T06:00:00.000Z"]);
  });

  it("excludes the start and includes the end", () => {
    const at = new Date("2026-10-30T06:00:00Z");
    expect(slotsBetween(daily("09:00", "Europe/Istanbul"), at, at)).toEqual([]);
    expect(slotsBetween(daily("09:00", "Europe/Istanbul"), new Date(at.getTime() - 1), at)).toHaveLength(1);
    expect(nextSlot(daily("09:00", "Europe/Istanbul"), at).toISOString()).toBe("2026-10-31T06:00:00.000Z");
  });

  it("runs weekly on its weekday only", () => {
    // 2026-11-02 is a Monday.
    const rule: SlotRule = { cadence: "weekly", time: "18:30", weekday: 1, timeZone: "UTC" };
    const slots = slotsBetween(rule, new Date("2026-10-30T00:00:00Z"), new Date("2026-11-20T00:00:00Z"));
    expect(slots.map((d) => d.toISOString())).toEqual(["2026-11-02T18:30:00.000Z", "2026-11-09T18:30:00.000Z", "2026-11-16T18:30:00.000Z"]);
  });

  it("follows daylight saving, and moves a time inside the spring gap past it", () => {
    // Berlin: CEST (+2) until 2026-10-25 03:00, then CET (+1).
    const rule = daily("09:00", "Europe/Berlin");
    const slots = slotsBetween(rule, new Date("2026-10-24T00:00:00Z"), new Date("2026-10-26T12:00:00Z"));
    expect(slots.map((d) => d.toISOString())).toEqual(["2026-10-24T07:00:00.000Z", "2026-10-25T08:00:00.000Z", "2026-10-26T08:00:00.000Z"]);
    // 2026-03-29 02:30 does not exist in Berlin; it runs at 03:30 CEST (01:30 UTC).
    expect(new Date(zonedToInstant(Date.UTC(2026, 2, 29, 2, 30), "Europe/Berlin")).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    // 2026-10-25 02:30 happens twice; the first one (CEST, 00:30 UTC) counts.
    expect(new Date(zonedToInstant(Date.UTC(2026, 9, 25, 2, 30), "Europe/Berlin")).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("knows a time zone from a typo", () => {
    expect(validTimeZone("Europe/Istanbul")).toBe(true);
    expect(validTimeZone("Mars/Olympus")).toBe(false);
    expect(validTimeZone("")).toBe(false);
  });
});
