import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import { approval, daemon, hold, launch, limitReached, question, running, say, usage, type E2eProfile, type Harness } from "./harness.ts";

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

test("Inbox: an agent reports through the MCP report server, gets a reply, and its follow-up becomes a draft only", async () => {
  const { page } = h;
  // The fake runner calls the report tools through the daemon's pipe with the run's ticket (docs/adr/0007).
  h.setScripts({
    researcher: [
      [
        running,
        { mcp: { tool: "report", arguments: { kind: "needs_input", text: "Which region should the <b>cache</b> use?" } } },
        { mcp: { tool: "propose_followup", arguments: { title: "Cache the session lookups", description: "The lookup runs twice per request." } } },
        say("Waiting for the region."),
        hold(),
      ],
    ],
  });
  const task = await startTask("Plan the session cache");
  await openInbox();
  const reports = page.locator(".ib-report");
  await expect(reports).toHaveCount(2, { timeout: 20_000 });
  const ask = reports.filter({ hasText: "needs your input" });
  // The agent's words are text: the markup shows as typed, never as HTML.
  await expect(ask.locator(".ib-quote")).toHaveText("Which region should the <b>cache</b> use?");
  await ask.getByRole("button", { name: "Reply" }).click();
  await ask.getByLabel("Your answer").fill("eu-west-1");
  await ask.getByRole("button", { name: "Send" }).click();
  await expect(reports).toHaveCount(1);

  const tasksBefore = (await tasks()).length;
  await reports.getByRole("button", { name: "Turn into a task" }).click();
  await expect(page.getByLabel("New task")).toBeVisible();
  await expect.poll(async () => (await tasks()).length).toBe(tasksBefore + 1);
  const draft = (await taskByTitle("Cache the session lookups"))!;
  expect(draft.status).toBe("proposed");
  expect(await runsOf(draft.id)).toHaveLength(0);
  await daemon(page, "tasks.cancel", { taskId: draft.id });
  await daemon(page, "tasks.cancel", { taskId: task.id });
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

test("Best of: runs two implementers, compares them and keeps one, which the review continues", async () => {
  const { page } = h;
  const work = [running, say("Implemented."), { wait: 200 }];
  h.setScripts({ implementer: [work, work], reviewer: [[running, say("Reviewed."), { wait: 100 }]] });
  await page.locator("#app-sidebar").getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByLabel("New task").fill("Add a token bucket to the limiter");
  await page.getByLabel("Kind").selectOption("code");
  await page.getByLabel("Best of").selectOption("2");
  await page.getByRole("button", { name: "Propose crew" }).click();
  const proposal = page.getByRole("region", { name: /Suggested crew for/ });
  await expect(proposal.getByText("Best of 2 · implement step")).toBeVisible();
  await expect(proposal.getByText(/for every variant/)).toBeVisible();
  await proposal.getByRole("button", { name: "Approve and start" }).click();

  const title = "Add a token bucket to the limiter";
  const phase = async () => (await daemon<{ bestOfGroup: { phase: string } | null }>(h.page, "tasks.get", { taskId: (await taskByTitle(title))!.id })).bestOfGroup?.phase;
  await expect.poll(phase, { timeout: 30_000 }).toBe("choosing");
  // The variants are hidden tasks: the list shows the parent only.
  expect((await tasks()).filter((t) => t.title === title)).toHaveLength(1);
  const row = page.locator(".tk-row", { hasText: title });
  await row.getByRole("button", { name: "Compare" }).click();
  const compare = page.getByRole("region", { name: `Best of variants for ${title}` });
  await expect(compare).toBeVisible();
  const first = compare.getByLabel(/^Variant 1, /);
  await first.getByRole("button", { name: "Keep this one" }).click();
  await expect(first.locator(".tk-confirm")).toContainText("1 other variant is stopped");
  await first.getByRole("button", { name: "Keep it" }).click();
  await expect.poll(phase, { timeout: 20_000 }).toBe("kept");
  await expect.poll(async () => (await taskByTitle(title))?.status, { timeout: 30_000 }).toBe("review");
});

test("Schedules: creates one switched off, switches it on and runs it now", async () => {
  const { page } = h;
  await page.locator("#app-sidebar").getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: /^Schedules/ }).click();
  await expect(page.getByText(/Schedules run only while Crewyard is open/)).toBeVisible();
  await page.getByRole("button", { name: "New schedule" }).click();
  const form = page.getByRole("region", { name: "New schedule" });
  await form.getByLabel("Task title").fill("Nightly limiter check");
  await form.getByLabel("Kind").selectOption("research");
  await form.getByLabel("Auto-approve this crew").check();
  await expect(form.getByText(/starts without asking you/)).toBeVisible();
  await form.getByLabel("Auto-approve this crew").uncheck();
  await form.getByRole("button", { name: "Save schedule" }).click();
  const row = page.locator(".tk-row", { hasText: "Nightly limiter check" });
  await expect(row.locator(".tk-status .st")).toHaveText("Off");
  await row.getByRole("group", { name: /on or off/ }).getByRole("button", { name: "On" }).click();
  await expect(row.locator(".tk-status .st")).toHaveText("On");
  await expect(row.getByText(/^Next /)).toBeVisible();
  await row.getByRole("button", { name: "Run now" }).click();
  // It proposes the task and waits for your approval, like any task.
  await expect.poll(async () => (await taskByTitle("Nightly limiter check"))?.status).toBe("proposed");
  await expect(row.getByText(/Last: Proposed, waits for approval/)).toBeVisible();
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Tasks" }).click();
});

test("Fallback: with account switching on, a limit moves the step to the provider's other account and the Inbox says so", async () => {
  const { page } = h;
  const main = page.locator("main");
  const toggle = () => main.getByRole("group", { name: "Switch accounts of the same provider" });
  // Off by default; turning it on shows the provider-terms note first (docs/adr/0009).
  await page.locator("#app-sidebar").getByRole("button", { name: "Settings" }).click();
  await expect(toggle().getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
  await toggle().getByRole("button", { name: "On" }).click();
  const note = main.getByRole("alertdialog", { name: "Before you turn it on" });
  await expect(note).toBeVisible();
  await note.getByRole("button", { name: "I understand, turn it on" }).click();
  await expect(toggle().getByRole("button", { name: "On" })).toHaveAttribute("aria-pressed", "true");
  // Settings hides the sidebar; Back returns to where it was opened from.
  await main.getByRole("button", { name: "[ Back ]", exact: true }).click();

  // Two accounts of one provider: whichever the crew picks, the other one takes over.
  const model = (id: string): E2eProfile["model"] => ({ id, name: id, family: null, context: 200_000, output: 16_000, cost: { input: 1.25, output: 10, cacheRead: 0.125 }, reasoning: true, openWeights: false, released: null });
  const profiles: E2eProfile[] = [
    { id: "e2e-work", alias: "Fake Work", providerId: "openai", model: model("fake-sol") },
    { id: "e2e-home", alias: "Fake Home", providerId: "openai", model: model("fake-sol") },
  ];
  const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
  h.setScripts({ researcher: [[running, limitReached(resetsAt), hold()], [running, say("Continued on the other account."), { wait: 200 }]] }, profiles);
  const proposal = await compose("Check the limiter on a second account", { onLimit: "manual" });
  await expect(proposal.getByLabel(/Same-provider accounts may take over/)).toBeChecked();
  await proposal.getByRole("button", { name: "Approve and start" }).click();
  // Manual mode, and still no question: the switch comes before the task's fallback mode.
  await expect.poll(async () => (await taskByTitle("Check the limiter on a second account"))?.status, { timeout: 20_000 }).toBe("done");
  const task = (await taskByTitle("Check the limiter on a second account"))!;
  expect((await runsOf(task.id)).map((r) => r.endReason)).toEqual(expect.arrayContaining(["limit", "completed"]));

  await openInbox();
  await expect(page.getByText("Switched accounts · 1")).toBeVisible();
  const entry = page.locator(".ib-switch");
  await expect(entry).toContainText("Fake Work");
  await expect(entry).toContainText("Fake Home");
  await expect(entry).toContainText("limit reached");
  await entry.getByRole("button", { name: "Off for this task" }).click();
  await expect(entry.getByRole("button", { name: "Off for this task" })).toBeDisabled();
  await entry.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator(".ib-switch")).toHaveCount(0);

  // Off again, so the flows after this one see the default.
  h.setScripts({});
  await page.locator("#app-sidebar").getByRole("button", { name: "Settings" }).click();
  await toggle().getByRole("button", { name: "Off" }).click();
  await expect(toggle().getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
  await main.getByRole("button", { name: "[ Back ]", exact: true }).click();
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

test("Settings: a development build says it does not update itself, and nothing reaches a feed", async () => {
  const { page } = h;
  type Updates = { phase: string; off: string | null; feed: string | null; autoCheck: boolean };
  const bridge = (action: "updates" | "checkForUpdates" | "downloadUpdate" | "installUpdate") =>
    page.evaluate((a) => (window as unknown as { crewyard: Record<string, () => Promise<Updates>> }).crewyard[a]!(), action);
  const updates = page.locator("#settings-updates");
  await page.getByRole("button", { name: /^\d+\s*Updates$/ }).click();
  await expect(updates.getByText("Only an installed copy of Crewyard updates itself.", { exact: false })).toBeVisible();
  await expect(updates.getByText("None in this build")).toBeVisible();
  await expect(updates.getByRole("button", { name: "Check now" })).toBeDisabled();
  await expect(updates.getByRole("group", { name: "Check automatically" }).getByRole("button", { name: "On" })).toBeDisabled();
  // Asking anyway, past the disabled buttons, changes nothing.
  expect(await bridge("checkForUpdates")).toMatchObject({ phase: "off", off: "development", feed: null, autoCheck: false });
  await bridge("downloadUpdate");
  await bridge("installUpdate");
  expect(await bridge("updates")).toMatchObject({ phase: "off", off: "development" });
  await expect(page.locator("#settings-about").getByText("Third-party licences")).toBeVisible();
});

/** A 1x1 PNG, the smallest image the daemon's signature check accepts as one. */
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("Attachments: a pasted image goes with the task, a picked file with a queued message", async () => {
  const { page } = h;
  h.setScripts({ researcher: [[running, hold()]] });
  // The settings flows leave Settings open, which hides the sidebar.
  await page.locator("main").getByRole("button", { name: "[ Back ]", exact: true }).click();
  await page.locator("#app-sidebar").getByRole("button", { name: "Tasks", exact: true }).click();
  const box = page.getByLabel("New task");
  await box.fill("Explain the error in the screenshot");
  // Ctrl V with only an image on the clipboard, as a screenshot tool leaves it.
  await box.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG_1PX);
  const composer = page.locator(".tk-composer");
  await expect(composer.getByRole("img", { name: "Attached image: pasted.png" })).toBeVisible();
  // A renamed executable is refused by the daemon, and the reason is shown.
  await composer.locator("input[type=file]").setInputFiles({ name: "tool.png", mimeType: "image/png", buffer: Buffer.from("MZ not an image") });
  await expect(composer.getByText("Only PNG, JPEG, GIF and WebP images, PDFs and text files can be attached.")).toBeVisible();
  await page.getByLabel("Kind").selectOption("research");
  await page.getByRole("button", { name: "Propose crew" }).click();
  const proposal = page.getByRole("region", { name: /Suggested crew for/ });
  await expect(proposal.getByText("1 attachment")).toBeVisible();
  await expect(proposal.getByRole("img", { name: "Attached image: pasted.png" })).toBeVisible();
  await proposal.getByRole("button", { name: "Approve and start" }).click();
  const task = (await taskByTitle("Explain the error in the screenshot"))!;
  const detail = await daemon<{ attachments?: Array<{ name: string; kind: string }> }>(page, "tasks.get", { taskId: task.id });
  expect(detail.attachments).toEqual([expect.objectContaining({ name: "pasted.png", kind: "image" })]);

  await expect.poll(async () => (await runsOf(task.id))[0]?.state).toBe("running");
  await page.locator("button.tk-top-main", { hasText: task.title }).click();
  const inspector = page.locator("#app-inspector");
  await inspector.locator("input[type=file]").setInputFiles({ name: "build log.txt", mimeType: "text/plain", buffer: Buffer.from("error: limiter.ts:42\n") });
  await expect(inspector.getByText("build log.txt")).toBeVisible();
  await inspector.getByRole("button", { name: "Send", exact: true }).click();
  const queue = inspector.getByRole("list", { name: "1 attachment" }).first();
  await expect(queue).toContainText("build log.txt");
  await daemon(page, "tasks.cancel", { taskId: task.id });
});
