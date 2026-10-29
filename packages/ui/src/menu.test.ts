import { describe, expect, it } from "vitest";
import { clampMenu, initialIndex, moveIndex, SEPARATOR, tidySeparators, type MenuEntry } from "./menu.ts";

const entries: MenuEntry[] = [{ id: "a", disabledReason: "no run" }, { id: "b" }, SEPARATOR, { id: "c", disabledReason: "ended" }, { id: "d" }];

describe("context menu rules", () => {
  it("opens on the first enabled item, or the first item when all are disabled", () => {
    expect(initialIndex(entries)).toBe(1);
    expect(initialIndex([{ id: "x", disabledReason: "why" }])).toBe(0);
    expect(initialIndex([])).toBe(-1);
  });

  it("moves over separators, keeps disabled items reachable and wraps", () => {
    expect(moveIndex(entries, 1, 1)).toBe(3);
    expect(moveIndex(entries, 3, -1)).toBe(1);
    expect(moveIndex(entries, 4, 1)).toBe(0);
    expect(moveIndex(entries, 0, -1)).toBe(4);
    expect(moveIndex(entries, 2, "first")).toBe(0);
    expect(moveIndex(entries, 0, "last")).toBe(4);
    expect(moveIndex([SEPARATOR], 0, 1)).toBe(-1);
  });

  it("drops separators that no longer separate anything", () => {
    expect(tidySeparators([SEPARATOR, { id: "a" }, SEPARATOR, SEPARATOR, { id: "b" }, SEPARATOR])).toEqual([{ id: "a" }, SEPARATOR, { id: "b" }]);
  });

  it("keeps the menu on screen", () => {
    expect(clampMenu(100, 100, 240, 200, 1280, 800)).toEqual({ left: 100, top: 100 });
    expect(clampMenu(1200, 100, 240, 200, 1280, 800)).toEqual({ left: 1032, top: 100 });
    // Not enough room below: opens upwards from the pointer.
    expect(clampMenu(100, 700, 240, 200, 1280, 800)).toEqual({ left: 100, top: 500 });
    // Taller than the window: pinned to the top margin.
    expect(clampMenu(0, 50, 240, 900, 1280, 800)).toEqual({ left: 8, top: 8 });
  });
});
