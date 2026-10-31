import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { FakeStep } from "@crewyard/adapter-fake";
import { daemon, launch, say, type Harness } from "./harness.ts";

// The task assistant's read tools (docs/adr/0018) against the fake runner, with Autopilot off: the
// agent lists the tasks, reads one and its crew, reads spend and local git through the real report
// pipe, proposes a draft and, in a second turn, refines it with edit_draft. The conversation shows
// one line per call worded by the panel in the person's language ("Read task: ...", "Görevi
// okudu: ..."), never the runner's raw tool name, and a refused call says so. The draft card
// follows the agent's edit, and Add creates the task from it. Nothing starts. Screenshots land in
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

const tool = (name: string, args: Record<string, unknown> = {}): FakeStep => ({ mcp: { tool: name, arguments: args } });

async function look(page: Page, width: number, theme: "dark" | "light") {
  await h.app.evaluate(({ BrowserWindow }, [w]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, 1000), [width]);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
  const html = page.locator("html");
  for (let i = 0; i < 3 && (await html.getAttribute("data-theme")) !== theme; i++) await page.locator(".statusbar").getByTitle(/theme|tema/i).click();
  await expect(html).toHaveAttribute("data-theme", theme);
  // The bottom panel at its tallest, so every tool line, the reply and the draft card are in the picture.
  await page.getByRole("separator", { name: /Resize the panel|Paneli/i }).press("End");
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

test("the assistant reads with Autopilot off, refines its own draft, and starts nothing", async () => {
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
        // The runner's own raw line for our tool is left out; Crewyard writes one of its own.
        { emit: { type: "tool.call", toolCallId: "t1", title: "mcp__crewyard__list_tasks", kind: "other", input: {} } },
        tool("list_tasks"),
        tool("read_task", { task_id: task.id }),
        tool("read_crew", { task_id: task.id }),
        tool("read_usage"),
        tool("git_overview", { commits: 3 }),
        tool("read_task", { task_id: "no-such-task" }),
        // mcp result 6: propose_task answers with the new draft's id.
        tool("propose_task", { title: "Fix login", description: "Users land on the home page after signing in.", kind: "code", acceptance_criteria: ["Signing in returns to the page you came from"] }),
        say("There is one task, Fix the login redirect. Its crew waits for your approval. I drafted a follow-up."),
        { awaitTurn: true },
        // A model that sends null for the fields it keeps: only the title changes.
        tool("edit_draft", { draft_id: "{{mcp.6.draft_id}}", title: "Fix the login redirect for SSO users", description: null, kind: null, acceptance_criteria: null }),
        say("I made the draft's title more precise."),
      ],
    ],
  });

  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+Shift+A");
  const p = page.getByRole("region", { name: "Task assistant" });
  await expect(p).toBeVisible();
  const input = p.getByLabel("Message to the task assistant");
  await input.fill("What is going on in this project?");
  await input.press("Enter");

  const log = p.getByRole("log", { name: "Conversation with the task assistant" });
  await expect(log.getByText("I drafted a follow-up.", { exact: false })).toBeVisible({ timeout: 40_000 });
  for (const line of ["Listed tasks", "Read task: Fix the login redirect", "Read crew: Fix the login redirect", "Read spend and limits: last 7 days", `Read git status: ${basename(repo)}`, "Could not read task"]) {
    await expect(log.getByText(line, { exact: true })).toBeVisible();
  }
  await expect(log.getByText("mcp__crewyard__list_tasks")).toHaveCount(0);

  // The card is on screen with the agent's first title before the agent edits it.
  const drafts = p.getByRole("region", { name: "Task drafts" });
  const card = drafts.getByRole("article");
  await expect(card).toHaveCount(1);
  await expect(card.getByLabel("Title")).toHaveValue("Fix login");

  await input.fill("Make the draft more precise.");
  await input.press("Enter");
  await expect(log.getByText("I made the draft's title more precise.", { exact: true })).toBeVisible({ timeout: 40_000 });
  await expect(log.getByText("Edited draft: Fix the login redirect for SSO users", { exact: true })).toBeVisible();
  // The open card follows the agent's edit; the fields it sent as null kept their text.
  await expect(card.getByLabel("Title")).toHaveValue("Fix the login redirect for SSO users");
  await expect(card.getByLabel("Description")).toHaveValue("Users land on the home page after signing in.");

  // Reading started nothing: Autopilot is off, the task is still a proposal with no run.
  const autopilot = await daemon<{ enabled: boolean }>(page, "autopilot.get", { projectId: project!.id });
  expect(autopilot.enabled).toBe(false);
  const detail = await daemon<{ status: string; runs: unknown[] }>(page, "tasks.get", { taskId: task.id });
  expect(detail.status).toBe("proposed");
  expect(detail.runs).toHaveLength(0);

  // Lines are stored as data (tool, outcome, subject), never as English prose.
  const view = await daemon<{ lines: Array<{ role: string; text: string; call?: { tool: string; outcome: string; subject: string | null; days?: number } }> }>(page, "assistant.get", { projectId: project!.id });
  expect(view.lines.filter((l) => l.call).map((l) => [l.call!.tool, l.call!.outcome, l.call!.subject, l.call!.days ?? null])).toEqual([
    ["list_tasks", "done", null, null],
    ["read_task", "done", "Fix the login redirect", null],
    ["read_crew", "done", "Fix the login redirect", null],
    ["read_usage", "done", null, 7],
    ["git_overview", "done", basename(repo), null],
    ["read_task", "refused", null, null],
    ["edit_draft", "done", "Fix the login redirect for SSO users", null],
  ]);

  await shoot(page, "reads");

  // In Turkish the same stored lines read in Turkish.
  await page.locator("#app-sidebar").getByRole("button", { name: "Settings" }).click();
  await page.locator("main").getByRole("group", { name: "Language" }).getByRole("button", { name: "Türkçe" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "tr");
  await page.locator("main").getByRole("button", { name: "[ Geri ]", exact: true }).click();
  const trLog = page.getByRole("log", { name: "Görev asistanıyla sohbet" });
  for (const line of ["Görevlere baktı", "Görevi okudu: Fix the login redirect", "Ekibe baktı: Fix the login redirect", "Harcamaya ve limitlere baktı: son 7 gün", `Git durumuna baktı: ${basename(repo)}`, "Görev okunamadı", "Taslağı düzenledi: Fix the login redirect for SSO users"]) {
    await expect(trLog.getByText(line, { exact: true })).toBeVisible();
  }
  await shoot(page, "reads-tr");

  await page.locator("#app-sidebar").getByRole("button", { name: "Ayarlar" }).click();
  await page.locator("main").getByRole("button", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.locator("main").getByRole("button", { name: "[ Back ]", exact: true }).click();

  // Add creates the task from the agent's edited draft; its crew still waits for approval.
  await card.getByRole("button", { name: "Add as draft" }).click();
  await expect.poll(async () => (await daemon<Array<{ title: string; status: string }>>(page, "tasks.list", { projectId: project!.id })).map((t) => [t.title, t.status])).toContainEqual(["Fix the login redirect for SSO users", "proposed"]);
});
