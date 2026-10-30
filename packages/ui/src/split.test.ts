import { describe, expect, it } from "vitest";
import { clampSize, dragSize, growKeys, resolveCollapsibleDrag, SPLIT_STEP, splitKey } from "./split.ts";

const bounds = { min: 184, max: 360 };

describe("clampSize", () => {
  it("keeps a size inside the bounds and rounds it", () => {
    expect(clampSize(250.6, bounds)).toBe(251);
    expect(clampSize(10, bounds)).toBe(184);
    expect(clampSize(9000, bounds)).toBe(360);
  });

  it("falls back to the min when the window leaves no room or the value is not a number", () => {
    expect(clampSize(400, { min: 320, max: 200 })).toBe(320);
    expect(clampSize(Number.NaN, bounds)).toBe(184);
    expect(clampSize(Number.POSITIVE_INFINITY, bounds)).toBe(184);
  });
});

describe("dragSize", () => {
  it("grows a pane whose handle is on its right edge when the pointer moves right", () => {
    expect(dragSize(224, 224, 260, "end")).toBe(260);
    expect(dragSize(224, 224, 200, "end")).toBe(200);
  });

  it("grows a pane whose handle is on its left edge when the pointer moves left", () => {
    expect(dragSize(380, 900, 860, "start")).toBe(420);
    expect(dragSize(380, 900, 950, "start")).toBe(330);
  });
});

describe("splitKey", () => {
  it("moves by 16 px in the direction that matches the handle", () => {
    expect(SPLIT_STEP).toBe(16);
    expect(splitKey("ArrowRight", 224, bounds, "end")).toEqual({ kind: "size", size: 240 });
    expect(splitKey("ArrowLeft", 224, bounds, "end")).toEqual({ kind: "size", size: 208 });
    expect(splitKey("ArrowLeft", 380, { min: 320, max: 720 }, "start")).toEqual({ kind: "size", size: 396 });
    expect(splitKey("ArrowRight", 380, { min: 320, max: 720 }, "start")).toEqual({ kind: "size", size: 364 });
  });

  it("uses Up and Down on a horizontal handle, and ignores Left and Right there", () => {
    const drawer = { min: 160, max: 640 };
    // On the drawer's top edge, moving the handle up grows the drawer.
    expect(splitKey("ArrowUp", 280, drawer, "start", { orientation: "horizontal" })).toEqual({ kind: "size", size: 296 });
    expect(splitKey("ArrowDown", 280, drawer, "start", { orientation: "horizontal" })).toEqual({ kind: "size", size: 264 });
    expect(splitKey("ArrowDown", 280, drawer, "end", { orientation: "horizontal" })).toEqual({ kind: "size", size: 296 });
    expect(splitKey("ArrowLeft", 280, drawer, "start", { orientation: "horizontal" })).toBeNull();
    expect(splitKey("ArrowUp", 280, drawer, "start")).toBeNull();
    expect(growKeys("start", "horizontal")).toEqual({ grow: "ArrowUp", shrink: "ArrowDown" });
    expect(growKeys("end")).toEqual({ grow: "ArrowRight", shrink: "ArrowLeft" });
  });

  it("stops at the bounds and jumps to them with Home and End", () => {
    expect(splitKey("ArrowLeft", 190, bounds, "end")).toEqual({ kind: "size", size: 184 });
    expect(splitKey("ArrowRight", 352, bounds, "end")).toEqual({ kind: "size", size: 360 });
    expect(splitKey("Home", 300, bounds, "end")).toEqual({ kind: "size", size: 184 });
    expect(splitKey("End", 200, bounds, "start")).toEqual({ kind: "size", size: 360 });
  });

  it("toggles on Enter only when the pane can collapse, and ignores other keys", () => {
    expect(splitKey("Enter", 224, bounds, "end", { canToggle: true })).toEqual({ kind: "toggle" });
    expect(splitKey("Enter", 224, bounds, "end")).toBeNull();
    expect(splitKey("ArrowUp", 224, bounds, "end")).toBeNull();
    expect(splitKey("Tab", 224, bounds, "end")).toBeNull();
  });
});

describe("resolveCollapsibleDrag", () => {
  const c = { ...bounds, collapseBelow: 136 };

  it("collapses past the threshold and keeps the width to return to", () => {
    expect(resolveCollapsibleDrag(120, 280, c)).toEqual({ width: 280, collapsed: true });
  });

  it("expands and clamps between the threshold and the min", () => {
    expect(resolveCollapsibleDrag(150, 280, c)).toEqual({ width: 184, collapsed: false });
    expect(resolveCollapsibleDrag(300, 280, c)).toEqual({ width: 300, collapsed: false });
    expect(resolveCollapsibleDrag(999, 280, c)).toEqual({ width: 360, collapsed: false });
  });
});
