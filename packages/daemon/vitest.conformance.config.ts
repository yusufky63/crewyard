import { defineConfig } from "vitest/config";

// `pnpm conformance`: the installed runner CLIs against a scripted local model server, free and
// deterministic (PLAN.md §5.4). Opt-in with CREWYARD_CONFORMANCE=1; the files end in
// .conformance.ts so `pnpm check` and CI never see them.
export default defineConfig({
  test: {
    include: ["src/conformance/**/*.conformance.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 10 * 60_000,
    hookTimeout: 2 * 60_000,
  },
});
