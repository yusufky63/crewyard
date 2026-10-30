import { defineConfig } from "@playwright/test";

// Screenshots over a live run's data (capture.live.ts). Separate from playwright.config.ts, whose
// `*.spec.ts` match keeps this folder out of `pnpm e2e`.
export default defineConfig({
  testDir: ".",
  testMatch: "*.live.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../../out/e2e-live-results",
});
