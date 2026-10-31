import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { FakeStep } from "@crewyard/adapter-fake";
import { daemon, launch, say, type Harness } from "./harness.ts";

// The task assistant's read tools (docs/adr/0018) against the fake runner, with Autopilot off: the
// agent lists the tasks, reads one and its crew, reads spend and local git through the real report
// pipe, and edits nothing. The conversation shows one readable line per call ("Read task: ..."),
// never the runner's raw tool name, and a refused call says so. Nothing starts. Screenshots land in
// apps/desktop/screens/assistant-tools (git-ignored).

test.describe.configure({ mode: "serial" });

let h: Harness;
const shots = join(import.meta.dirname, "..", "screens", "assistant-tools");

test.beforeAll(async () => {
  h = await launch();
  mkdirSync(shots, { recursive: true });
});

test.afterAll(async () => {
  await h?.close();
});

const panel = (page: Page) => page.getByRole("region", { name: "Task assistant" });
const tool = (name: string, args: Record<string, unknown> = {}): FakeStep => ({ mcp: { tool: name, arguments: args } });

async function look(page: Page, width: number, theme: "dark" | "light") {
  await h.app.evaluate(({ BrowserWindow }, [w]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, 1000), [width]);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
  const html = page.locator("html");
  for (let i = 0; i < 3 && (await html.getAttribute("data-theme")) !== theme; i++) await page.locator(".statusbar").getByTitle(/theme/i).click();
  await expect(html).toHaveAttribute("data-theme", theme);
}

test("the assistant reads tasks, a crew, spend and git with Autopilot off, and starts nothing", async () => {
  const { page, repo } = h;
  const start = page.getByRole("region", { name: "Start" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.getByRole("button", { name: "Open folder" }).click();
  await start.locator("button.ptile", { hasText: basename(repo) }).click();
  await page.locator("#app-sidebar").getByRole("button", { name: "Tasks", exact: true }).click();

  const [project] = await daemon<Array<{ id: string }>>(page, "projects.list", undefined);
  const task = await daemon<{ id: string }>(page, "tasks.propose", { projectId: project!.id, title: "Fix the login redirect", kind: "code" });

  h.setScripts({
    assistant: [
      [
        { emit: { type: "turn.started", turnRef: null } },
        // The runner's own raw line for our tool is left out; Crewyard writes a readable one.
        { emit: { type: "tool.call", toolCallId: "t1", title: "mcp__crewyard__list_tasks", kind: "other", input: {} } },
        tool("list_tasks"),
        tool("read_task", { task_id: task.id }),
        tool("read_crew", { task_id: task.id }),
        tool("read_usage"),
        tool("git_overview", { commits: 3 }),
        tool("read_task", { task_id: "no-such-task" }),
        say("There is one task, Fix the login redirect. Its crew waits for your approval."),
      ],
    ],
  });

  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+Shift+A");
  const p = panel(page);
  await expect(p).toBeVisible();
  await p.getByLabel("Message to the task assistant").fill("What is going on in this project?");
  await p.getByLabel("Message to the task assistant").press("Enter");

  const log = p.getByRole("log", { name: "Conversation with the task assistant" });
  await expect(log.getByText("Its crew waits for your approval.", { exact: false })).toBeVisible({ timeout: 40_000 });
  for (const line of ["Listed tasks", "Read task: Fix the login redirect", "Read crew: Fix the login redirect", "Read spend and limits: last 7 days", `Read git status: ${basename(repo)}`, "Read task (refused)"]) {
    await expect(log.getByText(line, { exact: true })).toBeVisible();
  }
  await expect(log.getByText("mcp__crewyard__list_tasks")).toHaveCount(0);

  // Reading started nothing: Autopilot is off, the task is still a proposal with no run.
  const autopilot = await daemon<{ enabled: boolean }>(page, "autopilot.get", { projectId: project!.id });
  expect(autopilot.enabled).toBe(false);
  const detail = await daemon<{ status: string; runs: unknown[] }>(page, "tasks.get", { taskId: task.id });
  expect(detail.status).toBe("proposed");
  expect(detail.runs).toHaveLength(0);

  const view = await daemon<{ lines: Array<{ role: string; text: string; call?: { tool: string; outcome: string } }> }>(page, "assistant.get", { projectId: project!.id });
  expect(view.lines.filter((l) => l.call).map((l) => [l.call!.tool, l.call!.outcome])).toEqual([
    ["list_tasks", "done"],
    ["read_task", "done"],
    ["read_crew", "done"],
    ["read_usage", "done"],
    ["git_overview", "done"],
    ["read_task", "refused"],
  ]);

  for (const width of [1280, 1920]) {
    for (const theme of ["dark", "light"] as const) {
      await look(page, width, theme);
      // The panel is short: bring the tool lines into view for the picture.
      await log.getByText("Read task: Fix the login redirect", { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(shots, `reads-${theme}-${width}.png`) });
    }
  }
  await look(page, 1280, "dark");
});
