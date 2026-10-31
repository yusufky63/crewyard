import { describe, expect, it } from "vitest";
import type { NotificationSettings, RequestView } from "@crewyard/core";
import { AttentionTracker, BADGE_COLORS, BADGE_SIZE, badgeText, drawBadge, waitingRequests } from "./badge.ts";

const settings = (patch: Partial<NotificationSettings> = {}): NotificationSettings => ({
  enabled: true,
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  mutedProjects: [],
  approveFromToast: false,
  limitActions: true,
  ...patch,
});

let seq = 0;
const req = (projectId: string, patch: Partial<RequestView> = {}): RequestView =>
  ({
    id: `r${++seq}`,
    taskId: "t1",
    projectId,
    runId: "run1",
    sessionId: null,
    kind: "approval",
    risk: "medium",
    payload: { kind: "approval" },
    createdAt: new Date(Date.UTC(2026, 9, 31, 10, 0, seq)).toISOString(),
    answeredAt: null,
    answer: null,
    answeredBy: null,
    ...patch,
  }) as RequestView;

const noon = new Date(2026, 9, 31, 12, 0);
const night = new Date(2026, 9, 31, 23, 30);

describe("waitingRequests", () => {
  it("counts open requests of every kind and leaves answered ones out", () => {
    const list = [req("a"), req("a", { kind: "question" }), req("b", { kind: "handoff" }), req("a", { answeredAt: "2026-10-31T10:05:00Z" })];
    expect(waitingRequests(list, settings())).toHaveLength(3);
  });

  it("leaves muted projects out", () => {
    const list = [req("a"), req("b"), req("b")];
    expect(waitingRequests(list, settings({ mutedProjects: ["b"] })).map((r) => r.projectId)).toEqual(["a"]);
  });

  it("counts everything before settings are read", () => {
    expect(waitingRequests([req("a"), req("b")], null)).toHaveLength(2);
  });
});

describe("AttentionTracker", () => {
  it("never flashes for what was already waiting at start", () => {
    const t = new AttentionTracker();
    expect(t.next([req("a"), req("a")], settings(), noon, false)).toEqual({ count: 2, flash: false });
  });

  it("flashes once for a new request while the window is not in front", () => {
    const t = new AttentionTracker();
    const first = req("a");
    t.next([first], settings(), noon, false);
    const second = req("a");
    expect(t.next([first, second], settings(), noon, false)).toEqual({ count: 2, flash: true });
    expect(t.next([first, second], settings(), noon, false)).toEqual({ count: 2, flash: false });
  });

  it("does not flash while the window is focused, and remembers the request", () => {
    const t = new AttentionTracker();
    t.next([], settings(), noon, false);
    const r = req("a");
    expect(t.next([r], settings(), noon, true).flash).toBe(false);
    expect(t.next([r], settings(), noon, false).flash).toBe(false);
  });

  it("keeps the count but does not flash in quiet hours", () => {
    const t = new AttentionTracker();
    const quiet = settings({ quietHours: { enabled: true, start: "22:00", end: "08:00" } });
    t.next([], quiet, night, false);
    expect(t.next([req("a")], quiet, night, false)).toEqual({ count: 1, flash: false });
  });

  it("does not flash or count for a muted project", () => {
    const t = new AttentionTracker();
    const s = settings({ mutedProjects: ["m"] });
    t.next([], s, noon, false);
    expect(t.next([req("m")], s, noon, false)).toEqual({ count: 0, flash: false });
  });

  it("does not flash with notifications off, or before settings are known", () => {
    const off = new AttentionTracker();
    off.next([], settings({ enabled: false }), noon, false);
    expect(off.next([req("a")], settings({ enabled: false }), noon, false)).toEqual({ count: 1, flash: false });
    const unknown = new AttentionTracker();
    unknown.next([], null, noon, false);
    expect(unknown.next([req("a")], null, noon, false)).toEqual({ count: 1, flash: false });
  });

  it("drops to zero when the last request is answered", () => {
    const t = new AttentionTracker();
    const r = req("a");
    t.next([r], settings(), noon, false);
    expect(t.next([{ ...r, answeredAt: "2026-10-31T12:01:00Z" }], settings(), noon, false)).toEqual({ count: 0, flash: false });
  });
});

describe("drawBadge", () => {
  const px = (buf: Buffer, x: number, y: number) => {
    const i = (y * BADGE_SIZE + x) * 4;
    return { r: buf[i + 2], g: buf[i + 1], b: buf[i], a: buf[i + 3] };
  };
  const rgb = (c: readonly number[]) => ({ r: c[0], g: c[1], b: c[2], a: 255 });

  it("says the count up to 9, then 9+", () => {
    expect([0, 1, 9, 10, 250].map(badgeText)).toEqual(["0", "1", "9", "9+", "9+"]);
  });

  it("is a 16 px disc in the theme's warning token with transparent corners", () => {
    for (const dark of [true, false]) {
      const buf = drawBadge(3, { dark });
      expect(buf.length).toBe(BADGE_SIZE * BADGE_SIZE * 4);
      expect(px(buf, 0, 0).a).toBe(0);
      expect(px(buf, 15, 15).a).toBe(0);
      // Left of the digit, inside the disc.
      expect(px(buf, 2, 8)).toEqual(rgb(BADGE_COLORS[dark ? "dark" : "light"].fill));
    }
  });

  it("draws the digit in the theme's ink on whole pixels", () => {
    const buf = drawBadge(1, { dark: true });
    // The 1's stem: column 1 of the glyph, doubled, starting at x = 5 + 2.
    expect(px(buf, 7, 3)).toEqual(rgb(BADGE_COLORS.dark.ink));
    expect(px(buf, 8, 12)).toEqual(rgb(BADGE_COLORS.dark.ink));
    expect(px(buf, 5, 3)).toEqual(rgb(BADGE_COLORS.dark.fill));
  });

  it("draws every count differently up to 9 and the same 9+ above", () => {
    const shapes = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => drawBadge(n, { dark: true }).toString("hex")));
    expect(shapes.size).toBe(9);
    expect(drawBadge(10, { dark: false }).equals(drawBadge(99, { dark: false }))).toBe(true);
    expect(drawBadge(10, { dark: false }).equals(drawBadge(9, { dark: false }))).toBe(false);
  });

  it("uses the token values, not colors of its own", () => {
    expect(BADGE_COLORS.dark.fill).toEqual([0xf0, 0xb4, 0x4c]);
    expect(BADGE_COLORS.light.fill).toEqual([0x93, 0x56, 0x00]);
    expect(BADGE_COLORS.light.ink).toEqual([0xff, 0xff, 0xff]);
  });
});
