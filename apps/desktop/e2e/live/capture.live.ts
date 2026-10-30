import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { _electron as electron, test, type Page } from "@playwright/test";

// Screenshots of the built app over the data a live run left behind (packages/daemon/src/live).
// CREWYARD_LIVE_PROFILE is the run's "electron profile" folder: its data\ is the daemon's data
// folder, so Tasks, Inspector, Limits and GitHub show that run's tasks, spend and caps.
//
// The app is started in e2e mode only to point userData at that folder and keep tray, toasts,
// close-to-tray and the single-instance lock off. The script file is empty, so the fake runner
// starts nothing; the live profiles stay in the database and the screens read them from there.
// Run: pnpm --filter @crewyard/desktop exec playwright test -c e2e/live/playwright.live.config.ts

const profile = process.env.CREWYARD_LIVE_PROFILE;
const out = process.env.CREWYARD_LIVE_SHOTS ?? join(profile ?? ".", "shots");
const appDir = resolve(import.meta.dirname, "..", "..");
const electronExe = createRequire(join(appDir, "package.json"))("electron") as unknown as string;

const SIZES = [
  [1280, 800],
  [1920, 1080],
] as const;
const SCREENS = ["Tasks", "Inbox", "Crew graph", "Limits & usage", "GitHub"] as const;

test.skip(!profile, "CREWYARD_LIVE_PROFILE is not set");

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: join(out, `${name}.png`) });
}

for (const theme of ["dark", "light"] as const) {
  test(`live data, ${theme}`, async () => {
    test.setTimeout(180_000);
    mkdirSync(out, { recursive: true });
    const script = join(profile as string, "empty-script.json");
    writeFileSync(script, JSON.stringify({ profiles: [], scripts: {} }));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ELECTRON_RENDERER_URL" && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
    const app = await electron.launch({ executablePath: electronExe, args: [appDir], env: { ...env, CREWYARD_E2E: "1", CREWYARD_E2E_SCRIPT: script, CREWYARD_E2E_PROFILE: profile as string }, timeout: 60_000 });
    const pid = app.process().pid;
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await page.evaluate((t) => localStorage.setItem("crewyard:prefs", JSON.stringify({ state: { language: "en", theme: t }, version: 1 })), theme);
      await page.reload();
      await page.getByRole("region", { name: "Start" }).locator("button.ptile", { hasText: "e2e sample repo" }).click();
      const nav = page.locator("#app-sidebar");
      for (const [w, h] of SIZES) {
        await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0]?.setContentSize(width, height), [w, h] as const);
        for (const screen of SCREENS) {
          await nav.getByRole("button", { name: new RegExp(`^${screen}`) }).click();
          await shoot(page, `${theme}-${w}-${screen.split(" ")[0]!.toLowerCase()}`);
        }
        await nav.getByRole("button", { name: "Tasks", exact: true }).click();
        const rows = page.locator("button.tk-top-main");
        const count = await rows.count();
        for (let i = 0; i < Math.min(count, 3); i++) {
          await rows.nth(i).click();
          await shoot(page, `${theme}-${w}-inspector-${i + 1}`);
        }
      }
    } finally {
      await Promise.race([app.close().catch(() => undefined), new Promise((r) => setTimeout(r, 10_000))]);
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } catch {
        // already gone
      }
    }
  });
}
