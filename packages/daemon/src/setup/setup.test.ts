import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultProjectConfig } from "@crewyard/core";
import { run, which } from "@crewyard/proc";
import { createHandlers, handleMessage } from "../server.ts";
import { Store } from "../store.ts";
import { gitInit, writeCi } from "./actions.ts";
import { ciTemplate, parseTargetFramework } from "./ci.ts";
import { CONFIG_REL, readProjectConfig, validateProjectConfig, writeProjectConfig } from "./config.ts";
import { checkPathLength, defaultWorktreeRoot, detectProjectType, gitState, MAX_PATH, parseGithubRemote, TASK_SEGMENT } from "./detect.ts";

const temps: string[] = [];
// Spaces on purpose: every path in Crewyard must survive them (AGENTS.md, Windows).
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "crewyard setup test-"));
  temps.push(d);
  return d;
};
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const files = (dir: string, entries: Record<string, string>) => {
  for (const [rel, content] of Object.entries(entries)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
};

describe("project type detection", () => {
  it("reads Godot with C# as a dotnet project", () => {
    const dir = files(tempDir(), { "project.godot": "", "New Rts.csproj": "<Project />" });
    expect(detectProjectType(dir)).toEqual({ kind: "godot-csharp", markers: ["project.godot", "New Rts.csproj"], packageManager: null, build: "dotnet build", test: "dotnet test" });
  });

  it("leaves commands empty for GDScript-only Godot projects", () => {
    const dir = files(tempDir(), { "project.godot": "" });
    expect(detectProjectType(dir)).toMatchObject({ kind: "godot", build: null, test: null });
  });

  it("reads .NET solutions", () => {
    const dir = files(tempDir(), { "App.sln": "" });
    expect(detectProjectType(dir)).toMatchObject({ kind: "dotnet", markers: ["App.sln"], build: "dotnet build", test: "dotnet test" });
  });

  it.each([
    ["pnpm-lock.yaml", "pnpm", "pnpm build", "pnpm test"],
    ["package-lock.json", "npm", "npm run build", "npm test"],
    ["yarn.lock", "yarn", "yarn build", "yarn test"],
    ["bun.lock", "bun", "bun build", "bun test"],
  ])("picks the package manager from %s", (lock, pm, build, test) => {
    const dir = files(tempDir(), { "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }), [lock]: "" });
    expect(detectProjectType(dir)).toEqual({ kind: "node", markers: ["package.json", lock], packageManager: pm, build, test });
  });

  it("only suggests scripts the package actually has", () => {
    const dir = files(tempDir(), { "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }), "package-lock.json": "" });
    expect(detectProjectType(dir)).toMatchObject({ build: null, test: null });
  });

  it("falls back to the packageManager field, and to nothing without one", () => {
    const withField = files(tempDir(), { "package.json": JSON.stringify({ packageManager: "pnpm@9.15.4", scripts: { build: "x" } }) });
    expect(detectProjectType(withField)).toMatchObject({ packageManager: "pnpm", build: "pnpm build" });
    const both = files(tempDir(), { "package.json": JSON.stringify({ packageManager: "pnpm@9.15.4", scripts: { build: "x" } }), "package-lock.json": "" });
    expect(detectProjectType(both)).toMatchObject({ packageManager: "pnpm", build: "pnpm build" });
    const workspace = files(tempDir(), { "package.json": JSON.stringify({ scripts: { test: "vitest" } }), "pnpm-workspace.yaml": "" });
    expect(detectProjectType(workspace)).toMatchObject({ packageManager: "pnpm", test: "pnpm test" });
    const bare = files(tempDir(), { "package.json": JSON.stringify({ scripts: { build: "x" } }) });
    expect(detectProjectType(bare)).toMatchObject({ packageManager: null, build: null, test: null });
  });

  it("reads Rust and Python", () => {
    expect(detectProjectType(files(tempDir(), { "Cargo.toml": "" }))).toMatchObject({ kind: "rust", build: "cargo build", test: "cargo test" });
    const py = files(tempDir(), { "pyproject.toml": "[dependency-groups]\ndev = [\"pytest\"]\n", "uv.lock": "" });
    expect(detectProjectType(py)).toMatchObject({ kind: "python", markers: ["pyproject.toml", "uv.lock"], build: "uv build", test: "uv run pytest" });
    expect(detectProjectType(files(tempDir(), { "pyproject.toml": "" }))).toMatchObject({ kind: "python", build: null, test: null });
  });

  it("says unknown instead of guessing", () => {
    expect(detectProjectType(files(tempDir(), { "README.md": "" }))).toEqual({ kind: "unknown", markers: [], packageManager: null, build: null, test: null });
  });

  it("reads the target framework for the CI template", () => {
    expect(parseTargetFramework("<PropertyGroup><TargetFramework>net8.0</TargetFramework>")).toBe("8.0");
    expect(parseTargetFramework("<Project />")).toBeNull();
  });
});

describe("git detection", () => {
  it("parses GitHub remotes in every common form", () => {
    expect(parseGithubRemote("https://github.com/yusufky63/crewyard.git")).toBe("yusufky63/crewyard");
    expect(parseGithubRemote("git@github.com:yusufky63/crewyard.git")).toBe("yusufky63/crewyard");
    expect(parseGithubRemote("ssh://git@github.com/yusufky63/crew.yard")).toBe("yusufky63/crew.yard");
    expect(parseGithubRemote("https://gitlab.com/a/b.git")).toBeNull();
  });

  it("reports branch, commits, clean state and remote", async () => {
    const git = await which("git");
    if (!git) return;
    const dir = tempDir();
    const g = (...args: string[]) => run(git, ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-C", dir, ...args], { timeoutMs: 20_000 });
    expect((await gitState(dir)).isRepo).toBe(false);
    await g("init", "-b", "main");
    expect(await gitState(dir)).toMatchObject({ isRepo: true, branch: "main", commits: 0, clean: true, remoteUrl: null });
    writeFileSync(join(dir, "a file.txt"), "x");
    expect((await gitState(dir)).clean).toBe(false);
    await g("add", ".");
    await g("commit", "-m", "first");
    await g("remote", "add", "origin", "https://github.com/someone/thing.git");
    expect(await gitState(dir)).toMatchObject({ commits: 1, clean: true, githubRepo: "someone/thing" });
    mkdirSync(join(dir, "sub dir"));
    expect(await gitState(join(dir, "sub dir"))).toMatchObject({ isRepo: false });
    expect((await gitState(join(dir, "sub dir"))).parentRepo?.toLowerCase()).toBe(dir.toLowerCase());
  });

  it("git init runs once and never on a subfolder of another repo", async () => {
    if (!(await which("git"))) return;
    const dir = tempDir();
    expect(await gitInit(dir)).toEqual({ branch: "main" });
    expect((await gitState(dir)).isRepo).toBe(true);
    expect(await gitInit(dir)).toEqual({ branch: "main" });
    mkdirSync(join(dir, "inner"));
    await expect(gitInit(join(dir, "inner"))).rejects.toThrow(/inside another repository/);
  });
});

describe("path length", () => {
  it("puts worktrees next to the projects folder", () => {
    expect(defaultWorktreeRoot(join("C:\\Projeler", "new-rts"))).toBe(join("C:\\Projeler", ".mc", "worktrees", "new-rts"));
  });

  it("adds the worktree prefix and task folder to the longest relative path", () => {
    const dir = tempDir();
    const deep = join("assets", "a very long folder name for textures", "terrain", "grass_blades_variation_02.png");
    files(dir, { [deep]: "", "short.txt": "", [join("node_modules", "x".repeat(200), "y")]: "" });
    const root = join("C:\\Projeler", ".mc", "worktrees", "new rts");
    const res = checkPathLength(dir, root, false);
    // node_modules is reinstalled per worktree and never walked, so its 200-character folder does not count.
    expect(res.longestRelative).toBe(deep);
    expect(res.longest).toBe(root.length + 1 + TASK_SEGMENT + 1 + res.longestRelative!.length);
    expect(res.limit).toBe(MAX_PATH);
    expect(res.ok).toBe(res.longest < MAX_PATH);
  });

  it("passes short trees and fails long ones against 260", () => {
    const dir = files(tempDir(), { [join("src", "main.ts")]: "" });
    expect(checkPathLength(dir, "C:\\wt", false)).toMatchObject({ ok: true, longestRelative: join("src", "main.ts") });
    const long = files(tempDir(), { [join("a".repeat(100), "b".repeat(100), "c.txt")]: "" });
    const res = checkPathLength(long, "C:\\Projeler\\.mc\\worktrees\\game", false);
    expect(res.ok).toBe(false);
    expect(checkPathLength(long, "C:\\Projeler\\.mc\\worktrees\\game", true)).toMatchObject({ ok: true, limit: null });
  });

  it("stops at its bound and says so", () => {
    const dir = tempDir();
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, `f${i}.txt`), "");
    expect(checkPathLength(dir, "C:\\wt", false, 10)).toMatchObject({ truncated: true, filesSeen: 10 });
    expect(checkPathLength(dir, "C:\\wt", false)).toMatchObject({ truncated: false, filesSeen: 30 });
  });
});

describe("project.json", () => {
  const valid = () => defaultProjectConfig("new rts", "C:\\Projeler\\.mc\\worktrees\\new rts");

  it("accepts the default config and rejects broken ones", () => {
    expect(validateProjectConfig(valid())).toEqual(valid());
    expect(() => validateProjectConfig({ ...valid(), rules: { ...valid().rules, slots: 99 } })).toThrow(/rules\.slots/);
    expect(() => validateProjectConfig({ ...valid(), github: { ...valid().github, pushNeedsApproval: false } })).toThrow(/pushNeedsApproval/);
  });

  it("refuses anything that looks like a secret, even keys zod would drop", async () => {
    const dir = tempDir();
    const bad = { ...valid(), budget: { ...valid().budget, apiKey: "sk-test-not-real" } };
    await expect(writeProjectConfig(dir, bad)).rejects.toThrow(/budget\.apiKey/);
    expect(existsSync(join(dir, CONFIG_REL))).toBe(false);
  });

  it("writes and reads back the config in a folder with spaces", async () => {
    const dir = tempDir();
    const { file } = await writeProjectConfig(dir, valid());
    expect(file).toBe(join(dir, ".mission", "project.json"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(valid());
    expect(readProjectConfig(dir)).toEqual(valid());
  });

  it("creates the project through IPC, and adds nothing when refused", async () => {
    const dir = tempDir();
    const store = new Store(join(dir, "t.db"));
    const project = join(dir, "my game");
    mkdirSync(project);
    const handlers = createHandlers({ store, info: { startedAt: "now", dbPath: "t.db", dataDir: dir }, emit: () => {} });
    const refused = await handleMessage(handlers, { kind: "request", id: 1, method: "setup.create", params: { path: project, config: { ...valid(), github: { ...valid().github, token: "ghp_x" } } } });
    expect(refused).toMatchObject({ ok: false });
    expect(store.listProjects()).toHaveLength(0);
    const ok = await handleMessage(handlers, { kind: "request", id: 2, method: "setup.create", params: { path: project, config: valid() } });
    expect(ok).toMatchObject({ ok: true, result: { project: { name: "new rts", path: project } } });
    expect(store.listProjects()[0]?.lastOpenedAt).not.toBeNull();
    const detected = await handleMessage(handlers, { kind: "request", id: 3, method: "setup.detect", params: { path: project } });
    expect(detected).toMatchObject({ ok: true, result: { alreadyAdded: true, existingConfig: valid(), name: "new rts" } });
    store.close();
  });
});

describe("CI template", () => {
  const input = { branch: "main", build: "pnpm build", test: "pnpm test", packageManager: "pnpm" as const, kind: "node", dotnetVersion: null, usesUv: false };

  it("follows the CI rules", () => {
    const yml = ciTemplate(input);
    expect(yml).toMatch(/push:\n {4}branches: \["main"\]/);
    expect(yml).toContain("  pull_request:");
    expect(yml).toContain("cancel-in-progress: true");
    expect(yml).toContain("timeout-minutes: 15");
    expect(yml).toContain("runs-on: ubuntu-latest");
    expect(yml).not.toMatch(/schedule|windows-|macos-/);
    expect(yml).toContain('- run: "pnpm test"');
    expect(yml).toContain("pnpm install --frozen-lockfile");
  });

  it("sets up dotnet only when the version is known, and refuses empty jobs", () => {
    expect(ciTemplate({ ...input, kind: "godot-csharp", packageManager: null, dotnetVersion: "8.0", build: "dotnet build", test: null })).toContain('dotnet-version: "8.0.x"');
    expect(ciTemplate({ ...input, kind: "dotnet", packageManager: null, build: "dotnet build" })).not.toContain("setup-dotnet");
    expect(() => ciTemplate({ ...input, build: null, test: " " })).toThrow(/build or test/);
    expect(() => ciTemplate({ ...input, branch: "main; rm" })).toThrow(/branch/);
  });

  it("never overwrites an existing workflow", async () => {
    const dir = files(tempDir(), { "Cargo.toml": "" });
    const { file } = await writeCi(dir, { branch: "main", build: "cargo build", test: "cargo test" });
    expect(readFileSync(file, "utf8")).toContain('- run: "cargo test"');
    await expect(writeCi(dir, { branch: "main", build: "cargo build", test: null })).rejects.toThrow(/already exists/);
  });
});
