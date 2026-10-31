import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { daemon, launch, type Harness } from "./harness.ts";

// Settings → Instructions and skills (docs/adr/0015). Discovery reads a temp home folder
// (CREWYARD_E2E_HOME, e2e only); a skill found there is shared with one Codex profile, which gets
// a copy in its own config folder, and a later edit shows as out of date until Sync.

test.describe.configure({ mode: "serial" });

let h: Harness;
let home: string;

const SKILL = "---\nname: release-notes\ndescription: Writes release notes from the git log\nallowed-tools: Bash(git log:*)\n---\nRead the log since the last tag.\n";

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "shoot-crewyard-e2e-home "));
  const skill = join(home, ".claude", "skills", "release notes");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), SKILL);
  writeFileSync(join(home, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"never-read"}}');
  h = await launch({ env: { CREWYARD_E2E_HOME: home } });
  const start = h.page.getByRole("region", { name: "Start" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.getByRole("button", { name: "Open folder" }).click();
  await start.locator("button.ptile", { hasText: basename(h.repo) }).click();
  await expect(h.page.locator("#app-sidebar")).toBeVisible();
});

test.afterAll(async () => {
  await h?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

interface Profile {
  id: string;
  alias: string;
  configDir: string;
}

test("lists a skill from your home folder and shares it with one profile", async () => {
  const { page } = h;
  // A Codex profile that signs in on its own needs no key; its folder lives under the e2e data folder.
  const profile = await daemon<Profile>(page, "providers.profileCreate", { alias: "work-two", runner: "codex", providerId: "openai", credentialId: null, defaultModel: null });
  await page.locator("#app-sidebar").getByRole("button", { name: "Settings" }).click();
  const section = page.locator("#settings-agentfiles");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByRole("heading", { name: "Instructions and skills" })).toBeVisible();
  await expect(section.getByText(home, { exact: false })).toBeVisible();

  // Keyboard: the tool group opens with Enter.
  const group = section.getByRole("button", { name: /Claude Code.*1 skill/ });
  await group.focus();
  await page.keyboard.press("Enter");
  await expect(group).toHaveAttribute("aria-expanded", "true");
  const item = section.locator(".af-item", { hasText: "release notes" });
  await expect(item.getByText("Writes release notes from the git log")).toBeVisible();
  await expect(item.getByText("A copy leaves out: allowed-tools.")).toBeVisible();
  // The credentials file next to it is never listed.
  await expect(section.getByText(".credentials.json")).toHaveCount(0);

  await item.getByRole("button", { name: "Preview" }).click();
  await expect(item.getByLabel("Start of release notes")).toContainText("Read the log since the last tag.");

  await item.getByRole("button", { name: "Share", exact: true }).click();
  const form = item.getByRole("group", { name: "Share release notes" });
  await form.getByRole("group", { name: "Runner" }).getByRole("button", { name: "Codex" }).click();
  await form.getByLabel("Profiles").selectOption({ label: "work-two" });
  await form.getByRole("button", { name: "Share and copy" }).click();
  await expect(form).toHaveCount(0);

  const copy = join(profile.configDir, "skills", "release notes", "SKILL.md");
  expect(existsSync(copy)).toBe(true);
  expect(readFileSync(copy, "utf8")).not.toContain("allowed-tools");
  const shared = section.locator(".mcp-list li", { hasText: "work-two" });
  await expect(shared.getByText("Up to date")).toBeVisible();

  // An edit to the original shows as out of date until Sync copies it again.
  writeFileSync(join(home, ".claude", "skills", "release notes", "SKILL.md"), SKILL.replace("last tag", "last release"));
  await section.getByRole("button", { name: "Look again" }).click();
  await expect(shared.getByText("Changed since the copy")).toBeVisible();
  await shared.getByRole("button", { name: "Sync" }).click();
  await expect(shared.getByText("Up to date")).toBeVisible();
  expect(readFileSync(copy, "utf8")).toContain("last release");
});

test("the project bridge is off by default and turns on in Settings", async () => {
  const { page, repo } = h;
  writeFileSync(join(repo, "AGENTS.md"), "Use pnpm.\n");
  const section = page.locator("#settings-agentfiles");
  await section.getByRole("button", { name: "Look again" }).click();
  const toggle = section.getByRole("group", { name: "Offer this project's instruction files to every runner" });
  await expect(toggle.getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
  const projects = await daemon<Array<{ id: string; path: string }>>(page, "projects.list", undefined);
  const projectId = projects.find((p) => p.path.toLowerCase() === repo.toLowerCase())!.id;
  const file = section.locator(".af-bridge-files li", { hasText: "AGENTS.md" });
  await expect(file.getByRole("checkbox")).toBeDisabled();
  await toggle.getByRole("button", { name: "On" }).click();
  await expect.poll(async () => (await daemon<{ enabled: boolean }>(page, "agentfiles.bridge", { projectId })).enabled).toBe(true);
  await expect(file.getByRole("checkbox")).toBeChecked();
  await expect(file.getByText("Claude Code: in its system prompt")).toBeVisible();
});
