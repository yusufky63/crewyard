import { basename } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { daemon, launch, running, say, type Harness } from "./harness.ts";

// Managing a crew in the Crew graph (PLAN.md §9 step 6) against scripted runners: a proposal is
// edited step by step (add a step, change its AI, its standby chain and what it waits for, by the
// edge's remove button and by the keyboard's checkbox) and then approved; a failed step is
// retried from its node menu. Its own app instance, so app.spec.ts is unaffected.

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

  // Nothing started yet; Approve and start runs the edited crew.
  expect((await taskByTitle(page, title))!.runs).toEqual([]);
  await bar.getByRole("button", { name: "Approve and start" }).click();
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
  await menu.getByRole("menuitem", { name: "Retry step" }).click();
  await expect(screen.locator(".crew-live")).toContainText("again");
  await expect.poll(async () => (await taskByTitle(page, title))?.status, { timeout: 20_000 }).toBe("done");
});
