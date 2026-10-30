import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDefender, resetProbes } from "./machine.ts";
import { longPathsEnabled } from "./setup/index.ts";

// Windows-only checks read N/A on Linux and macOS (docs/adr/0010): nothing is started for them
// and the Start screen leaves the rows out (screens/start/machine.ts drops null and "unavailable").

const real = process.platform;
const as = (platform: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: platform, configurable: true });
afterEach(() => {
  as(real);
  resetProbes();
});

describe("Windows-only machine checks elsewhere", () => {
  it("reports Defender as unavailable for the worktree folders, with spaces kept", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      as(platform);
      const check = await checkDefender([], "/home/me/My Projects");
      expect(check.state).toBe("unavailable");
      expect(check.folders).toEqual([{ path: join("/home/me/My Projects", ".crewyard", "worktrees"), excluded: null }]);
      expect(check.canReadExclusions).toBe(false);
    }
  });

  it("reads long paths as not applicable instead of querying the registry", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      as(platform);
      expect(await longPathsEnabled()).toBeNull();
    }
  });
});
