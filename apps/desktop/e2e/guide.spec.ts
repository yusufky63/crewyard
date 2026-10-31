import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import { launch, type Harness } from "./harness.ts";

// The Guide (How it works): reachable from Start before any project exists and with G W, its
// Getting started list reads real state, and its buttons go where they say.

test.describe.configure({ mode: "serial" });

let h: Harness;

test.beforeAll(async () => {
  h = await launch();
  await expect(h.page.getByRole("region", { name: "Start" })).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await h?.close();
});

const row = (label: string) => h.page.locator(".gd-row", { hasText: label });

test("opens from Start without a project and says what needs one", async () => {
  const { page } = h;
  await page.getByRole("button", { name: "New here? How it works" }).click();
  await expect(page.getByRole("heading", { name: "How it works", level: 1 })).toBeVisible();
  await expect(page.getByText("Most buttons here open a project screen")).toBeVisible();
  // A fresh profile has no project: the row says so and offers the way to make one.
  await expect(row("A project open").locator(".badge")).toHaveText("Not yet");
  await expect(row("A project open").getByRole("button", { name: "New project" })).toBeVisible();
  // Project buttons are off with their reason as text.
  const inboxTile = page.locator(".gd-step", { hasText: "Answer in the Inbox" });
  await expect(inboxTile.getByRole("button", { name: "Open Inbox" })).toBeDisabled();
  await expect(inboxTile.getByText("Open a project first")).toBeVisible();

  await page.getByRole("button", { name: "Back to Start" }).click();
  await expect(page.getByRole("region", { name: "Start" })).toBeVisible();
  // G then W jumps there from Start too.
  await page.keyboard.press("g");
  await page.keyboard.press("w");
  await expect(page.getByRole("heading", { name: "How it works", level: 1 })).toBeVisible();
});

test("reads the open project and follows a button to its screen", async () => {
  const { page } = h;
  await page.getByRole("button", { name: "Back to Start" }).click();
  const start = page.getByRole("region", { name: "Start" });
  await start.getByRole("button", { name: "Open folder" }).click();
  await start.locator("button.ptile", { hasText: basename(h.repo) }).click();
  await page.locator("#app-sidebar").getByRole("button", { name: "Guide" }).click();
  await expect(page.getByRole("heading", { name: "How it works", level: 1 })).toBeVisible();
  await expect(row("A project open").locator(".badge")).toHaveText("Done");
  await expect(page.getByText("Most buttons here open a project screen")).toHaveCount(0);

  // The FAQ answers open from the keyboard.
  const faq = page.locator("details", { hasText: "Does closing a panel stop an agent?" });
  await faq.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(faq).toHaveAttribute("open", "");
  await expect(faq.getByText("keeps agents running")).toBeVisible();

  // The keyboard tile opens the map, which lists the Guide's own jump.
  await page.getByRole("button", { name: "Open the keyboard map" }).click();
  const map = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(map.getByText("Guide (how it works)")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(map).toHaveCount(0);

  await page.locator(".gd-step", { hasText: "Answer in the Inbox" }).getByRole("button", { name: "Open Inbox" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});
