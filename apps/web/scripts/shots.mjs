// Takes the website's app screenshots with the desktop app's own screenshot mode (CREWYARD_SHOT,
// see CLAUDE.md "Screenshots"): its sample data, a throwaway profile, one Electron at a time, at most
// 60 s each. Writes WebP files to apps/web/public/shots and their sizes to apps/web/lib/shots.json,
// and copies the app icon into the site. Re-run after UI changes land:
//
//   pnpm --filter @crewyard/web shots              (builds the desktop app first)
//   pnpm --filter @crewyard/web shots --skip-build (uses apps/desktop/out as it is)
//
// Options through the environment: SHOTS=tasks,crew picks shots; SHOT_SIZE (default 1440x900),
// SHOT_SCALE (2), SHOT_WIDTH (output width, 1920), SHOT_QUALITY (0.86), SHOT_DELAY (ms, 6000).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { killTree, run, start } from "@crewyard/proc";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const root = join(web, "..", "..");
const desktop = join(root, "apps", "desktop");
const outDir = join(web, "public", "shots");
const manifestFile = join(web, "lib", "shots.json");

/** What each picture shows. Every one uses the app's sample data (`fixture`), which the page says. */
const SHOTS = [
  { name: "tasks", screen: "tasks", query: "fixture" },
  { name: "crew", screen: "crew", query: "fixture" },
  { name: "inbox", screen: "inbox", query: "fixture" },
  { name: "limits", screen: "limits", query: "fixture" },
];
const THEMES = ["dark", "light"];
const TIMEOUT_MS = 60_000;
const MIN_PNG_BYTES = 40_000;

const env = process.env;
const size = env.SHOT_SIZE ?? "1440x900";
const scale = env.SHOT_SCALE ?? "2";
const width = Number(env.SHOT_WIDTH ?? 1920);
const quality = Number(env.SHOT_QUALITY ?? 0.86);
const delay = env.SHOT_DELAY ?? "6000";
const only = env.SHOTS ? new Set(env.SHOTS.split(",").map((s) => s.trim())) : null;
const shots = SHOTS.filter((s) => !only || only.has(s.name));

const electron = createRequire(join(desktop, "package.json"))("electron");
const temp = mkdtempSync(join(tmpdir(), "crewyard-site-shots-"));
let current = null;

function cleanup() {
  rmSync(temp, { recursive: true, force: true });
}

async function stopCurrent() {
  if (current?.pid) await killTree(current.pid);
  current = null;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void stopCurrent().finally(() => {
      cleanup();
      process.exit(130);
    });
  });
}

/** One Electron run; the tree is killed when it outlives the timeout. */
function electronRun(args, extraEnv) {
  return new Promise((resolve) => {
    const child = start(electron, args, { cwd: desktop, env: { ...env, ...extraEnv }, stdio: ["ignore", "ignore", "pipe"] });
    current = child;
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (d) => {
      if (stderr.length < 8000) stderr += d;
    });
    const timer = setTimeout(() => {
      void stopCurrent().then(() => resolve({ code: null, stderr: `${stderr}\ntimed out after ${TIMEOUT_MS / 1000} s` }));
    }, TIMEOUT_MS);
    child.once("error", (err) => {
      clearTimeout(timer);
      current = null;
      resolve({ code: null, stderr: String(err) });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      current = null;
      resolve({ code, stderr });
    });
  });
}

async function main() {
  if (!process.argv.includes("--skip-build")) {
    console.log("building the desktop app");
    const b = await run("pnpm", ["--filter", "@crewyard/desktop", "build"], { cwd: root, timeoutMs: 600_000, env });
    if (b.code !== 0) throw new Error(`desktop build failed:\n${b.stderr || b.stdout}`);
  }
  if (!existsSync(join(desktop, "out", "main", "index.js"))) throw new Error("apps/desktop/out is missing; run without --skip-build");

  // The title bar shows the project folder's name, so the shots open a neutral, empty repository
  // rather than whatever checkout this runs in.
  const project = join(temp, "sample-project");
  mkdirSync(project);
  const init = await run("git", ["init", "-q"], { cwd: project, timeoutMs: 20_000, env });
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr}`);

  const jobs = [];
  const failed = [];
  for (const shot of shots) {
    const pair = [];
    for (const theme of THEMES) {
      const png = join(temp, `${shot.name}-${theme}.png`);
      const r = await electronRun(["."], {
        CREWYARD_SHOT: png,
        CREWYARD_SHOT_THEME: theme,
        CREWYARD_SHOT_LANG: "en",
        CREWYARD_SHOT_SIZE: size,
        CREWYARD_SHOT_SCALE: scale,
        CREWYARD_SHOT_DELAY: delay,
        CREWYARD_SHOT_PROJECT: project,
        CREWYARD_SHOT_SCREEN: shot.screen,
        CREWYARD_SHOT_QUERY: shot.query,
      });
      // A renderer error leaves an empty canvas, which compresses to a few kilobytes; such a picture
      // is refused rather than published. The previous files for that shot are kept.
      const bytes = existsSync(png) ? statSync(png).size : 0;
      if (r.code !== 0 || bytes < MIN_PNG_BYTES) {
        failed.push(`${shot.name} (${theme}): ${r.code !== 0 ? `exit ${r.code} ${r.stderr.trim().slice(-400)}` : `blank capture (${bytes} bytes), likely a renderer error on that screen`}`);
        break;
      }
      console.log(`shot ${shot.name} ${theme}`);
      pair.push({ name: shot.name, theme, input: png, output: join(outDir, `${shot.name}-${theme}.webp`), width, quality });
    }
    // Both themes or neither, so the page never shows one theme's picture in the other.
    if (pair.length === THEMES.length) jobs.push(...pair);
  }
  if (jobs.length === 0) throw new Error(`no screenshot succeeded:\n${failed.join("\n")}`);

  mkdirSync(outDir, { recursive: true });
  const jobsFile = join(temp, "jobs.json");
  writeFileSync(jobsFile, JSON.stringify(jobs));
  const enc = await electronRun([join(here, "webp-encode.cjs"), jobsFile], {});
  if (enc.code !== 0) throw new Error(`WebP encoding failed:\n${enc.stderr}`);
  const results = JSON.parse(readFileSync(`${jobsFile}.result.json`, "utf8"));

  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : {};
  for (const shot of shots) {
    const dark = results.find((r) => r.output === join(outDir, `${shot.name}-dark.webp`));
    if (!dark) continue;
    manifest[shot.name] = { width: dark.width, height: dark.height, dark: `/shots/${shot.name}-dark.webp`, light: `/shots/${shot.name}-light.webp` };
  }
  const sorted = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
  writeFileSync(manifestFile, `${JSON.stringify(sorted, null, 2)}\n`);
  for (const r of results) console.log(`${relative(web, r.output)} ${r.width}x${r.height} ${(statSync(r.output).size / 1024).toFixed(0)} KB`);

  // The site's favicon and touch icon are the app's own icon (apps/desktop/build/icon.png).
  const icon = join(desktop, "build", "icon.png");
  copyFileSync(icon, join(web, "app", "icon.png"));
  copyFileSync(icon, join(web, "app", "apple-icon.png"));

  if (failed.length > 0) {
    console.error(`kept the previous files for:\n${failed.join("\n")}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => cleanup())
  .catch(async (err) => {
    await stopCurrent();
    cleanup();
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
