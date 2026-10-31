import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { FakeStep } from "@crewyard/adapter-fake";
import { daemon, launch, running, say, type Harness } from "./harness.ts";

// Autopilot (docs/adr/0017) against the fake runner: you turn it on in the task assistant with its
// consent card and limits; the assistant creates a research task and a code task through the real
// report pipe, approves both crews under budget, hears that the research finished, reads its
// report and marks it done, and is refused when it tries to mark the code task done: that task
// ends Ready for review and its pull request waits for you. Stop Autopilot in the status bar
// refuses everything at once. Screenshots land in apps/desktop/screens/autopilot (git-ignored).

test.describe.configure({ mode: "serial" });

let h: Harness;
const shots = join(import.meta.dirname, "..", "screens", "autopilot");

test.beforeAll(async () => {
  h = await launch();
  mkdirSync(shots, { recursive: true });
});

test.afterAll(async () => {
  await h?.close();
});

const panel = (page: Page) => page.getByRole("region", { name: "Task assistant" });
const strip = (page: Page) => panel(page).getByRole("region", { name: "Autopilot" });
const tool = (name: string, args: Record<string, unknown>): FakeStep => ({ mcp: { tool: name, arguments: args } });

const ASK = "The Windows build is slow. Find out why the Windows build is slow, and exclude the output folder from Defender scans.";

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

test("Autopilot is off until you accept what it may do and set its limits", async () => {
  const { page, repo } = h;
  const start = page.getByRole("region", { name: "Start" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.getByRole("button", { name: "Open folder" }).click();
  await start.locator("button.ptile", { hasText: basename(repo) }).click();
  await page.locator("#app-sidebar").getByRole("button", { name: "Tasks", exact: true }).click();
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+Shift+A");
  const s = strip(page);
  await expect(s).toBeVisible();
  await expect(s.getByText("Off", { exact: true })).toBeVisible();
  // Nothing outward-facing shows in the status bar while it is off.
  await expect(page.locator(".statusbar").getByRole("button", { name: /Stop Autopilot/ })).toHaveCount(0);

  await s.getByRole("button", { name: "Turn on…" }).click();
  const consent = s.getByRole("alertdialog", { name: "Turn on Autopilot for this project" });
  await expect(consent).toBeVisible();
  await expect(consent.getByText("pushing, pull requests and merging")).toBeVisible();
  await expect(consent.getByText("Inbox questions and approvals, Medium and High risk included")).toBeVisible();
  await consent.getByLabel("Per task (USD)").fill("5");
  await consent.getByLabel("Per day (USD)").fill("20");
  await shoot(page, "consent");
  await consent.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(consent).toHaveCount(0);
  await expect(s.getByText("On", { exact: true })).toBeVisible();
  await expect(s.getByText("You allowed Autopilot here on", { exact: false })).toBeVisible();
  await expect(page.locator(".statusbar").getByRole("button", { name: /Stop Autopilot/ })).toBeVisible();
});

test("the assistant runs a research task to done, and the code task's pull request waits for you", async () => {
  const { page } = h;
  h.setScripts({
    assistant: [
      [
        { emit: { type: "turn.started", turnRef: null } },
        tool("create_task", { title: "Find why the Windows build is slow", kind: "research", size: "S", acceptance_criteria: ["Which step takes longest?"], basis: "Find out why the Windows build is slow", sources: [{ kind: "file", ref: "README.md" }], reason: "You asked to find the cause." }),
        tool("approve_crew", { task_id: "{{mcp.0.task_id}}", reason: "The estimate fits the per-task limit." }),
        tool("create_task", { title: "Exclude the output folder from Defender", kind: "code", size: "S", acceptance_criteria: ["The build output folder is excluded"], basis: "exclude the output folder from Defender scans", reason: "You asked for the exclusion." }),
        tool("approve_crew", { task_id: "{{mcp.2.task_id}}", reason: "Small change, fits the limits." }),
        say("Started a research task and a code task."),
        // Crewyard's note that the research finished arrives as the next turn.
        { awaitTurn: true },
        tool("read_task", { task_id: "{{mcp.0.task_id}}" }),
        tool("complete_task", { task_id: "{{mcp.0.task_id}}", reason: "The report names the slow step." }),
        tool("complete_task", { task_id: "{{mcp.2.task_id}}", reason: "Trying to close the code task too." }),
        say("Marked the research done. The code task waits for your review and pull request."),
      ],
    ],
    researcher: [[running, say("Findings: Defender scans the build output folder; that step takes most of the time.")]],
    implementer: [[running, { wait: 1500 }, say("Excluded the output folder.")]],
    reviewer: [[running, say("Reviewed.")]],
  });
  const p = panel(page);
  const box = p.getByLabel("Message to the task assistant");
  await box.fill(ASK);
  await box.press("Enter");

  const log = p.getByRole("log", { name: "Conversation with the task assistant" });
  await expect(log.getByText("Marked the research done.", { exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(log.getByText("Autopilot: Created a task.").first()).toBeVisible();
  await expect(log.getByText("Autopilot: Approved a crew.").first()).toBeVisible();
  await expect(log.getByText("Autopilot told the assistant: one of its tasks finished.")).toBeVisible();
  await expect(log.getByText("Autopilot was refused: Marked an analysis done.")).toBeVisible();

  type Row = { id: string; title: string; kind: string; status: string };
  const tasks = async () => await daemon<Row[]>(page, "tasks.list", {});
  await expect.poll(async () => (await tasks()).find((t) => t.kind === "code")?.status, { timeout: 30_000 }).toBe("review");
  const rows = await tasks();
  const research = rows.find((t) => t.kind === "research")!;
  const code = rows.find((t) => t.kind === "code")!;
  expect(research.status).toBe("done");
  // Ready for review, never merged: no pull request was opened, pushing and the PR are yours.
  const detail = await daemon<{ pullRequest?: unknown; status: string }>(page, "tasks.get", { taskId: code.id });
  expect(detail.status).toBe("review");
  expect(detail.pullRequest ?? null).toBeNull();

  const projects = await daemon<Array<{ id: string; path: string }>>(page, "projects.list", undefined);
  const projectId = projects.find((x) => x.path.toLowerCase() === h.repo.toLowerCase())!.id;
  const view = await daemon<{ log: Array<{ action: string; outcome: string; code: string | null }>; tasks: Array<{ taskId: string; completedAt: string | null }> }>(page, "autopilot.get", { projectId });
  expect(view.log.map((l) => [l.action, l.outcome, l.code]).reverse()).toEqual(
    expect.arrayContaining([
      ["create_task", "done", null],
      ["approve_crew", "done", null],
      ["complete_task", "done", null],
      ["complete_task", "refused", "code_task"],
    ]),
  );
  expect(view.tasks.find((t) => t.taskId === research.id)?.completedAt).not.toBeNull();
  expect(view.tasks.find((t) => t.taskId === code.id)?.completedAt).toBeNull();

  // The strip's log lists every call with the agent's reason as text.
  const s = strip(page);
  await s.getByText("Autopilot log").click();
  await expect(s.getByText("The report names the slow step.")).toBeVisible();
  await expect(s.getByText("Refused: code tasks wait for you")).toBeVisible();
  await shoot(page, "log");

  // The research report says who marked it done.
  await page.getByRole("button", { name: "Open report" }).first().click();
  await expect(page.getByText("Marked done by Autopilot on", { exact: false })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("Stop Autopilot in the status bar refuses everything at once and leaves agents alone", async () => {
  const { page } = h;
  const s = strip(page);
  await page.locator(".statusbar").getByRole("button", { name: /Stop Autopilot/ }).click();
  await expect(s.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(s.getByText("every Autopilot action is refused in every project", { exact: false })).toBeVisible();
  await shoot(page, "stopped");
  const global = await daemon<{ killed: boolean }>(page, "autopilot.global", {});
  expect(global.killed).toBe(true);
  await page.locator(".statusbar").getByRole("button", { name: /Lift the stop/ }).click();
  await expect(s.getByText("On", { exact: true })).toBeVisible();
});
