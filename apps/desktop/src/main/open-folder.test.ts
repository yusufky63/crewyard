import { describe, expect, it } from "vitest";
import { checkFolder, folderArg, type StatFn } from "./open-folder.ts";

const win = { cwd: "C:\\Users\\me\\My Projects", platform: "win32" as const, skip: 1 };
const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\Crewyard\\Crewyard.exe";

describe("folderArg", () => {
  it("takes the folder after the exe, spaces included", () => {
    expect(folderArg([exe, "C:\\Projeler\\my app"], win)).toBe("C:\\Projeler\\my app");
  });

  it("returns null when only the exe and switches are there", () => {
    expect(folderArg([exe], win)).toBeNull();
    expect(folderArg([exe, "--hidden", "--updated"], win)).toBeNull();
  });

  it("skips Electron, Chromium and toast switches wherever they sit", () => {
    const argv = [exe, "--original-process-start-time=1330", "-ToastActivated", "/prefetch:1", "C:\\work\\api", "--allow-file-access-from-files"];
    expect(folderArg(argv, win)).toBe("C:\\work\\api");
  });

  it("treats everything after -- as a path, even when it starts with a dash", () => {
    expect(folderArg([exe, "--", "-odd name"], win)).toBe("C:\\Users\\me\\My Projects\\-odd name");
  });

  it("repairs the quote Windows leaves behind a trailing backslash", () => {
    // `"C:\"` and `"C:\My folder\"` reach argv as `C:"` and `C:\My folder"`.
    expect(folderArg([exe, 'C:"'], win)).toBe("C:\\");
    expect(folderArg([exe, 'C:\\My folder"'], win)).toBe("C:\\My folder");
  });

  it("drops stray surrounding quotes", () => {
    expect(folderArg([exe, '"C:\\Projeler\\quoted dir"'], win)).toBe("C:\\Projeler\\quoted dir");
  });

  it("keeps ! and other shell characters in names", () => {
    expect(folderArg([exe, "C:\\Projeler\\wow! & (1) %PATH% ^x"], win)).toBe("C:\\Projeler\\wow! & (1) %PATH% ^x");
  });

  it("resolves relative paths against the caller's folder", () => {
    expect(folderArg([exe, "."], win)).toBe("C:\\Users\\me\\My Projects");
    expect(folderArg([exe, "..\\other dir"], win)).toBe("C:\\Users\\me\\other dir");
    expect(folderArg([exe, "sub/app"], win)).toBe("C:\\Users\\me\\My Projects\\sub\\app");
  });

  it("skips the app folder of a development run", () => {
    const argv = ["C:\\repo\\node_modules\\electron\\dist\\electron.exe", ".", "C:\\Projeler\\x"];
    expect(folderArg(argv, { ...win, skip: 2 })).toBe("C:\\Projeler\\x");
    expect(folderArg(argv.slice(0, 2), { ...win, skip: 2 })).toBeNull();
  });

  it("ignores blank arguments and takes only the first folder", () => {
    expect(folderArg([exe, "  ", "C:\\a", "C:\\b"], win)).toBe("C:\\a");
  });

  it("reads POSIX paths on Linux and macOS, where / is not a switch", () => {
    const posix = { cwd: "/home/me", platform: "linux" as const, skip: 1 };
    expect(folderArg(["/opt/Crewyard/crewyard", "--no-sandbox", "/srv/my repo"], posix)).toBe("/srv/my repo");
    expect(folderArg(["/opt/Crewyard/crewyard", "code"], posix)).toBe("/home/me/code");
  });
});

const dirs = (folders: string[], files: string[] = []): StatFn => {
  const lower = (s: string) => s.toLowerCase();
  return (p) => (folders.map(lower).includes(lower(p)) ? { isDirectory: () => true } : files.map(lower).includes(lower(p)) ? { isDirectory: () => false } : null);
};

describe("checkFolder", () => {
  const stat = dirs(["C:\\Projeler\\my app", "C:\\", "D:\\wow! (1)"], ["C:\\Projeler\\notes.txt"]);

  it("accepts an existing folder and normalises it", () => {
    expect(checkFolder("C:\\Projeler\\my app", "win32", stat)).toEqual({ path: "C:\\Projeler\\my app", problem: null });
    expect(checkFolder("C:/Projeler/./my app/", "win32", stat)).toEqual({ path: "C:\\Projeler\\my app", problem: null });
    expect(checkFolder("D:\\wow! (1)", "win32", stat).problem).toBeNull();
  });

  it("keeps a drive root as C:\\", () => {
    expect(checkFolder("C:\\", "win32", stat)).toEqual({ path: "C:\\", problem: null });
  });

  it("drops the long-path prefix on a drive path", () => {
    expect(checkFolder("\\\\?\\C:\\Projeler\\my app", "win32", stat)).toEqual({ path: "C:\\Projeler\\my app", problem: null });
  });

  it("refuses WSL paths in both spellings", () => {
    expect(checkFolder("\\\\wsl$\\Ubuntu\\home\\me", "win32", stat).problem).toBe("wsl");
    expect(checkFolder("\\\\wsl.localhost\\Ubuntu\\home", "win32", stat).problem).toBe("wsl");
    expect(checkFolder("//WSL$/Ubuntu", "win32", stat).problem).toBe("wsl");
  });

  it("refuses other UNC and device paths", () => {
    expect(checkFolder("\\\\server\\share\\repo", "win32", stat).problem).toBe("unc");
    expect(checkFolder("\\\\?\\UNC\\server\\share", "win32", stat).problem).toBe("unc");
    expect(checkFolder("\\\\.\\PhysicalDrive0", "win32", stat).problem).toBe("invalid");
  });

  it("refuses relative, empty and control-character paths", () => {
    expect(checkFolder("Projeler\\x", "win32", stat).problem).toBe("invalid");
    expect(checkFolder("", "win32", stat).problem).toBe("invalid");
    expect(checkFolder("C:\\a\u0000b", "win32", stat).problem).toBe("invalid");
    expect(checkFolder(`C:\\${"a".repeat(40_000)}`, "win32", stat).problem).toBe("invalid");
  });

  it("says when the folder is missing or is a file", () => {
    expect(checkFolder("C:\\Projeler\\gone", "win32", stat)).toEqual({ path: "C:\\Projeler\\gone", problem: "missing" });
    expect(checkFolder("C:\\Projeler\\notes.txt", "win32", stat).problem).toBe("notFolder");
  });

  it("checks POSIX paths on Linux and macOS", () => {
    const posix = dirs(["/srv/my repo"]);
    expect(checkFolder("/srv/my repo/", "linux", posix)).toEqual({ path: "/srv/my repo", problem: null });
    expect(checkFolder("srv", "linux", posix).problem).toBe("invalid");
  });
});
