import { defineConfig } from "vitest/config";

// Many tests spawn git, node fixtures and fake agents. On Windows, with the full suite running in
// parallel (and other work on the machine), those can pass the 5 s default without being wrong.
const testTimeout = 30_000;

export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: "packages", include: ["packages/*/src/**/*.test.ts"], testTimeout } },
      { extends: true, test: { name: "desktop", root: "apps/desktop", include: ["src/**/*.test.ts"], testTimeout } },
    ],
  },
});
