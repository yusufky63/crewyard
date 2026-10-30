import { describe, expect, it } from "vitest";
import { inQuietHours } from "./settings.ts";

const at = (hhmm: string) => new Date(`2026-10-30T${hhmm}:00`);

describe("quiet hours", () => {
  it("wraps past midnight and ends at the end minute", () => {
    const q = { enabled: true, start: "22:00", end: "08:00" };
    expect(inQuietHours(q, at("21:59"))).toBe(false);
    expect(inQuietHours(q, at("22:00"))).toBe(true);
    expect(inQuietHours(q, at("03:15"))).toBe(true);
    expect(inQuietHours(q, at("07:59"))).toBe(true);
    expect(inQuietHours(q, at("08:00"))).toBe(false);
  });

  it("handles a same-day window, an empty window and the switch", () => {
    const q = { enabled: true, start: "12:00", end: "13:30" };
    expect(inQuietHours(q, at("11:59"))).toBe(false);
    expect(inQuietHours(q, at("12:45"))).toBe(true);
    expect(inQuietHours(q, at("13:30"))).toBe(false);
    expect(inQuietHours({ ...q, end: "12:00" }, at("12:00"))).toBe(false);
    expect(inQuietHours({ ...q, enabled: false }, at("12:45"))).toBe(false);
  });
});
