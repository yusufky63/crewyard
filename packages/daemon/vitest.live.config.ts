import { defineConfig } from "vitest/config";

// `pnpm --filter @crewyard/daemon live`: real runners, real keys, real money (cents). Opt-in with
// CREWYARD_LIVE=1 under env-vault `run`; the files end in .live.ts so `pnpm check` never sees them.
export default defineConfig({
  test: {
    include: ["src/live/**/*.live.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
