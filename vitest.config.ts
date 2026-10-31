import { defineConfig } from "vitest/config";

// Many tests spawn git, node fixtures and fake agents. On Windows, with the full suite running in
// parallel (and other work on the machine), those can pass the 5 s default without being wrong.
const testTimeout = 30_000;

export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: "packages", include: ["packages/*/src/**/*.test.ts"], testTimeout } },
      // Repository scripts, such as the history scan behind docs/public-release-checklist.md.
      { extends: true, test: { name: "scripts", include: ["scripts/**/*.test.ts"], testTimeout } },
      // No fsModuleCache: it keys a transformed file by its own content, so an import.meta.glob in it
      // (locales, screens, the key registry test) kept its old file list and a new file went unseen.
      { extends: true, test: { name: "desktop", root: "apps/desktop", include: ["src/**/*.test.ts", "scripts/**/*.test.ts"], testTimeout, fsModuleCache: false } },
      // The website (apps/web) keeps its own project config for its server-only alias.
      "apps/web/vitest.config.ts",
    ],
  },
});
