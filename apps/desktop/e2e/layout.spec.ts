import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import { launch, type Harness, composerMode } from "./harness.ts";

// The main view grows with the window (DESIGN.md §4). At every supported width, with the sidebar
// expanded and as a rail, no screen may scroll sideways: long paths and rows must shrink, grids
// must add or drop columns.

test.describe.configure({ mode: "serial" });

let h: Harness;

test.beforeAll(async () => {
  h = await launch();
  const start = h.page.getByRole("region", { name: "Start" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.getByRole("button", { name: "Open folder" }).click();
  await start.locator("button.ptile", { hasText: basename(h.repo) }).click();
  await expect(h.page.getByLabel("New goal")).toBeVisible();
  // A drafted crew puts the proposal tiles on the Tasks screen.
  await composerMode(h.page, "Crew");
  await h.page.getByLabel("New task").fill("Check the layout at every width");
  await h.page.getByRole("button", { name: "Propose crew" }).click();
  await expect(h.page.getByRole("region", { name: /Suggested crew for/ })).toBeVisible();
});

test.afterAll(async () => {
  await h?.close();
});

const WIDTHS = [960, 1280, 1920, 2560];
const SCREENS = ["Tasks", "Inbox", "Crew graph", "Limits & usage", "Providers", "GitHub", "Guide"];
/** A screen whose page title is not its sidebar name. */
const TITLES: Record<string, string> = { Guide: "How it works" };

async function resize(width: number): Promise<void> {
  await h.app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]!.setContentSize(w, 900), width);
  await expect.poll(() => h.page.evaluate(() => window.innerWidth)).toBe(width);
}

/** Widest sideways overflow of the page and of the main view, in px (0 when nothing scrolls). */
const overflow = () =>
  h.page.evaluate(() => {
    const main = document.querySelector("main");
    const page = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    return Math.max(page, main ? main.scrollWidth - main.clientWidth : 0);
  });

for (const sidebar of ["full", "rail"] as const) {
  test(`no screen scrolls sideways, sidebar ${sidebar}`, async () => {
    const { page } = h;
    const html = page.locator("html");
    if ((await html.getAttribute("data-sidebar")) !== sidebar) {
      await page.locator("main").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("Control+B");
    }
    for (const width of WIDTHS) {
      await resize(width);
      for (const name of SCREENS) {
        await page.locator("#app-sidebar").getByRole("button", { name: new RegExp(`^${name}`) }).click();
        await expect(page.getByRole("heading", { name: TITLES[name] ?? name, exact: true, level: 1 })).toBeVisible();
        expect(await overflow(), `${name} at ${width} px, sidebar ${sidebar}`).toBe(0);
      }
    }
  });
}

test("Settings does not scroll sideways", async () => {
  const { page } = h;
  // Settings has no sidebar, so it is opened once and the window resized under it.
  await page.locator("#app-sidebar").getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  for (const width of WIDTHS) {
    await resize(width);
    expect(await overflow(), `Settings at ${width} px`).toBe(0);
  }
});
