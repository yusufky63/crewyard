import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

// Workspace packages export TypeScript source, so they are bundled instead of externalized.
const workspace = ["@crewyard/core", "@crewyard/proc", "@crewyard/daemon", "@crewyard/ui", "@crewyard/adapter-fake", "@crewyard/adapter-claude", "@crewyard/adapter-codex", "@crewyard/adapter-opencode", "@crewyard/adapter-acp"];

// A strict CSP for built pages; the dev server needs inline scripts for React refresh.
const csp = (): Plugin => ({
  name: "crewyard-csp",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'" />`,
    ),
});

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: workspace },
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/main/index.ts"),
          daemon: resolve(import.meta.dirname, "../../packages/daemon/src/entry.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: workspace },
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/preload/index.ts") },
        // Sandboxed preloads must be CommonJS.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    plugins: [react(), csp()],
    build: {
      rollupOptions: { input: resolve(import.meta.dirname, "src/renderer/index.html") },
    },
  },
});
