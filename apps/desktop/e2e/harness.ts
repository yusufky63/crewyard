import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import type { FakeStep } from "@crewyard/adapter-fake";

// Launches the built app (out/) the way screenshot mode does: a throwaway profile under %TEMP%,
// fake runners only (CREWYARD_E2E, packages/daemon/src/e2e), and a cleanup that kills the whole
// process tree and removes every temp folder, also after a failed test.

const appDir = resolve(import.meta.dirname, "..");
const electronExe = createRequire(join(appDir, "package.json"))("electron") as unknown as string;

/** Same shape as packages/daemon/src/e2e: the n-th run of a role plays the n-th script. */
export type Scripts = Record<string, FakeStep[][]>;

export interface Harness {
  app: ElectronApplication;
  page: Page;
  root: string;
  /** A git repository whose path has spaces in it, as the Windows rules ask. */
  repo: string;
  setScripts(scripts: Scripts): void;
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

export async function launch(): Promise<Harness> {
  // The "shoot-" prefix also lets the machine's scheduled headless cleanup sweep a crashed run.
  const root = mkdtempSync(join(tmpdir(), "shoot-crewyard-e2e "));
  const profile = join(root, "profile");
  const script = join(root, "script.json");
  const setScripts = (scripts: Scripts) => writeFileSync(script, JSON.stringify({ scripts }));
  setScripts({});
  const repo = makeRepo(root);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ELECTRON_RENDERER_URL" && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      executablePath: electronExe,
      args: [appDir],
      env: { ...env, CREWYARD_E2E: "1", CREWYARD_E2E_SCRIPT: script, CREWYARD_E2E_PROFILE: profile },
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
