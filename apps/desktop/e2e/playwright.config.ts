import { defineConfig } from "@playwright/test";

// App-level end-to-end tests (PLAN.md §15). They drive the built Electron app on a real display,
// so they run locally on Windows with `pnpm e2e` and stay out of `pnpm check` and CI.
// One worker: the flows share one app instance and each launch owns its own throwaway profile.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "../out/e2e-results",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
