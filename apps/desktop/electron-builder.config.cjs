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
