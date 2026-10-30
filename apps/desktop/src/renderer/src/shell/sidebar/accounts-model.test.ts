import { describe, expect, it } from "vitest";
import type { AccountMeter, AccountRow } from "@crewyard/core";
import { meterLines, showAccounts } from "./accounts-model.ts";

const base: AccountRow = { key: "k", label: "a", providerId: "openai", runner: "codex", kind: "plan", pct: null, value: { kind: "none" }, provenance: "unknown", window: null, resetsAt: null, meters: [], signIn: null };
const meter = (window: AccountMeter["window"], pct: number | null, bucket: string | null = null): AccountMeter => ({
  window,
  bucket,
  bucketLabel: null,
  pct,
  resetsAt: "2026-11-03T00:00:00.000Z",
  provenance: pct === null ? "unknown" : "reported",
  observedAt: "2026-10-30T10:00:00.000Z",
});

describe("accounts block hide rules", () => {
  it("draws no block without accounts", () => {
    expect(showAccounts(undefined)).toBe(false);
    expect(showAccounts([])).toBe(false);
    expect(showAccounts([base])).toBe(true);
  });

  it("shows a key's spend as text only when it has no cap, and a cap meter when it has one", () => {
    const key: AccountRow = { ...base, kind: "api_key", runner: "opencode", value: { kind: "usd", usd: 1.12, capUsd: null }, provenance: "estimated", window: "budget-day", meters: [] };
    expect(meterLines(key)).toEqual([]);
    expect(meterLines({ ...key, pct: 22.4, value: { kind: "usd", usd: 1.12, capUsd: 5 } })).toEqual([{ kind: "cap", key: "cap", pct: 22.4, capUsd: 5, provenance: "estimated" }]);
    expect(meterLines({ ...key, pct: null, value: { kind: "usd", usd: 0, capUsd: 0 } })[0]).toMatchObject({ pct: 100 });
  });

  it("shows only the windows a plan reported, every bucket included", () => {
    const row: AccountRow = { ...base, pct: 84, value: { kind: "pct", pct: 84 }, provenance: "reported", meters: [meter("5h", 84), meter("weekly", null), meter("monthly", 12, "mcp")] };
    expect(meterLines(row).map((l) => (l.kind === "window" ? [l.bucket, l.window, l.pct] : l.kind))).toEqual([
      [null, "5h", 84],
      ["mcp", "monthly", 12],
    ]);
  });

  it("draws a single Unknown row when nothing is known, not one per possible window", () => {
    const lines = meterLines({ ...base, meters: [meter("5h", null), meter("weekly", null)] });
    expect(lines).toEqual([{ kind: "window", key: "unknown", window: "5h", bucket: null, bucketLabel: null, pct: null, resetsAt: null, provenance: "unknown" }]);
    expect(meterLines({ ...base, meters: [] })).toHaveLength(1);
  });

  it("draws nothing under a profile that must sign in or update first, or a local server", () => {
    expect(meterLines({ ...base, signIn: { state: "signed_out", plan: null, probedAt: null } })).toEqual([]);
    expect(meterLines({ ...base, signIn: { state: "blocked", plan: null, probedAt: null } })).toEqual([]);
    expect(meterLines({ ...base, kind: "local" })).toEqual([]);
  });
});
