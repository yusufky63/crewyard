// electron-builder afterPack hook: runs once per platform and arch, after the app folder is laid out
// and before fuses are flipped and the macOS bundle is signed.
//
// node-pty's macOS terminal starts each shell through `spawn-helper`, a small executable next to
// pty.node. The node-pty 1.1.0 npm tarball stores both prebuilt copies with mode 0644 (checked with
// `tar -tvzf node-pty-1.1.0.tgz`), pnpm keeps that mode and electron-builder copies it, so a packaged
// Mac would fail every terminal with "posix_spawnp failed". The hook makes it executable before the
// bundle is signed, and fails the build if it is missing.
const { chmodSync, existsSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

/** @param {string} resources the app's Resources folder */
function fixSpawnHelpers(resources) {
  const prebuilds = join(resources, "native", "node-pty", "prebuilds");
  const dirs = existsSync(prebuilds) ? readdirSync(prebuilds).filter((d) => d.startsWith("darwin-")) : [];
  if (dirs.length === 0) throw new Error(`no node-pty prebuild for macOS under ${prebuilds}`);
  const fixed = [];
  for (const dir of dirs) {
    const helper = join(prebuilds, dir, "spawn-helper");
    if (!existsSync(helper)) throw new Error(`node-pty's spawn-helper is missing: ${helper}`);
    chmodSync(helper, 0o755);
    if ((statSync(helper).mode & 0o111) === 0) throw new Error(`could not make ${helper} executable`);
    fixed.push(helper);
  }
  return fixed;
}

/** @param {import("electron-builder").AfterPackContext} context */
async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  fixSpawnHelpers(join(app, "Contents", "Resources"));
}

module.exports = { afterPack, fixSpawnHelpers };
