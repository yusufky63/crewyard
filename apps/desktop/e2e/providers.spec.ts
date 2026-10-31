import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import { launch, type Harness } from "./harness.ts";

// The Works with column shows runner marks, not names (DESIGN.md §5 ProvidersTable), so each chip
// must keep its meaning for the keyboard and screen readers: a name, one tab stop per row, and a
// tooltip on focus that Escape closes.

let h: Harness;

test.beforeAll(async () => {
  h = await launch();
  const start = h.page.getByRole("region", { name: "Start" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.getByRole("button", { name: "Open folder" }).click();
  await start.locator("button.ptile", { hasText: basename(h.repo) }).click();
  await h.page.getByRole("button", { name: "Providers" }).click();
});

test.afterAll(async () => {
  await h?.close();
});

test("Providers: runner icons carry their state by name, keyboard and tooltip", async () => {
  const page = h.page;
  const row = page.getByRole("group", { name: "Runners that work with DeepSeek" });
  const claude = row.getByRole("img", { name: "Claude Code: works directly" });
  const codex = row.getByRole("img", { name: "Codex: through the profile's config" });
  await expect(claude).toHaveAttribute("tabindex", "0");
  await expect(codex).toHaveAttribute("tabindex", "-1");

  await claude.focus();
  const tip = page.getByRole("tooltip").filter({ hasText: "ANTHROPIC_BASE_URL" });
  await expect(tip).toBeVisible();
  await expect(claude).toHaveAccessibleDescription(/Anthropic-compatible endpoint/);

  await page.keyboard.press("ArrowRight");
  await expect(codex).toBeFocused();
  await expect(tip).toBeHidden();
  await expect(page.getByRole("tooltip").filter({ hasText: "model_providers" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip").filter({ hasText: "model_providers" })).toBeHidden();
  await expect(codex).toBeFocused();
  // The roving stop stays on the runner last visited.
  await expect(codex).toHaveAttribute("tabindex", "0");

  await page.getByRole("button", { name: "What the runner icons mean" }).focus();
  await expect(page.getByRole("tooltip").filter({ hasText: "Its frame says how it connects" })).toBeVisible();
});
