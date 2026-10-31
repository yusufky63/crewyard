import { describe, expect, it } from "vitest";
import { gitBashFrom, isShellId, posixShells, windowsShells } from "./shells.ts";

describe("gitBashFrom", () => {
  it("finds bash.exe from each place Git for Windows keeps git.exe", () => {
    expect(gitBashFrom("C:\\Program Files\\Git\\cmd\\git.exe")).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(gitBashFrom("C:\\Program Files\\Git\\bin\\git.exe")).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(gitBashFrom("D:\\Tools\\Git Portable\\mingw64\\bin\\git.exe")).toBe("D:\\Tools\\Git Portable\\bin\\bash.exe");
  });
});

describe("windowsShells", () => {
  it("offers PowerShell 5.1 first, then what was found, then Command Prompt", () => {
    const shells = windowsShells("C:\\Windows", { pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", gitBash: "C:\\Program Files\\Git\\bin\\bash.exe" });
    expect(shells.map((s) => s.id)).toEqual(["powershell", "pwsh", "gitbash", "cmd"]);
    expect(shells[0]!.path).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(shells[3]!.path).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("leaves out what is not installed", () => {
    expect(windowsShells("C:\\Windows", { pwsh: null, gitBash: null }).map((s) => s.id)).toEqual(["powershell", "cmd"]);
  });

  it("starts every shell on UTF-8 and never puts a folder in its arguments", () => {
    const [ps, pwsh, bash, cmd] = windowsShells("C:\\Windows", { pwsh: "C:\\pwsh.exe", gitBash: "C:\\bash.exe" });
    expect(ps!.args.join(" ")).toContain("UTF8Encoding $false");
    expect(pwsh!.args.join(" ")).toContain("UTF8Encoding $false");
    expect(bash!.args).toEqual(["--login", "-i"]);
    expect(cmd!.args).toEqual(["/K", "chcp 65001>nul"]);
  });
});

describe("posixShells", () => {
  it("uses your login shell, or bash when SHELL is missing or relative", () => {
    expect(posixShells("/bin/zsh")[0]).toMatchObject({ id: "posix", path: "/bin/zsh" });
    expect(posixShells(undefined)[0]!.path).toBe("/bin/bash");
    expect(posixShells("zsh")[0]!.path).toBe("/bin/bash");
  });
});

describe("isShellId", () => {
  it("accepts only the known ids", () => {
    expect(isShellId("powershell")).toBe(true);
    expect(isShellId("bash; rm -rf /")).toBe(false);
    expect(isShellId(undefined)).toBe(false);
  });
});
