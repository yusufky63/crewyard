import { describe, expect, it } from "vitest";
import { e2eMode } from "./e2e.ts";

describe("e2e mode", () => {
  const profile = process.platform === "win32" ? "C:\\Temp\\crewyard e2e\\profile" : "/tmp/crewyard e2e/profile";

  it("is refused in a packaged build and strips the variables before the daemon inherits them", () => {
    const env: NodeJS.ProcessEnv = { CREWYARD_E2E: "1", CREWYARD_E2E_SCRIPT: "x.json", CREWYARD_E2E_PROFILE: profile, CREWYARD_E2E_HOME: profile, PATH: "p" };
    expect(e2eMode(env, true)).toEqual({ enabled: false, refused: true });
    expect(env).toEqual({ PATH: "p" });
  });

  it("is off without the flag and needs an absolute profile with it", () => {
    expect(e2eMode({}, false)).toEqual({ enabled: false, refused: false });
    expect(e2eMode({}, true)).toEqual({ enabled: false, refused: false });
    expect(() => e2eMode({ CREWYARD_E2E: "1", CREWYARD_E2E_PROFILE: "rel" }, false)).toThrow("absolute");
    expect(e2eMode({ CREWYARD_E2E: "1", CREWYARD_E2E_PROFILE: profile }, false)).toEqual({ enabled: true, refused: false, profile });
  });
});
