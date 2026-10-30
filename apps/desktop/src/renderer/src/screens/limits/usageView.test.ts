import { describe, expect, it } from "vitest";
import type { UsageGroup } from "@crewyard/core";
import { compact, OTHER, slices } from "./usageView.ts";

const g = (key: string, tokens: number, usd: number | null): UsageGroup => ({
  key,
  tokensIn: tokens,
  tokensOut: 0,
  cacheRead: 0,
  cacheUnknown: false,
  reasoning: 0,
  tokensProvenance: "reported",
  usd,
  usdProvenance: usd === null ? "unknown" : "estimated",
  unbilledTokens: usd === null ? tokens : 0,
});

describe("slices", () => {
  it("keeps up to four and sums the tail into other", () => {
    const s = slices([g("a", 10, 1), g("b", 50, 5), g("c", 30, 0), g("d", 5, 2), g("e", 1, 0.5)], "tokens");
    expect(s.map((x) => x.key)).toEqual(["b", "c", "a", OTHER]);
    expect(s[3]).toEqual({ key: OTHER, value: 6, keys: ["d", "e"] });
  });
  it("leaves out groups without dollars when measuring dollars", () => {
    expect(slices([g("plan", 900, null), g("key", 10, 0.2)], "usd").map((x) => x.key)).toEqual(["key"]);
  });
});

describe("compact", () => {
  it("formats per locale", () => {
    expect(compact(950, "en")).toBe("950");
    expect(compact(12_400, "en")).toBe("12.4K");
    expect(compact(3_100_000, "tr")).toMatch(/3,1/);
  });
});
