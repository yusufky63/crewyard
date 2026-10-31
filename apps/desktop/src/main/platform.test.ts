import { describe, expect, it } from "vitest";
import { desktopFeatures } from "./platform.ts";

describe("desktopFeatures", () => {
  it("keeps everything Windows had in a real session, and only the caption buttons in headless runs", () => {
    expect(desktopFeatures("win32", true)).toEqual({ tray: true, notifications: "toast", closeToTray: true, openAtLogin: true, titleBarOverlay: true, toastActivator: true, dockReopen: false, badge: "overlay" });
    expect(desktopFeatures("win32", false)).toEqual({ tray: false, notifications: null, closeToTray: false, openAtLogin: false, titleBarOverlay: true, toastActivator: false, dockReopen: false, badge: null });
  });

  it("gives macOS the menu bar, plain notifications, login items and Dock reopen, without caption overlay", () => {
    expect(desktopFeatures("darwin", true)).toEqual({ tray: true, notifications: "basic", closeToTray: true, openAtLogin: true, titleBarOverlay: false, toastActivator: false, dockReopen: true, badge: "dock" });
  });

  it("gives Linux plain notifications and no tray, so closing the window asks before stopping agents", () => {
    const linux = desktopFeatures("linux", true);
    expect(linux).toMatchObject({ tray: false, notifications: "basic", closeToTray: false, openAtLogin: false, titleBarOverlay: true, badge: null });
  });

  it("never offers close-to-tray without a tray, on any platform or mode", () => {
    for (const platform of ["win32", "darwin", "linux", "freebsd"] as const) {
      for (const interactive of [true, false]) {
        const f = desktopFeatures(platform, interactive);
        if (f.closeToTray) expect(f.tray).toBe(true);
        if (!interactive) expect(f.notifications).toBeNull();
      }
    }
  });
});
