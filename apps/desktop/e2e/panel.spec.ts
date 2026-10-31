import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { daemon, launch, running, type Harness } from "./harness.ts";

// The bottom panel (DESIGN.md §4): five tabs after the WAI-ARIA tabs pattern, a real shell in the
// Terminal tab (docs/adr/0016-terminal.md) that sees none of Crewyard's variables and survives the
// panel being hidden, and a Problems row followed to its fix. Screenshots land in
// apps/desktop/screens/panel (git-ignored) for the dark and light, 1280 and 1920 px check.

test.describe.configure({ mode: "serial" });

let h: Harness;
const shots = join(import.meta.dirname, "..", "screens", "panel");
const TASK = "Survey the build scripts";

test.beforeAll(async () => {
  h = await launch();
  mkdirSync(shots, { recursive: true });
});

test.afterAll(async () => {
  await h?.close();
});

const panel = (page: Page) => page.getByRole("region", { name: "Panel", exact: true });
const tab = (page: Page, name: string) => panel(page).getByRole("tablist", { name: "Panel views" }).getByRole("tab", { name: new RegExp(`^${name}`) });
const screen = (page: Page) => panel(page).locator(".term-view .xterm-rows");

async function look(page: Page, width: number, theme: "dark" | "light") {
  await h.app.evaluate(({ BrowserWindow }, [w]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, 900), [width]);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
  const html = page.locator("html");
  for (let i = 0; i < 3 && (await html.getAttribute("data-theme")) !== theme; i++) await page.locator(".statusbar").getByTitle(/theme/i).click();
  await expect(html).toHaveAttribute("data-theme", theme);
}

/** Types a line into the focused terminal and presses Enter. */
async function run(page: Page, line: string) {
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

test("opens a project whose research run fails with a provider error", async () => {
  const { page, repo } = h;
  const start = page.getByRole("region", { name: "Start" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.getByRole("button", { name: "Open folder" }).click();
  await start.locator("button.ptile", { hasText: basename(repo) }).click();
  await expect(page.locator("#app-sidebar")).toBeVisible();
  await expect(panel(page)).toHaveCount(0);

  h.setScripts({ researcher: [[running, { emit: { type: "run.ended", reason: "failed", detail: 'API Error: 402 {"error":{"message":"Insufficient Balance"}}' } }]] });
  const main = page.locator("main");
  await main.getByLabel("New task").fill(TASK);
  await main.getByLabel("Kind").selectOption("research");
  await main.getByRole("button", { name: "Propose crew" }).click();
  await main.getByRole("region", { name: /Suggested crew for/ }).getByRole("button", { name: "Approve and start" }).click();
  await expect.poll(async () => (await daemon<Array<{ title: string; status: string }>>(page, "tasks.list", {})).find((t) => t.title === TASK)?.status, { timeout: 20_000 }).toBe("failed");
});

test("Ctrl J opens the panel; arrows, Home and End move through all five tabs", async () => {
  const { page } = h;
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+j");
  await expect(panel(page)).toBeVisible();
  const names = ["Assistant", "Terminal", "Events", "Logs", "Problems"];
  await expect(panel(page).getByRole("tablist", { name: "Panel views" }).getByRole("tab")).toHaveCount(5);
  await tab(page, "Events").focus();
  await page.keyboard.press("Home");
  for (const [i, name] of names.entries()) {
    if (i > 0) await page.keyboard.press("ArrowRight");
    await expect(tab(page, name)).toBeFocused();
    await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
  }
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Assistant")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(tab(page, "Problems")).toHaveAttribute("aria-selected", "true");
  await expect(panel(page).getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "drawer-tab-problems");

  // Each tab shows its own view.
  await tab(page, "Assistant").click();
  await expect(panel(page).getByRole("region", { name: "Task assistant" })).toBeVisible();
  await tab(page, "Terminal").click();
  await expect(panel(page).getByRole("button", { name: "New terminal" })).toBeVisible();
  await expect(panel(page).getByText("No terminal is open in this project.")).toBeVisible();
  await tab(page, "Events").click();
  await expect(panel(page).getByRole("list", { name: "Events, newest first" })).toBeVisible();
  await tab(page, "Logs").click();
  await expect(panel(page).getByRole("list", { name: "Log lines, newest first" })).toBeVisible();
  await tab(page, "Problems").click();
  await expect(panel(page).getByRole("list", { name: "Problems, newest first" })).toBeVisible();
});

test("Ctrl Shift A opens the assistant tab on any screen; Esc in it stops and closes", async () => {
  const { page } = h;
  await page.locator("#app-sidebar").getByRole("button", { name: "Providers", exact: true }).click();
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+Shift+A");
  await expect(tab(page, "Assistant")).toHaveAttribute("aria-selected", "true");
  await expect(panel(page).getByLabel("Message to the task assistant")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator("#activity-toggle")).toBeFocused();
  await page.locator("#app-sidebar").getByRole("button", { name: "Tasks", exact: true }).click();
});

test("a terminal runs echo, never sees Crewyard's variables, and outlives a hidden panel", async () => {
  const { page } = h;
  await page.keyboard.press("Control+Shift+T");
  await expect(tab(page, "Terminal")).toHaveAttribute("aria-selected", "true");
  // Nothing started on its own.
  await expect(panel(page).getByRole("tablist", { name: "Terminals" })).toHaveCount(0);
  await panel(page).getByRole("button", { name: "New terminal" }).click();
  const term = panel(page).getByRole("tablist", { name: "Terminals" }).getByRole("tab");
  await expect(term).toHaveCount(1);
  await expect(term).toHaveText(/Windows PowerShell 1/);
  // PowerShell's prompt names the project folder, a path with spaces.
  await expect(screen(page)).toContainText(basename(h.repo), { timeout: 20_000 });
  await expect(panel(page).locator(".term-view .xterm-helper-textarea")).toBeFocused();
  await run(page, 'echo "crewyard-$(6*7)"');
  await expect(screen(page)).toContainText("crewyard-42");
  // The e2e run sets CREWYARD_E2E and friends; the shell must not have them.
  await run(page, 'echo "[e2e=$env:CREWYARD_E2E][run=$env:ELECTRON_RUN_AS_NODE][path=$([bool]$env:PATH)]"');
  await expect(screen(page)).toContainText("[e2e=][run=][path=True]");
  await expect(tab(page, "Terminal")).toContainText("1");

  // Esc goes to the shell, not to the panel.
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeVisible();

  // Hide the panel: the shell keeps running and keeps its screen.
  await page.keyboard.press("Control+j");
  await expect(panel(page)).toHaveCount(0);
  await page.keyboard.press("Control+j");
  await tab(page, "Terminal").click();
  await expect(screen(page)).toContainText("crewyard-42");
  await panel(page).locator(".term-view .xterm-screen").click();
  await run(page, 'echo "still-$(2+3)"');
  await expect(screen(page)).toContainText("still-5");

  for (const width of [1280, 1920]) {
    for (const theme of ["dark", "light"] as const) {
      await look(page, width, theme);
      await page.screenshot({ path: join(shots, `terminal-${theme}-${width}.png`) });
    }
  }

  // F6 leaves the terminal for its tab; Delete there asks before ending the running shell.
  await panel(page).locator(".term-view .xterm-screen").click();
  await page.keyboard.press("F6");
  await expect(term).toBeFocused();
  await page.keyboard.press("Delete");
  const confirm = panel(page).getByRole("alertdialog");
  await expect(confirm).toContainText("End this shell?");
  await confirm.getByRole("button", { name: "Keep it" }).click();
  await expect(term).toHaveCount(1);
  await term.focus();
  await page.keyboard.press("Delete");
  await panel(page).getByRole("alertdialog").getByRole("button", { name: "End shell" }).click();
  await expect(term).toHaveCount(0);
  await expect(panel(page).getByText("No terminal is open in this project.")).toBeVisible();
});

test("Problems lists the failed run with the provider's words and leads to its task", async () => {
  const { page } = h;
  await page.keyboard.press("Control+Shift+M");
  await expect(tab(page, "Problems")).toHaveAttribute("aria-selected", "true");
  const list = panel(page).getByRole("list", { name: "Problems, newest first" });
  const row = list.getByRole("listitem").filter({ hasText: TASK }).filter({ hasText: "failed" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText("402 · Insufficient Balance");
  await expect(tab(page, "Problems")).toContainText(/\d/);

  for (const width of [1280, 1920]) {
    for (const theme of ["dark", "light"] as const) {
      await look(page, width, theme);
      for (const name of ["Problems", "Assistant", "Events", "Logs"]) {
        await tab(page, name).click();
        await page.screenshot({ path: join(shots, `${name.toLowerCase()}-${theme}-${width}.png`) });
      }
    }
  }
  await look(page, 1280, "dark");
  await tab(page, "Problems").click();

  // Dismiss hides it until you ask to see it again.
  await row.getByRole("button", { name: /^Dismiss/ }).click();
  await expect(row).toHaveCount(0);
  await panel(page).getByRole("button", { name: /Show 1 dismissed/ }).click();
  await expect(row).toBeVisible();

  // Open task: the task is selected and its inspector shows the failed step.
  await row.getByRole("button", { name: "Open task" }).click();
  const inspector = page.locator("aside").filter({ hasText: TASK });
  await expect(inspector.first()).toBeVisible();
  await expect(inspector.first()).toContainText("Insufficient Balance");
});
