// Packaging for Crewyard on Windows, macOS and Linux (docs/adr/0004-packaging-and-recovery.md,
// docs/adr/0010-linux-macos-groundwork.md, docs/release.md). Nothing is published from here:
// every build runs with `--publish never`, and the release workflow uploads the files itself.
//
//   pnpm package          Windows: per-user NSIS install into %LOCALAPPDATA%\Programs\crewyard, no admin prompt
//   pnpm package:mac      macOS: dmg and zip, arm64 and x64, ad-hoc signed (not notarized)
//   pnpm package:linux    Linux: AppImage and deb, x64
//
// Windows code signing and the update feed come from environment variables only; scripts/release.cjs
// lists them and docs/adr/0011-signing-and-auto-update.md explains them. Without any, the build is
// unsigned and has no update feed, as before. In short:
//   - CREWYARD_SIGN=1 with WIN_CSC_LINK (.pfx) and WIN_CSC_KEY_PASSWORD, or CREWYARD_SIGN_CERT_SHA1
//     (a certificate in the Windows store), signs every exe and dll, the installer and the
//     uninstaller. forceCodeSigning is then on, so a missing or broken certificate fails the build
//     instead of shipping an unsigned installer. The password never reaches a command line.
//   - CREWYARD_UPDATE_URL turns on update checks against that feed (electron-updater's generic
//     provider). An https feed needs a signed build. Nothing is uploaded: `--publish never`.
//
// Artifact names come from scripts/release-assets.cjs: the release workflow and the website match
// downloads by them.
const { releaseOptions } = require("./scripts/release.cjs");
const { ARTIFACT_NAMES } = require("./scripts/release-assets.cjs");
const { afterPack } = require("./scripts/after-pack.cjs");
const { dirname } = require("node:path");
const { realpathSync } = require("node:fs");

const release = releaseOptions(process.env);

const REPOSITORY = "https://github.com/yusufky63/crewyard";
// The licences of everything bundled (scripts/third-party-licenses.mjs) and NOTICE. Windows and Linux
// keep them next to the executable, beside Electron's own LICENSE.electron.txt and
// LICENSES.chromium.html. A macOS bundle keeps resources in Contents/Resources, and a loose file
// directly in Contents puts code signing at risk, so there they go to Resources.
const LICENCE_FILES = { from: "out/third-party", to: ".", filter: ["NOTICE.txt", "THIRD-PARTY-LICENSES.txt"] };

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "dev.crewyard.app", // same as app.setAppUserModelId in src/main/index.ts, so toasts and the taskbar match
  productName: "Crewyard",
  copyright: "Copyright 2026 Crewyard contributors",
  directories: { output: "dist", buildResources: "build" },
  // Main, daemon, preload and renderer are bundled by electron-vite and use only Node and Electron
  // built-ins at runtime, so no node_modules ship.
  files: ["out/**/*", "!out/third-party/**", "package.json", "!**/node_modules/**"],
  // node-pty, the terminal's one native module (docs/adr/0016-terminal.md), cannot load from inside
  // app.asar: its runtime files go next to the archive in resources/native/node-pty, which the pty
  // host loads by path. Only the target's own binaries, without debug symbols:
  //   - Windows and macOS: node-pty's prebuilds/<platform>-<arch> (both macOS arches ship in the
  //     package, so either can be built on either Mac);
  //   - Linux: build/Release/pty.node, which `pnpm install` compiles from source (there is no Linux
  //     prebuild), so a Linux package is built on Linux for its own arch.
  // node-pty is a Node-API addon, so the same binary loads in Node and in Electron 45 (no rebuild).
  extraResources: [
    {
      from: dirname(realpathSync(require.resolve("node-pty/package.json"))),
      to: "native/node-pty",
      filter: ["package.json", "LICENSE", "lib/**/*.js", "!lib/**/*.test.js", "!lib/testUtils*", "prebuilds/${platform}-${arch}/**", "build/Release/*.node", "!**/*.pdb"],
    },
  ],
  // The packaged app reads its name from here: app.getName() and the profile folder become
  // %APPDATA%\Crewyard (~/Library/Application Support/Crewyard, ~/.config/Crewyard), and the
  // description is what Windows shows as the file description. desktopName is Electron's app id and
  // WM_CLASS on Linux, so the window groups under the installed crewyard.desktop entry.
  extraMetadata: {
    name: "crewyard",
    productName: "Crewyard",
    description: "Crewyard",
    author: "Crewyard contributors",
    homepage: REPOSITORY,
    license: "MIT",
    desktopName: "crewyard.desktop",
    ...release.metadata,
  },
  npmRebuild: false,
  asar: true,
  // The Electron that `pnpm install` put in node_modules when it is the one this build needs, so
  // packaging needs no second download. Any other platform or arch (an x64 Mac build on Apple
  // silicon, say) returns null, and electron-builder downloads the matching Electron, checked
  // against its checksums, instead of copying the wrong binary into the app.
  electronDist: ({ platformName, arch }) => (platformName === process.platform && arch === process.arch ? "node_modules/electron/dist" : null),
  forceCodeSigning: release.forceCodeSigning,
  // Electron fuses, flipped in the packaged exe (agent-orchestrator #6446). Nothing here runs
  // Electron as plain Node: the daemon is a utility process and agents are their own CLIs.
  // grantFileProtocolExtraPrivileges stays on: the renderer still loads its ES modules from file://.
  // Electron validates asar integrity on Windows and macOS; on Linux the check is compiled out
  // (shell/common/asar/archive.cc), so the fuse is harmless there.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
  },
  afterPack,
  // With a feed, electron-builder writes resources\app-update.yml and dist\latest.yml; it still uploads nothing.
  publish: release.publish,
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.ico",
    requestedExecutionLevel: "asInvoker",
    extraFiles: [LICENCE_FILES],
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
    artifactName: ARTIFACT_NAMES.nsis,
    // Explorer's "Open in Crewyard" for folders and folder backgrounds, per user under HKCU, removed on
    // uninstall and kept across updates (PLAN.md §12).
    include: "build/installer.nsh",
  },
  // macOS: ad-hoc signed, not notarized (docs/adr/0010). Without any signature Apple silicon refuses
  // to start an arm64 app and a downloaded copy is reported as "damaged"; an ad-hoc signature turns
  // that into Gatekeeper's "could not verify the developer", which System Settings -> Privacy &
  // Security -> Open Anyway gets past (docs/release.md). Hardened runtime stays off: it only matters
  // for notarization, and with an ad-hoc identity library validation would refuse Electron's own
  // frameworks and node-pty. A Developer ID identity, hardenedRuntime and notarize come together.
  mac: {
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    category: "public.app-category.developer-tools",
    icon: "build/icon.icns",
    identity: "-",
    hardenedRuntime: false,
    notarize: false,
    // Follow the system's light or dark appearance, as the app's own theme does.
    darkModeSupport: true,
    extraResources: [LICENCE_FILES],
    artifactName: ARTIFACT_NAMES.macZip,
  },
  dmg: {
    artifactName: ARTIFACT_NAMES.dmg,
  },
  linux: {
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
    icon: "build/icons",
    category: "Development",
    executableName: "crewyard",
    synopsis: "Run and supervise crews of coding agents",
    description: "A desktop app that runs and supervises coding agents (Claude Code, Codex, Gemini CLI, OpenCode) across your own accounts and API keys.",
    maintainer: "Yusuf <yusufky63@users.noreply.github.com>",
    extraFiles: [LICENCE_FILES],
  },
  appImage: {
    artifactName: ARTIFACT_NAMES.appImage,
  },
  deb: {
    artifactName: ARTIFACT_NAMES.deb,
  },
};
