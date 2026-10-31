import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { daemon, launch, running, type Harness } from "./harness.ts";

// A ready-made analysis end to end (docs/adr/0014): the owner typed "projeyi incele" and saw only
// "Done". Here the composer's preset makes a research task, the fake researcher ends with checked
// findings, the row shows the report's first line with tone badges, the inspector the whole
// report with findings that expand, filter, copy and jump to their two suggested drafts, and the
// Suggested tab adds both as tasks waiting for their crews. The assistant panel puts a
// preset in its drafts without any model call. Screenshots land in apps/desktop/screens/report.

test.describe.configure({ mode: "serial" });

let h: Harness;
const shots = join(import.meta.dirname, "..", "screens", "report");

test.beforeAll(async () => {
  h = await launch();
  mkdirSync(shots, { recursive: true });
});

test.afterAll(async () => {
  await h?.close();
});

const FINDINGS = {
  summary: "Two problems stand out: a token reaches the debug log, and the retry loop never gives up.",
  findings: [
    {
      title: "Token logged on auth failure",
      severity: "high",
      file: "src/auth.ts",
      line: 42,
      detail: "The Authorization header is written to <b>debug.log</b> when a request fails.",
      suggestedTask: { title: "Redact the Authorization header in logs", description: "Strip the header before logging.", kind: "code", acceptanceCriteria: ["No token in debug.log"] },
    },
    {
      title: "Retry loop has no cap",
      severity: "medium",
      file: "src/net.ts",
      line: null,
      detail: "A failing endpoint is retried forever.",
      suggestedTask: { title: "Cap network retries at five", description: "Back off and stop after five tries.", kind: "code", acceptanceCriteria: ["Stops after five tries"] },
    },
    { title: "README is current", severity: "info", file: null, line: null, detail: "Nothing to do.", suggestedTask: null },
  ],
};

async function look(page: Page, width: number, theme: "dark" | "light") {
  await h.app.evaluate(({ BrowserWindow }, [w]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, 1000), [width]);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
  const html = page.locator("html");
  for (let i = 0; i < 3 && (await html.getAttribute("data-theme")) !== theme; i++) await page.locator(".statusbar").getByTitle(/theme/i).click();
  await expect(html).toHaveAttribute("data-theme", theme);
}

test("a preset from the composer runs as a research task and its report shows on the row", async () => {
  const { page, repo } = h;
  const start = page.getByRole("region", { name: "Start" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.getByRole("button", { name: "Open folder" }).click();
  await start.locator("button.ptile", { hasText: basename(repo) }).click();
  await page.locator("#app-sidebar").getByRole("button", { name: "Tasks", exact: true }).click();

  h.setScripts({ researcher: [[running, { emit: { type: "run.ended", reason: "completed", output: { ok: true, value: FINDINGS } } }]] });
  const main = page.locator("main");
  await main.getByLabel("Ready-made").selectOption({ label: "Find bugs and problems" });
  await expect(main.getByLabel("New task")).toHaveValue(/^Find bugs and problems\nFind bugs and likely failures/);
  await expect(main.getByLabel("Kind")).toHaveValue("research");
  await main.getByRole("button", { name: "Propose crew" }).click();
  await main.getByRole("region", { name: /Suggested crew for/ }).getByRole("button", { name: "Approve and start" }).click();
  await expect.poll(async () => (await daemon<Array<{ title: string; status: string; kind: string }>>(page, "tasks.list", {})).map((t) => [t.title, t.kind, t.status]), { timeout: 20_000 }).toEqual([["Find bugs and problems", "research", "done"]]);

  const row = main.locator(".tk-row", { hasText: "Find bugs and problems" });
  await expect(row.locator(".tk-report-text")).toHaveText(FINDINGS.summary);
  await expect(row.getByText("3 findings")).toBeVisible();
  await expect(row.getByText("2 suggested tasks")).toBeVisible();
  for (const width of [1280, 1920]) {
    for (const theme of ["dark", "light"] as const) {
      await look(page, width, theme);
      await page.screenshot({ path: join(shots, `row-${theme}-${width}.png`) });
    }
  }
  await look(page, 1280, "dark");
});

test("Open report shows the whole report in the inspector: findings expand, filter, copy and jump to their drafts", async () => {
  const { page } = h;
  const main = page.locator("main");
  await main.locator(".tk-row", { hasText: "Find bugs and problems" }).getByRole("button", { name: "Open report" }).click();
  const inspector = page.locator("#app-inspector");
  const report = inspector.getByRole("region", { name: "Report" });
  await expect(report).toBeVisible();
  // The source and the verdict are badges; the summary is text-only Markdown.
  await expect(report.locator(".tk-report-head .badge", { hasText: "Findings" })).toBeVisible();
  await expect(report.locator(".tk-report-summary")).toHaveText(FINDINGS.summary);
  const list = report.getByRole("list", { name: "Findings" });
  await expect(list.locator(".tk-finding")).toHaveCount(3);
  await expect(report.locator(".tk-finding-title", { hasText: "Token logged on auth failure" })).toBeVisible();
  await expect(report.getByText("src/auth.ts:42", { exact: true })).toBeVisible();

  // The severity bar filters the list, and a second click shows everything again.
  const bar = report.getByRole("group", { name: "Filter findings by severity" });
  await expect(bar.getByRole("button")).toHaveText(["High 1", "Medium 1", "Info 1"]);
  await bar.getByRole("button", { name: "Medium 1" }).click();
  await expect(bar.getByRole("button", { name: "Medium 1" })).toHaveAttribute("aria-pressed", "true");
  await expect(list.locator(".tk-finding")).toHaveCount(1);
  await expect(report.getByText("Showing 1 of 3")).toBeVisible();
  await bar.getByRole("button", { name: "Medium 1" }).click();
  await expect(list.locator(".tk-finding")).toHaveCount(3);

  // Rows are buttons: keyboard reaches them, arrows move, Enter expands; the detail stays text.
  const first = list.locator(".tk-finding-toggle").first();
  await first.focus();
  await page.keyboard.press("ArrowDown");
  await expect(list.locator(".tk-finding-toggle").nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(first).toBeFocused();
  await expect(report.locator(".tk-finding-detail")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await expect(report.locator("b")).toHaveCount(0);
  await expect(report.locator(".tk-finding-detail", { hasText: "<b>debug.log</b>" })).toBeVisible();

  // Copy puts the finding on the clipboard as plain text.
  await report.locator(".tk-finding.open").getByRole("button", { name: "Copy" }).click();
  await expect(report.locator(".tk-finding.open").getByRole("button", { name: "Copied" })).toBeVisible();
  // Windows hands clipboard text back with CRLF line ends.
  expect((await h.app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, "\n")).toBe("[High] Token logged on auth failure\nsrc/auth.ts:42\n\nThe Authorization header is written to <b>debug.log</b> when a request fails.");

  // The file opens in the Files tab when the task has a worktree, and is copied when it has none.
  const tasks = await daemon<Array<{ id: string; title: string }>>(page, "tasks.list", {});
  const task = await daemon<{ worktree: { path: string } | null }>(page, "tasks.get", { taskId: tasks.find((t) => t.title === "Find bugs and problems")!.id });
  if (!task.worktree) {
    await report.getByRole("button", { name: "src/auth.ts:42" }).click();
    await expect(report.getByText("Path copied")).toBeVisible();
    expect(await h.app.evaluate(({ clipboard }) => clipboard.readText())).toBe("src/auth.ts:42");
  } else {
    await report.getByRole("button", { name: "src/auth.ts:42" }).click();
    await expect(inspector.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    await expect(inspector.getByRole("region", { name: /src\/auth\.ts/ })).toBeVisible();
    await inspector.getByRole("tab", { name: "Details" }).click();
  }

  // The finding jumps to its suggested draft at the bottom of Details.
  const suggested = inspector.getByRole("region", { name: "Suggested tasks" });
  await report.locator(".tk-finding.open").getByRole("button", { name: "Its suggested task" }).click();
  await expect(suggested.locator(".tk-suggested-slot").first()).toBeFocused();
  await expect(suggested.locator(".tk-suggested-slot").first().getByRole("article", { name: /Redact the Authorization header/ })).toBeInViewport();
  await expect(suggested.getByRole("article")).toHaveCount(2);
  await expect(suggested.getByText("2 open")).toBeVisible();

  for (const width of [1280, 1920]) {
    for (const theme of ["dark", "light"] as const) {
      await look(page, width, theme);
      await report.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(shots, `inspector-${theme}-${width}.png`) });
    }
  }
  await look(page, 1280, "dark");
});

test("the Suggested tab lists the drafts with their count, and Add all adds each as a task waiting for its crew", async () => {
  const { page } = h;
  const inspector = page.locator("#app-inspector");
  const tab = inspector.getByRole("tab", { name: "Suggested 2" });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const suggested = inspector.getByRole("region", { name: "Suggested tasks" });
  await expect(suggested.getByRole("article")).toHaveCount(2);
  await expect(suggested.getByText("Nothing starts until you approve each crew", { exact: false })).toBeVisible();
  for (const width of [1280, 1920]) {
    for (const theme of ["dark", "light"] as const) {
      await look(page, width, theme);
      await page.screenshot({ path: join(shots, `suggested-${theme}-${width}.png`) });
    }
  }
  await look(page, 1280, "dark");

  await suggested.getByRole("button", { name: "Add all as drafts (2)" }).click();
  await expect(suggested.getByText("2 tasks added. Each crew waits for your approval in Tasks.")).toBeVisible();
  await expect.poll(async () => (await daemon<Array<{ title: string; status: string }>>(page, "tasks.list", {})).map((t) => [t.title, t.status]).sort()).toEqual([
    ["Cap network retries at five", "proposed"],
    ["Find bugs and problems", "done"],
    ["Redact the Authorization header in logs", "proposed"],
  ]);
  // Added drafts stay on show as added; nothing is open, so the count and Add all go.
  await expect(suggested.getByText("Added to Tasks. Its crew waits for your approval.")).toHaveCount(2);
  await expect(inspector.getByRole("tab", { name: "Suggested", exact: true })).toBeVisible();
  await expect(suggested.getByRole("button", { name: /Add all as drafts/ })).toHaveCount(0);
});

test("the assistant panel puts a ready-made task in its drafts without a model call", async () => {
  const { page, repo } = h;
  await page.keyboard.press("Escape");
  await page.locator("#tk-assistant-toggle").click();
  const panel = page.getByRole("region", { name: "Task assistant" });
  await expect(panel).toBeVisible();
  const presets = panel.locator(".as-presets");
  await expect(presets.getByText("For this project")).toBeVisible();
  // The e2e repository has no test command, so that preset comes first, with why.
  await expect(presets.getByRole("button").first()).toHaveText("Find test coverage gaps");
  await expect(presets.getByText("no test command is set", { exact: false })).toBeVisible();
  await expect(presets.getByText(/about \$0\.\d{4}/)).toBeVisible();
  await presets.getByRole("button", { name: "Find security issues" }).click();
  const drafts = panel.getByRole("region", { name: "Task drafts" });
  await expect(drafts.getByRole("article", { name: /Find security issues/ })).toBeVisible();
  const projects = await daemon<Array<{ id: string; path: string }>>(page, "projects.list", undefined);
  const projectId = projects.find((p) => p.path.toLowerCase() === repo.toLowerCase())!.id;
  const view = await daemon<{ state: string; lines: unknown[] }>(page, "assistant.get", { projectId });
  expect(view).toMatchObject({ state: "idle", lines: [] });
  for (const width of [1280, 1920]) {
    for (const theme of ["dark", "light"] as const) {
      await look(page, width, theme);
      await page.screenshot({ path: join(shots, `presets-${theme}-${width}.png`) });
    }
  }
});
