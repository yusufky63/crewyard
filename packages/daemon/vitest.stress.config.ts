import { defineConfig } from "vitest/config";

// `pnpm stress`: the admission stress test is slow, so it stays out of `pnpm check`.
// --expose-gc lets it measure retained memory instead of garbage that is merely uncollected.
export default defineConfig({
  test: {
    include: ["src/**/*.stress.ts"],
    pool: "forks",
    execArgv: ["--expose-gc"],
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
