import { describe, expect, it } from "vitest";
import { exitCodeWithin, isShutdownExit, start, WINDOWS_SHUTDOWN_EXIT } from "./index.ts";

describe("shutdown exit", () => {
  it("recognises the status Windows gives processes it ends at shutdown, as Node reports it", async () => {
    const child = start(process.execPath, ["-e", `process.exit(${WINDOWS_SHUTDOWN_EXIT})`], { stdio: "ignore" });
    const code = await exitCodeWithin(child, 10_000);
    expect(code).toBe(1073807364);
    expect(isShutdownExit(code)).toBe(true);
    expect(isShutdownExit(1)).toBe(false);
    expect(isShutdownExit(null)).toBe(false);
  });

  it("gives up with null when the child is still running", async () => {
    const child = start(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
    expect(await exitCodeWithin(child, 50)).toBeNull();
    child.kill();
    // Already exited: answers at once from exitCode.
    await new Promise((r) => child.once("exit", r));
    expect(await exitCodeWithin(child, 0)).toBe(child.exitCode);
  });
});
