// Writes the licence files the installer ships (docs/adr/0011-signing-and-auto-update.md):
//   out/third-party/THIRD-PARTY-LICENSES.txt  every npm package bundled into this build, with its licence text
//   out/third-party/NOTICE.txt                the repository's NOTICE
// The package list comes from the build itself (electron.vite.config.ts, one JSON per bundle), so
// only what ships is listed. A package whose licence is outside AGENTS.md's list fails the build,
// unless EXCEPTIONS names it with the reason it may ship.
//
// Run after `electron-vite build`: node scripts/third-party-licenses.mjs

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** AGENTS.md allows MIT, Apache-2.0, ISC and BSD for npm code; fonts are OFL-1.1 (DESIGN.md §3). */
const ALLOWED = new Set(["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "OFL-1.1", "CC0-1.0"]);

/** Packages that ship under other terms, each with the reason. NOTICE says the same. */
const EXCEPTIONS = {
  "@anthropic-ai/claude-agent-sdk": "Anthropic's commercial terms (its LICENSE.md); used only to drive Claude Code with API keys (NOTICE, PLAN.md §6)",
};

/**
 * The folder of the npm package a bundled file came from, or null for our own sources.
 * pnpm keeps packages under node_modules/.pnpm/<id>/node_modules/<name>, so the last node_modules wins.
 * @param {string} id
 * @returns {string | null}
 */
export function packageDirOf(id) {
  const path = id.replace(/^\0/, "").split("?")[0].replace(/\\/g, "/");
  const at = path.lastIndexOf("/node_modules/");
  if (at < 0) return null;
  const rest = path.slice(at + "/node_modules/".length).split("/");
  const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1] ?? ""}` : rest[0];
  if (!name || name.startsWith(".") || name.endsWith("/")) return null;
  return `${path.slice(0, at)}/node_modules/${name}`;
}

/**
 * Whether an SPDX expression is within the allowed list: every AND part, at least one OR choice.
 * @param {string} expression
 */
export function licenceAllowed(expression) {
  const clean = expression.replace(/[()]/g, " ").trim();
  if (!clean) return false;
  return clean.split(/\s+OR\s+/).some((choice) => choice.split(/\s+AND\s+/).every((part) => ALLOWED.has(part.trim())));
}

/** @param {unknown} license */
function licenceName(license) {
  if (typeof license === "string") return license;
  if (license && typeof license === "object" && "type" in license) return String(license.type);
  return "UNKNOWN";
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/**
 * @param {string[]} dirs
 * @returns {{ name: string, version: string, license: string, homepage: string | null, texts: Array<{ file: string, text: string }> }[]}
 */
export function collect(dirs) {
  const seen = new Map();
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    const texts = readdirSync(dir)
      .filter((f) => LICENCE_FILE.test(f))
      .sort()
      .map((file) => ({ file, text: readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n").trim() }));
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    seen.set(key, { name: pkg.name, version: pkg.version, license: licenceName(pkg.license), homepage: pkg.homepage ?? repo ?? null, texts });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** @param {ReturnType<typeof collect>} entries */
export function refused(entries) {
  return entries.filter((e) => !licenceAllowed(e.license) && !(e.name in EXCEPTIONS)).map((e) => `${e.name}@${e.version} (${e.license})`);
}

const RULE = "-".repeat(78);

/** @param {ReturnType<typeof collect>} entries */
export function render(entries) {
  const head = [
    "Crewyard: third-party licences",
    "",
    "The npm packages below are bundled into this build of Crewyard (main process, daemon, preload",
    "and window). Electron's and Chromium's own licences ship next to this file as LICENSE.electron.txt",
    "and LICENSES.chromium.html. NOTICE.txt lists the data and designs Crewyard uses.",
    "",
    `${entries.length} packages.`,
  ];
  const body = entries.flatMap((e) => {
    const lines = [RULE, `${e.name} ${e.version}`, `License: ${e.license}`];
    if (e.name in EXCEPTIONS) lines.push(`Note: ${EXCEPTIONS[e.name]}`);
    if (e.homepage) lines.push(e.homepage);
    lines.push(RULE);
    if (e.texts.length === 0) lines.push(`The package ships no licence file; its package.json declares ${e.license}.`, "");
    for (const t of e.texts) lines.push(`[${t.file}]`, "", t.text, "");
    return lines;
  });
  return [...head, "", ...body].join("\r\n") + "\r\n";
}

function main() {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = join(appDir, "out", "third-party");
  const targets = ["main", "preload", "renderer"];
  const missing = targets.filter((t) => !existsSync(join(outDir, `${t}.json`)));
  if (missing.length) throw new Error(`no package list for ${missing.join(", ")}: run electron-vite build first`);
  const dirs = targets.flatMap((t) => JSON.parse(readFileSync(join(outDir, `${t}.json`), "utf8")));
  const entries = collect(dirs);
  const bad = refused(entries);
  if (bad.length) {
    console.error(`Bundled packages with a licence outside AGENTS.md's list (MIT, Apache-2.0, ISC, BSD):\n  ${bad.join("\n  ")}`);
    process.exit(1);
  }
  writeFileSync(join(outDir, "THIRD-PARTY-LICENSES.txt"), render(entries));
  writeFileSync(join(outDir, "NOTICE.txt"), readFileSync(join(appDir, "..", "..", "NOTICE"), "utf8").replace(/\r?\n/g, "\r\n"));
  console.log(`third-party licences: ${entries.length} bundled packages, written to out/third-party`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
