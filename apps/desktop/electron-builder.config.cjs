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
  },
};
