import { describe, expect, it } from "vitest";
import { start } from "./index.ts";
import { descendantsOf, findOnPosixPath, killTreePosix, parsePsTable, posixSearchDirs, wellKnownBinDirs, type PosixKillDeps, type ProcessRow } from "./platform.ts";

// The Linux and macOS branches, with the platform passed in, so they run on Windows too. Paths
// keep spaces, as user folders and app bundles have them.

const home = "/Users/a b";

describe("POSIX binary lookup", () => {
  it("searches the runners' own install folders after PATH, per platform", () => {
    expect(wellKnownBinDirs("darwin", home)).toEqual([`${home}/.local/bin`, `${home}/.opencode/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
    expect(wellKnownBinDirs("linux", "/home/a b")).toEqual(["/home/a b/.local/bin", "/home/a b/.opencode/bin", "/usr/local/bin", "/usr/bin", "/bin", "/home/linuxbrew/.linuxbrew/bin", "/snap/bin"]);
    expect(wellKnownBinDirs("win32", "C:\\Users\\a b")).toEqual([]);
    // No usable home: only the system folders.
    expect(wellKnownBinDirs("linux", "")).toEqual(["/usr/local/bin", "/usr/bin", "/bin", "/home/linuxbrew/.linuxbrew/bin", "/snap/bin"]);
  });

  it("drops empty and relative PATH entries, which POSIX reads as the current folder", () => {
    const dirs = posixSearchDirs(":./bin:/opt/my tools//bin::/usr/bin:node_modules/.bin", "linux", "/home/a b");
    expect(dirs.slice(0, 2)).toEqual(["/opt/my tools/bin", "/usr/bin"]);
    expect(dirs.some((d) => !d.startsWith("/"))).toBe(false);
    // PATH order first, and a folder already on PATH is not searched twice.
    expect(dirs.filter((d) => d === "/usr/bin")).toHaveLength(1);
  });

  it("returns the first executable in PATH order, then in the install folders", async () => {
    const files = new Set([`${home}/.local/bin/claude`, "/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/opt/my tools/bin/codex"]);
    const isExecutable = async (p: string) => files.has(p);
    const find = (name: string, pathValue = "/usr/bin:/bin") => findOnPosixPath(name, { pathValue, platform: "darwin", home, isExecutable });
    // A Dock launch has a short PATH; the native installer's folder still finds claude.
    expect(await find("claude")).toBe(`${home}/.local/bin/claude`);
    expect(await find("codex")).toBe("/opt/homebrew/bin/codex");
    expect(await find("codex", "/opt/my tools/bin:/usr/bin")).toBe("/opt/my tools/bin/codex");
    expect(await find("gemini")).toBeNull();
    // Names with a slash are paths, not lookups.
    expect(await find("../codex")).toBeNull();
    expect(await find("")).toBeNull();
  });
});

describe("POSIX process tree", () => {
  it("parses ps output from Linux and macOS", () => {
    const linux = "    1     0\n  812     1\n 9001   812\n";
    const mac = "  1   0\n812   1\n9001 812\nbad line\n";
    expect(parsePsTable(linux)).toEqual([{ pid: 1, ppid: 0 }, { pid: 812, ppid: 1 }, { pid: 9001, ppid: 812 }]);
    expect(parsePsTable(mac)).toEqual(parsePsTable(linux));
  });

  it("finds every descendant once, children before grandchildren", () => {
    const rows: ProcessRow[] = [
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 10 },
      { pid: 13, ppid: 11 },
      { pid: 20, ppid: 1 },
      { pid: 21, ppid: 21 },
    ];
    expect(descendantsOf(10, rows)).toEqual([11, 12, 13]);
    expect(descendantsOf(20, rows)).toEqual([]);
    expect(descendantsOf(99, rows)).toEqual([]);
  });

  function fakeKill(opts: { exitsOnTerm: Set<number>; tree: ProcessRow[] }) {
    const alive = new Set<number>([-10, 10, 11, 12]);
    const sent: Array<[number, string | 0]> = [];
    let slept = 0;
    const deps: PosixKillDeps = {
      signal: (pid, sig) => {
        if (sig !== 0) sent.push([pid, sig]);
        if (!alive.has(pid)) return false;
        if (sig === "SIGKILL" || (sig === "SIGTERM" && opts.exitsOnTerm.has(pid))) alive.delete(pid);
        return true;
      },
      table: async () => opts.tree,
      sleep: async (ms) => void (slept += ms),
      graceMs: 300,
    };
    return { deps, alive, sent, slept: () => slept };
  }

  const tree: ProcessRow[] = [
    { pid: 10, ppid: 5 },
    { pid: 11, ppid: 10 },
    { pid: 12, ppid: 11 },
  ];

  it("terms the group and each descendant, and stops waiting once all are gone", async () => {
    const k = fakeKill({ exitsOnTerm: new Set([-10, 10, 11, 12]), tree });
    await killTreePosix(10, k.deps);
    expect(k.sent).toEqual([
      [-10, "SIGTERM"],
      [10, "SIGTERM"],
      [11, "SIGTERM"],
      [12, "SIGTERM"],
    ]);
    expect(k.alive.size).toBe(0);
    expect(k.slept()).toBe(0);
  });

  it("kills what is still there after the grace period", async () => {
    // 12 left the group and ignores SIGTERM.
    const k = fakeKill({ exitsOnTerm: new Set([-10, 10, 11]), tree });
    await killTreePosix(10, k.deps);
    expect(k.sent.filter(([, s]) => s === "SIGKILL")).toEqual([[12, "SIGKILL"]]);
    expect(k.slept()).toBe(300);
    expect(k.alive.size).toBe(0);
  });

  it("still signals the group when ps is unavailable, and never touches pid 0, 1 or a negative pid", async () => {
    const k = fakeKill({ exitsOnTerm: new Set([-10, 10, 11, 12]), tree: [] });
    k.deps.table = async () => Promise.reject(new Error("no ps"));
    await killTreePosix(10, k.deps);
    expect(k.sent.map(([p]) => p)).toEqual([-10, 10]);
    for (const pid of [0, 1, -10, 1.5]) {
      const none = fakeKill({ exitsOnTerm: new Set(), tree });
      await killTreePosix(pid, none.deps);
      expect(none.sent).toEqual([]);
    }
  });

  // Real processes; runs on the Linux CI job and on a Mac.
  it.runIf(process.platform !== "win32")("ends a real child and the grandchild it started", async () => {
    const script = "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)";
    const child = start(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    const grandchild = await new Promise<number>((resolve) => child.stdout?.once("data", (d: Buffer) => resolve(Number(String(d).trim()))));
    const alive = (pid: number) => {
      try {
        return process.kill(pid, 0);
      } catch {
        return false;
      }
    };
    expect(alive(grandchild)).toBe(true);
    await killTreePosix(child.pid!);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(grandchild)).toBe(false);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
