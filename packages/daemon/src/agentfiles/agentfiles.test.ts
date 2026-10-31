import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "@crewyard/adapter-fake";
import { AGENT_FILE_LIMITS, MEMORY_MARKER, type ProfileRunner } from "@crewyard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store.ts";
import { AdapterRegistry } from "../orchestrator/adapters.ts";
import { Orchestrator } from "../orchestrator/orchestrator.ts";
import { CANDIDATES, cleanTemps, ScriptedAdapter, tempDir, tempRepo, waitFor } from "../orchestrator/testing.ts";
import { bridgeDecorator } from "./bridge.ts";
import { commandFor } from "./copy.ts";
import { scanAgentFiles, userBases } from "./scan.ts";
import { AgentFilesService, nativeProjectFiles } from "./service.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const open: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
  cleanTemps();
});

function write(file: string, text: string | Buffer): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

/** A home folder with spaces, holding a typical personal setup and the files that must never be read. */
function makeHome(root: string): string {
  const home = join(root, "home with spaces");
  write(join(home, ".claude", "CLAUDE.md"), "# Mine\nAlways answer in Turkish.\n@AGENTS.md\n");
  write(join(home, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"sk-ant-oat-secret"}}');
  write(join(home, ".claude", "settings.json"), '{"hooks":{"Stop":[{"command":"evil"}]}}');
  write(join(home, ".claude", "skills", "release notes", "SKILL.md"), "---\nname: release-notes\ndescription: Writes release notes\nallowed-tools: Bash(git log:*)\n---\nRead the log.\n");
  write(join(home, ".claude", "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: PDF tools\n---\nRun scripts/extract.py.\n");
  write(join(home, ".claude", "skills", "pdf", "scripts", "extract.py"), "print('hi')\n");
  write(join(home, ".claude", "skills", "pdf", ".env"), "KEY=secret\n");
  write(join(home, ".claude", "skills", "notes", "SKILL.md"), "---\nname: notes\ndescription: Keeps notes\n---\nWrite notes.\n");
  write(join(home, ".claude", "skills", "notes", "reference.md"), "Reference.\n");
  write(join(home, ".claude", "commands", "review.md"), "---\ndescription: Review a change\nmodel: opus\n---\nReview $ARGUMENTS.\n");
  write(join(home, ".claude", "commands", "status.md"), "Status: !`git status`\n");
  write(join(home, ".claude", "agents", "helper.md"), "---\nname: helper\n---\nHelp.\n");
  write(join(home, ".codex", "AGENTS.md"), "Use pnpm.\n");
  write(join(home, ".codex", "auth.json"), '{"OPENAI_API_KEY":"sk-secret"}');
  write(join(home, ".codex", "config.toml"), 'notify = ["evil"]\n');
  write(join(home, ".gemini", "commands", "plan.toml"), 'description = "Plan it"\nprompt = """\nPlan {{args}}.\n"""\n');
  write(join(home, ".gemini", "oauth_creds.json"), '{"refresh_token":"x"}');
  write(join(home, ".agents", "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: Cross-tool\n---\nShared.\n");
  write(join(home, "Documents", "Cline", "Rules", "style.md"), "Short functions.\n");
  write(join(home, "unrelated.md"), "Not an agent file.\n");
  return home;
}

function makeProject(root: string): string {
  const repo = join(root, "my project (1)");
  write(join(repo, "AGENTS.md"), "Project rules for every agent.\n");
  write(join(repo, "CLAUDE.md"), "Claude rules.\n");
  write(join(repo, ".github", "copilot-instructions.md"), "Copilot rules.\n");
  write(join(repo, ".cursor", "rules", "style.mdc"), "---\nalwaysApply: true\n---\nTabs.\n");
  write(join(repo, ".claude", "skills", "local", "SKILL.md"), "---\nname: local\n---\nLocal.\n");
  return repo;
}

function setup() {
  const root = tempDir("crewyard agentfiles ");
  const home = makeHome(root);
  const repo = makeProject(root);
  const store = new Store(join(root, "t.db"));
  open.push(() => store.close());
  const project = store.addProject(repo, "my project");
  const profiles: Record<string, { id: string; dir: string }> = {};
  const addProfile = (id: string, runner: ProfileRunner) => {
    const dir = join(root, "data", "profiles", runner, `${id} alias`);
    mkdirSync(dir, { recursive: true });
    store.db.prepare("insert into profiles (id, alias, runner, provider_id, credential_id, default_model, config_dir, created_at, updated_at) values (?, ?, ?, 'p', null, null, ?, 'now', 'now')").run(id, `${id} alias`, runner, dir);
    profiles[id] = { id, dir };
  };
  addProfile("claude-a", "claude-code");
  addProfile("claude-b", "claude-code");
  addProfile("codex-a", "codex");
  addProfile("gemini-a", "gemini-cli");
  addProfile("opencode-a", "opencode");
  const topics: string[] = [];
  const svc = new AgentFilesService({ db: store.db, bases: () => userBases(home, {}), emit: (t) => topics.push(t) });
  return { root, home, repo, store, project, profiles, svc, topics };
}

const byPath = (scan: ReturnType<AgentFilesService["scan"]>, suffix: string) => scan.items.find((i) => i.path.endsWith(suffix));

describe("discovery", () => {
  it("lists only allowlisted files, user and project, and never opens a denied name", () => {
    const { svc, project, home } = setup();
    const scan = svc.scan(project.id);
    const paths = scan.items.map((i) => i.path);
    expect(paths.some((p) => /credentials|auth\.json|settings\.json|config\.toml|oauth_creds|unrelated/.test(p))).toBe(false);
    expect(JSON.stringify(scan.items)).not.toContain("secret");
    expect(scan.items.find((i) => i.kind === "instructions" && i.scope === "user" && i.tool === "claude")?.imports).toEqual(["AGENTS.md"]);
    expect(byPath(scan, "release notes")).toMatchObject({ kind: "skill", name: "release notes", description: "Writes release notes", strippedKeys: ["allowed-tools"] });
    expect(byPath(scan, join("skills", "pdf"))).toMatchObject({ scripts: ["scripts/extract.py"], files: 2 });
    expect(byPath(scan, join("skills", "pdf"))!.skipped).toEqual([{ path: join(home, ".claude", "skills", "pdf", ".env"), reason: "denied" }]);
    expect(byPath(scan, "status.md")).toMatchObject({ kind: "command", inlineShell: true });
    expect(byPath(scan, "plan.toml")).toMatchObject({ kind: "command", tool: "gemini", description: "Plan it" });
    expect(byPath(scan, "helper.md")?.support.every((s) => s.support.how === "none")).toBe(true);
    expect(byPath(scan, join(".agents", "skills", "shared"))).toMatchObject({ tool: "agents", scope: "user" });
    expect(byPath(scan, join("Cline", "Rules", "style.md"))).toMatchObject({ tool: "cline", kind: "instructions" });
    expect(byPath(scan, "style.mdc")).toMatchObject({ tool: "cursor", scope: "project" });
    expect(byPath(scan, join("my project (1)", "AGENTS.md"))).toMatchObject({ tool: "agents", scope: "project" });
    expect(scan.roots.find((r) => r.path === join(home, ".codex", "AGENTS.md"))?.found).toBe(true);
  });

  it("skips files over the cap, folders past the count, deep skills and links", () => {
    const { home, svc } = setup();
    write(join(home, ".claude", "commands", "huge.md"), "x".repeat(AGENT_FILE_LIMITS.fileBytes + 1));
    for (let i = 0; i < AGENT_FILE_LIMITS.perFolder + 2; i++) write(join(home, ".gemini", "commands", `c${String(i).padStart(3, "0")}.toml`), 'prompt = "x"');
    write(join(home, ".claude", "skills", "deep", "SKILL.md"), "Deep.\n");
    write(join(home, ".claude", "skills", "deep", "a", "b", "c", "d", "e.md"), "Too deep.\n");
    symlinkSync(join(home, ".codex"), join(home, ".claude", "skills", "linked"), "junction");
    const scan = svc.scan(null);
    expect(scan.skipped).toContainEqual({ path: join(home, ".claude", "commands", "huge.md"), reason: "too_large" });
    expect(scan.skipped.filter((s) => s.reason === "too_many").length).toBeGreaterThanOrEqual(2);
    expect(scan.skipped).toContainEqual({ path: join(home, ".claude", "skills", "linked"), reason: "link" });
    expect(byPath(scan, join("skills", "deep"))).toMatchObject({ capped: true });
    expect(scan.items.filter((i) => i.tool === "gemini" && i.kind === "command")).toHaveLength(AGENT_FILE_LIMITS.perFolder);
  });

  it("reads the tools' own override folders when you set them", () => {
    const bases = userBases("C:\\Users\\me", { CODEX_HOME: "D:\\codex home", GEMINI_CLI_HOME: "D:\\gem", XDG_CONFIG_HOME: "D:\\xdg" });
    expect(bases.codex).toBe("D:\\codex home");
    expect(bases.gemini).toBe(join("D:\\gem", ".gemini"));
    expect(bases.opencode).toBe(join("D:\\xdg", "opencode"));
    expect(bases.claude).toBe(join("C:\\Users\\me", ".claude"));
  });

  it("finds nothing and writes nothing in an empty home", () => {
    const root = tempDir("crewyard agentfiles empty ");
    const scan = scanAgentFiles(userBases(join(root, "nobody"), {}), null);
    expect(scan.items).toEqual([]);
    expect(scan.roots.every((r) => !r.found)).toBe(true);
    expect(existsSync(join(root, "nobody"))).toBe(false);
  });
});

describe("sharing", () => {
  it("copies a skill into one profile only, with the granting front matter removed", async () => {
    const { svc, profiles, home, topics } = setup();
    const skill = byPath(svc.scan(null), "release notes")!;
    const view = await svc.share({ itemId: skill.id, target: { runner: "claude-code", profileId: "claude-a" } });
    expect(view.copies).toHaveLength(1);
    expect(view.copies[0]).toMatchObject({ profileId: "claude-a", state: "current", error: null });
    const copied = readFileSync(join(profiles["claude-a"]!.dir, "skills", "release notes", "SKILL.md"), "utf8");
    expect(copied).not.toContain("allowed-tools");
    expect(copied).toContain("Read the log.");
    expect(existsSync(join(profiles["claude-b"]!.dir, "skills"))).toBe(false);
    // The source is never written.
    expect(readFileSync(join(home, ".claude", "skills", "release notes", "SKILL.md"), "utf8")).toContain("allowed-tools");
    expect(topics).toContain("agentfiles.changed");
  });

  it("puts each kind where each runner reads it", async () => {
    const { svc, profiles } = setup();
    const scan = svc.scan(null);
    const shared = byPath(scan, join(".agents", "skills", "shared"))!;
    for (const runner of ["claude-code", "codex", "gemini-cli", "opencode"] as const) await svc.share({ itemId: shared.id, target: { runner, profileId: null } });
    expect(existsSync(join(profiles["claude-a"]!.dir, "skills", "shared", "SKILL.md"))).toBe(true);
    expect(existsSync(join(profiles["codex-a"]!.dir, "skills", "shared", "SKILL.md"))).toBe(true);
    expect(existsSync(join(profiles["gemini-a"]!.dir, ".gemini", "skills", "shared", "SKILL.md"))).toBe(true);
    expect(existsSync(join(profiles["opencode-a"]!.dir, "config", "opencode", "skills", "shared", "SKILL.md"))).toBe(true);

    const review = byPath(scan, "review.md")!;
    await svc.share({ itemId: review.id, target: { runner: "gemini-cli", profileId: null } });
    const toml = readFileSync(join(profiles["gemini-a"]!.dir, ".gemini", "commands", "review.toml"), "utf8");
    expect(toml).toContain('description = "Review a change"');
    expect(toml).toContain("Review {{args}}.");
    expect(toml).not.toContain("opus");
    const plan = byPath(scan, "plan.toml")!;
    await svc.share({ itemId: plan.id, target: { runner: "opencode", profileId: null } });
    expect(readFileSync(join(profiles["opencode-a"]!.dir, "config", "opencode", "commands", "plan.md"), "utf8")).toBe('---\ndescription: "Plan it"\n---\nPlan $ARGUMENTS.\n');
    await expect(svc.share({ itemId: review.id, target: { runner: "codex", profileId: null } })).rejects.toThrow("agentfiles.not_supported");
  });

  it("joins every shared instruction file into the profile's memory file, and removes it when the last one goes", async () => {
    const { svc, profiles } = setup();
    const scan = svc.scan(null);
    const mine = scan.items.find((i) => i.kind === "instructions" && i.tool === "claude" && i.scope === "user")!;
    const codex = scan.items.find((i) => i.kind === "instructions" && i.tool === "codex")!;
    const a = await svc.share({ itemId: mine.id, target: { runner: "gemini-cli", profileId: null } });
    const b = await svc.share({ itemId: codex.id, target: { runner: "gemini-cli", profileId: null } });
    const file = join(profiles["gemini-a"]!.dir, ".gemini", "GEMINI.md");
    const text = readFileSync(file, "utf8");
    expect(text.startsWith(MEMORY_MARKER)).toBe(true);
    expect(text.indexOf("Always answer in Turkish.")).toBeLessThan(text.indexOf("Use pnpm."));
    expect(svc.shares().flatMap((s) => s.copies.map((c) => c.state))).toEqual(["current", "current"]);
    await svc.unshare(a.id);
    expect(readFileSync(file, "utf8")).not.toContain("Turkish");
    await svc.unshare(b.id);
    expect(existsSync(file)).toBe(false);
  });

  it("never overwrites a memory file or a folder someone else wrote", async () => {
    const { svc, profiles } = setup();
    write(join(profiles["codex-a"]!.dir, "AGENTS.md"), "My own codex profile notes.\n");
    write(join(profiles["claude-a"]!.dir, "skills", "notes", "SKILL.md"), "Someone's own.\n");
    const scan = svc.scan(null);
    const view = await svc.share({ itemId: scan.items.find((i) => i.kind === "instructions" && i.tool === "claude" && i.scope === "user")!.id, target: { runner: "codex", profileId: null } });
    expect(view.copies[0]).toMatchObject({ error: "agentfiles.dest_exists", state: "missing" });
    expect(readFileSync(join(profiles["codex-a"]!.dir, "AGENTS.md"), "utf8")).toBe("My own codex profile notes.\n");
    const notes = await svc.share({ itemId: byPath(scan, join("skills", "notes"))!.id, target: { runner: "claude-code", profileId: "claude-a" } });
    expect(notes.copies[0]!.error).toBe("agentfiles.dest_exists");
    expect(readFileSync(join(profiles["claude-a"]!.dir, "skills", "notes", "SKILL.md"), "utf8")).toBe("Someone's own.\n");
  });

  it("copies scripts and shell commands only with the tick, and never subagents or project files", async () => {
    const { svc, project, profiles } = setup();
    const scan = svc.scan(project.id);
    const pdf = byPath(scan, join("skills", "pdf"))!;
    await expect(svc.share({ itemId: pdf.id, target: { runner: "claude-code", profileId: null } })).rejects.toThrow("agentfiles.scripts_need_tick");
    await expect(svc.share({ itemId: byPath(scan, "status.md")!.id, target: { runner: "claude-code", profileId: null } })).rejects.toThrow("agentfiles.scripts_need_tick");
    await expect(svc.share({ itemId: byPath(scan, "helper.md")!.id, target: { runner: "claude-code", profileId: null } })).rejects.toThrow("agentfiles.subagents_off");
    await expect(svc.share({ itemId: byPath(scan, join("skills", "local"))!.id, target: { runner: "claude-code", profileId: null } })).rejects.toThrow("agentfiles.not_shareable");
    await expect(svc.share({ itemId: pdf.id, target: { runner: "claude-code", profileId: "codex-a" } })).rejects.toThrow("agentfiles.unknown_profile");
    expect(svc.shares()).toEqual([]);
    const ok = await svc.share({ itemId: pdf.id, target: { runner: "claude-code", profileId: "claude-a" }, allowScripts: true });
    expect(ok.allowScripts).toBe(true);
    expect(existsSync(join(profiles["claude-a"]!.dir, "skills", "pdf", "scripts", "extract.py"))).toBe(true);
    expect(existsSync(join(profiles["claude-a"]!.dir, "skills", "pdf", ".env"))).toBe(false);
  });

  it("shows outdated, modified and missing copies and brings them back with Sync", async () => {
    const { svc, home, profiles } = setup();
    const skill = byPath(svc.scan(null), join("skills", "notes"))!;
    const share = await svc.share({ itemId: skill.id, target: { runner: "claude-code", profileId: null } });
    const state = () => svc.shares()[0]!.copies.map((c) => [c.profileId, c.state]);
    expect(state()).toEqual([["claude-a", "current"], ["claude-b", "current"]]);

    write(join(home, ".claude", "skills", "notes", "reference.md"), "Reference, edited.\n");
    expect(state()).toEqual([["claude-a", "outdated"], ["claude-b", "outdated"]]);
    write(join(profiles["claude-b"]!.dir, "skills", "notes", "SKILL.md"), "Edited in the profile.\n");
    rmSync(join(profiles["claude-a"]!.dir, "skills", "notes"), { recursive: true });
    expect(state()).toEqual([["claude-a", "missing"], ["claude-b", "modified"]]);

    await svc.sync(share.id);
    expect(state()).toEqual([["claude-a", "current"], ["claude-b", "current"]]);
    expect(readFileSync(join(profiles["claude-b"]!.dir, "skills", "notes", "reference.md"), "utf8")).toBe("Reference, edited.\n");

    rmSync(join(home, ".claude", "skills", "notes"), { recursive: true });
    expect(state()).toEqual([["claude-a", "source_missing"], ["claude-b", "source_missing"]]);
    // A gone source leaves the copies as they were.
    await svc.sync();
    expect(existsSync(join(profiles["claude-a"]!.dir, "skills", "notes", "SKILL.md"))).toBe(true);
    await svc.unshare(share.id);
    expect(existsSync(join(profiles["claude-a"]!.dir, "skills", "notes"))).toBe(false);
  });

  it("gives a profile added later the runner-wide share on the next Sync", async () => {
    const { svc, store, root } = setup();
    const skill = byPath(svc.scan(null), join("skills", "notes"))!;
    await svc.share({ itemId: skill.id, target: { runner: "codex", profileId: null } });
    const dir = join(root, "data", "profiles", "codex", "late");
    store.db.prepare("insert into profiles (id, alias, runner, provider_id, credential_id, default_model, config_dir, created_at, updated_at) values ('codex-late', 'late', 'codex', 'p', null, null, ?, 'now', 'now')").run(dir);
    expect(svc.shares()[0]!.copies.find((c) => c.profileId === "codex-late")?.state).toBe("missing");
    await svc.sync();
    expect(existsSync(join(dir, "skills", "notes", "SKILL.md"))).toBe(true);
  });

  it("converts commands without carrying a model or tools", () => {
    expect(commandFor("claude-code", "---\ndescription: d\nallowed-tools: Bash\nmodel: x\n---\nDo $ARGUMENTS\n", false)).toBe("---\ndescription: d\n---\nDo $ARGUMENTS\n");
    expect(commandFor("gemini-cli", 'prompt = "Do {{args}}"\n', true)).toBe('prompt = "Do {{args}}"\n');
  });
});

describe("bridge", () => {
  it("is off by default and offers each runner what it does not read natively", () => {
    const { svc, project, repo } = setup();
    expect(svc.bridge(project.id).enabled).toBe(false);
    expect(svc.instructionFilesFor("codex", repo)).toBeNull();
    const view = svc.bridgeSet(project.id, true);
    expect(view.files.filter((f) => f.exists).map((f) => f.path)).toEqual(["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"]);
    expect(svc.instructionFilesFor("claude-code", repo)).toEqual(["AGENTS.md", ".github/copilot-instructions.md"]);
    expect(svc.instructionFilesFor("codex", repo)).toEqual(["CLAUDE.md"]);
    expect(svc.instructionFilesFor("gemini-cli", repo)).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(svc.instructionFilesFor("opencode", repo)).toEqual(["CLAUDE.md", ".github/copilot-instructions.md"]);
    svc.bridgeSet(project.id, true, ["CLAUDE.md", "not-a-bridge-file.md"]);
    expect(svc.bridge(project.id).chosen).toEqual(["CLAUDE.md"]);
    expect(svc.instructionFilesFor("claude-code", repo)).toBeNull();
    expect(svc.instructionFilesFor("fake", repo)).toBeNull();
    expect(svc.instructionFilesFor("codex", join(repo, "..", "elsewhere"))).toBeNull();
  });

  it("names what each step reads in the crew proposal", async () => {
    const { svc, project, repo } = setup();
    expect(nativeProjectFiles("claude-code", repo)).toEqual(["CLAUDE.md"]);
    rmSync(join(repo, "CLAUDE.md"));
    // Claude Code reads AGENTS.md itself when the folder has no CLAUDE.md.
    expect(nativeProjectFiles("claude-code", repo)).toEqual(["AGENTS.md"]);
    write(join(repo, "CLAUDE.md"), "Claude rules.\n");
    svc.bridgeSet(project.id, true);
    await svc.share({ itemId: byPath(svc.scan(null), join("skills", "notes"))!.id, target: { runner: "codex", profileId: "codex-a" } });
    const steps = svc.forSteps(project.id, ["codex-a", "gemini-a", "e2e-unknown"]);
    expect(steps).toEqual([
      { profileId: "codex-a", runner: "codex", shared: [{ kind: "skill", name: "notes", state: "current" }], project: ["AGENTS.md"], bridged: ["CLAUDE.md"] },
      { profileId: "gemini-a", runner: "gemini-cli", shared: [], project: [], bridged: ["AGENTS.md", "CLAUDE.md"] },
      { profileId: "e2e-unknown", runner: null, shared: [], project: [], bridged: [] },
    ]);
  });

  it("reaches a run started in a task worktree through the wrapped adapter", async () => {
    const root = tempDir("crewyard bridge-run ");
    const repo = await tempRepo(root);
    write(join(repo, "AGENTS.md"), "Rules.\n");
    write(join(repo, "CLAUDE.md"), "Claude.\n");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["add", "-A"], { cwd: repo, windowsHide: true });
    execFileSync("git", ["commit", "-q", "-m", "instructions"], { cwd: repo, windowsHide: true });
    const store = new Store(join(root, "t.db"));
    const project = store.addProject(repo, "demo");
    const svc = new AgentFilesService({ db: store.db, bases: () => userBases(join(root, "home"), {}) });
    svc.bridgeSet(project.id, true);
    const hold: FakeStep[] = [{ emit: { type: "run.state", state: "running" } }, { emit: { type: "request.question", requestId: "hold", questions: [{ prompt: "hold", options: [{ label: "go" }], allowFreeText: false }] } }, { awaitAnswer: "hold" }];
    const adapter = new ScriptedAdapter(() => hold);
    const adapters = new AdapterRegistry({});
    adapters.set("fake", adapter);
    // The fake runner stands in for Codex here, so the lookup asks for Codex's files.
    adapters.decorate(bridgeDecorator((_runner, cwd) => svc.instructionFilesFor("codex", cwd)));
    const o = new Orchestrator({ store, dataDir: join(root, "data"), emit: () => {}, adapters, directory: { candidates: () => CANDIDATES(), envFor: () => ({}) }, tickMs: 0, freeMemoryMb: () => 64_000, stopTimeoutMs: 2_000 });
    o.start();
    open.push(async () => {
      o.shutdown();
      await o.settle();
      store.close();
    });
    const draft = await o.propose({ projectId: project.id, title: "Implement the cache expiry", kind: "code", size: "S" });
    await o.approve({ taskId: draft.id });
    await o.tick();
    const { req } = await waitFor(() => adapter.started[0]);
    expect(req.cwd.toLowerCase()).not.toBe(repo.toLowerCase());
    expect(req.instructionFiles).toEqual(["CLAUDE.md"]);
  });
});
