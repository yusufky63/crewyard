import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { packageDirOf } from "./scripts/third-party-licenses.mjs";

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

// Which npm packages each bundle really contains, for the licence list that ships with the installer
// (scripts/third-party-licenses.mjs). Modules tree-shaken to nothing are left out; fonts and other
// assets count through the file they came from.
const bundledPackages = (target: string): Plugin => {
  let root = import.meta.dirname;
  return {
    name: "crewyard-bundled-packages",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const dirs = new Set<string>();
      // Asset sources are relative to the build's root; module ids are absolute.
      const add = (id: string) => {
        const dir = packageDirOf(id.startsWith("\0") ? id : resolve(root, id));
        if (dir) dirs.add(dir);
      };
      for (const out of Object.values(bundle)) {
        if (out.type === "asset") out.originalFileNames.forEach(add);
        else for (const [id, mod] of Object.entries(out.modules)) if (mod.renderedLength > 0 || /\.css($|\?)/.test(id)) add(id);
      }
      const dir = resolve(import.meta.dirname, "out/third-party");
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, `${target}.json`), JSON.stringify([...dirs].sort(), null, 2));
    },
  };
};

export default defineConfig({
  main: {
    plugins: [bundledPackages("main")],
    // electron-updater's GitHub provider parses XML with sax; the generic feed we use never does (src/main/updater/no-xml.ts).
    resolve: { alias: { sax: resolve(import.meta.dirname, "src/main/updater/no-xml.ts") } },
    build: {
      // electron-updater is bundled too: the installer ships no node_modules (docs/adr/0004).
      externalizeDeps: { exclude: [...workspace, "electron-updater"] },
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/main/index.ts"),
          daemon: resolve(import.meta.dirname, "../../packages/daemon/src/entry.ts"),
          // The terminals' utility process (docs/adr/0016-terminal.md); node-pty stays external.
          "pty-host": resolve(import.meta.dirname, "src/main/terminal/pty-host.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [bundledPackages("preload")],
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
    plugins: [react(), csp(), bundledPackages("renderer")],
    build: {
      rollupOptions: { input: resolve(import.meta.dirname, "src/renderer/index.html") },
    },
  },
});
