import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, inboxListBounds, inspectorBounds, layoutVars, sanitizeLayout, sidebarColumn } from "./layout.ts";

describe("sanitizeLayout", () => {
  it("fills the defaults when nothing was stored", () => {
    expect(sanitizeLayout(undefined)).toEqual(DEFAULT_LAYOUT);
    expect(sanitizeLayout("garbage")).toEqual(DEFAULT_LAYOUT);
  });

  it("keeps stored sizes inside their limits and drops values of the wrong type", () => {
    const l = sanitizeLayout({ sidebarWidth: 9000, sidebarCollapsed: true, inspectorWidth: 12, inspectorCollapsed: "yes", inboxListWidth: "wide" });
    expect(l).toEqual({ sidebarWidth: 360, sidebarCollapsed: true, inspectorWidth: 320, inspectorCollapsed: false, inboxListWidth: 360 });
  });

  it("round-trips what the store persists", () => {
    const saved = { sidebarWidth: 272, sidebarCollapsed: false, inspectorWidth: 512, inspectorCollapsed: true, inboxListWidth: 420 };
    expect(sanitizeLayout(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });
});

describe("sidebarColumn", () => {
  it("is the rail when collapsed or when the window is narrow", () => {
    expect(sidebarColumn(1440, { sidebarWidth: 280, sidebarCollapsed: false })).toBe(280);
    expect(sidebarColumn(1440, { sidebarWidth: 280, sidebarCollapsed: true })).toBe(56);
    expect(sidebarColumn(1100, { sidebarWidth: 280, sidebarCollapsed: false })).toBe(56);
  });
});

describe("inspectorBounds", () => {
  it("leaves the main view its minimum while the inspector is a column", () => {
    expect(inspectorBounds(1920, 224)).toEqual({ min: 320, max: 720 });
    expect(inspectorBounds(1280, 224)).toEqual({ min: 320, max: 456 });
  });

  it("allows more as an overlay and never drops under the minimum", () => {
    expect(inspectorBounds(1200, 224)).toEqual({ min: 320, max: 720 });
    expect(inspectorBounds(960, 56)).toEqual({ min: 320, max: 720 });
    expect(inspectorBounds(1280, 360)).toEqual({ min: 320, max: 320 });
    expect(inspectorBounds(500, 56)).toEqual({ min: 320, max: 324 });
  });
});

describe("inboxListBounds", () => {
  it("keeps the detail pane readable", () => {
    expect(inboxListBounds(1064, 16)).toEqual({ min: 280, max: 560 });
    expect(inboxListBounds(800, 16)).toEqual({ min: 280, max: 464 });
    expect(inboxListBounds(500, 16)).toEqual({ min: 280, max: 280 });
  });
});

describe("layoutVars", () => {
  it("writes each size as a pixel custom property", () => {
    expect(layoutVars(DEFAULT_LAYOUT)).toEqual({ "--sidebar-w": "224px", "--inspector-w": "380px", "--inbox-list-w": "360px" });
  });
});
