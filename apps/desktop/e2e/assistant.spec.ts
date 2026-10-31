import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { FakeStep } from "@crewyard/adapter-fake";
import { daemon, launch, say, usage, type Harness } from "./harness.ts";

// The task assistant (docs/adr/0014) against the fake runner: Ctrl Shift A opens it, the agent
// reads, proposes two drafts through the real report pipe and replies; one draft is edited and
// added (it lands in Tasks waiting for its crew), the other discarded; Esc stops and closes it.
// Screenshots land in apps/desktop/screens/assistant (git-ignored) for the dark and light, 1280
// and 1920 px check.

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
        say("one to research the slow build, <b>one</b> to cache installs in CI."),
        usage(12_000, 900),
      ],
    ],
  });

  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+Shift+A");
  const p = panel(page);
  await expect(p).toBeVisible();
  await expect(page.locator("#tk-assistant-toggle")).toHaveAttribute("aria-expanded", "true");
  // The message box takes focus at once.
  await expect(p.getByLabel("Message to the task assistant")).toBeFocused();
  await expect(p.getByText("Describe what you want done or found out.", { exact: false })).toBeVisible();
  await look(page, 1280, "dark");
  await page.screenshot({ path: join(shots, "empty-dark-1280.png") });
});

test("the agent proposes two drafts, read-only, and the spend shows as Estimated", async () => {
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
  await expect(log.getByText("one to research the slow build, <b>one</b> to cache installs in CI.", { exact: false })).toBeVisible({ timeout: 20_000 });
  // Agent text stays text: no element was made from it.
  await expect(log.locator("b")).toHaveCount(0);
  await expect(log.getByText("Read README.md")).toBeVisible();
  await expect(log.getByText("Refused a request to write, run a command or use the network", { exact: false })).toBeVisible();
  await expect(p.getByText("Your turn")).toBeVisible();
  const drafts = p.getByRole("region", { name: "Task drafts" });
  await expect(drafts.getByRole("article")).toHaveCount(2);
  await expect(p.locator(".as-head .as-spend")).toContainText("Estimated");
  await expect(p.locator(".as-run")).toContainText("Fake");

  // Nothing became a task on its own.
  expect(await daemon<unknown[]>(page, "tasks.list", {})).toHaveLength(0);

  for (const width of [1280, 1920]) {
    for (const theme of ["dark", "light"] as const) {
      await look(page, width, theme);
      await page.screenshot({ path: join(shots, `drafts-${theme}-${width}.png`) });
    }
  }
  await look(page, 1280, "dark");
});

test("one draft is edited and added to Tasks waiting for its crew, the other discarded", async () => {
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

  const second = drafts.getByRole("article", { name: /Cache the dependency install in CI/ });
  await second.getByRole("button", { name: "Discard" }).click();
  await expect(drafts.getByRole("article")).toHaveCount(1);
  expect(await daemon<unknown[]>(page, "tasks.list", {})).toHaveLength(1);
  await page.screenshot({ path: join(shots, "added-dark-1280.png") });
});

test("keyboard: Tab reaches the log, the box and every draft control; Esc stops and closes", async () => {
  const { page, repo } = h;
  const p = panel(page);
  const box = p.getByLabel("Message to the task assistant");
  await box.focus();
  // Shift Tab from the box goes back to the scrollable log, which is focusable for reading.
  await page.keyboard.press("Shift+Tab");
  await expect(p.getByRole("log")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(box).toBeFocused();
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
  await expect(panel(page).getByRole("log").getByText("Stopped: you closed the panel.", { exact: false })).toBeVisible();
  await expect(panel(page).getByText("Stopped", { exact: true })).toBeVisible();
  for (const width of [1280, 1920]) {
    for (const theme of ["dark", "light"] as const) {
      await look(page, width, theme);
      await page.screenshot({ path: join(shots, `stopped-${theme}-${width}.png`) });
    }
  }
  await page.keyboard.press("Control+Shift+A");
  await expect(panel(page)).toHaveCount(0);
});

async function projectId(page: Page, repo: string): Promise<string> {
  const list = await daemon<Array<{ id: string; path: string }>>(page, "projects.list", undefined);
  return list.find((p) => p.path.toLowerCase() === repo.toLowerCase())!.id;
}
