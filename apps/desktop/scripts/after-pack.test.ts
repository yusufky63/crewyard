import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { afterPack, fixSpawnHelpers } from "./after-pack.cjs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A Resources folder with node-pty's macOS prebuilds, spawn-helper stored 0644 as in the npm tarball. */
function resources(arches: string[], withHelper = true): string {
  const root = mkdtempSync(join(tmpdir(), "crewyard after pack "));
  dirs.push(root);
  for (const arch of arches) {
    const dir = join(root, "native", "node-pty", "prebuilds", `darwin-${arch}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pty.node"), "");
    if (withHelper) {
      writeFileSync(join(dir, "spawn-helper"), "");
      chmodSync(join(dir, "spawn-helper"), 0o644);
    }
  }
  return root;
}

describe("afterPack", () => {
  it("leaves Windows and Linux builds alone", async () => {
    await expect(afterPack({ electronPlatformName: "win32", appOutDir: "nowhere" } as never)).resolves.toBeUndefined();
    await expect(afterPack({ electronPlatformName: "linux", appOutDir: "nowhere" } as never)).resolves.toBeUndefined();
  });

  it("fails a macOS build that carries no node-pty prebuild or no spawn-helper", () => {
    expect(() => fixSpawnHelpers(resources([]))).toThrow(/no node-pty prebuild for macOS/);
    expect(() => fixSpawnHelpers(resources(["arm64"], false))).toThrow(/spawn-helper is missing/);
  });

  // Windows has no execute bit to set or read.
  it.runIf(process.platform !== "win32")("makes every macOS spawn-helper executable", () => {
    const fixed = fixSpawnHelpers(resources(["arm64", "x64"]));
    expect(fixed).toHaveLength(2);
    for (const f of fixed) expect(statSync(f).mode & 0o777).toBe(0o755);
  });
});
