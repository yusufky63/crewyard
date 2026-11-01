import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import type { FakeStep } from "@crewyard/adapter-fake";

// Launches the built app (out/) the way screenshot mode does: a throwaway profile under %TEMP%,
// fake runners only (CREWYARD_E2E, packages/daemon/src/e2e), and a cleanup that kills the whole
// process tree and removes every temp folder, also after a failed test.

const appDir = resolve(import.meta.dirname, "..");
const electronExe = createRequire(join(appDir, "package.json"))("electron") as unknown as string;

/** Same shape as packages/daemon/src/e2e: the n-th run of a role plays the n-th script. */
export type Scripts = Record<string, FakeStep[][]>;

/** A fake profile, as packages/daemon/src/e2e takes it; without a list the daemon uses its three defaults. */
export interface E2eProfile {
  id: string;
  alias: string;
  providerId: string;
  model: { id: string; name: string; family: null; context: number; output: number; cost: { input: number; output: number; cacheRead: number }; reasoning: boolean; openWeights: boolean; released: null };
}

/**
 * What a scripted run was started with, as packages/daemon/src/e2e logs it next to the script
 * (`script.runs.jsonl`, one JSON line per run, in start order).
 */
export interface RunRecord {
  key: string;
  role: string | null;
  resumed: boolean;
  writes: "none" | "worktree" | "docs";
  prompt: string;
}

export interface Harness {
  app: ElectronApplication;
  page: Page;
  root: string;
  /** A git repository whose path has spaces in it, as the Windows rules ask. */
  repo: string;
  setScripts(scripts: Scripts, profiles?: E2eProfile[]): void;
  /** Every run the daemon started so far, oldest first, with its prompt. */
  runs(): RunRecord[];
  close(): Promise<void>;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, windowsHide: true, stdio: "ignore" });
}

function makeRepo(parent: string): string {
  const repo = join(parent, "demo repo with spaces");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Crewyard E2E");
  git(repo, "config", "user.email", "e2e@crewyard.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "# demo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** `env` adds variables for this launch, such as CREWYARD_E2E_HOME for agent file discovery. */
export async function launch(opts: { env?: Record<string, string> } = {}): Promise<Harness> {
  // The "shoot-" prefix also lets the machine's scheduled headless cleanup sweep a crashed run.
  const root = mkdtempSync(join(tmpdir(), "shoot-crewyard-e2e "));
  const profile = join(root, "profile");
  const script = join(root, "script.json");
  const setScripts = (scripts: Scripts, profiles?: E2eProfile[]) => writeFileSync(script, JSON.stringify(profiles ? { scripts, profiles } : { scripts }));
  setScripts({});
  const repo = makeRepo(root);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ELECTRON_RENDERER_URL" && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      executablePath: electronExe,
      args: [appDir],
      env: { ...env, ...opts.env, CREWYARD_E2E: "1", CREWYARD_E2E_SCRIPT: script, CREWYARD_E2E_PROFILE: profile },
      timeout: 60_000,
    });
    const page = await app.firstWindow();
    // English and dark, whatever the machine's display language; the settings flow changes both.
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(() => localStorage.setItem("crewyard:prefs", JSON.stringify({ state: { language: "en", theme: "dark" }, version: 1 })));
    await page.reload();
    // The folder picker is a native dialog Playwright cannot click; it answers with the test repo.
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, repo);
    const opened = app;
    return {
      app: opened,
      page,
      root,
      repo,
      setScripts,
      runs: () => {
        const log = join(root, "script.runs.jsonl");
        if (!existsSync(log)) return [];
        return readFileSync(log, "utf8")
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as RunRecord);
      },
      async close() {
        const pid = opened.process().pid;
        await Promise.race([opened.close().catch(() => undefined), new Promise((r) => setTimeout(r, 10_000))]);
        killTree(pid);
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      },
    };
  } catch (err) {
    killTree(app?.process().pid);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    throw err;
  }
}

/** Calls the daemon through the preload bridge, for waiting on state the UI shows. */
export function daemon<T>(page: Page, method: string, params: unknown): Promise<T> {
  return page.evaluate(([m, p]) => (window as unknown as { crewyard: { call(m: string, p: unknown): Promise<unknown> } }).crewyard.call(m, p), [method, params] as const) as Promise<T>;
}

// Script steps, named after what the runner does.
export const running: FakeStep = { emit: { type: "run.state", state: "running" } };
export const say = (text: string): FakeStep => ({ emit: { type: "message.delta", text } });
export const hold = (id = "never"): FakeStep => ({ awaitAnswer: id });
export const question = (id: string, prompt: string, options: string[]): FakeStep[] => [
  { emit: { type: "request.question", requestId: id, questions: [{ prompt, options: options.map((label) => ({ label })), allowFreeText: false }] } },
  { awaitAnswer: id },
];
export const approval = (id: string, command: string): FakeStep[] => [
  { emit: { type: "request.approval", requestId: id, toolCallId: null, command, cwd: null, paths: [], network: false } },
  { awaitAnswer: id },
];
export const limitReached = (resetsAt: string): FakeStep => ({ emit: { type: "limit.update", window: "5h", usedPct: 100, resetsAt, provenance: "reported", reached: true } });
export const usage = (tokensIn: number, tokensOut = 0): FakeStep => ({
  emit: { type: "usage.update", tokensIn, tokensOut, cacheRead: 0, cacheWrite: 0, reasoning: 0, contextUsed: null, contextSize: null, costUsd: null, costProvenance: "unknown" },
});
/** Writes a file in the run's worktree, as an agent editing it would; pinHead commits it when the step completes. */
export const write = (path: string, text: string): FakeStep => ({ write: { path, text } });
/** The structured result the run ends with, checked against the run's schema (a verdict, findings, a goal plan). */
export const result = (value: unknown): FakeStep => ({ result: value });

/**
 * Picks how the composer runs the next submission. Orchestra is the default wherever a profile can
 * plan, which the fake profiles can; flows that propose one task pick Crew first. The project then
 * reopens on Crew, so picking it again is harmless.
 */
export async function composerMode(page: Page, mode: "Orchestra" | "Crew" | "Solo"): Promise<void> {
  const button = page.locator("main .tk-composer").getByRole("group", { name: "How to run" }).getByRole("button", { name: mode, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}
