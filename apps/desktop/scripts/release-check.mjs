// The checks the release workflow runs (.github/workflows/release.yml, docs/release.md). Node
// built-ins only, so it runs before or without `pnpm install`. Each command exits non-zero with a
// reason when something is wrong, which stops the release before anything is published.
//
//   version <tag> | --dry-run       tag matches both package.json versions; prints version= and
//                                   prerelease= lines for $GITHUB_OUTPUT
//   build <build-id> <dist> <stage> this build's files exist, its native terminal module is the one
//                                   for its OS and CPU and works, then copies the files into <stage>
//   smoke <build-id> <dist>         starts the packaged app (throwaway profile), checks the daemon
//                                   answers and that it exits cleanly
//   release <dir> <version>         <dir> holds exactly this release's files; writes SHA256SUMS.txt
//   published <assets.json> <dir> <version>
//                                   the draft carries exactly those files, uploaded, at the local sizes
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { BUILDS, CHECKSUMS, buildById, checkVersions, parseTag, releaseAssets } = require("./release-assets.cjs");

const appDir = join(import.meta.dirname, "..");
const PRODUCT = "Crewyard";
const MARKER = "crewyard-pty-ok";
// Linux builds run on ubuntu-22.04 so that pty.node, compiled there, asks for no newer glibc than
// Ubuntu 22.04 and Debian 12 have. A newer runner would quietly raise the floor; this catches it.
const GLIBC_FLOOR = [2, 35];

function fail(message) {
  console.error(`release-check: ${message}`);
  process.exit(1);
}

const readVersion = (file) => JSON.parse(readFileSync(file, "utf8")).version;

function version(arg) {
  const desktopVersion = readVersion(join(appDir, "package.json"));
  const rootVersion = readVersion(join(appDir, "..", "..", "package.json"));
  // A manual (dry) run builds whatever the branch carries, still with matching versions.
  const tag = arg === "--dry-run" ? `v${desktopVersion}` : arg;
  if (!tag) fail("version needs a tag or --dry-run");
  const { version: v, prerelease } = checkVersions({ tag, desktopVersion, rootVersion });
  console.log(`version=${v}`);
  console.log(`prerelease=${prerelease}`);
}

/** Where electron-builder left the unpacked app, and the paths inside it this script needs. */
function layout(build, dist) {
  const root = join(dist, build.unpacked);
  if (build.platform === "mac") {
    const app = join(root, `${PRODUCT}.app`);
    return { root, app, exe: join(app, "Contents", "MacOS", PRODUCT), resources: join(app, "Contents", "Resources") };
  }
  const exe = join(root, build.platform === "win" ? `${PRODUCT}.exe` : "crewyard");
  return { root, app: root, exe, resources: join(root, "resources") };
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** node-pty as the packaged app will load it: the right files, for the right CPU, and working. */
function checkNativeModule(build, paths) {
  const pty = join(paths.resources, "native", "node-pty");
  const prebuilds = join(pty, "prebuilds");
  const present = existsSync(prebuilds) ? readdirSync(prebuilds) : [];
  const need = (rel) => {
    const file = join(pty, rel);
    if (!existsSync(file) || statSync(file).size === 0) fail(`${build.id}: node-pty file missing from the package: ${rel}`);
    return file;
  };
  need("lib/index.js");
  need("LICENSE");

  if (build.platform === "win") {
    const dir = `prebuilds/win32-${build.arch}`;
    for (const f of ["pty.node", "conpty.node", "conpty/conpty.dll", "conpty/OpenConsole.exe"]) need(`${dir}/${f}`);
    if (present.some((d) => d !== `win32-${build.arch}`)) fail(`${build.id}: other prebuilds shipped too: ${present.join(", ")}`);
  } else if (build.platform === "mac") {
    const dir = `prebuilds/darwin-${build.arch}`;
    const node = need(`${dir}/pty.node`);
    const helper = need(`${dir}/spawn-helper`);
    if (present.some((d) => d !== `darwin-${build.arch}`)) fail(`${build.id}: other prebuilds shipped too: ${present.join(", ")}`);
    if ((statSync(helper).mode & 0o111) === 0) fail(`${build.id}: spawn-helper is not executable (afterPack did not run?)`);
    const cpu = build.arch === "x64" ? "x86_64" : build.arch;
    for (const file of [node, helper, paths.exe]) {
      const archs = run("lipo", ["-archs", file]).split(/\s+/);
      if (!archs.includes(cpu)) fail(`${build.id}: ${file} is built for ${archs.join(" ")}, not ${cpu}`);
    }
    // Ad hoc: valid, no identity. --strict also catches loose files the signature does not cover.
    run("codesign", ["--verify", "--deep", "--strict", paths.app]);
    const details = spawnSync("codesign", ["-dv", paths.app], { encoding: "utf8" }).stderr;
    if (!/Signature=adhoc/.test(details)) fail(`${build.id}: expected an ad-hoc signature, codesign says:\n${details}`);
    console.log(`${build.id}: ${cpu} binaries, spawn-helper executable, ad-hoc signature valid`);
  } else {
    const node = need("build/Release/pty.node");
    if (present.length > 0) fail(`${build.id}: unexpected prebuilds on Linux: ${present.join(", ")}`);
    const kind = run("file", ["-b", node]);
    if (build.arch === "x64" && !/x86-64/.test(kind)) fail(`${build.id}: pty.node is not x86-64: ${kind}`);
    const versions = [...run("objdump", ["-T", node]).matchAll(/GLIBC_(\d+)\.(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const newest = versions.reduce((a, b) => (b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]) ? b : a), [0, 0]);
    if (newest[0] > GLIBC_FLOOR[0] || (newest[0] === GLIBC_FLOOR[0] && newest[1] > GLIBC_FLOOR[1])) {
      fail(`${build.id}: pty.node needs glibc ${newest.join(".")}, newer than the ${GLIBC_FLOOR.join(".")} floor; build it on ubuntu-22.04`);
    }
    console.log(`${build.id}: pty.node is ${kind.split(",")[0]}, needs glibc ${newest.join(".")} at most`);
  }

  // Load it the way the pty host does and run one command in a pseudo terminal. node-pty is a
  // Node-API addon, so the runner's Node loads the same binary Electron will. Only on the CPU it is
  // for; a separate process, so a native crash fails this check instead of killing it.
  if (process.arch !== build.arch) {
    console.log(`${build.id}: pty start skipped (runner is ${process.arch})`);
    return;
  }
  const probe = `
    const pty = require(process.env.PTY_DIR + "/lib/index.js");
    const win = process.platform === "win32";
    const p = pty.spawn(win ? "cmd.exe" : "/bin/sh", win ? ["/d", "/c", "echo ${MARKER}"] : ["-c", "echo ${MARKER}"], {
      name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
      ...(win ? { useConpty: true, useConptyDll: true } : {}),
    });
    let out = "";
    p.onData((d) => { out += d; });
    p.onExit(({ exitCode }) => { console.log(JSON.stringify({ exitCode, saw: out.includes("${MARKER}") })); process.exit(0); });
    setTimeout(() => { console.log(JSON.stringify({ timeout: true, out })); process.exit(1); }, 20000);
  `;
  const res = spawnSync(process.execPath, ["-e", probe], { env: { ...process.env, PTY_DIR: resolve(pty) }, encoding: "utf8", timeout: 30_000, windowsHide: true });
  const line = (res.stdout ?? "").trim().split("\n").pop() ?? "";
  let result = null;
  try {
    result = JSON.parse(line);
  } catch {
    // reported below
  }
  if (!result?.saw || result.exitCode !== 0) fail(`${build.id}: node-pty did not run a command: ${line || "(no output)"}\n${res.stderr ?? ""}`);
  console.log(`${build.id}: node-pty started a shell in a pseudo terminal`);
}

function buildCheck(id, dist, stage) {
  if (!id || !dist || !stage) fail("build needs <build-id> <dist> <stage>");
  const build = buildById(id);
  const v = readVersion(join(appDir, "package.json"));
  const files = build.files(v);
  for (const f of files) {
    const p = join(dist, f);
    if (!existsSync(p) || statSync(p).size === 0) fail(`${build.id}: ${f} was not built (found: ${readdirSync(dist).join(", ")})`);
  }
  const paths = layout(build, resolve(dist));
  if (!existsSync(paths.exe)) fail(`${build.id}: no unpacked app at ${paths.exe}`);
  checkNativeModule(build, paths);
  mkdirSync(stage, { recursive: true });
  for (const f of files) copyFileSync(join(dist, f), join(stage, f));
  console.log(`${build.id}: staged ${files.join(", ")}`);
}

/** Starts the packaged app once with CREWYARD_SMOKE=1: the daemon round trip, then exit 0. */
async function smoke(id, dist) {
  if (!id || !dist) fail("smoke needs <build-id> <dist>");
  const build = buildById(id);
  const { exe } = layout(build, resolve(dist));
  if (!existsSync(exe)) fail(`${build.id}: no unpacked app at ${exe}`);
  // CREWYARD_SHOT gives the run a throwaway profile in the temp folder, so a smoke run on a
  // developer's machine never opens their real database; the smoke exits before any screenshot.
  const scratch = mkdtempSync(join(tmpdir(), "crewyard-smoke-"));
  const env = { ...process.env, CREWYARD_SMOKE: "1", CREWYARD_SHOT: join(scratch, "unused.png") };
  for (const k of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "CREWYARD_E2E"]) delete env[k];
  // Chromium's test switch for macOS: cookie encryption uses a stand-in key instead of the
  // Keychain, so a CI runner can never hang on a Keychain prompt.
  const args = build.platform === "mac" ? ["--use-mock-keychain"] : [];
  const child = spawn(exe, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout");
    }, 120_000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  // The throwaway profile the app made for itself (main/index.ts names it after its pid).
  for (const dir of [scratch, join(tmpdir(), `shoot-crewyard-${child.pid}`)]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // still locked for a moment; the app sweeps old ones on its next screenshot run
    }
  }
  const tail = out.trim().split("\n").slice(-20).join("\n");
  if (code !== 0 || !out.includes('"smoke":"ok"')) fail(`${build.id}: smoke run ended with ${code}\n${tail}`);
  console.log(`${build.id}: packaged app started and its daemon answered`);
}

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => hash.update(d))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

async function release(dir, v) {
  if (!dir || !v) fail("release needs <dir> <version>");
  parseTag(`v${v}`);
  const expected = releaseAssets(v).filter((f) => f !== CHECKSUMS);
  const found = readdirSync(dir).filter((f) => f !== CHECKSUMS);
  const missing = expected.filter((f) => !found.includes(f));
  const extra = found.filter((f) => !expected.includes(f));
  if (missing.length || extra.length) fail(`release ${v}: missing [${missing.join(", ")}], unexpected [${extra.join(", ")}]`);
  const lines = [];
  for (const f of expected) {
    if (statSync(join(dir, f)).size === 0) fail(`release ${v}: ${f} is empty`);
    // The format `sha256sum -c` and `shasum -a 256 -c` read: hash, two spaces, file name.
    lines.push(`${await sha256(join(dir, f))}  ${f}`);
  }
  writeFileSync(join(dir, CHECKSUMS), `${lines.join("\n")}\n`);
  console.log(`release ${v}: ${expected.length} files, ${CHECKSUMS} written`);
}

function published(assetsJson, dir, v) {
  if (!assetsJson || !dir || !v) fail("published needs <assets.json> <dir> <version>");
  const { assets } = JSON.parse(readFileSync(assetsJson, "utf8"));
  const expected = releaseAssets(v);
  const names = assets.map((a) => a.name);
  const missing = expected.filter((f) => !names.includes(f));
  const extra = names.filter((f) => !expected.includes(f));
  if (missing.length || extra.length) {
    fail(`draft ${v}: missing [${missing.join(", ")}], unexpected [${extra.join(", ")}]${extra.length ? "; delete the unexpected files from the draft and re-run the failed jobs" : ""}`);
  }
  for (const a of assets) {
    if (a.state && a.state !== "uploaded") fail(`draft ${v}: ${a.name} is ${a.state}, not uploaded`);
    const local = statSync(join(dir, a.name)).size;
    if (a.size !== local) fail(`draft ${v}: ${a.name} is ${a.size} bytes on GitHub, ${local} here`);
  }
  console.log(`draft ${v}: carries exactly the ${expected.length} release files`);
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "version") version(args[0]);
  else if (cmd === "build") buildCheck(args[0], args[1], args[2]);
  else if (cmd === "smoke") await smoke(args[0], args[1]);
  else if (cmd === "release") await release(args[0], args[1]);
  else if (cmd === "published") published(args[0], args[1], args[2]);
  else fail(`unknown command ${JSON.stringify(cmd)}; builds: ${BUILDS.map((b) => b.id).join(", ")}`);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
