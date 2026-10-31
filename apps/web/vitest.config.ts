import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

// The site's unit tests, run by the root `pnpm test` as the "web" project. `server-only` is Next's
// guard against importing server code into the browser; outside Next it is an empty module.
export default defineProject({
  resolve: {
    alias: { "server-only": fileURLToPath(new URL("./lib/server-only.stub.ts", import.meta.url)) },
  },
  test: {
    name: "web",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts", "components/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
