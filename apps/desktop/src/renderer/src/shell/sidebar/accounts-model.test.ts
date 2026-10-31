import { describe, expect, it } from "vitest";
import type { AccountMeter, AccountRow } from "@crewyard/core";
import { inUse, lineValue, meterLines, newestReading, showAccounts, splitAccounts } from "./accounts-model.ts";

const now = new Date("2026-10-31T12:00:00.000Z");
const base: AccountRow = { key: "k", label: "a", providerId: "openai", runner: "codex", kind: "plan", pct: null, value: { kind: "none" }, provenance: "unknown", window: null, resetsAt: null, meters: [], signIn: null };
const meter = (window: AccountMeter["window"], pct: number | null, bucket: string | null = null, resetsAt = "2026-11-03T00:00:00.000Z"): AccountMeter => ({
  window,
  bucket,
  bucketLabel: null,
  pct,
  resetsAt,
  provenance: pct === null ? "unknown" : "reported",
  observedAt: "2026-10-31T10:00:00.000Z",
});
const plan = (pct: number, extra: Partial<AccountRow> = {}): AccountRow => ({ ...base, pct, value: { kind: "pct", pct }, provenance: "reported", window: "5h", meters: [meter("5h", pct)], ...extra });
const key = (usd: number, capUsd: number | null): AccountRow => ({ ...base, kind: "api_key", runner: "opencode", pct: capUsd ? (usd / capUsd) * 100 : null, value: { kind: "usd", usd, capUsd }, provenance: "estimated", window: "budget-day", meters: [] });

describe("accounts block hide rules", () => {
  it("draws no block without accounts", () => {
    expect(showAccounts(undefined)).toBe(false);
    expect(showAccounts([])).toBe(false);
    expect(showAccounts([base])).toBe(true);
  });
});

describe("accounts in use", () => {
  it("puts in front a window above 0%, near and over the limit included", () => {
    expect(inUse(plan(12), now)).toBe(true);
    expect(inUse(plan(84), now)).toBe(true);
    expect(inUse(plan(100), now)).toBe(true);
    expect(inUse(plan(0), now)).toBe(false);
  });

  it("ignores a window whose reset time has passed", () => {
    expect(inUse(plan(40, { meters: [meter("5h", 40, null, "2026-10-31T11:00:00.000Z")] }), now)).toBe(false);
    expect(inUse(plan(40, { meters: [meter("5h", 40, null, "2026-10-31T11:00:00.000Z"), meter("weekly", 3)] }), now)).toBe(true);
  });

  it("counts a key with spend today, with or without a cap", () => {
    expect(inUse(key(1.12, 5), now)).toBe(true);
    expect(inUse(key(0.4, null), now)).toBe(true);
    expect(inUse(key(0, null), now)).toBe(false);
    expect(inUse(key(0, 5), now)).toBe(false);
  });

  it("counts any account with a run that has not ended, even with nothing reported", () => {
    expect(inUse({ ...base, activeRuns: 1 }, now)).toBe(true);
    expect(inUse({ ...base, kind: "local", activeRuns: 2 }, now)).toBe(true);
    expect(inUse({ ...base, activeRuns: 0 }, now)).toBe(false);
  });

  it("folds unknown plans, local servers and profiles that must sign in or update", () => {
    expect(inUse(base, now)).toBe(false);
    expect(inUse({ ...base, kind: "local" }, now)).toBe(false);
    expect(inUse({ ...plan(50), signIn: { state: "signed_out", plan: null, probedAt: null } }, now)).toBe(false);
    expect(inUse({ ...base, signIn: { state: "blocked", plan: null, probedAt: null } }, now)).toBe(false);
  });

  it("keeps the daemon's most urgent first order in both groups", () => {
    const rows = [plan(96, { key: "a" }), { ...base, key: "b" }, key(1, 5), { ...base, key: "d", kind: "local" as const }, plan(3, { key: "e" })].map((r, i) => ({ ...r, key: r.key === "k" ? `x${i}` : r.key }));
    const { inUse: used, unused } = splitAccounts(rows, now);
    expect(used.map((r) => r.key)).toEqual(["a", "x2", "e"]);
    expect(unused.map((r) => r.key)).toEqual(["b", "d"]);
  });
});

describe("meter rows", () => {
  it("draws a cap row for a key with a daily cap and none without one", () => {
    expect(meterLines(key(1.12, null))).toEqual([]);
    expect(meterLines({ ...key(1.12, 5), pct: 22.4 })).toEqual([{ key: "cap", label: { kind: "cap" }, pct: 22.4, provenance: "estimated" }]);
    expect(meterLines({ ...key(0, 0), pct: null })[0]).toMatchObject({ pct: 100 });
  });

  it("is label, % and provenance only: no reset time or source text on the row", () => {
    const row: AccountRow = { ...plan(84), meters: [meter("5h", 84), meter("weekly", null), meter("monthly", 12, "mcp")] };
    expect(meterLines(row)).toEqual([
      { key: "|5h", label: { kind: "window", window: "5h" }, pct: 84, provenance: "reported" },
      { key: "mcp|monthly", label: { kind: "bucket", bucket: "mcp", bucketLabel: null }, pct: 12, provenance: "reported" },
    ]);
  });

  it("draws a single Unknown row when nothing is known, not one per possible window", () => {
    expect(meterLines({ ...base, meters: [meter("5h", null), meter("weekly", null)] })).toEqual([{ key: "unknown", label: { kind: "quota" }, pct: null, provenance: "unknown" }]);
    expect(meterLines({ ...base, meters: [] })).toHaveLength(1);
  });

  it("draws no meter under a profile that must sign in or update first, or a local server", () => {
    expect(meterLines({ ...base, signIn: { state: "signed_out", plan: null, probedAt: null } })).toEqual([]);
    expect(meterLines({ ...base, signIn: { state: "blocked", plan: null, probedAt: null } })).toEqual([]);
    expect(meterLines({ ...base, kind: "local" })).toEqual([]);
  });
});

describe("one-line accounts", () => {
  it("says what stands in for the meter", () => {
    expect(lineValue(base)).toEqual({ kind: "unknown" });
    expect(lineValue({ ...base, kind: "local" })).toEqual({ kind: "local" });
    expect(lineValue({ ...base, signIn: { state: "signed_out", plan: null, probedAt: null } })).toEqual({ kind: "signIn" });
    expect(lineValue({ ...base, signIn: { state: "blocked", plan: null, probedAt: null } })).toEqual({ kind: "update" });
    expect(lineValue(key(0, null))).toEqual({ kind: "usd", usd: 0, provenance: "estimated" });
    expect(lineValue(plan(0))).toEqual({ kind: "pct", pct: 0, provenance: "reported" });
  });

  it("dates the detail by the newest reading", () => {
    expect(newestReading({ ...plan(5), meters: [meter("5h", 5), { ...meter("weekly", 2), observedAt: "2026-10-31T11:30:00.000Z" }] })).toBe("2026-10-31T11:30:00.000Z");
    expect(newestReading(key(1, null))).toBeNull();
  });
});
