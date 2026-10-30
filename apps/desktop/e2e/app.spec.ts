import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import { approval, daemon, hold, launch, limitReached, question, running, say, usage, type Harness } from "./harness.ts";

// One app instance walks through the flows in order, the way a person would: open a project,
// run tasks against scripted runners, answer the Inbox, then change settings and layout.

test.describe.configure({ mode: "serial" });

let h: Harness;

test.beforeAll(async () => {
  h = await launch();
});

test.afterAll(async () => {
  await h?.close();
});

interface TaskSummary {
  id: string;
  title: string;
  status: string;
}
interface RunView {
  id: string;
  role: string;
  state: string | null;
  endReason: string | null;
  paused?: boolean;
}

const tasks = () => daemon<TaskSummary[]>(h.page, "tasks.list", {});
const taskByTitle = async (title: string) => (await tasks()).find((t) => t.title === title);
const runsOf = async (taskId: string) => (await daemon<{ runs: RunView[] }>(h.page, "tasks.get", { taskId })).runs;

async function compose(text: string, opts: { onLimit?: string; budget?: string; kind?: string } = {}) {
  const { page } = h;
  await page.locator("#app-sidebar").getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByLabel("New task").fill(text);
  // Research tasks have one step, so a script for the researcher drives the whole task.
  await page.getByLabel("Kind").selectOption(opts.kind ?? "research");
  if (opts.onLimit) await page.getByLabel("On limit").selectOption(opts.onLimit);
  if (opts.budget) await page.getByLabel("Budget $").fill(opts.budget);
  await page.getByRole("button", { name: "Propose crew" }).click();
  const proposal = page.getByRole("region", { name: /Suggested crew for/ });
  await expect(proposal).toBeVisible();
  return proposal;
}

async function startTask(text: string, opts: { onLimit?: string; budget?: string; kind?: string } = {}): Promise<TaskSummary> {
  const proposal = await compose(text, opts);
  await proposal.getByRole("button", { name: "Approve and start" }).click();
  const title = text.split("\n")[0]!;
  await expect.poll(async () => (await taskByTitle(title))?.status).not.toBe("proposed");
  return (await taskByTitle(title))!;
}

async function openInbox() {
  await h.page.locator("#app-sidebar").getByRole("button", { name: /^Inbox/ }).click();
  await expect(h.page.getByRole("heading", { name: "Inbox" })).toBeVisible();
}

test("Start: opens a project from a git repo with spaces in its path", async () => {
  const { page, repo } = h;
  const start = page.getByRole("region", { name: "Start" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.getByRole("button", { name: "Open folder" }).click();
  const tile = start.locator("button.ptile", { hasText: basename(repo) });
  await expect(tile).toBeVisible();
  await tile.click();
  await expect(page.locator("#app-sidebar")).toBeVisible();
  await expect(page.getByLabel("New task")).toBeVisible();
});

test("Tasks: composes a task, shows the crew proposal and approves it", async () => {
  h.setScripts({ researcher: [[running, say("Found three options."), { wait: 200 }]] });
  const proposal = await compose("Compare rate limiter libraries\nList the trade-offs.", { onLimit: "ask" });
  await expect(proposal.locator("h2.tk-crew-task")).toHaveText("Compare rate limiter libraries");
  await expect(proposal.getByText(/\d+ roles?/)).toBeVisible();
  await proposal.getByRole("button", { name: "Approve and start" }).click();
  await expect.poll(async () => (await taskByTitle("Compare rate limiter libraries"))?.status, { timeout: 20_000 }).toBe("done");
});

test("Inbox: answers an approval request and a question", async () => {
  const { page } = h;
  h.setScripts({ researcher: [[running, ...approval("a1", "npm view express version"), ...question("q1", "Which store should the limiter use?", ["redis", "memory"]), say("Answered."), { wait: 200 }]] });
  const task = await startTask("Check the limiter store");
  await openInbox();
  const list = page.getByRole("listbox", { name: "Requests" });
  await list.getByRole("option", { name: /Run npm view express version\?/ }).click();
  await page.getByRole("button", { name: "Approve once" }).click();
  await list.getByRole("option", { name: /Which store should the limiter use\?/ }).click();
  await page.getByRole("radio", { name: "redis" }).check();
  await page.getByRole("button", { name: "Send answer" }).click();
  await expect.poll(async () => (await taskByTitle(task.title))?.status, { timeout: 20_000 }).toBe("done");
  await expect(page.getByText("Nothing needs you right now.")).toBeVisible();
});

test("Limits: a limit notice hands off in Ask mode, a budget cap pauses and continues", async () => {
  const { page } = h;
  const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
  h.setScripts({ researcher: [[running, limitReached(resetsAt), hold()], [running, say("Continued on the standby."), { wait: 200 }]] });
  const limited = await startTask("Survey limiter benchmarks", { onLimit: "ask" });
  await openInbox();
  const list = page.getByRole("listbox", { name: "Requests" });
  await list.getByRole("option", { name: /Limit reached on the 5-hour window/ }).click();
  await expect(page.getByText("Proposed")).toBeVisible();
  await page.getByRole("button", { name: /^Hand off to / }).click();
  await expect.poll(async () => (await taskByTitle(limited.title))?.status, { timeout: 20_000 }).toBe("done");
  const handed = await runsOf(limited.id);
  expect(handed.map((r) => r.endReason)).toEqual(expect.arrayContaining(["limit", "completed"]));

  // 1M input tokens on the first fake profile cost about $3, past a $0.05 task budget.
  h.setScripts({ researcher: [[running, usage(1_000_000), hold()]], resume: [[running, say("Done after the cap."), { wait: 200 }]] });
  const capped = await startTask("Summarize limiter docs", { budget: "0.05" });
  await openInbox();
  await list.getByRole("option", { name: /Task budget of .* reached/ }).click();
  await page.getByRole("button", { name: "Continue past the cap" }).click();
  await expect.poll(async () => (await taskByTitle(capped.title))?.status, { timeout: 20_000 }).toBe("done");
});

test("Runs: pauses, resumes and stops a run with a confirm", async () => {
  const { page } = h;
  // Pause ends the live session; Resume and Check again continue it natively ("resume" scripts).
  const checked = [running, say("Checked again."), { wait: 200 }];
  h.setScripts({ researcher: [[running, hold()], checked], resume: [[running, hold()], checked] });
  const task = await startTask("Profile the limiter under load");
  await expect.poll(async () => (await runsOf(task.id))[0]?.state).toBe("running");
  await page.locator("button.tk-top-main", { hasText: task.title }).click();
  const inspector = page.locator("#app-inspector");
  await expect(inspector).toBeVisible();
  await inspector.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(async () => (await runsOf(task.id))[0]?.state).toBe("paused");
  await inspector.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(async () => (await runsOf(task.id))[0]?.state).toBe("running");
  await inspector.getByRole("button", { name: "Stop agent" }).click();
  const confirm = inspector.locator(".tk-confirm");
  await expect(confirm).toContainText(/Stop .*\?/);
  await confirm.getByRole("button", { name: "Stop" }).click();
  await expect.poll(async () => (await runsOf(task.id))[0]?.endReason).toBe("stopped");
  // Only Check again in the crew graph (next flows) finishes this task.
  expect((await taskByTitle(task.title))?.status).not.toBe("done");
});

test("Layout: Ctrl B collapses the sidebar and the keyboard resizes the inspector", async () => {
  const { page } = h;
  const html = page.locator("html");
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+B");
  await expect(html).toHaveAttribute("data-sidebar", "rail");
  await page.keyboard.press("Control+B");
  await expect(html).toHaveAttribute("data-sidebar", "full");

  const splitter = page.getByRole("separator", { name: "Resize run details" });
  await expect(splitter).toBeVisible();
  const before = Number(await splitter.getAttribute("aria-valuenow"));
  await splitter.focus();
  // The inspector sits at the end of the window, so ArrowLeft grows it by one 16 px step.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(splitter).toHaveAttribute("aria-valuenow", String(before + 32));
  await page.keyboard.press("ArrowRight");
  await expect(splitter).toHaveAttribute("aria-valuenow", String(before + 16));
});

test("Crew graph: right-clicks a node and runs Check again", async () => {
  const { page } = h;
  const task = (await taskByTitle("Profile the limiter under load"))!;
  await page.locator("#app-sidebar").getByRole("button", { name: "Crew graph" }).click();
  const screen = page.getByRole("region", { name: "Crew graph" });
  await expect(screen).toBeVisible();
  const node = screen.locator('.crew-node[data-node^="m:"]').first();
  await expect(node).toBeVisible();
  await node.click({ button: "right" });
  const menu = page.getByRole("menu", { name: /^Actions for / });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Check again" }).click();
  await expect(screen.locator(".crew-live")).toContainText("again");
  await expect.poll(async () => (await taskByTitle(task.title))?.status, { timeout: 20_000 }).toBe("done");
});

test("Settings: theme and language change and the UI follows", async () => {
  const { page } = h;
  const html = page.locator("html");
  await page.locator("#app-sidebar").getByRole("button", { name: "Settings" }).click();
  const main = page.locator("main");
  await main.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await main.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");

  await main.getByRole("group", { name: "Language" }).getByRole("button", { name: "Türkçe" }).click();
  await expect(html).toHaveAttribute("lang", "tr");
  await expect(main.getByRole("group", { name: "Language" })).toHaveCount(0);
  await main.getByRole("button", { name: "English", exact: true }).click();
  await expect(html).toHaveAttribute("lang", "en");
  await expect(main.getByRole("group", { name: "Language" })).toBeVisible();
});
