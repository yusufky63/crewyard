import { describe, expect, it } from "vitest";
import { peakFactor, PeakPricing, requestCost, RequestPricing } from "./catalog.ts";

// DeepSeek's weekday peak hours, as its pricing page listed them on 2026-10-30.
const deepseek = PeakPricing.parse({ factor: 2, days: [1, 2, 3, 4, 5], windows: ["01:00-04:00", "06:00-10:00"], ref: "https://api-docs.deepseek.com/quick_start/pricing", checked: "2026-10-30" });

describe("peakFactor", () => {
  it("doubles inside a weekday window and keeps the standard rate outside it", () => {
    // Friday 2026-10-30: the overnight live run at 07:59 UTC, the comparison run at 10:45 UTC.
    expect(peakFactor(deepseek, new Date("2026-10-30T07:59:00Z"))).toBe(2);
    expect(peakFactor(deepseek, new Date("2026-10-30T10:45:00Z"))).toBe(1);
    expect(peakFactor(deepseek, new Date("2026-10-30T04:30:00Z"))).toBe(1);
  });

  it("starts a window on its first minute and ends it before its last", () => {
    expect(peakFactor(deepseek, new Date("2026-10-30T01:00:00Z"))).toBe(2);
    expect(peakFactor(deepseek, new Date("2026-10-30T03:59:59Z"))).toBe(2);
    expect(peakFactor(deepseek, new Date("2026-10-30T04:00:00Z"))).toBe(1);
    expect(peakFactor(deepseek, new Date("2026-10-30T00:59:59Z"))).toBe(1);
  });

  it("reads days in UTC, not in local time", () => {
    // Saturday 07:00 UTC is off-peak even where the local clock still says Friday.
    expect(peakFactor(deepseek, new Date("2026-10-31T07:00:00Z"))).toBe(1);
    // Monday 01:30 UTC is peak even where the local clock still says Sunday.
    expect(peakFactor(deepseek, new Date("2026-11-02T01:30:00Z"))).toBe(2);
  });

  it("is 1 for a provider without time-of-use pricing", () => {
    expect(peakFactor(null, new Date("2026-10-30T07:59:00Z"))).toBe(1);
    expect(peakFactor(undefined, new Date("2026-10-30T07:59:00Z"))).toBe(1);
  });

  it("refuses a window that is not HH:MM-HH:MM", () => {
    expect(PeakPricing.safeParse({ ...deepseek, windows: ["1-4"] }).success).toBe(false);
  });
});

// DeepSeek's Search and Fetch APIs, as its pricing page listed them on 2026-10-30: billing starts
// at 00:00 Beijing time (UTC+8) on 2026-11-01.
const searchFetch = RequestPricing.parse({ searchPer1k: 0.75, fetchPer1k: 0.75, from: "2026-11-01T00:00:00+08:00", ref: "https://api-docs.deepseek.com/quick_start/pricing", checked: "2026-10-30" });

describe("requestCost", () => {
  it("is free before billing starts and per 1,000 requests from its first instant", () => {
    expect(requestCost(searchFetch, 4, 2, new Date("2026-10-31T15:59:59Z"))).toBe(0);
    expect(requestCost(searchFetch, 4, 2, new Date("2026-10-31T16:00:00Z"))).toBeCloseTo(0.0045, 10);
    expect(requestCost(searchFetch, 1_000, 0, new Date("2026-11-02T08:00:00Z"))).toBeCloseTo(0.75, 10);
  });

  it("is zero without a price or without requests", () => {
    expect(requestCost(null, 10, 10, new Date("2026-11-02T08:00:00Z"))).toBe(0);
    expect(requestCost(undefined, 10, 10, new Date("2026-11-02T08:00:00Z"))).toBe(0);
    expect(requestCost(searchFetch, 0, 0, new Date("2026-11-02T08:00:00Z"))).toBe(0);
  });

  it("refuses a start that is not an ISO instant", () => {
    expect(RequestPricing.safeParse({ ...searchFetch, from: "2026-11-01" }).success).toBe(false);
  });
});
