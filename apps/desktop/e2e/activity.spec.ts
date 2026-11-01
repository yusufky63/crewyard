import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { daemon, launch, running, say, type Harness, composerMode } from "./harness.ts";

// The bottom panel's Events and Logs tabs (DESIGN.md §4) against scripted runners: Ctrl J and
// the status bar toggle, the live event feed with its filters, paging and "Show all", the redacted
// Logs tab, Esc order, the splitter by keyboard and by pointer, and the height and the collapsed
// strip surviving a reload. Screenshots land in apps/desktop/screens/activity (git-ignored) for the
// dark and light, 960 / 1280 / 1920 px check.

test.describe.configure({ mode: "serial" });

let h: Harness;
const shots = join(import.meta.dirname, "..", "screens", "activity");

test.beforeAll(async () => {
  h = await launch();
  mkdirSync(shots, { recursive: true });
});

test.afterAll(async () => {
  await h?.close();
});

const drawer = (page: Page) => page.getByRole("region", { name: "Panel", exact: true });
const toggle = (page: Page) => page.locator("#activity-toggle");
/** The panel's own collapse toggle, at the right end of its head. */
const headToggle = (page: Page) => page.locator("#drawer-toggle");
/** The view under the tabs, there only while the panel is expanded. */
const body = (page: Page) => drawer(page).getByRole("tabpanel");

async function startTask(title: string) {
  const { page } = h;
  await page.locator("#app-sidebar").getByRole("button", { name: "Tasks", exact: true }).click();
  const main = page.locator("main");
  await composerMode(page, "Crew");
  await main.getByLabel("New task").fill(title);
  await main.getByLabel("Kind").selectOption("research");
  await main.getByRole("button", { name: "Propose crew" }).click();
  await main.getByRole("region", { name: /Suggested crew for/ }).getByRole("button", { name: "Approve and start" }).click();
  await expect.poll(async () => (await daemon<Array<{ title: string; status: string }>>(page, "tasks.list", {})).find((t) => t.title === title)?.status, { timeout: 20_000 }).toBe("done");
}

/** Window content size and theme for a screenshot; the theme goes through the status bar button. */
async function look(page: Page, width: number, theme: "dark" | "light") {
  await h.app.evaluate(({ BrowserWindow }, [w]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, 900), [width]);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
  const html = page.locator("html");
  for (let i = 0; i < 3 && (await html.getAttribute("data-theme")) !== theme; i++) await page.locator(".statusbar").getByTitle(/theme/i).click();
  await expect(html).toHaveAttribute("data-theme", theme);
}

test("opens a project and runs a task whose output needs the drawer", async () => {
  const { page, repo } = h;
  const start = page.getByRole("region", { name: "Start" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.getByRole("button", { name: "Open folder" }).click();
  await start.locator("button.ptile", { hasText: basename(repo) }).click();
  await expect(page.locator("#app-sidebar")).toBeVisible();
  // Collapsed to its head strip by default, and both toggles say so.
  await expect(drawer(page)).toBeVisible();
  await expect(body(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(headToggle(page)).toHaveAttribute("aria-expanded", "false");

  h.setScripts({
    researcher: [
      [
        running,
        say("Reading the repository."),
        { emit: { type: "tool.call", toolCallId: "c1", title: "<b>Read README.md</b>", kind: "read", input: { path: "README.md" } } },
        { emit: { type: "tool.update", toolCallId: "c1", status: "completed", output: `${"line of output\n".repeat(200)}END OF OUTPUT` } },
        { emit: { type: "run.ended", reason: "completed" } },
      ],
    ],
  });
  await startTask("Survey the docs folder");
});

test("Ctrl J opens the drawer on Events with the newest first, untrusted text as text", async () => {
  const { page } = h;
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+j");
  const d = drawer(page);
  await expect(body(page)).toBeVisible();
  await expect(d.getByRole("tab", { name: "Events" })).toBeFocused();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  const list = d.getByRole("list", { name: "Events, newest first" });
  await expect(list.getByText("<b>Read README.md</b>")).toBeVisible();
  // The title stays text: no element came from it.
  await expect(d.locator("b")).toHaveCount(0);
  // Streamed text is left out until asked for.
  await expect(list.getByText("run.message.delta")).toHaveCount(0);
  await d.getByLabel("Streamed text").check();
  await expect(list.getByText("run.message.delta")).toBeVisible();
  await d.getByLabel("Streamed text").uncheck();
});

test("filters by kind and shows a cut output in full on request", async () => {
  const { page } = h;
  const d = drawer(page);
  await d.getByLabel("Kind", { exact: true }).selectOption("run.tool.update");
  const row = d.getByRole("listitem").filter({ hasText: "run.tool.update" });
  await expect(row).toHaveCount(1);
  await expect(row.getByText("END OF OUTPUT")).toHaveCount(0);
  await row.getByRole("button", { name: /Show the whole run.tool.update event/ }).click();
  await expect(row.getByLabel("Whole run.tool.update event")).toContainText("END OF OUTPUT");
  await row.getByRole("button", { name: "Show less" }).click();
  await d.getByRole("button", { name: "Clear filters" }).click();
  await expect(d.getByLabel("Kind", { exact: true })).toHaveValue("");
});

test("new events arrive on the newest page without a reload", async () => {
  const { page } = h;
  h.setScripts({ researcher: [[running, { emit: { type: "tool.call", toolCallId: "c2", title: "Search for TODO", kind: "search", input: {} } }, { wait: 200 }]] });
  await startTask("Find open TODOs");
  // The drawer stayed open across screens and runs; the batch refresh brings the new row in.
  await expect(drawer(page).getByText("Search for TODO")).toBeVisible();
  await look(page, 1280, "dark");
  await page.screenshot({ path: join(shots, "events-dark-1280.png") });
});

test("filters by task and run, and pages back to the newest", async () => {
  const { page } = h;
  const d = drawer(page);
  await d.getByLabel("Task", { exact: true }).selectOption({ label: "Survey the docs folder" });
  await expect(d.getByText("Search for TODO")).toHaveCount(0);
  await expect(d.getByText("<b>Read README.md</b>")).toBeVisible();
  const runOption = d.getByLabel("Run", { exact: true }).locator("option").nth(1);
  await d.getByLabel("Run", { exact: true }).selectOption((await runOption.getAttribute("value"))!);
  await expect(d.getByLabel("Task", { exact: true })).not.toHaveValue("");
  await expect(d.getByRole("button", { name: "Newer" })).toBeDisabled();
  await d.getByRole("button", { name: "Clear filters" }).click();
});

test("Logs tab shows Crewyard's own lines, newest first", async () => {
  const { page } = h;
  const d = drawer(page);
  await d.getByRole("tab", { name: "Events" }).focus();
  // Tabs follow the WAI-ARIA pattern: the arrow key moves and selects.
  await page.keyboard.press("ArrowRight");
  await expect(d.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
  const lines = d.getByRole("list", { name: "Log lines, newest first" });
  await expect(lines.getByText(/Daemon starting/)).toBeVisible();
  await expect(lines.getByText(/Crewyard .* starting on/)).toBeVisible();
  await d.getByLabel("Source", { exact: true }).selectOption("updater");
  await expect(lines.getByText(/Daemon starting/)).toHaveCount(0);
  await d.getByLabel("Source", { exact: true }).selectOption("all");
  await look(page, 1280, "light");
  await page.screenshot({ path: join(shots, "logs-light-1280.png") });
});

test("Esc inside the drawer collapses it first and returns focus; collapsing stops nothing", async () => {
  const { page } = h;
  const d = drawer(page);
  await d.getByRole("tab", { name: "Logs" }).focus();
  await page.keyboard.press("Escape");
  await expect(body(page)).toHaveCount(0);
  await expect(d).toBeVisible();
  await expect(headToggle(page)).toBeFocused();
  await expect(page.locator("#app-sidebar")).toBeVisible();
  // The status bar item expands and collapses it too, and keeps focus where you clicked.
  await toggle(page).click();
  await expect(body(page)).toBeVisible();
  await expect(toggle(page)).toBeFocused();
  await toggle(page).click();
  await expect(body(page)).toHaveCount(0);
  await toggle(page).click();
  await expect(body(page)).toBeVisible();
  await page.keyboard.press("Control+j");
  await expect(body(page)).toHaveCount(0);
  await page.keyboard.press("Control+j");
  await expect(body(page)).toBeVisible();
});

test("the splitter resizes by keyboard, Enter collapses, and the height and the strip survive a reload", async () => {
  const { page } = h;
  const sep = page.getByRole("separator", { name: "Resize the panel" });
  await expect(sep).toHaveAttribute("aria-orientation", "horizontal");
  await sep.focus();
  await expect(sep).toHaveAttribute("aria-valuenow", "280");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(sep).toHaveAttribute("aria-valuenow", "312");
  const box = await drawer(page).boundingBox();
  expect(Math.round(box!.height)).toBe(312);
  await page.reload();
  // The open project is not kept across a reload; the drawer's state and height are.
  await page.getByRole("region", { name: "Start" }).locator("button.ptile", { hasText: basename(h.repo) }).click();
  await expect(drawer(page)).toBeVisible();
  // The stored height is on <html> before the first render, so the drawer opens at it.
  expect(Math.round((await drawer(page).boundingBox())!.height)).toBe(312);
  await page.getByRole("separator", { name: "Resize the panel" }).focus();
  await page.keyboard.press("Enter");
  // Enter collapses to the strip; the handle stays and keeps focus, and reports the strip's height.
  await expect(body(page)).toHaveCount(0);
  await expect(page.getByRole("separator", { name: "Resize the panel" })).toBeFocused();
  await expect(page.getByRole("separator", { name: "Resize the panel" })).toHaveAttribute("aria-valuenow", "36");
  expect(Math.round((await drawer(page).boundingBox())!.height)).toBeLessThanOrEqual(40);
  // Collapsed survives a reload too, applied before the first paint.
  await page.reload();
  await page.getByRole("region", { name: "Start" }).locator("button.ptile", { hasText: basename(h.repo) }).click();
  await expect(drawer(page)).toBeVisible();
  await expect(body(page)).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-drawer", "collapsed");
  // Up on the handle expands it again to the height it had.
  await page.getByRole("separator", { name: "Resize the panel" }).focus();
  await page.keyboard.press("ArrowUp");
  await expect(body(page)).toBeVisible();
  expect(Math.round((await drawer(page).boundingBox())!.height)).toBe(312);
  const again = page.getByRole("separator", { name: "Resize the panel" });
  await again.focus();
  await page.keyboard.press("Home");
  await expect(again).toHaveAttribute("aria-valuenow", "160");
  // Double-click returns to the default height.
  await again.dblclick();
  await expect(again).toHaveAttribute("aria-valuenow", "280");
});

test("dragging the edge under 96 px collapses to the strip, and dragging the strip up expands it", async () => {
  const { page } = h;
  const sep = page.getByRole("separator", { name: "Resize the panel" });
  await expect(body(page)).toBeVisible();
  const pane = (await drawer(page).boundingBox())!;
  const floor = pane.y + pane.height;
  const height = async () => Math.round((await drawer(page).boundingBox())!.height);
  /** Presses on the handle and drags it to `y`, in steps, as a hand would. */
  const dragTo = async (y: number) => {
    const handle = (await sep.boundingBox())!;
    const x = handle.x + handle.width / 2;
    await page.mouse.move(x, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 10 });
    await page.mouse.up();
  };

  // Down to 60 px above the status bar: under 96 px, so it collapses to the strip and stops nothing.
  await dragTo(floor - 60);
  await expect(body(page)).toHaveCount(0);
  await expect(headToggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(sep).toHaveAttribute("aria-valuenow", "36");
  expect(await height()).toBeLessThanOrEqual(40);

  // Up from the strip to 120 px: above 96 px it expands, and never under its 160 px minimum.
  await dragTo(floor - 120);
  await expect(body(page)).toBeVisible();
  await expect(headToggle(page)).toHaveAttribute("aria-expanded", "true");
  expect(await height()).toBe(160);

  // Up to 300 px: it follows the pointer.
  await dragTo(floor - 300);
  await expect.poll(height).toBeGreaterThanOrEqual(290);
  expect(await height()).toBeLessThanOrEqual(310);
  await sep.dblclick();
  await expect(sep).toHaveAttribute("aria-valuenow", "280");
});

test("screenshots in dark and light at 960, 1280 and 1920 px", async () => {
  const { page } = h;
  for (const width of [960, 1280, 1920]) {
    for (const theme of ["dark", "light"] as const) {
      await look(page, width, theme);
      for (const tab of ["Events", "Logs"]) {
        await drawer(page).getByRole("tab", { name: tab }).click();
        await page.screenshot({ path: join(shots, `${tab.toLowerCase()}-${theme}-${width}.png`) });
      }
    }
  }
});
