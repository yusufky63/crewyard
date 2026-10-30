import { describe, expect, it } from "vitest";
import { refusedDebugSwitches, type DebugStart } from "./debug-switches.ts";

describe("remote debugging switches", () => {
  const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\crewyard\\Crewyard.exe";
  const ROOT = "0123456789ABCDEF0123456789ABCDEF01234567";
  const none = () => false;
  const packaged = (argv: string[], hasSwitch: DebugStart["hasSwitch"] = none): DebugStart => ({ packaged: true, testRoot: null, argv: [exe, ...argv], hasSwitch });

  it("refuses both switches in a packaged build when Chromium sees them", () => {
    expect(refusedDebugSwitches(packaged([], (s) => s === "remote-debugging-port"))).toEqual(["remote-debugging-port"]);
    expect(refusedDebugSwitches(packaged([], () => true))).toEqual(["remote-debugging-port", "remote-debugging-pipe"]);
  });

  it("refuses every spelling Chromium accepts on Windows even when hasSwitch misses it", () => {
    for (const arg of ["--remote-debugging-port=9339", "-remote-debugging-port=9339", "/remote-debugging-port=9339", "--REMOTE-Debugging-Port=0", " --remote-debugging-port=9339 ", "--remote-debugging-port"]) {
      expect(refusedDebugSwitches(packaged([arg])), arg).toEqual(["remote-debugging-port"]);
    }
    expect(refusedDebugSwitches(packaged(["--hidden", "--remote-debugging-pipe"]))).toEqual(["remote-debugging-pipe"]);
  });

  it("lets an ordinary packaged start through", () => {
    expect(refusedDebugSwitches(packaged([]))).toEqual([]);
    expect(refusedDebugSwitches(packaged(["--hidden"]))).toEqual([]);
    // Neither opens anything on its own.
    expect(refusedDebugSwitches(packaged(["--remote-debugging-address=127.0.0.1", "--remote-debugging-portal=1"]))).toEqual([]);
    // The executable's own path is not a switch, even off Windows where it starts with a slash.
    expect(refusedDebugSwitches({ packaged: true, testRoot: null, argv: ["/remote-debugging-port/crewyard"], hasSwitch: none })).toEqual([]);
  });

  it("allows them in a build with a test root, which the installed update test drives over CDP", () => {
    expect(refusedDebugSwitches({ ...packaged(["--remote-debugging-port=19123"], () => true), testRoot: ROOT })).toEqual([]);
  });

  it("allows them in unpackaged runs: pnpm dev, Playwright and screenshots", () => {
    expect(refusedDebugSwitches({ packaged: false, testRoot: null, argv: [exe, ".", "--remote-debugging-port=0"], hasSwitch: () => true })).toEqual([]);
  });
});
