import { describe, expect, it } from "vitest";
import type { LimitSample } from "./adapter.ts";
import { EMPTY_ALERT, evaluate, levelOf, minutesUntilFull } from "./limits.ts";

const s = (usedPct: number | null, observedAt = "2026-10-29T14:00:00Z", resetsAt: string | null = "2026-10-29T16:40:00Z", provenance: LimitSample["provenance"] = "reported"): LimitSample => ({
  profileId: "codex-work",
  window: "5h",
  usedPct,
  resetsAt,
  provenance,
  observedAt,
});

describe("levelOf", () => {
  it("never turns unknown data into a level", () => {
    expect(levelOf(s(null, undefined, null, "unknown"))).toBe("unknown");
    expect(levelOf(s(50, undefined, null, "unknown"))).toBe("unknown");
  });
  it("maps thresholds", () => {
    expect(levelOf(s(79))).toBe("ok");
    expect(levelOf(s(80))).toBe("warn");
    expect(levelOf(s(95))).toBe("critical");
    expect(levelOf(s(100))).toBe("reached");
  });
});

describe("evaluate", () => {
  it("warns once per window and re-arms after a reset", () => {
    let r = evaluate(EMPTY_ALERT, s(82));
    expect(r.notices.map((n) => n.kind)).toEqual(["warn"]);
    r = evaluate(r.state, s(86));
    expect(r.notices).toEqual([]);
    r = evaluate(r.state, s(96));
    expect(r.notices.map((n) => n.kind)).toEqual(["critical"]);
    r = evaluate(r.state, s(83, "2026-10-29T17:00:00Z", "2026-10-29T21:40:00Z"));
    expect(r.notices.map((n) => n.kind)).toEqual(["warn"]);
  });

  it("re-arms when usage drops below the re-arm line", () => {
    let r = evaluate(EMPTY_ALERT, s(85));
    r = evaluate(r.state, s(60));
    r = evaluate(r.state, s(81));
    expect(r.notices.map((n) => n.kind)).toEqual(["warn"]);
  });

  it("jumps straight to critical without a separate warn", () => {
    expect(evaluate(EMPTY_ALERT, s(97)).notices.map((n) => n.kind)).toEqual(["critical"]);
  });
});

describe("minutesUntilFull", () => {
  it("forecasts from the burn rate", () => {
    const samples = [s(60, "2026-10-29T14:00:00Z"), s(80, "2026-10-29T14:20:00Z")];
    expect(minutesUntilFull(samples, new Date("2026-10-29T14:20:00Z"))).toBe(20);
  });
  it("returns null when the reset comes first or usage is flat", () => {
    const early = [s(60, "2026-10-29T14:00:00Z", "2026-10-29T14:30:00Z"), s(62, "2026-10-29T14:20:00Z", "2026-10-29T14:30:00Z")];
    expect(minutesUntilFull(early, new Date("2026-10-29T14:20:00Z"))).toBeNull();
    expect(minutesUntilFull([s(50, "2026-10-29T14:00:00Z"), s(50, "2026-10-29T14:30:00Z")], new Date("2026-10-29T14:30:00Z"))).toBeNull();
  });
});
