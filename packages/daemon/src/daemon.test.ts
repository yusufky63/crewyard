import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseLongPaths } from "./machine.ts";
import { scanForRepos } from "./projects.ts";
import { createHandlers, handleMessage } from "./server.ts";
import { parseVersion, run, which } from "@crewyard/proc";
import { Store } from "./store.ts";

const temps: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "crewyard-test-"));
  temps.push(d);
  return d;
};
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("spawn helpers", () => {
  it("parses versions from CLI banners", () => {
    expect(parseVersion("codex-cli 0.166.0")).toBe("0.166.0");
    expect(parseVersion("git version 2.56.0.windows.3")).toBe("2.56.0");
    expect(parseVersion("gh version 2.83.1 (2026-10-01)")).toBe("2.83.1");
    expect(parseVersion("no digits")).toBeNull();
  });

  it.runIf(process.platform === "win32")("runs .cmd shims, which Node refuses to spawn directly", async () => {
    const dir = tempDir();
    const shim = join(dir, "fake agent.cmd");
    writeFileSync(shim, "@echo off\r\necho fake-agent 1.2.3 %1\r\n");
    const res = await run(shim, ["--version"]);
    expect(res.code).toBe(0);
    expect(parseVersion(res.stdout)).toBe("1.2.3");
    expect(res.stdout).toContain("--version");
  });

  it("finds node on PATH", async () => {
    expect(await which("node")).toMatch(/node(\.exe)?$/i);
    expect(await which("definitely-not-a-real-binary-xyz")).toBeNull();
  });

  it("reads the long paths registry value", () => {
    expect(parseLongPaths("    LongPathsEnabled    REG_DWORD    0x1\r\n")).toBe(true);
    expect(parseLongPaths("    LongPathsEnabled    REG_DWORD    0x0\r\n")).toBe(false);
    expect(parseLongPaths("")).toBeNull();
  });
});

describe("store", () => {
  it("migrates, adds projects once and ignores duplicate events", () => {
    const store = new Store(join(tempDir(), "t.db"));
    const a = store.addProject("C:\\Projeler\\demo", "demo");
    const b = store.addProject("c:\\projeler\\DEMO", "demo");
    expect(b.id).toBe(a.id);
    expect(store.listProjects()).toHaveLength(1);
    expect(store.appendEvent({ kind: "x", source: "test", payload: 1, dedupeKey: "k" })).not.toBeNull();
    expect(store.appendEvent({ kind: "x", source: "test", payload: 1, dedupeKey: "k" })).toBeNull();
    expect(store.eventsSince(0).map((e) => e.kind)).toEqual(["project.added", "x"]);
    store.close();
  });
});

describe("projects", () => {
  it("finds git repositories one level down and marks known ones", () => {
    const root = tempDir();
    mkdirSync(join(root, "alpha", ".git"), { recursive: true });
    mkdirSync(join(root, "beta", ".git"), { recursive: true });
    mkdirSync(join(root, "not-a-repo"));
    const res = scanForRepos(root, new Set([join(root, "beta").toLowerCase()]));
    expect(res.repos.map((r) => [r.name, r.known]).sort()).toEqual([["alpha", false], ["beta", true]]);
  });

  it("lists the repo git touched last first, by its index, and a repo without one by .git itself", () => {
    const root = tempDir();
    for (const name of ["old one", "recent one", "no index"]) mkdirSync(join(root, name, ".git"), { recursive: true });
    writeFileSync(join(root, "old one", ".git", "index"), "");
    writeFileSync(join(root, "recent one", ".git", "index"), "");
    utimesSync(join(root, "old one", ".git", "index"), new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    utimesSync(join(root, "recent one", ".git", "index"), new Date("2026-10-30T12:00:00Z"), new Date("2026-10-30T12:00:00Z"));
    utimesSync(join(root, "no index", ".git"), new Date("2026-06-01T00:00:00Z"), new Date("2026-06-01T00:00:00Z"));
    const res = scanForRepos(root, new Set());
    expect(res.repos.map((r) => [r.name, r.usedAt])).toEqual([
      ["recent one", "2026-10-30T12:00:00.000Z"],
      ["no index", "2026-06-01T00:00:00.000Z"],
      ["old one", "2026-01-01T00:00:00.000Z"],
    ]);
  });
});

describe("ipc handlers", () => {
  it("answers requests and reports errors without throwing", async () => {
    const dir = tempDir();
    const store = new Store(join(dir, "t.db"));
    const handlers = createHandlers({ store, info: { startedAt: "now", dbPath: "t.db", dataDir: dir }, emit: () => {} });
    const ok = await handleMessage(handlers, { kind: "request", id: 1, method: "projects.add", params: { path: dir } });
    expect(ok).toMatchObject({ id: 1, ok: true });
    const bad = await handleMessage(handlers, { kind: "request", id: 2, method: "projects.add", params: { path: join(dir, "missing") } });
    expect(bad).toMatchObject({ id: 2, ok: false });
    const id = (ok as { result: { id: string } }).result.id;
    const opened = await handleMessage(handlers, { kind: "request", id: 3, method: "projects.open", params: { projectId: id } });
    expect((opened as { result: { lastOpenedAt: string | null } }).result.lastOpenedAt).not.toBeNull();
    expect(await handleMessage(handlers, { kind: "event", topic: "x", payload: null })).toBeNull();
    store.close();
  });
});
