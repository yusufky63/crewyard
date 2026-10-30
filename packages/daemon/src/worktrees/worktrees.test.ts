import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "@crewyard/adapter-fake";
import { defaultProjectConfig, IncludePath, ProjectConfig, splitCommand, type BootstrapStep, type RequestView, type StartRequest } from "@crewyard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterRegistry } from "../orchestrator/adapters.ts";
import { Orchestrator } from "../orchestrator/orchestrator.ts";
import { CANDIDATES, cleanTemps, git, ScriptedAdapter, tempDir, tempRepo, waitFor } from "../orchestrator/testing.ts";
import { Store } from "../store.ts";
import { commandHash } from "./command.ts";
import { copyInclude, previewInclude } from "./include.ts";
import { pickPort } from "./port.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const open: Array<{ o: Orchestrator; store: Store }> = [];
afterEach(async () => {
  const all = open.splice(0);
  all.forEach(({ o }) => o.shutdown());
  for (const { o } of all) await o.settle();
  all.forEach(({ store }) => store.close());
  cleanTemps();
});

const step = (command: string, timeoutSec = 60): BootstrapStep => ({ command, timeoutSec });
// `node` is on PATH wherever the tests run; JSON.stringify quotes the script for splitCommand.
const nodeStep = (script: string, timeoutSec = 60) => step(`node -e ${JSON.stringify(script)}`, timeoutSec);

describe("commands", () => {
  it("splits without a shell and refuses shell syntax", () => {
    expect(splitCommand('pnpm install --filter "my app"')).toEqual({ argv: ["pnpm", "install", "--filter", "my app"] });
    expect(splitCommand("dotnet build C:\\Projeler\\new rts\\Game.csproj")).toEqual({ argv: ["dotnet", "build", "C:\\Projeler\\new", "rts\\Game.csproj"] });
    expect(splitCommand(`node -e "a; b | c"`)).toEqual({ argv: ["node", "-e", "a; b | c"] });
    expect(splitCommand("pnpm i && pnpm build")).toEqual({ problem: "shell_syntax" });
    expect(splitCommand("echo x > out.txt")).toEqual({ problem: "shell_syntax" });
    expect(splitCommand('node -e "x')).toEqual({ problem: "unclosed_quote" });
    expect(splitCommand("   ")).toEqual({ problem: "empty" });
    expect(splitCommand("a\nb")).toEqual({ problem: "multiline" });
  });

  it("hashes the exact text", () => {
    expect(commandHash("pnpm install")).toBe(commandHash("pnpm install"));
    expect(commandHash("pnpm install")).not.toBe(commandHash("pnpm  install"));
    expect(commandHash("pnpm install")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validates include paths and keeps old configs readable", () => {
    for (const ok of [".env", ".env.local", "apps/web/.env", "cache dir/"]) expect(IncludePath.safeParse(ok).success).toBe(true);
    for (const bad of ["C:\\secrets\\.env", "/etc/passwd", "../other/.env", "a/../../b", "*.env", ".git", ".git/config"]) expect(IncludePath.safeParse(bad).success).toBe(false);
    const { bootstrap: _drop, ...old } = defaultProjectConfig("old", "C:\\wt");
    expect(ProjectConfig.parse(old).bootstrap).toEqual({ setup: [], cleanup: [], include: [], includeMaxMb: 64, port: null });
  });
});

describe("ports", () => {
  it("is stable per branch and skips ports other worktrees hold", () => {
    const range = { from: 4100, to: 4999 };
    const a = pickPort("crewyard/fix-login-abc123", range, new Set());
    expect(pickPort("crewyard/fix-login-abc123", range, new Set())).toBe(a);
    expect(a).toBeGreaterThanOrEqual(4100);
    expect(a).toBeLessThanOrEqual(4999);
    const next = pickPort("crewyard/fix-login-abc123", range, new Set([a]));
    expect(next).not.toBe(a);
    expect(pickPort("x", { from: 5000, to: 5001 }, new Set([5000, 5001]))).toBeGreaterThanOrEqual(5000);
  });
});

describe("include list", () => {
  async function repoWithIgnored() {
    const root = tempDir("crewyard include test-");
    const repo = await tempRepo(root, "main checkout");
    writeFileSync(join(repo, ".gitignore"), ".env\n.env.local\ncache dir/\nbig.bin\nlinked/\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "ignore");
    writeFileSync(join(repo, ".env"), "SECRET_VALUE=do-not-log\n");
    mkdirSync(join(repo, "cache dir", "deep folder"), { recursive: true });
    writeFileSync(join(repo, "cache dir", "deep folder", "a file.txt"), "cached");
    writeFileSync(join(repo, "cache dir", "b.txt"), "b");
    writeFileSync(join(repo, "big.bin"), Buffer.alloc(2 * 1024 * 1024));
    return { root, repo };
  }

  it("copies only listed, gitignored files, in folders with spaces, and never overwrites", async () => {
    const { root, repo } = await repoWithIgnored();
    const preview = await previewInclude(repo, [".env", "cache dir", "README.md", ".env.local"], 64);
    expect(preview.entries.map((e) => [e.path, e.state, e.files])).toEqual([
      [".env", "copy", 1],
      ["cache dir", "copy", 2],
      ["README.md", "not_ignored", 1],
      [".env.local", "missing", 0],
    ]);
    // The preview carries names and sizes, never content.
    expect(JSON.stringify(preview)).not.toContain("do-not-log");

    const wt = join(root, "task worktree");
    mkdirSync(wt);
    writeFileSync(join(wt, "README.md"), "worktree copy");
    const copied = copyInclude(repo, wt, preview);
    expect(copied).toMatchObject({ files: 3, skipped: 0 });
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("SECRET_VALUE=do-not-log\n");
    expect(readFileSync(join(wt, "cache dir", "deep folder", "a file.txt"), "utf8")).toBe("cached");
    expect(readFileSync(join(wt, "README.md"), "utf8")).toBe("worktree copy");
    // A second copy finds the files there and leaves them.
    writeFileSync(join(wt, ".env"), "edited in the worktree");
    expect(copyInclude(repo, wt, preview)).toMatchObject({ files: 0, skipped: 3 });
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("edited in the worktree");
  });

  it("skips entries past the size cap and never follows links", async () => {
    const { root, repo } = await repoWithIgnored();
    const outside = join(root, "outside folder");
    mkdirSync(outside);
    writeFileSync(join(outside, "x.txt"), "outside");
    symlinkSync(outside, join(repo, "linked"), "junction");
    const preview = await previewInclude(repo, [".env", "big.bin", "linked"], 1);
    expect(preview.entries.map((e) => [e.path, e.state])).toEqual([
      [".env", "copy"],
      ["big.bin", "over_cap"],
      ["linked", "link"],
    ]);
    expect(preview.capBytes).toBe(1024 * 1024);
    const wt = join(root, "task worktree");
    mkdirSync(wt);
    copyInclude(repo, wt, preview);
    expect(existsSync(join(wt, ".env"))).toBe(true);
    expect(existsSync(join(wt, "big.bin"))).toBe(false);
    expect(existsSync(join(wt, "linked"))).toBe(false);
  });
});

// ---------------------------------------------------------------- with the orchestrator

const running: FakeStep = { emit: { type: "run.state", state: "running" } };
const quick = (role: string): FakeStep[] => [running, { emit: { type: "message.delta", text: `${role} done` } }];
const waitAnswer = (id: string): FakeStep[] => [running, { emit: { type: "request.question", requestId: id, questions: [{ prompt: "Which?", options: [{ label: "a" }], allowFreeText: false }] } }, { awaitAnswer: id }];
const TASK = { title: "Fix typo in the login error message", description: "" };

async function project(bootstrap: Partial<ProjectConfig["bootstrap"]>, pick: (role: string, req: StartRequest) => FakeStep[] = quick) {
  const root = tempDir("crewyard bootstrap test-");
  const repo = await tempRepo(root);
  writeFileSync(join(repo, ".gitignore"), ".env\nnode_modules/\nsetup-ran.txt\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "ignore");
  writeFileSync(join(repo, ".env"), "SECRET_VALUE=do-not-log\n");
  const writeConfig = (b: Partial<ProjectConfig["bootstrap"]>) => {
    const cfg = defaultProjectConfig("demo repo", join(root, ".mc", "worktrees", "demo repo"));
    cfg.bootstrap = { ...cfg.bootstrap, ...b };
    mkdirSync(join(repo, ".crewyard"), { recursive: true });
    writeFileSync(join(repo, ".crewyard", "project.json"), JSON.stringify(cfg));
  };
  writeConfig(bootstrap);
  const store = new Store(join(root, "t.db"));
  const proj = store.addProject(repo, "demo repo");
  const adapter = new ScriptedAdapter((role, req) => pick(role, req));
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const o = new Orchestrator({
    store,
    dataDir: join(root, "data"),
    emit: () => {},
    adapters,
    directory: { candidates: () => CANDIDATES(), envFor: () => ({}) },
    tickMs: 0,
    freeMemoryMb: () => 64_000,
    stopTimeoutMs: 2_000,
  });
  o.start();
  open.push({ o, store });
  const start = async () => {
    const t = await o.propose({ projectId: proj.id, ...TASK });
    await o.approve({ taskId: t.id });
    return t.id;
  };
  const bootRequests = (taskId: string) => o.requests({ taskId }).filter((q): q is RequestView & { payload: { kind: "approval" } } => q.payload.kind === "approval" && Boolean(q.payload.bootstrap));
  return { o, store, repo, root, adapter, project: proj, start, bootRequests, writeConfig };
}

describe("worktree bootstrap", () => {
  it("asks once per command hash, holds the run, then copies, sets up and passes the port and main checkout", async () => {
    const setup = nodeStep("require('fs').writeFileSync('setup-ran.txt', process.env.PORT + ' ' + process.env.CREWYARD_PORT + '|' + process.env.CREWYARD_REPO)");
    const p = await project({ setup: [setup], include: [".env"], port: { from: 5000, to: 5099, envVar: "PORT" } });
    const taskId = await p.start();
    const [q] = await waitFor(() => (p.bootRequests(taskId).length > 0 ? p.bootRequests(taskId) : null));
    expect(q).toMatchObject({ risk: "high", payload: { command: setup.command, bootstrap: { phase: "setup", hash: commandHash(setup.command) } } });
    // Nothing starts and nothing runs until the Inbox answers.
    expect(p.adapter.started.filter((s) => s.role === "implementer")).toEqual([]);
    const wt = p.o.get(taskId).worktree!.path;
    expect(existsSync(join(wt, "setup-ran.txt"))).toBe(false);
    await expect(p.o.answer(q!.id, { kind: "approval", decision: "allow_always" })).rejects.toThrow("request.always_high_risk");

    await p.o.answer(q!.id, { kind: "approval", decision: "allow_once" });
    const impl = await waitFor(() => p.adapter.started.find((s) => s.role === "implementer"));
    const port = Number(impl.req.env?.PORT);
    expect(port).toBeGreaterThanOrEqual(5000);
    expect(port).toBeLessThanOrEqual(5099);
    expect(impl.req.env?.CREWYARD_PORT).toBe(String(port));
    // Setup steps and the agent both get the main checkout, so a step can read from it.
    expect(impl.req.env?.CREWYARD_REPO).toBe(p.repo);
    expect(readFileSync(join(wt, "setup-ran.txt"), "utf8")).toBe(`${port} ${port}|${p.repo}`);
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("SECRET_VALUE=do-not-log\n");
    const events = p.store.db.prepare("select kind, payload from events").all() as Array<{ kind: string; payload: string }>;
    expect(events.find((e) => e.kind === "worktree.include_copied")?.payload).toContain(".env");
    expect(events.map((e) => e.payload).join("\n")).not.toContain("do-not-log");
    await waitFor(() => p.o.get(taskId).status === "review");

    // The same text is approved for the project from now on.
    const second = await p.start();
    await waitFor(() => p.o.get(second).status === "review");
    expect(p.bootRequests(second)).toEqual([]);

    // One changed character asks again.
    p.writeConfig({ setup: [nodeStep("require('fs').writeFileSync('setup-ran.txt', 'v2')")], include: [".env"], port: { from: 5000, to: 5099, envVar: "PORT" } });
    const third = await p.start();
    await waitFor(() => p.bootRequests(third).length > 0);
  });

  it("blocks the start on a failed setup and keeps its log tail", async () => {
    const failing = nodeStep("console.log('installing'); console.error('boom: lockfile out of date'); process.exit(3)");
    const p = await project({ setup: [failing] });
    const taskId = await p.start();
    const [q] = await waitFor(() => (p.bootRequests(taskId).length > 0 ? p.bootRequests(taskId) : null));
    await p.o.answer(q!.id, { kind: "approval", decision: "allow_once" });
    const failed = await waitFor(() => p.o.get(taskId).runs.find((r) => r.endDetail === "bootstrap.setup_failed"));
    expect(failed.endReason).toBe("failed");
    expect(p.adapter.started.filter((s) => s.role === "implementer")).toEqual([]);
    const disk = await p.o.bootstrap.disk(p.project.id);
    expect(disk.items[0]).toMatchObject({ state: "failed", failure: { command: failing.command, code: 3, timedOut: false } });
    expect(disk.items[0]!.failure!.tail).toContain("boom: lockfile out of date");
    expect(disk.items[0]!.failure!.tail).toContain("installing");
  });

  it("times a step out and kills it", async () => {
    const p = await project({ setup: [nodeStep("setTimeout(() => {}, 60000)", 1)] });
    const taskId = await p.start();
    const [q] = await waitFor(() => (p.bootRequests(taskId).length > 0 ? p.bootRequests(taskId) : null));
    await p.o.answer(q!.id, { kind: "approval", decision: "allow_once" });
    await waitFor(() => p.o.get(taskId).runs.find((r) => r.endDetail === "bootstrap.setup_failed"), 15_000);
    expect((await p.o.bootstrap.disk(p.project.id)).items[0]!.failure).toMatchObject({ code: null, timedOut: true });
  });

  it("fails the run when a setup step is denied", async () => {
    const p = await project({ setup: [nodeStep("1")] });
    const taskId = await p.start();
    const [q] = await waitFor(() => (p.bootRequests(taskId).length > 0 ? p.bootRequests(taskId) : null));
    await p.o.answer(q!.id, { kind: "approval", decision: "deny" });
    await waitFor(() => p.o.get(taskId).runs.find((r) => r.endDetail === "bootstrap.denied"));
    expect(p.adapter.started.filter((s) => s.role === "implementer")).toEqual([]);
  });

  it("parks only when nothing runs: commits WIP, removes the folder, keeps the branch, and resumes", async () => {
    let block = true;
    const p = await project({}, (role) => (role === "implementer" && block ? waitAnswer("q1") : quick(role)));
    const taskId = await p.start();
    const q = await waitFor(() => p.o.requests({ taskId }).find((r) => r.kind === "question"));
    const wt = p.o.get(taskId).worktree!;
    await expect(p.o.bootstrap.park(taskId)).rejects.toThrow("worktree.running");
    expect(existsSync(wt.path)).toBe(true);
    block = false;
    await p.o.answer(q.id, { kind: "question", answers: [{ selected: ["a"] }] });
    await waitFor(() => p.o.get(taskId).status === "review");

    writeFileSync(join(wt.path, "notes in progress.txt"), "half done");
    mkdirSync(join(wt.path, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(wt.path, "node_modules", "pkg", "index.js"), "x");
    const before = (await p.o.bootstrap.disk(p.project.id)).items[0]!;
    expect(before.bytes).toBeGreaterThan(0);

    const parked = await p.o.bootstrap.park(taskId);
    expect(parked).toMatchObject({ state: "parked", bytes: null });
    expect(parked.parkedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(wt.path)).toBe(false);
    expect((await git(p.repo, "rev-parse", "--verify", wt.branch)).trim()).toBe(parked.parkedSha);
    expect(await git(p.repo, "show", "--name-only", "--format=%s", wt.branch)).toContain("notes in progress.txt");
    expect(await git(p.repo, "worktree", "list")).not.toContain(wt.path.replace(/\\/g, "/"));
    await expect(p.o.bootstrap.park(taskId)).rejects.toThrow("worktree.parked");

    const back = await p.o.bootstrap.unpark(taskId);
    expect(back.state).toBe("pending");
    expect(readFileSync(join(wt.path, "notes in progress.txt"), "utf8")).toBe("half done");
    await expect(p.o.bootstrap.unpark(taskId)).rejects.toThrow("worktree.not_parked");
  });

  it("keeps the worktree when cleanup fails or is not approved yet", async () => {
    const cleanup = nodeStep("console.error('cannot stop the container'); process.exit(2)");
    const p = await project({ cleanup: [cleanup] });
    const taskId = await p.start();
    // Cleanup is asked for at the start too, so removal never meets an unknown command.
    const [q] = await waitFor(() => (p.bootRequests(taskId).length > 0 ? p.bootRequests(taskId) : null));
    expect(q!.payload).toMatchObject({ bootstrap: { phase: "cleanup" } });
    await p.o.answer(q!.id, { kind: "approval", decision: "allow_once" });
    await waitFor(() => p.o.get(taskId).status === "review");
    const wt = p.o.get(taskId).worktree!;

    await expect(p.o.bootstrap.park(taskId)).rejects.toThrow("worktree.cleanup_failed");
    expect(existsSync(wt.path)).toBe(true);
    expect((await p.o.bootstrap.disk(p.project.id)).items[0]!.failure!.tail).toContain("cannot stop the container");

    // A changed cleanup command waits in the Inbox (with no run) and the worktree stays.
    p.writeConfig({ cleanup: [nodeStep("process.exit(0)")] });
    await expect(p.o.bootstrap.cleanupAt(p.project.id, wt.path)).rejects.toThrow("worktree.cleanup_needs_approval");
    const asked = p.bootRequests(taskId).find((r) => !r.answeredAt)!;
    expect(asked).toMatchObject({ runId: null, payload: { bootstrap: { phase: "cleanup" } } });
    await p.o.answer(asked.id, { kind: "approval", decision: "allow_once" });
    await p.o.bootstrap.cleanupAt(p.project.id, wt.path);
    expect(existsSync(wt.path)).toBe(true);
  });
});
