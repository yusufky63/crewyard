import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { daemon, hold, launch, running, say, type Harness } from "./harness.ts";

// The bottom panel (DESIGN.md §4): five tabs after the WAI-ARIA tabs pattern, a toggle at the right
// end of its head that collapses it to that head strip and never closes it (owner, 2026-10-31), the
// assistant still running while it is collapsed, a real shell in the Terminal tab
// (docs/adr/0016-terminal.md) that sees none of Crewyard's variables and survives the panel being
// collapsed, and a Problems row followed to its fix. Screenshots land in
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
/** The collapse toggle in the panel's head; it stays in the strip. */
const headToggle = (page: Page) => panel(page).locator("#drawer-toggle");
/** The view under the tabs, there only while the panel is expanded. */
const body = (page: Page) => panel(page).getByRole("tabpanel");

/** Collapsed: the strip with its tabs stays, the view under it is gone. */
async function collapsed(page: Page) {
  await expect(panel(page)).toBeVisible();
  await expect(headToggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(body(page)).toHaveCount(0);
  await expect(panel(page).getByRole("tablist", { name: "Panel views" }).getByRole("tab")).toHaveCount(5);
}

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
  // Collapsed by default: only the head strip shows, and its toggle says so.
  await collapsed(page);
  expect(Math.round((await panel(page).boundingBox())!.height)).toBeLessThanOrEqual(40);

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
  await expect(headToggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(body(page)).toBeVisible();
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

test("Ctrl Shift A opens the assistant tab on any screen; Esc in it stops and collapses", async () => {
  const { page } = h;
  await page.locator("#app-sidebar").getByRole("button", { name: "Providers", exact: true }).click();
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+Shift+A");
  await expect(tab(page, "Assistant")).toHaveAttribute("aria-selected", "true");
  await expect(panel(page).getByLabel("Message to the task assistant")).toBeFocused();
  await page.keyboard.press("Escape");
  await collapsed(page);
  await expect(headToggle(page)).toBeFocused();
  await page.locator("#app-sidebar").getByRole("button", { name: "Tasks", exact: true }).click();
});

test("the head toggle collapses to the strip and expands; the assistant keeps running until Stop and close", async () => {
  const { page, repo } = h;
  const projectId = (await daemon<Array<{ id: string; path: string }>>(page, "projects.list", undefined)).find((p) => p.path.toLowerCase() === repo.toLowerCase())!.id;
  const state = async () => (await daemon<{ state: string }>(page, "assistant.get", { projectId })).state;
  // The assistant starts a reply and keeps working on it.
  h.setScripts({ assistant: [[{ emit: { type: "turn.started", turnRef: null } }, say("Reading the project for you."), hold()]] });
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+Shift+A");
  const box = panel(page).getByLabel("Message to the task assistant");
  await expect(box).toBeFocused();
  await box.fill("What should I work on next?");
  await box.press("Enter");
  await expect(panel(page).getByRole("log").getByText("Reading the project for you.")).toBeVisible({ timeout: 20_000 });
  await expect.poll(state).toBe("working");

  // The toggle sits at the right end of the head, says what it does and its shortcut.
  const toggleButton = headToggle(page);
  await expect(toggleButton).toHaveAttribute("aria-expanded", "true");
  // On the Assistant tab it leaves out Esc, which inside the assistant is the assistant's own stop.
  await expect(toggleButton).toHaveAttribute("title", /^Collapse the panel \(Ctrl.J\)\. The assistant keeps running\.$/);
  await expect(page.locator("#activity-toggle")).toHaveAttribute("title", /^Collapse the panel \(Ctrl.J\)\. The assistant keeps running\.$/);
  await expect(panel(page).locator(".drawer-note")).toHaveText("Collapsing keeps the assistant running; Stop and close, or Esc inside it, stops it.");
  await expect(toggleButton).toHaveAttribute("aria-keyshortcuts", /J$/);
  const head = (await panel(page).locator(".drawer-head").boundingBox())!;
  const at = (await toggleButton.boundingBox())!;
  expect(at.x + at.width).toBeGreaterThan(head.x + head.width - 16);
  const expandedHeight = Math.round((await panel(page).boundingBox())!.height);

  // Collapsing keeps the strip and stops nothing: the assistant is still working.
  await toggleButton.click();
  await collapsed(page);
  await expect(toggleButton).toHaveAttribute("title", /^Expand the panel: assistant, terminal, events, logs, problems/);
  await expect(page.locator("#activity-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.waitForTimeout(500);
  expect(await state()).toBe("working");
  await page.screenshot({ path: join(shots, "collapsed-dark-1280.png") });

  // The toggle expands it again to its last height, focus into the tab list.
  await toggleButton.click();
  await expect(body(page)).toBeVisible();
  await expect(tab(page, "Assistant")).toBeFocused();
  expect(Math.round((await panel(page).boundingBox())!.height)).toBe(expandedHeight);
  await expect(panel(page).getByRole("log").getByText("Reading the project for you.")).toBeVisible();

  // Keyboard: Esc on a tab collapses and puts focus on the toggle; Enter on it expands.
  await page.keyboard.press("Escape");
  await collapsed(page);
  await expect(toggleButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(body(page)).toBeVisible();
  await expect(tab(page, "Assistant")).toBeFocused();

  // Ctrl Shift A on the assistant collapses too, and still stops nothing; focus was on a tab, so it
  // goes to the toggle.
  await page.keyboard.press("Control+Shift+A");
  await collapsed(page);
  await expect(toggleButton).toBeFocused();
  expect(await state()).toBe("working");

  // The Tasks screen's button says it hides the assistant, and pressing it keeps focus on it.
  const opener = page.locator("#tk-assistant-toggle");
  await opener.click();
  await expect(body(page)).toBeVisible();
  await expect(opener).toHaveText("Hide assistant");
  await opener.click();
  await collapsed(page);
  await expect(opener).toBeFocused();
  await expect(opener).toHaveText("Assistant");
  expect(await state()).toBe("working");

  // A tab clicked in the strip expands the panel on that tab.
  await tab(page, "Events").click();
  await expect(body(page)).toBeVisible();
  await expect(tab(page, "Events")).toHaveAttribute("aria-selected", "true");
  await expect(panel(page).getByRole("list", { name: "Events, newest first" })).toBeVisible();

  // Only the assistant's own Stop and close stops it; the panel collapses to its strip.
  await tab(page, "Assistant").click();
  await panel(page).getByRole("button", { name: "Stop and close" }).click();
  await collapsed(page);
  await expect.poll(state).toBe("idle");
});

test("a terminal runs echo, never sees Crewyard's variables, and outlives a collapsed panel", async () => {
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

  // Collapse the panel: the shell keeps running and keeps its screen.
  await page.keyboard.press("Control+j");
  await collapsed(page);
  await expect(tab(page, "Terminal")).toContainText("1");
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
