import { basename } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { daemon, hold, launch, running, say, type Harness, composerMode } from "./harness.ts";

// Managing a crew in the Crew graph (PLAN.md §9 step 6) against scripted runners: a proposal is
// edited step by step (add a step, change its AI, its standby chain and what it waits for, by the
// edge's remove button and by the keyboard's checkbox, the standby badge's popover) and then
// approved from the task node's menu; a failed step is retried from its node menu; a waiting
// step's AI changes before its run and the task is cancelled from the task menu. Its own app
// instance, so app.spec.ts is unaffected.

test.describe.configure({ mode: "serial" });

let h: Harness;

test.beforeAll(async () => {
  h = await launch();
});

test.afterAll(async () => {
  await h?.close();
});

interface TaskView {
  id: string;
  title: string;
  status: string;
  crew: { members: Array<{ id: string; step: string; dependsOn: string[]; chosen: { profileId: string } | null; standby: Array<{ profileId: string }> }> } | null;
  runs: Array<{ memberId: string; endReason: string | null }>;
}

const taskByTitle = async (page: Page, title: string) => {
  const t = (await daemon<Array<{ id: string; title: string }>>(page, "tasks.list", {})).find((x) => x.title === title);
  return t ? daemon<TaskView>(page, "tasks.get", { taskId: t.id }) : null;
};

/** Proposes a research task; the composer selects it, so the Crew graph opens on it. */
async function propose(page: Page, title: string, onLimit?: string) {
  await page.locator("#app-sidebar").getByRole("button", { name: "Tasks", exact: true }).click();
  const main = page.locator("main");
  await composerMode(page, "Crew");
  await main.getByLabel("New task").fill(title);
  await main.getByLabel("Kind").selectOption("research");
  if (onLimit) await main.getByLabel("On limit").selectOption(onLimit);
  await main.getByRole("button", { name: "Propose crew" }).click();
  await expect(main.getByRole("region", { name: /Suggested crew for/ })).toBeVisible();
  await page.locator("#app-sidebar").getByRole("button", { name: "Crew graph" }).click();
  const screen = page.getByRole("region", { name: "Crew graph" });
  await expect(screen.locator(".crew-sub-title")).toHaveText(title);
  return screen;
}

test("opens a project", async () => {
  const { page, repo } = h;
  const start = page.getByRole("region", { name: "Start" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.getByRole("button", { name: "Open folder" }).click();
  await start.locator("button.ptile", { hasText: basename(repo) }).click();
  await expect(page.locator("#app-sidebar")).toBeVisible();
});

test("Crew graph: edits a proposal step by step and approves it", async () => {
  const { page } = h;
  h.setScripts({ researcher: [[running, say("Compared three libraries."), { wait: 200 }]], tester: [[running, say("Tests pass."), { wait: 200 }]] });
  const title = "Compare token bucket libraries";
  const screen = await propose(page, title);
  const bar = screen.getByRole("group", { name: "Crew" });
  await expect(bar).toContainText("Proposal");
  await expect(bar).toContainText("1 step");

  // Add a Test step after Research from the crew bar.
  await bar.getByRole("button", { name: "Add step" }).click();
  const add = page.getByRole("dialog", { name: "Add a step" });
  await add.getByLabel("Role").selectOption("tester");
  await add.getByLabel("Starts after").selectOption({ label: "01 Research" });
  await add.getByRole("button", { name: "Add step" }).click();
  await expect(add).toHaveCount(0);
  await expect(bar).toContainText("2 steps");
  await expect(screen.locator(".crew-live")).toContainText("Crew updated · forecast");

  // The new step's editor opened; pick another AI for it.
  const panel = screen.getByRole("complementary", { name: /^Edit 02 Test/ });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("radio").first()).toBeChecked();
  const before = (await taskByTitle(page, title))!.crew!.members[1]!;
  // The radio follows the crew as the daemon returns it, so click and wait for the stored change.
  await panel.getByRole("radio").nth(1).click();
  await expect.poll(async () => (await taskByTitle(page, title))!.crew!.members[1]!.chosen?.profileId).not.toBe(before.chosen?.profileId);
  // The profile it replaced leads the standby chain (three profiles: one in use, two standing by).
  const chain = panel.locator(".crew-chain-item");
  await expect(chain).toHaveCount(2);
  const order = (await taskByTitle(page, title))!.crew!.members[1]!.standby.map((s) => s.profileId);
  expect(order[0]).toBe(before.chosen?.profileId);
  // Alt+Up moves the focused one, the keyboard's way of dragging it into order.
  await chain.last().focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(async () => (await taskByTitle(page, title))!.crew!.members[1]!.standby.map((s) => s.profileId)).toEqual([order[1], order[0]]);

  // Remove the dependency by its edge's button, then draw it again with the keyboard's checkbox.
  await screen.getByRole("button", { name: /^Remove dependency: 02 Test/ }).click();
  await expect.poll(async () => (await taskByTitle(page, title))!.crew!.members[1]!.dependsOn).toEqual([]);
  await panel.getByRole("checkbox", { name: "01 Research" }).click();
  await expect.poll(async () => (await taskByTitle(page, title))!.crew!.members[1]!.dependsOn).toEqual(["researcher"]);
  // Making Research wait for Test would be a loop: its box is off and says why.
  // Esc closes the editor and gives the keyboard back to the step's tile.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(screen.locator('.crew-node[data-node^="m:"]').last()).toBeFocused();
  await screen.locator('.crew-node[data-node^="m:"]').first().click();
  const researchPanel = screen.getByRole("complementary", { name: /^Edit 01 Research/ });
  await expect(researchPanel.getByRole("checkbox", { name: "02 Test" })).toBeDisabled();
  await expect(researchPanel).toContainText("That would make a loop: 01 → 02 → 01");
  await researchPanel.getByRole("button", { name: "Close the step editor" }).click();

  // The Test step's standby chain is a badge on its tile, not a card of its own (owner, 2026-11-01).
  const testId = (await taskByTitle(page, title))!.crew!.members[1]!.id;
  await expect(screen.locator(".crew-node")).toHaveCount(3);
  const badge = screen.locator(`[data-standby="m:${testId}"]`);
  await expect(badge).toHaveText(/^Standby: .+\+1$/);
  await badge.click();
  const pop = page.getByRole("dialog", { name: "Standby for 02 Test" });
  await expect(pop.locator(".crew-pop-item")).toHaveCount(2);
  // Alt+Down on the focused first entry sends the step editor's own set_standby.
  await expect(pop.locator(".crew-pop-item").first()).toBeFocused();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(async () => (await taskByTitle(page, title))!.crew!.members[1]!.standby.map((s) => s.profileId)).toEqual([order[0], order[1]]);
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await expect(badge).toBeFocused();

  // Nothing started yet; the task node's menu (Menu key) approves the edited crew, as the crew bar does.
  expect((await taskByTitle(page, title))!.runs).toEqual([]);
  await screen.locator('.crew-node[data-node="task"]').focus();
  await page.keyboard.press("ContextMenu");
  const taskMenu = page.getByRole("menu", { name: /^Actions for Task/ });
  await expect(taskMenu.getByRole("menuitem", { name: "Open details" })).toBeVisible();
  await expect(taskMenu.getByRole("menuitem", { name: "Change AI for every step…" })).toBeVisible();
  await expect(taskMenu.getByRole("menuitem", { name: /^Cancel task…/ })).toHaveClass(/danger/);
  const approveItem = taskMenu.getByRole("menuitem", { name: "Approve and start" });
  await expect(approveItem).toHaveClass(/cmenu-ok/);
  // Open details has focus first; one arrow down reaches Approve and start.
  await expect(taskMenu.getByRole("menuitem", { name: "Open details" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(approveItem).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await taskByTitle(page, title))?.status, { timeout: 20_000 }).toBe("done");
  const done = (await taskByTitle(page, title))!;
  expect(done.crew!.members.map((m) => m.step)).toEqual(["researcher", "tester"]);
  expect(done.runs.filter((r) => r.endReason === "completed")).toHaveLength(2);
});

test("Crew graph: retries a failed step from its node menu", async () => {
  const { page } = h;
  // The first researcher run fails; the retry finishes.
  h.setScripts({ researcher: [[running, { emit: { type: "run.ended", reason: "failed", detail: "boom" } }], [running, say("Done on the second try."), { wait: 200 }]] });
  const title = "Benchmark the sliding window limiter";
  const screen = await propose(page, title, "manual");
  await screen.getByRole("group", { name: "Crew" }).getByRole("button", { name: "Approve and start" }).click();
  await expect.poll(async () => (await taskByTitle(page, title))?.runs[0]?.endReason, { timeout: 20_000 }).toBe("failed");

  const node = screen.locator('.crew-node[data-node^="m:"]').first();
  await expect(node).toContainText("Failed");
  // By keyboard: focus the tile and open its menu with Shift+F10.
  await node.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: /^Actions for / });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Open changes" })).toBeVisible();
  // Going again wears ok on its icon (DESIGN.md §3 "State colors on actions").
  await expect(menu.getByRole("menuitem", { name: "Retry step" })).toHaveClass(/cmenu-ok/);
  await menu.getByRole("menuitem", { name: "Retry step" }).click();
  await expect(screen.locator(".crew-live")).toContainText("again");
  await expect.poll(async () => (await taskByTitle(page, title))?.status, { timeout: 20_000 }).toBe("done");
});

test("Crew graph: changes a waiting step's AI and cancels the task from the task menu", async () => {
  const { page } = h;
  // The researcher holds, so the Test step after it waits with no run.
  h.setScripts({ researcher: [[running, hold()]], tester: [[running, say("Tests pass."), { wait: 200 }]] });
  const title = "Profile the sliding window limiter";
  const screen = await propose(page, title, "manual");
  const bar = screen.getByRole("group", { name: "Crew" });
  await bar.getByRole("button", { name: "Add step" }).click();
  const add = page.getByRole("dialog", { name: "Add a step" });
  await add.getByLabel("Role").selectOption("tester");
  await add.getByLabel("Starts after").selectOption({ label: "01 Research" });
  await add.getByRole("button", { name: "Add step" }).click();
  await expect(add).toHaveCount(0);
  await screen.getByRole("complementary", { name: /^Edit 02 Test/ }).getByRole("button", { name: "Close the step editor" }).click();
  await bar.getByRole("button", { name: "Approve and start" }).click();
  await expect.poll(async () => (await taskByTitle(page, title))?.runs.length, { timeout: 20_000 }).toBe(1);
  const before = (await taskByTitle(page, title))!.crew!.members[1]!;

  // An approved step with no run: Change AI picks another profile for it, and starts nothing.
  const test = screen.locator(`.crew-node[data-node="m:${before.id}"]`);
  await test.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: /^Actions for 02 Test/ });
  await menu.getByRole("menuitem", { name: "Change AI before it starts…" }).click();
  const pick = page.getByRole("dialog", { name: /^Change the AI for 02 Test/ });
  await expect(pick.getByRole("radio").first()).toBeChecked();
  await pick.getByRole("button", { name: "Use this AI" }).click();
  await expect(pick).toHaveCount(0);
  await expect.poll(async () => (await taskByTitle(page, title))!.crew!.members[1]!.chosen?.profileId).not.toBe(before.chosen?.profileId);
  const after = (await taskByTitle(page, title))!;
  expect(after.runs.filter((r) => r.memberId === before.id)).toEqual([]);
  // The profile it replaced leads the step's standby chain.
  expect(after.crew!.members[1]!.standby[0]?.profileId).toBe(before.chosen?.profileId);

  // Cancel task from the task node confirms, in danger, and names what it stops.
  await screen.locator('.crew-node[data-node="task"]').focus();
  await page.keyboard.press("Shift+F10");
  const taskMenu = page.getByRole("menu", { name: /^Actions for Task/ });
  await expect(taskMenu.getByRole("menuitem", { name: /^Retry failed steps/ })).toContainText("No step has failed");
  await taskMenu.getByRole("menuitem", { name: "Cancel task…" }).click();
  const confirm = page.getByRole("dialog", { name: `Cancel ${title}?` });
  await expect(confirm).toContainText("This stops 1 open agent run");
  await confirm.getByRole("button", { name: "Cancel task" }).click();
  await expect.poll(async () => (await taskByTitle(page, title))?.status, { timeout: 20_000 }).toBe("cancelled");
});
