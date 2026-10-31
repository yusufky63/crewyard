import { describe, expect, it } from "vitest";
import { ensureSystemEnv, exitCodeWithin, isShutdownExit, POSIX_SYSTEM_VARS, start, systemEnvVars, WINDOWS_SHUTDOWN_EXIT, WINDOWS_SYSTEM_VARS } from "./index.ts";

describe("shutdown exit", () => {
  it("recognises the status Windows gives processes it ends at shutdown", () => {
    expect(isShutdownExit(1073807364)).toBe(true);
    expect(isShutdownExit(1)).toBe(false);
    expect(isShutdownExit(null)).toBe(false);
  });

  // Only Windows keeps all 32 bits of an exit status; POSIX keeps the low 8, so this exits 4 there.
  it.runIf(process.platform === "win32")("sees that status as Node reports it", async () => {
    const child = start(process.execPath, ["-e", `process.exit(${WINDOWS_SHUTDOWN_EXIT})`], { stdio: "ignore" });
    expect(await exitCodeWithin(child, 10_000)).toBe(1073807364);
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

describe("ensureSystemEnv", () => {
  // Spelled the way a copied Windows process.env spells them.
  const source = { Path: "C:\\Windows;C:\\Program Files\\nodejs", SystemRoot: "C:\\Windows", SystemDrive: "C:", ProgramData: "C:\\ProgramData", windir: "C:\\Windows", TEMP: "C:\\Users\\a b\\Temp", TMP: "C:\\Users\\a b\\Temp", USERPROFILE: "C:\\Users\\a b", APPDATA: "C:\\Users\\a b\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\a b\\AppData\\Local", PATHEXT: ".COM;.EXE;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe", OTHER: "x" };

  it("adds every missing system variable once, under the source's own spelling", () => {
    const env = ensureSystemEnv<Record<string, string>>({ OPENCODE_SERVER_PASSWORD: "p" }, source, "win32");
    for (const name of WINDOWS_SYSTEM_VARS) {
      const keys = Object.keys(env).filter((k) => k.toUpperCase() === name.toUpperCase());
      expect(keys, name).toHaveLength(1);
    }
    expect(env.Path).toBe(source.Path);
    expect(env.ComSpec).toBe(source.ComSpec);
    expect("OTHER" in env).toBe(false);
  });

  it("never duplicates a name that differs only in case, and keeps an adapter's own value", () => {
    const env = ensureSystemEnv({ PATH: "C:\\only", USERPROFILE: "D:\\profile dir" }, source, "win32");
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(env.PATH).toBe("C:\\only");
    expect(env.USERPROFILE).toBe("D:\\profile dir");
  });

  it("on Linux and macOS copies the POSIX variables with exact names and keeps an adapter's HOME", () => {
    const posix = { PATH: "/usr/bin:/home/a b/.local/bin", Path: "/wrong", HOME: "/home/a b", TMPDIR: "/var/folders/x y/T", SHELL: "/bin/zsh", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", SystemRoot: "C:\\Windows", OTHER: "x" };
    for (const platform of ["linux", "darwin"] as const) {
      const env = ensureSystemEnv<Record<string, string>>({ HOME: "/profiles/codex work" }, posix, platform);
      expect(env).toEqual({ HOME: "/profiles/codex work", PATH: posix.PATH, TMPDIR: posix.TMPDIR, SHELL: posix.SHELL, DBUS_SESSION_BUS_ADDRESS: posix.DBUS_SESSION_BUS_ADDRESS });
      expect(systemEnvVars(platform)).toBe(POSIX_SYSTEM_VARS);
    }
    expect(systemEnvVars("win32")).toBe(WINDOWS_SYSTEM_VARS);
  });
});
