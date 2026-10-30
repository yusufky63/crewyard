// Windows installer for Crewyard: `pnpm package` (docs/adr/0004-packaging-and-recovery.md).
// Per-user NSIS install into %LOCALAPPDATA%\Programs\Crewyard, no admin prompt, nothing published.
//
// Code signing hook. There is no certificate yet, so builds are unsigned. To sign:
//   - put the certificate in WIN_CSC_LINK (path to a .pfx, or its base64) and its password in
//     WIN_CSC_KEY_PASSWORD, as environment variables only, never in this file or a commit;
//   - set CREWYARD_SIGN=1, which turns on forceCodeSigning so a missing or broken certificate
//     fails the build instead of shipping an unsigned installer.
// A certificate in the Windows store or an HSM goes through win.signtoolOptions
// (certificateSubjectName / certificateSha1, or a custom `sign` module) instead.
const sign = process.env.CREWYARD_SIGN === "1";

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "dev.crewyard.app", // same as app.setAppUserModelId in src/main/index.ts, so toasts and the taskbar match
  productName: "Crewyard",
  copyright: "Copyright 2026 Crewyard contributors",
  directories: { output: "dist", buildResources: "build" },
  // Main, daemon, preload and renderer are bundled by electron-vite and use only Node and Electron
  // built-ins at runtime, so no node_modules ship.
  files: ["out/**/*", "package.json", "!**/node_modules/**"],
  // The packaged app reads its name from here: app.getName() and the profile folder become
  // %APPDATA%\Crewyard, and the description is what Windows shows as the file description.
  extraMetadata: { name: "crewyard", productName: "Crewyard", description: "Crewyard", author: "Crewyard contributors" },
  npmRebuild: false,
  asar: true,
  // The Electron that `pnpm install` already put in node_modules, so packaging needs no second download.
  electronDist: "node_modules/electron/dist",
  forceCodeSigning: sign,
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
  publish: null,
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.ico",
    requestedExecutionLevel: "asInvoker",
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
