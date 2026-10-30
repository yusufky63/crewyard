import { describe, expect, it } from "vitest";
import { useNav } from "../../nav.ts";
import { backTarget, errorCode, exportName, formatBytes, openSettings, useSettingsNav } from "./model.ts";

describe("settings navigation", () => {
  it("remembers where it was opened from and goes back there", () => {
    useNav.setState({ screen: "inbox", projectId: "p1" });
    openSettings("notifications");
    expect(useNav.getState().screen).toBe("settings");
    expect(useSettingsNav.getState()).toMatchObject({ from: "inbox", section: "notifications" });
    // Opening it again from inside Settings keeps the original origin.
    openSettings("data");
    expect(useSettingsNav.getState().from).toBe("inbox");
    expect(backTarget("inbox", "p1")).toBe("inbox");
    expect(backTarget(null, "p1")).toBe("tasks");
    expect(backTarget(null, null)).toBe("start");
  });
});

describe("settings formatting", () => {
  it("formats sizes in the reader's language", () => {
    expect(formatBytes(512, "en")).toBe("512 byte");
    expect(formatBytes(1536, "en")).toBe("1.5 kB");
    expect(formatBytes(5 * 1024 * 1024, "tr")).toBe("5 MB");
  });

  it("maps daemon error codes, including the wrapping Electron adds", () => {
    expect(errorCode(new Error("Error invoking remote method 'crewyard:call': Error: restore.agents_running"))).toBe("restore.agents_running");
    expect(errorCode(new Error("data.exists"))).toBe("data.exists");
    expect(errorCode(new Error("ENOSPC: no space left on device"))).toBeNull();
    expect(errorCode(new Error("crew.bad_layout"))).toBeNull();
  });

  it("names exports by date", () => {
    expect(exportName(new Date(2026, 9, 3))).toBe("crewyard-2026-10-03.db");
  });
});
