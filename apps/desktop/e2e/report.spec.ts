import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { daemon, launch, running, type Harness } from "./harness.ts";

// A ready-made analysis end to end (docs/adr/0014): the owner typed "projeyi incele" and saw only
// "Done". Here the composer's preset makes a research task, the fake researcher ends with checked
// findings, the row shows the report's first line, the inspector the whole report with two
// suggested drafts, and one is added as a task waiting for its crew. The assistant panel puts a
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

test("Open report shows the whole report in the inspector, and one suggested draft is added", async () => {
  const { page } = h;
  const main = page.locator("main");
  await main.locator(".tk-row", { hasText: "Find bugs and problems" }).getByRole("button", { name: "Open report" }).click();
  const report = page.locator("#app-inspector").getByRole("region", { name: "Report" });
  await expect(report).toBeVisible();
  await expect(report.getByText("Findings", { exact: true })).toBeVisible();
  await expect(report.locator(".tk-finding-title", { hasText: "Token logged on auth failure" })).toBeVisible();
  await expect(report.getByText("src/auth.ts:42", { exact: true })).toBeVisible();
  // Agent text stays text.
  await expect(report.locator("b")).toHaveCount(0);
  await expect(report.locator(".tk-finding-detail", { hasText: "<b>debug.log</b>" })).toBeVisible();
  const drafts = report.getByRole("article");
  await expect(drafts).toHaveCount(2);
  for (const width of [1280, 1920]) {
    for (const theme of ["dark", "light"] as const) {
      await look(page, width, theme);
      await page.screenshot({ path: join(shots, `inspector-${theme}-${width}.png`) });
    }
  }
  await look(page, 1280, "dark");

  const first = report.getByRole("article", { name: /Redact the Authorization header/ });
  await first.getByRole("button", { name: "Add as draft" }).click();
  await expect.poll(async () => (await daemon<Array<{ title: string; status: string }>>(page, "tasks.list", {})).map((t) => [t.title, t.status]).sort()).toEqual([
    ["Find bugs and problems", "done"],
    ["Redact the Authorization header in logs", "proposed"],
  ]);
  await expect(report.getByText("Added to Tasks. Its crew waits for your approval.")).toBeVisible();
  await report.getByRole("article", { name: /Cap network retries/ }).getByRole("button", { name: "Discard" }).click();
  await expect(report.getByRole("article")).toHaveCount(1);

  // Open task on the added draft takes you to it from the inspector: the task selected, its row
  // focused, and the inspector moved from the report to that task on Details.
  await report.getByRole("article", { name: /Redact the Authorization header/ }).getByRole("button", { name: "Open task" }).click();
  const row = main.locator(".tk-row", { hasText: "Redact the Authorization header in logs" });
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(row.locator("[data-list-id]")).toBeFocused();
  const inspector = page.locator("#app-inspector");
  await expect(report).toHaveCount(0);
  await expect(inspector).toContainText("Redact the Authorization header in logs");
  await expect(inspector.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
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
