import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { daemon, launch, running, say, type Harness } from "./harness.ts";

// The bottom panel's Events and Logs tabs (DESIGN.md §4) against scripted runners: Ctrl J and
// the status bar toggle, the live event feed with its filters, paging and "Show all", the redacted
// Logs tab, Esc order, the splitter by keyboard, and the height surviving a reload. Screenshots land in
// apps/desktop/screens/activity (git-ignored) for the dark and light, 960 / 1280 / 1920 px check.

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

async function startTask(title: string) {
  const { page } = h;
  await page.locator("#app-sidebar").getByRole("button", { name: "Tasks", exact: true }).click();
  const main = page.locator("main");
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
  // Closed by default, and the toggle says so.
  await expect(drawer(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");

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
  await expect(d).toBeVisible();
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

test("Esc inside the drawer closes it first and returns focus; closing stops nothing", async () => {
  const { page } = h;
  const d = drawer(page);
  await d.getByRole("tab", { name: "Logs" }).focus();
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(toggle(page)).toBeFocused();
  await expect(page.locator("#app-sidebar")).toBeVisible();
  await toggle(page).click();
  await expect(drawer(page)).toBeVisible();
  await page.keyboard.press("Control+j");
  await expect(drawer(page)).toHaveCount(0);
  await page.keyboard.press("Control+j");
  await expect(drawer(page)).toBeVisible();
});

test("the splitter resizes by keyboard, Enter closes, and the height survives a reload", async () => {
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
  await expect(drawer(page)).toHaveCount(0);
  await page.keyboard.press("Control+j");
  await expect(drawer(page)).toBeVisible();
  const again = page.getByRole("separator", { name: "Resize the panel" });
  await again.focus();
  await page.keyboard.press("Home");
  await expect(again).toHaveAttribute("aria-valuenow", "160");
  // Double-click returns to the default height.
  await again.dblclick();
  await expect(again).toHaveAttribute("aria-valuenow", "280");
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
