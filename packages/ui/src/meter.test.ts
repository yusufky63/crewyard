import { describe, expect, it } from "vitest";
import { tickClasses } from "./meter.ts";

describe("tickClasses", () => {
  it("fills the used share and colors past the thresholds", () => {
    const t = tickClasses(86, 48);
    expect(t).toHaveLength(48);
    expect(t.filter((c) => c.includes("on")).length).toBe(38);
    expect(t.filter((c) => c.includes("w")).length).toBe(3);
    expect(t.some((c) => c.includes("cr"))).toBe(false);
    expect(t.filter((c) => c.includes("th")).length).toBe(1);
  });

  it("never fills an unknown meter", () => {
    expect(tickClasses(null, 12).every((c) => c === "")).toBe(true);
  });

  it("marks every sixth tick tall only on full-size meters", () => {
    expect(tickClasses(0, 48)[6]).toContain("tall");
    expect(tickClasses(0, 8).some((c) => c.includes("tall"))).toBe(false);
  });
});
