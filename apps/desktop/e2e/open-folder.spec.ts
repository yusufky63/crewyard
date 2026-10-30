import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { daemon, launch, type Harness } from "./harness.ts";

// Opening a folder from outside the app (PLAN.md §12). A second `Crewyard.exe <folder>` reaches the
// running app as `second-instance`; a drop reaches it as `crewyard:open-folder`. Both are emitted here
// on the main process, since Playwright cannot start a second instance or drag from Explorer.

test.describe.configure({ mode: "serial" });

let h: Harness;

test.beforeAll(async () => {
  h = await launch();
  await expect(h.page.getByRole("region", { name: "Start" })).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await h?.close();
});

interface Project {
  id: string;
  path: string;
}

/** What a second start hands over: its own parsed folder, or (an older build) only its argv. */
const secondStart = (argv: string[], cwd: string, folder?: string) =>
  h.app.evaluate(({ app }, [a, c, f]) => {
    app.emit("second-instance", {}, a, c, f === undefined ? {} : { folder: f });
  }, [argv, cwd, folder] as const);

const drop = (path: string) =>
  h.app.evaluate(({ ipcMain }, p) => {
    ipcMain.emit("crewyard:open-folder", {}, p);
  }, path);

test("a new folder from a second start opens New project at step 1 and writes nothing", async () => {
  const folder = join(h.root, "new folder! (1)");
  mkdirSync(folder);
  await secondStart(["Crewyard.exe", folder], h.root, folder);
  const setup = h.page.getByRole("region", { name: "New project" });
  await expect(setup).toBeVisible();
  await expect(setup.getByText("Step 1 of", { exact: false })).toBeVisible();
  await expect(setup.locator(".row-input .input")).toHaveText(folder);
  const projects = await daemon<Project[]>(h.page, "projects.list", undefined);
  expect(projects.some((p) => p.path.toLowerCase() === folder.toLowerCase())).toBe(false);
  expect(existsSync(join(folder, ".crewyard"))).toBe(false);
  await setup.getByRole("button", { name: "Cancel" }).click();
});

test("an older second start without additionalData is read from its argv, relative to its folder", async () => {
  mkdirSync(join(h.root, "rel dir"));
  // A development run: electron.exe, the app folder, then the user's arguments with switches mixed in.
  await secondStart(["electron.exe", "C:\\app", "--original-process-start-time=1", "rel dir"], h.root);
  await expect(h.page.getByRole("region", { name: "New project" }).locator(".row-input .input")).toHaveText(join(h.root, "rel dir"));
  await h.page.getByRole("region", { name: "New project" }).getByRole("button", { name: "Cancel" }).click();
});

test("a known project opens however its path is spelled", async () => {
  await daemon(h.page, "projects.add", { path: h.repo });
  await drop(`${h.repo.toUpperCase()}\\`);
  await expect(h.page.locator("#app-sidebar")).toBeVisible();
  await expect(h.page.getByLabel("New task")).toBeVisible();
});

test("WSL, network, missing and file paths are refused on the Start screen", async () => {
  const start = h.page.getByRole("region", { name: "Start" });
  await drop("\\\\wsl$\\Ubuntu\\home\\me");
  await expect(start.getByRole("alert")).toContainText("inside WSL");
  await drop("\\\\server\\share\\repo");
  await expect(start.getByRole("alert")).toContainText("network path");
  await drop(join(h.root, "gone"));
  await expect(start.getByRole("alert")).toContainText("does not exist");
  const file = join(h.root, "notes.txt");
  writeFileSync(file, "x");
  await drop(file);
  await expect(start.getByRole("alert")).toContainText("a file, not a folder");
  await start.getByRole("alert").getByRole("button", { name: "Dismiss" }).click();
  await expect(start.getByRole("alert")).toHaveCount(0);
});
