import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { daemon, launch, running, say, type Harness, composerMode } from "./harness.ts";

// The Guide (How it works): reachable from Start before any project exists and with G W, its
// Getting started list reads real state, and its buttons go where they say. The rows asserted here
// have an answer fixed by the test itself (a fresh profile, a task this test writes and approves, a
// profile it adds), so a row that ignored the daemon would fail; the machine and GitHub rules depend
// on this computer and are covered by model.test.ts.

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
const badge = (label: string) => row(label).locator(".badge");
const SETTLED = /^(Done|Not yet|Needs a look|Unknown)$/;

async function openGuide() {
  await h.page.locator("#app-sidebar").getByRole("button", { name: "Guide" }).click();
  await expect(h.page.getByRole("heading", { name: "How it works", level: 1 })).toBeVisible();
}

test("opens from Start without a project and says what needs one", async () => {
  const { page } = h;
  await page.getByRole("button", { name: "New here? How it works" }).click();
  await expect(page.getByRole("heading", { name: "How it works", level: 1 })).toBeVisible();
  await expect(page.getByText("Most buttons here open a project screen")).toBeVisible();
  // A fresh profile has no project: the row says so and offers the way to make one.
  await expect(badge("A project open")).toHaveText("Not yet");
  await expect(row("A project open").getByRole("button", { name: "New project" })).toBeVisible();
  // Project buttons are off with their reason as text.
  const inboxTile = page.locator(".gd-step", { hasText: "Answer in the Inbox" });
  await expect(inboxTile.getByRole("button", { name: "Open Inbox" })).toBeDisabled();
  await expect(inboxTile.getByText("Open a project first")).toBeVisible();
  // The rows that depend on this computer settle on an answer instead of staying on Checking.
  await expect(badge("This machine can run tasks")).toHaveText(SETTLED, { timeout: 20_000 });
  await expect(badge("GitHub connected")).toHaveText(SETTLED, { timeout: 20_000 });

  await page.getByRole("button", { name: "Back to Start" }).click();
  await expect(page.getByRole("region", { name: "Start" })).toBeVisible();
  // G then W jumps there from Start too.
  await page.keyboard.press("g");
  await page.keyboard.press("w");
  await expect(page.getByRole("heading", { name: "How it works", level: 1 })).toBeVisible();
});

test("reads profiles and tasks from the daemon and follows its buttons", async () => {
  const { page } = h;
  await page.getByRole("button", { name: "Back to Start" }).click();
  const start = page.getByRole("region", { name: "Start" });
  await start.getByRole("button", { name: "Open folder" }).click();
  await start.locator("button.ptile", { hasText: basename(h.repo) }).click();
  await openGuide();
  await expect(badge("A project open")).toHaveText("Done");
  await expect(page.getByText("Most buttons here open a project screen")).toHaveCount(0);

  // The e2e runners are not profiles, so the store starts with none.
  await expect(badge("A profile ready to run")).toHaveText("Not yet");
  await expect(row("A profile ready to run").getByRole("button", { name: "Open Providers" })).toBeVisible();
  // A profile on a local provider needs no key or sign-in, so the daemon's answer turns the row Done.
  await daemon(page, "providers.profileCreate", { alias: "local-studio", runner: "opencode", providerId: "lmstudio", credentialId: null, defaultModel: null });
  await expect(badge("A profile ready to run")).toHaveText("Done");

  // No task yet: the row's button opens the composer in this project.
  await expect(badge("A first task")).toHaveText("Not yet");
  await expect(badge("A first approved crew")).toHaveText("Not yet");
  await row("A first task").getByRole("button", { name: "Write a task" }).click();
  await composerMode(page, "Crew");
  await page.getByLabel("New task").fill("Survey the logging setup\nList what each module logs.");
  await page.getByLabel("Kind").selectOption("research");
  await page.getByRole("button", { name: "Propose crew" }).click();
  await expect(page.getByRole("region", { name: /Suggested crew for/ })).toBeVisible();

  // Proposed is a first task but not an approved crew; the crew row offers that very proposal.
  await openGuide();
  await expect(badge("A first task")).toHaveText("Done");
  await expect(badge("A first approved crew")).toHaveText("Not yet");
  h.setScripts({ researcher: [[running, say("Logging is set up per module."), { wait: 100 }]] });
  await row("A first approved crew").getByRole("button", { name: "Open the proposal" }).click();
  const proposal = page.getByRole("region", { name: /Suggested crew for/ });
  await proposal.getByRole("button", { name: "Approve and start" }).click();
  await expect.poll(async () => (await daemon<Array<{ title: string; status: string }>>(page, "tasks.list", {})).find((t) => t.title === "Survey the logging setup")?.status).not.toBe("proposed");
  await openGuide();
  await expect(badge("A first approved crew")).toHaveText("Done");
});

test("answers from the running build and opens the keyboard map", async () => {
  const { page } = h;
  // The FAQ answers open from the keyboard.
  const faq = page.locator("details", { hasText: "Does closing a panel stop an agent?" });
  await faq.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(faq).toHaveAttribute("open", "");
  await expect(faq.getByText("keeps agents running")).toBeVisible();

  // The release answer describes this run: an unpackaged build, which is unsigned and never updates.
  const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
  const release = page.locator("details", { hasText: "Is this build signed, and does it update itself?" });
  await release.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(release.locator("p")).toHaveText(`Crewyard ${version} is not code-signed, so Windows SmartScreen warns about an unknown publisher when you install it. Only an installed copy of Crewyard updates itself. This one is a development build.`);

  // The keyboard tile opens the map, which lists the Guide's own jump.
  await page.getByRole("button", { name: "Open the keyboard map" }).click();
  const map = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(map.getByText("Guide (how it works)")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(map).toHaveCount(0);

  await page.locator(".gd-step", { hasText: "Answer in the Inbox" }).getByRole("button", { name: "Open Inbox" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});
