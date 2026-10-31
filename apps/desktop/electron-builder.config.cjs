// Windows installer for Crewyard: `pnpm package` (docs/adr/0004-packaging-and-recovery.md).
// Per-user NSIS install into %LOCALAPPDATA%\Programs\Crewyard, no admin prompt, nothing published.
//
// Code signing and the update feed come from environment variables only; scripts/release.cjs
// lists them and docs/adr/0011-signing-and-auto-update.md explains them. Without any, the build is
// unsigned and has no update feed, as before. In short:
//   - CREWYARD_SIGN=1 with WIN_CSC_LINK (.pfx) and WIN_CSC_KEY_PASSWORD, or CREWYARD_SIGN_CERT_SHA1
//     (a certificate in the Windows store), signs every exe and dll, the installer and the
//     uninstaller. forceCodeSigning is then on, so a missing or broken certificate fails the build
//     instead of shipping an unsigned installer. The password never reaches a command line.
//   - CREWYARD_UPDATE_URL turns on update checks against that feed (electron-updater's generic
//     provider). An https feed needs a signed build. Nothing is uploaded: `--publish never`.
const { releaseOptions } = require("./scripts/release.cjs");
const { dirname } = require("node:path");
const { realpathSync } = require("node:fs");

const release = releaseOptions(process.env);

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "dev.crewyard.app", // same as app.setAppUserModelId in src/main/index.ts, so toasts and the taskbar match
  productName: "Crewyard",
  copyright: "Copyright 2026 Crewyard contributors",
  directories: { output: "dist", buildResources: "build" },
  // Main, daemon, preload and renderer are bundled by electron-vite and use only Node and Electron
  // built-ins at runtime, so no node_modules ship.
  files: ["out/**/*", "!out/third-party/**", "package.json", "!**/node_modules/**"],
  // The licences of everything bundled (scripts/third-party-licenses.mjs) and NOTICE, next to
  // Electron's own LICENSE.electron.txt and LICENSES.chromium.html in the install folder.
  extraFiles: [{ from: "out/third-party", to: ".", filter: ["NOTICE.txt", "THIRD-PARTY-LICENSES.txt"] }],
  // node-pty, the terminal's one native module (docs/adr/0016-terminal.md), cannot load from inside
  // app.asar: its runtime files go next to the archive in resources/native/node-pty, which the pty
  // host loads by path. Only this platform's prebuilt binaries, without debug symbols.
  extraResources: [
    {
      from: dirname(realpathSync(require.resolve("node-pty/package.json"))),
      to: "native/node-pty",
      filter: ["package.json", "LICENSE", "lib/**/*.js", "!lib/**/*.test.js", "!lib/testUtils*", "prebuilds/${platform}-${arch}/**", "build/Release/*.node", "!**/*.pdb"],
    },
  ],
  // The packaged app reads its name from here: app.getName() and the profile folder become
  // %APPDATA%\Crewyard, and the description is what Windows shows as the file description.
  extraMetadata: { name: "crewyard", productName: "Crewyard", description: "Crewyard", author: "Crewyard contributors", ...release.metadata },
  npmRebuild: false,
  asar: true,
  // The Electron that `pnpm install` already put in node_modules, so packaging needs no second download.
  electronDist: "node_modules/electron/dist",
  forceCodeSigning: release.forceCodeSigning,
  // Electron fuses, flipped in the packaged exe (agent-orchestrator #6446). Nothing here runs
  // Electron as plain Node: the daemon is a utility process and agents are their own CLIs.
  // grantFileProtocolExtraPrivileges stays on: the renderer still loads its ES modules from file://.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
  },
  // With a feed, electron-builder writes resources\app-update.yml and dist\latest.yml; it still uploads nothing.
  publish: release.publish,
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.ico",
    requestedExecutionLevel: "asInvoker",
    ...release.win,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    shortcutName: "Crewyard",
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    // Your projects, profiles and database stay when the app is removed; deleting them is your call.
    deleteAppDataOnUninstall: false,
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico",
    artifactName: "Crewyard-Setup-${version}-${arch}.${ext}",
    // Explorer's "Open in Crewyard" for folders and folder backgrounds, per user under HKCU, removed on
    // uninstall and kept across updates (PLAN.md §12).
    include: "build/installer.nsh",
  },
  // Linux and macOS (docs/adr/0010-linux-macos-groundwork.md): prepared, not shipped. Unsigned and
  // never published (publish: null above). Nothing builds them unless `pnpm package:mac` or
  // `pnpm package:linux` runs on that OS: electronDist is the Electron pnpm installed for the
  // machine it runs on. Known gaps before a first build, listed in the ADR: no .icns or Linux icon
  // set yet (electron-builder falls back to Electron's), and deb needs a homepage and a maintainer
  // email, which do not exist yet.
  mac: {
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    category: "public.app-category.developer-tools",
    // null skips signing entirely; Apple silicon then needs at least an ad-hoc signature to start.
    identity: null,
    notarize: false,
    artifactName: "Crewyard-${version}-${arch}.${ext}",
  },
  linux: {
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
    category: "Development",
    executableName: "crewyard",
    synopsis: "Run and supervise crews of coding agents",
    artifactName: "Crewyard-${version}-${arch}.${ext}",
  },
};
