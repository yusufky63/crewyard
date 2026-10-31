import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { FakeStep } from "@crewyard/adapter-fake";
import { daemon, launch, say, usage, type Harness } from "./harness.ts";

// The task assistant (docs/adr/0014) against the fake runner: Ctrl Shift A opens it, the agent
// reads (the live row under your message says what it does), proposes two drafts through the real
// report pipe and replies in Markdown shown as text-only elements; its reply can be copied, quoted
// and turned into more drafts; one draft is edited and added (it lands in Tasks waiting for its
// crew) and Open task takes you to it from another screen; the others are discarded; Esc stops and
// closes it. Screenshots land in apps/desktop/screens/assistant (git-ignored) for the dark and
// light, 1280 and 1920 px check.

test.describe.configure({ mode: "serial" });

let h: Harness;
const shots = join(import.meta.dirname, "..", "screens", "assistant");

test.beforeAll(async () => {
  h = await launch();
  mkdirSync(shots, { recursive: true });
});

test.afterAll(async () => {
  await h?.close();
});

const panel = (page: Page) => page.getByRole("region", { name: "Task assistant" });
const propose = (args: unknown): FakeStep => ({ mcp: { tool: "propose_task", arguments: args } });

async function look(page: Page, width: number, theme: "dark" | "light") {
  await h.app.evaluate(({ BrowserWindow }, [w]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, 1000), [width]);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
  const html = page.locator("html");
  for (let i = 0; i < 3 && (await html.getAttribute("data-theme")) !== theme; i++) await page.locator(".statusbar").getByTitle(/theme/i).click();
  await expect(html).toHaveAttribute("data-theme", theme);
}

async function shoot(page: Page, name: string) {
  for (const width of [1280, 1920]) {
    for (const theme of ["dark", "light"] as const) {
      await look(page, width, theme);
      await page.screenshot({ path: join(shots, `${name}-${theme}-${width}.png`) });
    }
  }
  await look(page, 1280, "dark");
}

test("opens a project and the assistant with Ctrl Shift A", async () => {
  const { page, repo } = h;
  const start = page.getByRole("region", { name: "Start" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.getByRole("button", { name: "Open folder" }).click();
  await start.locator("button.ptile", { hasText: basename(repo) }).click();
  await expect(page.locator("#app-sidebar")).toBeVisible();
  await page.locator("#app-sidebar").getByRole("button", { name: "Tasks", exact: true }).click();

  h.setScripts({
    assistant: [
      [
        { emit: { type: "turn.started", turnRef: null } },
        { emit: { type: "tool.call", toolCallId: "t1", title: "Read README.md", kind: "read", input: { path: "README.md" } } },
        // Long enough to see the live row name the read and count the time.
        { wait: 2500 },
        { emit: { type: "tool.call", toolCallId: "t2", title: "Grep: slow build", kind: "search", input: { pattern: "slow build" } } },
        { emit: { type: "request.approval", requestId: "a1", toolCallId: null, command: "pnpm install", cwd: null, paths: [], network: true } },
        { awaitAnswer: "a1" },
        propose({
          title: "Find why the Windows build is slow",
          description: "Compare a cold and a warm build on this machine.",
          kind: "research",
          acceptance_criteria: ["Which step takes longest?", "Does Defender scan the output folder?"],
          size: "S",
        }),
        propose({ title: "Cache the dependency install in CI", description: "Restore the pnpm store between runs.", kind: "code", acceptance_criteria: ["A warm CI run skips the install"], size: "M" }),
        say("I read the README and drafted two tasks: "),
        say("one to research the slow build, <b>one</b> to cache installs in CI.\n\n"),
        say("- Find the store with:\n\n```\npnpm store path\n```\n\nSee `README.md:3` and [the docs](https://example.com/pnpm)."),
        usage(12_000, 900),
        // Make drafts from this: a normal message, answered with one more draft.
        { awaitTurn: true },
        { wait: 1500 },
        propose({ title: "Measure the cold build time", description: "Time a cold build three times.", kind: "research", acceptance_criteria: ["How long is a cold build?"], size: "S" }),
        say("Drafted one more task from that reply."),
      ],
    ],
  });

  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+Shift+A");
  const p = panel(page);
  await expect(p).toBeVisible();
  await expect(page.locator("#tk-assistant-toggle")).toHaveAttribute("aria-expanded", "true");
  // The message box takes focus at once, inside its own frame, with Send beside it.
  const box = p.getByLabel("Message to the task assistant");
  await expect(box).toBeFocused();
  await expect(p.locator(".as-box")).toBeVisible();
  await expect(p.getByRole("button", { name: "Send" })).toBeVisible();
  // One short line of keys; the rest is behind the info button. Read-only shows in the header.
  await expect(p.getByText("Enter sends · Shift Enter: new line")).toBeVisible();
  await expect(p.getByText("Read-only: it never edits files", { exact: false })).toBeHidden();
  await expect(p.locator(".as-head").getByText("Read-only", { exact: true })).toBeVisible();
  await expect(p.getByText("Describe what you want done or found out.", { exact: false })).toBeVisible();
  await look(page, 1280, "dark");
  await page.screenshot({ path: join(shots, "empty-dark-1280.png") });
});

test("the live row shows what the agent does under your message, then the reply and two drafts", async () => {
  const { page } = h;
  const p = panel(page);
  const box = p.getByLabel("Message to the task assistant");
  await box.fill("The Windows build got slow and CI reinstalls everything.");
  // Shift Enter adds a line; Enter sends.
  await box.press("Shift+Enter");
  await box.type("Plan it.");
  await expect(box).toHaveValue("The Windows build got slow and CI reinstalls everything.\nPlan it.");
  await box.press("Enter");

  const log = p.getByRole("log", { name: "Conversation with the task assistant" });
  // In the message flow, under your message: the latest call, a spinner and the elapsed time.
  const row = log.locator(".as-live");
  await expect(row).toContainText("Read README.md", { timeout: 20_000 });
  await expect(row.locator(".spin")).toHaveCount(1);
  await expect(row.locator(".as-live-time")).toHaveText(/^\d+:\d\d$/);
  // The call in progress shows once, in the live row, not again as its own line just above it.
  await expect(log.getByText("Read README.md", { exact: true })).toHaveCount(1);
  // Stop shows while it works, in the bad tone.
  await expect(p.locator(".as-box").getByRole("button", { name: "Stop" })).toHaveClass(/btn-bad/);
  await page.screenshot({ path: join(shots, "live-dark-1280.png") });

  await expect(log.getByText("one to research the slow build, <b>one</b> to cache installs in CI.", { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveCount(0);
  await expect(p.locator(".as-box").getByRole("button", { name: "Stop" })).toHaveCount(0);
  // Agent text stays text: no element was made from its HTML, and its link does not open.
  await expect(log.locator("b")).toHaveCount(0);
  await expect(log.locator("a")).toHaveCount(0);
  await expect(log.getByText("https://example.com/pnpm", { exact: false })).toBeVisible();
  // Markdown as text-only elements: a list, a code block that copies, a path with a copy action.
  const reply = log.getByRole("article", { name: "Agent reply" });
  await expect(reply.locator("li", { hasText: "Find the store with:" })).toBeVisible();
  await expect(reply.locator(".as-pre pre")).toHaveText("pnpm store path");
  await expect(reply.getByRole("button", { name: "Copy path README.md:3" })).toHaveCount(1);
  // The two calls fold into one line; it opens to list them.
  const burst = log.getByRole("button", { name: "Read 1 file · 1 search" });
  await expect(burst).toHaveAttribute("aria-expanded", "false");
  await expect(log.getByText("Grep: slow build")).toHaveCount(0);
  await burst.click();
  await expect(burst).toHaveAttribute("aria-expanded", "true");
  await expect(log.getByText("Read README.md")).toBeVisible();
  await expect(log.getByText("Grep: slow build")).toBeVisible();
  await expect(log.getByText("Refused a request to write, run a command or use the network", { exact: false })).toBeVisible();
  await expect(p.getByText("Your turn")).toBeVisible();
  const drafts = p.getByRole("region", { name: "Task drafts" });
  await expect(drafts.getByRole("article")).toHaveCount(2);
  await expect(p.locator(".as-head .as-spend")).toContainText("Estimated");
  await expect(p.locator(".as-run")).toContainText("Fake");

  // Nothing became a task on its own.
  expect(await daemon<unknown[]>(page, "tasks.list", {})).toHaveLength(0);
  await shoot(page, "drafts");
});

test("a reply can be selected, copied, quoted and turned into more drafts", async () => {
  const { page } = h;
  const p = panel(page);
  const log = p.getByRole("log");
  const reply = log.getByRole("article", { name: "Agent reply" });
  const box = p.getByLabel("Message to the task assistant");

  // Nothing blocks selecting the reply's text.
  const selected = await reply.locator("p").first().evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return { text: sel.toString(), userSelect: getComputedStyle(el).userSelect };
  });
  expect(selected.text).toContain("I read the README");
  expect(selected.userSelect).not.toBe("none");

  await reply.getByRole("button", { name: "Copy reply" }).click();
  await expect(reply.getByRole("button", { name: "Copied" })).toBeVisible();
  // The Windows clipboard hands text back with CRLF line ends.
  expect((await h.app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, "\n")).toContain("```\npnpm store path\n```");

  await reply.getByRole("button", { name: "Quote in my message" }).click();
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(/^> I read the README and drafted two tasks:/);
  await box.fill("");

  await reply.getByRole("button", { name: "Make drafts from this" }).click();
  await expect(log.locator(".as-user", { hasText: 'Turn your reply that starts with "I read the README' })).toBeVisible();
  await expect(log.locator(".as-live")).toContainText("Thinking…", { timeout: 10_000 });
  await expect(log.getByText("Drafted one more task from that reply.")).toBeVisible({ timeout: 20_000 });
  const drafts = p.getByRole("region", { name: "Task drafts" });
  await expect(drafts.getByRole("article")).toHaveCount(3);

  // A taller panel, so the screenshots show whole replies, the folded calls and the drafts.
  const handle = page.getByRole("separator", { name: "Resize the panel" });
  await handle.focus();
  await handle.press("End");
  await log.evaluate((el) => (el.scrollTop = 0));
  await shoot(page, "reply");
});

test("one draft is edited and added; Open task takes you to it from another screen", async () => {
  const { page } = h;
  const drafts = panel(page).getByRole("region", { name: "Task drafts" });
  const first = drafts.getByRole("article", { name: /Find why the Windows build is slow/ });
  await first.getByLabel("Title").fill("Find why the Windows build is slow on this machine");
  await expect(first.getByLabel("Questions to answer, one per line")).toHaveValue("Which step takes longest?\nDoes Defender scan the output folder?");
  await first.getByRole("button", { name: "Add as draft" }).click();

  await expect.poll(async () => (await daemon<Array<{ title: string; status: string }>>(page, "tasks.list", {})).map((t) => [t.title, t.status])).toEqual([["Find why the Windows build is slow on this machine", "proposed"]]);
  const [task] = await daemon<Array<{ id: string }>>(page, "tasks.list", {});
  const detail = await daemon<{ kind: string; description: string; runs: unknown[] }>(page, "tasks.get", { taskId: task!.id });
  expect(detail.kind).toBe("research");
  expect(detail.description).toContain("Acceptance criteria:\n- Which step takes longest?");
  expect(detail.runs).toHaveLength(0);
  // The new task opens with its crew proposal, which still waits for approval.
  await expect(page.locator("main").getByRole("region", { name: /Suggested crew for/ })).toBeVisible();
  await expect(drafts.getByText("Added to Tasks. Its crew waits for your approval.")).toBeVisible();
  await expect(drafts.locator(".as-draft-added .badge-ok")).toHaveText("Added");

  // From another screen, Open task goes to Tasks, selects the task, opens the inspector on it
  // and puts focus on its row, even when you had collapsed the inspector to its strip.
  await page.locator("main .tk-row [data-list-id]", { hasText: "Find why the Windows build is slow on this machine" }).click();
  await page.locator("#app-inspector").getByRole("button", { name: "Collapse panel" }).click();
  await expect(page.locator("#app-inspector")).toHaveClass(/ins-strip/);
  await page.locator("#app-sidebar").getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(page.locator("main").getByRole("heading", { name: "Tasks", level: 1 })).toHaveCount(0);
  await drafts.getByRole("button", { name: "Open task" }).click();
  await expect(page.locator("main").getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  const row = page.locator("main .tk-row", { hasText: "Find why the Windows build is slow on this machine" });
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(row.locator("[data-list-id]")).toBeFocused();
  const inspector = page.locator("#app-inspector");
  await expect(inspector).toContainText("Find why the Windows build is slow on this machine");
  await expect(inspector).not.toHaveClass(/ins-strip/);
  await expect(inspector.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
  // The expanded inspector slides in; the screenshot waits for it to settle.
  await inspector.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  await page.screenshot({ path: join(shots, "open-task-dark-1280.png") });

  // On the Tasks screen itself, Open task leaves the Schedules view and a filter that hides the task.
  const main = page.locator("main");
  await main.getByRole("tab", { name: /^Done/ }).click();
  await expect(row).toHaveCount(0);
  await main.getByRole("group", { name: "View" }).getByRole("button", { name: /^Schedules/ }).click();
  await drafts.getByRole("button", { name: "Open task" }).click();
  await expect(main.getByRole("group", { name: "View" }).getByRole("button", { name: "Tasks" })).toHaveAttribute("aria-pressed", "true");
  await expect(main.getByRole("tab", { name: /^All/ })).toHaveAttribute("aria-selected", "true");
  await expect(row.locator("[data-list-id]")).toBeFocused();

  for (const name of [/Cache the dependency install in CI/, /Measure the cold build time/]) {
    await drafts.getByRole("article", { name }).getByRole("button", { name: "Discard" }).click();
  }
  await expect(drafts.getByRole("article")).toHaveCount(1);
  expect(await daemon<unknown[]>(page, "tasks.list", {})).toHaveLength(1);
  await page.screenshot({ path: join(shots, "added-dark-1280.png") });
});

test("keyboard: the log is one Tab stop with arrows inside; the info tip; Esc stops and closes", async () => {
  const { page, repo } = h;
  const p = panel(page);
  const box = p.getByLabel("Message to the task assistant");
  await box.focus();
  // Shift Tab from the box goes back to the scrollable log, which is focusable for reading.
  await page.keyboard.press("Shift+Tab");
  const log = p.getByRole("log");
  await expect(log).toBeFocused();
  // Up moves to the latest message; its actions come next on Tab.
  await page.keyboard.press("ArrowUp");
  const last = log.getByRole("article", { name: "Agent reply" }).last();
  await expect(last).toBeFocused();
  await expect(last).toContainText("Drafted one more task from that reply.");
  await page.keyboard.press("Tab");
  await expect(last.getByRole("button", { name: "Copy reply" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(log.locator(".as-user").last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(box).toBeFocused();
  // Leaving the log makes it one stop again.
  await page.keyboard.press("Shift+Tab");
  await expect(log).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(box).toBeFocused();

  // The info button holds the full keys and the read-only, spend and idle facts; Esc closes only it.
  await page.keyboard.press("Tab");
  const info = p.getByRole("button", { name: "About the assistant: keys, read-only, spend" });
  await expect(info).toBeFocused();
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText("Spend counts against the profile's key");
  await expect(tip).toContainText("Esc stops and closes");
  await page.screenshot({ path: join(shots, "info-dark-1280.png") });
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  await expect(p).toBeVisible();
  // A click opens it too and leaves it open (it does not toggle shut what hover just opened), the
  // pointer can move onto it, and Escape closes only the tip even with focus back in the box.
  await info.click();
  await expect(tip).toBeVisible();
  await tip.hover();
  await expect(tip).toBeVisible();
  await box.focus();
  await expect(tip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  await expect(p).toBeVisible();
  await page.mouse.move(0, 0);
  await info.focus();
  await expect(tip).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(p.getByRole("button", { name: "Send" })).toBeDisabled();
  // Disabled Send is skipped; the drafts column comes next, ready-made tasks first.
  const column = p.getByRole("region", { name: "Task drafts" });
  await expect(column.locator(".as-presets").getByRole("button").first()).toBeFocused();
  // Every ready-made task, then Suggest, then the added draft's Open task, one Tab each.
  const stops = await column.locator("button:not([disabled])").count();
  for (let i = 1; i < stops; i++) await page.keyboard.press("Tab");
  await expect(column.getByRole("button", { name: "Open task" })).toBeFocused();

  await box.focus();
  await page.keyboard.press("Escape");
  await expect(p).toHaveCount(0);
  await expect(page.locator("#tk-assistant-toggle")).toBeFocused();
  const view = await daemon<{ state: string; ended: string; drafts: unknown[] }>(page, "assistant.get", { projectId: await projectId(page, repo) });
  expect(view.state).toBe("idle");
  expect(view.ended).toBe("closed");

  // Reopening shows the kept conversation and the added draft; the session is not running.
  await page.locator("#tk-assistant-toggle").press("Enter");
  await expect(panel(page).getByRole("log").getByText("Stopped: you pressed Stop and close or Esc.", { exact: false })).toBeVisible();
  await expect(panel(page).getByText("Stopped", { exact: true })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Stop and close" })).toHaveClass(/btn-bad/);
  await shoot(page, "stopped");
  await page.keyboard.press("Control+Shift+A");
  await expect(panel(page)).toHaveCount(0);
});

async function projectId(page: Page, repo: string): Promise<string> {
  const list = await daemon<Array<{ id: string; path: string }>>(page, "projects.list", undefined);
  return list.find((p) => p.path.toLowerCase() === repo.toLowerCase())!.id;
}
