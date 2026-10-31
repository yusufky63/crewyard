import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultProjectConfig, ProjectConfig, SETUP_CONFIG_INVALID, SETUP_CONFIG_NEWER, type IpcMethods } from "@crewyard/core";
import { createHandlers, handleMessage } from "../server.ts";
import { Store } from "../store.ts";
import { CONFIG_REL, inspectProjectConfig, keepUnknownKeys, readProjectConfig, writeProjectConfig } from "./config.ts";
import { effectiveProjectConfig } from "./index.ts";

const temps: string[] = [];
// Spaces on purpose: every path in Crewyard must survive them (AGENTS.md, Windows).
const project = () => {
  const d = mkdtempSync(join(tmpdir(), "crewyard config test-"));
  temps.push(d);
  const p = join(d, "my game");
  mkdirSync(join(p, ".crewyard"), { recursive: true });
  return p;
};
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const valid = () => defaultProjectConfig("my game", "C:\\Projeler\\.crewyard\\worktrees\\my game");
const fileOf = (dir: string) => join(dir, CONFIG_REL);
const put = (dir: string, value: unknown) => writeFileSync(fileOf(dir), typeof value === "string" ? value : JSON.stringify(value, null, 2));

describe("reading project.json", () => {
  it("tells a missing file from a valid one", () => {
    const dir = project();
    expect(inspectProjectConfig(dir)).toEqual({ status: { state: "missing" }, config: null, raw: null });
    put(dir, valid());
    expect(inspectProjectConfig(dir)).toMatchObject({ status: { state: "valid", file: fileOf(dir), fallbacks: [] }, config: valid() });
  });

  it("reads a file saved with a byte order mark, as Notepad does", () => {
    const dir = project();
    put(dir, `\uFEFF${JSON.stringify(valid())}`);
    expect(readProjectConfig(dir)).toEqual(valid());
  });

  it("falls back on unknown values, and security fields fall to their most restrictive value", () => {
    const dir = project();
    const cfg = valid();
    put(dir, {
      ...cfg,
      runners: ["codex", "future-runner", "claude-code"],
      rules: { ...cfg.rules, fallback: "sometimes", network: "open", toastApprovals: "all" },
      github: { ...cfg.github, pushNeedsApproval: false },
    });
    const read = inspectProjectConfig(dir);
    expect(read.status.state).toBe("valid");
    expect(read.config?.rules).toMatchObject({ fallback: "ask", network: "ask", toastApprovals: "none" });
    expect(read.config?.github.pushNeedsApproval).toBe(true);
    expect(read.config?.runners).toEqual(["codex", "claude-code"]);
    expect(read.status.state === "valid" && read.status.fallbacks).toEqual([
      { path: "rules.fallback", value: '"sometimes"', used: '"ask"' },
      { path: "rules.network", value: '"open"', used: '"ask"' },
      { path: "rules.toastApprovals", value: '"all"', used: '"none"' },
      { path: "github.pushNeedsApproval", value: "false", used: "true" },
      { path: "runners.1", value: '"future-runner"', used: null },
    ]);
  });

  it("names each problem with a reason the UI can show", () => {
    const dir = project();
    const cases: Array<[unknown, string, RegExp]> = [
      ["{ not json", "json", /JSON|property/i],
      ["[1, 2]", "not_object", /array/],
      [{ ...valid(), version: undefined }, "version", /missing/],
      [{ ...valid(), version: "1" }, "version", /"1"/],
      [{ ...valid(), version: 0 }, "version", /0/],
      [{ ...valid(), rules: { ...valid().rules, slots: 99 } }, "schema", /rules\.slots/],
      [{ ...valid(), budget: "ten dollars" }, "schema", /budget/],
    ];
    for (const [value, reason, detail] of cases) {
      put(dir, value);
      const read = inspectProjectConfig(dir);
      expect(read.config, reason).toBeNull();
      expect(read.status, reason).toMatchObject({ state: "invalid", file: fileOf(dir), reason });
      expect(read.status.state === "invalid" && read.status.detail, reason).toMatch(detail);
    }
  });

  it("refuses a secret-like key by name and never repeats its value", () => {
    const dir = project();
    put(dir, { ...valid(), github: { ...valid().github, token: "ghp_not_a_real_token" } });
    const { status } = inspectProjectConfig(dir);
    expect(status).toMatchObject({ state: "invalid", reason: "secret", detail: "github.token" });
    expect(JSON.stringify(status)).not.toContain("ghp_not_a_real_token");
  });

  it("uses a newer file as far as it understands it", () => {
    const dir = project();
    put(dir, { ...valid(), version: 3, rules: { ...valid().rules, network: "proxy-only" }, lanes: [{ name: "fast" }] });
    const read = inspectProjectConfig(dir);
    expect(read.status).toEqual({ state: "newer", file: fileOf(dir), version: 3, understood: true, detail: null, fallbacks: [{ path: "rules.network", value: '"proxy-only"', used: '"ask"' }] });
    expect(read.config).toEqual(valid());

    put(dir, { ...valid(), version: 2, budget: { perDay: { usd: 10 } } });
    const odd = inspectProjectConfig(dir);
    expect(odd.status).toMatchObject({ state: "newer", version: 2, understood: false });
    expect(odd.status.state === "newer" && odd.status.detail).toMatch(/budget/);
    expect(odd.config).toBeNull();
  });

  it("runs with defaults and toast approvals off when the file cannot be used", () => {
    const dir = project();
    rmSync(join(dir, ".crewyard"), { recursive: true });
    expect(effectiveProjectConfig(dir, "my game")).toMatchObject({ fromFile: false, config: { rules: { toastApprovals: "low", network: "ask" } } });
    mkdirSync(join(dir, ".crewyard"));
    put(dir, "{ broken");
    expect(effectiveProjectConfig(dir, "my game")).toMatchObject({ fromFile: false, status: { state: "invalid" }, config: { name: "my game", rules: { toastApprovals: "none", network: "ask" } } });
    put(dir, { ...valid(), version: 2, budget: null });
    expect(effectiveProjectConfig(dir, "my game")).toMatchObject({ fromFile: false, config: { rules: { toastApprovals: "none" } } });
    put(dir, valid());
    expect(effectiveProjectConfig(dir, "my game")).toMatchObject({ fromFile: true, config: valid() });
  });
});

describe("writing project.json", () => {
  it("keeps keys this build does not know through a read-modify-write", async () => {
    const dir = project();
    const cfg = valid();
    put(dir, {
      ...cfg,
      team: { owner: "someone" },
      rules: { ...cfg.rules, reviewers: 2, network: "open" },
      bootstrap: { ...cfg.bootstrap, port: { from: 4100, to: 4199, envVar: "PORT", host: "127.0.0.1" } },
    });
    const read = readProjectConfig(dir)!;
    const { backup } = await writeProjectConfig(dir, { ...read, name: "renamed" });
    expect(backup).toBeNull();
    const written = JSON.parse(readFileSync(fileOf(dir), "utf8")) as Record<string, Record<string, unknown>>;
    expect(written.name).toBe("renamed");
    expect(written.team).toEqual({ owner: "someone" });
    expect(written.rules).toMatchObject({ reviewers: 2, network: "ask" });
    expect(written.bootstrap!.port).toEqual({ from: 4100, to: 4199, envVar: "PORT", host: "127.0.0.1" });
    expect(readProjectConfig(dir)?.name).toBe("renamed");
  });

  it("replaces arrays whole and drops nothing the wizard sent", () => {
    expect(keepUnknownKeys({ a: [1, { x: 1 }], b: { c: 1, d: 2 } }, { a: [3], b: { c: 5 } })).toEqual({ a: [3], b: { c: 5, d: 2 } });
    expect(keepUnknownKeys(null, { a: 1 })).toEqual({ a: 1 });
    expect(keepUnknownKeys({ port: { from: 1 } }, { port: null })).toEqual({ port: null });
  });

  it("never writes a file from a newer Crewyard", async () => {
    const dir = project();
    const text = JSON.stringify({ ...valid(), version: 2, lanes: [] });
    put(dir, text);
    await expect(writeProjectConfig(dir, valid())).rejects.toThrow(SETUP_CONFIG_NEWER);
    expect(readFileSync(fileOf(dir), "utf8")).toBe(text);
  });

  it("replaces an invalid file only when asked, and keeps a copy", async () => {
    const dir = project();
    const text = '{ "version": 1, "name": "hand edit", oops }';
    put(dir, text);
    await expect(writeProjectConfig(dir, valid())).rejects.toThrow(SETUP_CONFIG_INVALID);
    expect(readFileSync(fileOf(dir), "utf8")).toBe(text);
    expect(existsSync(`${fileOf(dir)}.bak`)).toBe(false);

    const { backup, file } = await writeProjectConfig(dir, valid(), { replaceInvalid: true });
    expect(backup).toBe(`${fileOf(dir)}.bak`);
    expect(readFileSync(backup!, "utf8")).toBe(text);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(valid());
    expect(inspectProjectConfig(dir).status.state).toBe("valid");
  });

  it("keeps the copy next to a legacy file it replaces", async () => {
    const dir = project();
    rmSync(join(dir, ".crewyard"), { recursive: true });
    mkdirSync(join(dir, ".mission"));
    writeFileSync(join(dir, ".mission", "project.json"), "not json");
    const { backup, file } = await writeProjectConfig(dir, valid(), { replaceInvalid: true });
    expect(backup).toBe(join(dir, ".mission", "project.json.bak"));
    expect(readFileSync(backup!, "utf8")).toBe("not json");
    expect(file).toBe(fileOf(dir));
    expect(existsSync(join(dir, ".mission", "project.json"))).toBe(false);
  });
});

describe("project.json through IPC", () => {
  const daemon = (dir: string) => {
    const store = new Store(join(dir, "..", "t.db"));
    const handlers = createHandlers({ store, info: { startedAt: "now", dbPath: "t.db", dataDir: join(dir, "..") }, emit: () => {} });
    let id = 0;
    const call = (method: keyof IpcMethods, params: unknown) => handleMessage(handlers, { kind: "request", id: ++id, method, params });
    return { store, call };
  };

  it("detects the file's state, adds a newer project without writing, and lists notices", async () => {
    const dir = project();
    const text = JSON.stringify({ ...valid(), version: 2, name: "from the future", lanes: [] });
    put(dir, text);
    const { store, call } = daemon(dir);
    expect(await call("setup.detect", { path: dir })).toMatchObject({ ok: true, result: { name: "from the future", configStatus: { state: "newer", version: 2, understood: true } } });
    expect(await call("setup.create", { path: dir, config: valid() })).toMatchObject({ ok: true, result: { written: false, backup: null, configPath: fileOf(dir), project: { name: "my game" } } });
    expect(readFileSync(fileOf(dir), "utf8")).toBe(text);
    expect(await call("setup.configNotices", undefined)).toMatchObject({ ok: true, result: [{ name: "my game", status: { state: "newer" } }] });
    store.close();
  });

  it("refuses to replace an invalid file until the wizard says the user agreed", async () => {
    const dir = project();
    put(dir, "{ broken");
    const { store, call } = daemon(dir);
    expect(await call("setup.detect", { path: dir })).toMatchObject({ ok: true, result: { existingConfig: null, configStatus: { state: "invalid", reason: "json" } } });
    expect(await call("setup.create", { path: dir, config: valid() })).toMatchObject({ ok: false });
    expect(store.listProjects()).toHaveLength(0);
    expect(await call("setup.create", { path: dir, config: valid(), replaceInvalid: true })).toMatchObject({ ok: true, result: { written: true, backup: `${fileOf(dir)}.bak` } });
    expect(await call("setup.configNotices", undefined)).toMatchObject({ ok: true, result: [] });
    store.close();
  });
});

// customRoles (PLAN.md §9.1) has no field in the wizard, so a wizard save must not erase it.

describe("customRoles in project.json", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "crewyard config roles "));
    mkdirSync(join(repo, ".crewyard"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const onDisk = () => JSON.parse(readFileSync(join(repo, CONFIG_REL), "utf8")) as Record<string, unknown>;

  it("keeps the list on disk when the wizard saves without it", async () => {
    const steps = [{ role: "perf", kinds: ["code"], after: ["implementer"] }];
    writeFileSync(join(repo, CONFIG_REL), JSON.stringify({ ...defaultProjectConfig("app", "D:\\wt"), customRoles: steps }));
    const { config } = await writeProjectConfig(repo, { ...defaultProjectConfig("renamed", "D:\\wt") });
    expect(onDisk().customRoles).toEqual(steps);
    expect(onDisk().name).toBe("renamed");
    expect(config.customRoles).toEqual(steps);
  });

  it("keeps even a list that does not validate, for the user to fix", async () => {
    const bad = [{ role: "reviewer", kinds: ["code"] }];
    writeFileSync(join(repo, CONFIG_REL), JSON.stringify({ ...defaultProjectConfig("app", "D:\\wt"), customRoles: bad }));
    const { config } = await writeProjectConfig(repo, defaultProjectConfig("app", "D:\\wt"));
    expect(onDisk().customRoles).toEqual(bad);
    expect(config.customRoles).toBeUndefined();
  });

  it("drops a bad list without dropping the rest of the config", () => {
    const parsed = ProjectConfig.parse({ ...defaultProjectConfig("app", "D:\\wt"), budget: { dailyUsd: 3, perTaskUsd: 1 }, customRoles: [{ role: "Not An Id", kinds: ["code"] }] });
    expect(parsed.customRoles).toBeUndefined();
    expect(parsed.budget.dailyUsd).toBe(3);
  });
});
