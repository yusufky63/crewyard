import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exitCodeWithin, LineSplitter, pickWindowsHit, ProbeCache, run, shimArgsProblem, start, which, windowsPathHits } from "./index.ts";

const win = process.platform === "win32";
const root = mkdtempSync(join(tmpdir(), "crewyard proc "));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A folder with spaces holding `name.cmd`, which runs `script` through the same node. */
function shimDir(folder: string, name: string, script: string, cmdBody?: string): string {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.js`), script);
  writeFileSync(join(dir, `${name}.cmd`), cmdBody ?? `@echo off\r\n"${process.execPath}" "%~dp0${name}.js" %*\r\n`);
  return dir;
}

describe("which on Windows", () => {
  it("prefers an .exe over a .cmd shim anywhere on PATH and skips what cannot be spawned", () => {
    expect(pickWindowsHit(["C:\\npm\\claude", "C:\\npm\\claude.cmd", "C:\\npm\\claude.ps1", "C:\\Users\\me\\.local\\bin\\claude.exe"])).toBe("C:\\Users\\me\\.local\\bin\\claude.exe");
    expect(pickWindowsHit(["C:\\npm\\codex", "C:\\npm\\codex.cmd"])).toBe("C:\\npm\\codex.cmd");
    expect(pickWindowsHit(["C:\\npm\\codex", "C:\\npm\\codex.ps1"])).toBeNull();
  });

  it("lists PATH hits as where.exe would, in-process: folder order, bare name then PATHEXT, no current folder", () => {
    const npm = String.raw`C:\Users\me\AppData\Roaming\npm`;
    const spaced = String.raw`C:\Program Files\x y`;
    const files = new Set([`${npm}\\codex`, `${npm}\\codex.cmd`, `${spaced}\\codex.exe`].map((f) => f.toLowerCase()));
    const exists = (p: string) => files.has(p.toLowerCase());
    // Folder order, an empty entry, a relative entry (never searched), a quoted folder, and the
    // first folder again with a trailing backslash (no repeats).
    const path = [npm, "", String.raw`relative\bin`, `"${spaced}"`, `${npm}\\`].join(";");
    expect(windowsPathHits("codex", path, ".COM;.EXE;.BAT;.CMD", exists)).toEqual([`${npm}\\codex`, `${npm}\\codex.cmd`, `${spaced}\\codex.exe`]);
    // A name with a folder or drive in it, or no PATH at all, finds nothing.
    expect(windowsPathHits(String.raw`..\codex`, path, undefined, exists)).toEqual([]);
    expect(windowsPathHits("C:codex", path, undefined, exists)).toEqual([]);
    expect(windowsPathHits("codex", undefined, undefined, exists)).toEqual([]);
  });

  it.runIf(win)("resolves in PATH order without starting a child, never the extensionless npm script", async () => {
    const shims = shimDir("npm global", "fake-agent", "console.log('shim')");
    writeFileSync(join(shims, "fake-agent"), "#!/bin/sh\nexit 1\n");
    const env = { ...process.env, PATH: shims };
    expect(await which("fake-agent", { env })).toBe(join(shims, "fake-agent.cmd"));

    const native = join(root, "native bin");
    mkdirSync(native, { recursive: true });
    copyFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), join(native, "fake-agent.exe"));
    // The shim comes first on PATH, the real binary still wins.
    expect(await which("fake-agent", { env: { ...process.env, PATH: [shims, native].join(delimiter) } })).toBe(join(native, "fake-agent.exe"));
    expect(await which("fake-agent", { env: { ...process.env, PATH: join(root, "nothing here") } })).toBeNull();
    // An env copied from process.env spells it Path on Windows; that works the same.
    const { PATH: _p, Path: _q, ...rest } = process.env;
    expect(await which("fake-agent", { env: { ...rest, Path: shims } })).toBe(join(shims, "fake-agent.cmd"));
  });
});

describe(".cmd shims", () => {
  const echo = () => shimDir("echo shim", "echo args", "console.log(JSON.stringify(process.argv.slice(2)))");

  it.runIf(win)("passes arguments with spaces, quotes and cmd.exe metacharacters through unchanged", async () => {
    const args = ["with space", 'has "quotes"', "a&b", "100%", "%PATH%", "x^y", "!bang", "a|b", "<in>", "", "trail\\", "C:\\Program Files\\x y\\", "--flag=1 2"];
    const res = await run(join(echo(), "echo args.cmd"), args);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(args);
  });

  it("refuses a line break in an argument to a shim instead of letting cmd.exe cut the command", async () => {
    const shim = join(root, "x y", "agent.cmd");
    if (win) {
      expect(shimArgsProblem(shim, ["ok", "two\nlines"])).toMatch(/argument 2 contains a line break/);
      const res = await run(shim, ["line1\nline2 --danger", "after"]);
      expect(res).toMatchObject({ code: null, stdout: "" });
      expect(res.stderr).toMatch(/line break/);
      expect(() => start(shim, ["a\r\nb"])).toThrow(/line break/);
    }
    // A real binary gets its arguments verbatim, line breaks included.
    expect(shimArgsProblem(process.execPath, ["two\nlines"])).toBeNull();
    const res = await run(process.execPath, ["-e", "console.log(JSON.stringify(process.argv[1]))", "two\nlines"]);
    expect(JSON.parse(res.stdout)).toBe("two\nlines");
  });

  it.runIf(win)("reports a shim that exits at once with its exit code and stderr", async () => {
    const dir = shimDir("dying shim", "dies", "", "@echo off\r\necho node: not found 1>&2\r\nexit /b 9009\r\n");
    const shim = join(dir, "dies.cmd");
    const res = await run(shim, ["--version"]);
    expect(res.code).toBe(9009);
    expect(res.stderr).toContain("node: not found");

    const child = start(shim, ["serve"], { stdio: ["ignore", "ignore", "pipe"] });
    const closed = new Promise((r) => child.once("close", r));
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    expect(await exitCodeWithin(child, 10_000)).toBe(9009);
    await closed;
    expect(stderr).toContain("node: not found");
  });
});

describe("ProbeCache", () => {
  it("shares one in-flight probe, reuses fresh answers per caller's freshness and never keeps failures", async () => {
    let t = 0;
    const cache = new ProbeCache<number>(() => t);
    let calls = 0;
    let release!: (n: number) => void;
    const probe = () => {
      calls++;
      return new Promise<number>((r) => (release = r));
    };
    const a = cache.get("k", 1_000, probe);
    const b = cache.get("k", 0, probe);
    release(42);
    expect(await Promise.all([a, b])).toEqual([42, 42]);
    expect(calls).toBe(1);

    t = 500;
    expect(await cache.get("k", 1_000, async () => (calls++, 1))).toBe(42);
    expect(await cache.get("k", 100, async () => (calls++, 7))).toBe(7);
    expect(calls).toBe(2);

    await expect(cache.get("bad", 1_000, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await cache.get("bad", 1_000, async () => 3)).toBe(3);
  });
});

describe("LineSplitter", () => {
  it("splits chunks that end mid-line, strips CR and skips blank lines", () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\r\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n\n{"c":3')).toEqual(['{"b":2}']);
    expect(s.flush()).toEqual(['{"c":3']);
    expect(s.flush()).toEqual([]);
  });

  it("drops a line past the cap while it streams in, reports its size once and carries on", () => {
    const seen: number[] = [];
    const s = new LineSplitter(10, (n) => seen.push(n));
    expect(s.push("short\n0123456")).toEqual(["short"]);
    expect(s.push("789abcdef")).toEqual([]);
    expect(s.push("ghij\nnext\n")).toEqual(["next"]);
    expect(seen).toEqual([20]);
  });
});
