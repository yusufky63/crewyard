# ADR 0011: Code signing and auto-update for the Windows installer

**Status:** accepted, 2026-10-30, for the build and the app. The certificate and the feed host are still to be chosen; nothing has been released or published.

The owner asked on 2026-10-30 for the signing certificate and auto-update to be prepared and tested on this machine. Releases come later, once everything is done (PLAN.md §17). Windows comes first; Linux and macOS are only prepared.

## Problem

PLAN.md §12 and M6 ask for a signed installer and auto-update. [ADR 0004](0004-packaging-and-recovery.md) left signing as a documented hook and auto-update out, because both need things that did not exist yet: a certificate and a place to serve releases from. Three needs remain:

1. **Signing** from a certificate in environment variables (a PFX and its password) or in the Windows certificate store, where the password never reaches a command line, a log or git, and where asking for a signed build fails the build instead of shipping an unsigned one.
2. **Updates** that the app checks, downloads and installs only on your click, where a signed build never runs an update that is unsigned, changed or signed by someone else, and where the app only makes outgoing requests.
3. **Licences:** the installer shipped neither NOTICE nor the licences of the npm packages bundled into it.

What the code we build on does today (versions as installed, read on 2026-10-30):

- **electron-builder 26.17.0 signs with `signtool.exe` and passes the PFX password as `/p <password>`** (`app-builder-lib/out/codeSign/windowsSignToolManager.js`, `addCommonSigningArgs`). Every process on the machine can read a command line. Without `SIGNTOOL_PATH` it would also download its `winCodeSign` bundle, which is not cached here.
- **electron-updater 6.8.11's Windows signature check fails open.** `windowsExecutableCodeSignatureVerifier.js` starts `powershell.exe` through `cmd.exe` (`shell: true`), found through `PATH`, and splices the file path into the command text (it escapes single quotes). When PowerShell or `ConvertTo-Json` cannot run, `handleError` returns without rejecting and the update is accepted. electron-builder's docs on `master` describe electron-builder 27 and electron-updater 7 as failing closed instead, and adding Ed25519-signed update manifests; both are alphas (7.0.0-alpha.13, 2026-10-29).
- **electron-updater skips the signature check when `app-update.yml` names no publisher** (`NsisUpdater.verifySignature`).
- **A private GitHub repository as a feed** needs a `GH_TOKEN` on every user's machine; electron-builder's docs call that "not intended and not suitable for all users".

## Options

### Update feed

1. **GitHub Releases provider.** electron-builder can upload to it, and hosting is free. But the code repository is private (PLAN.md §17), so it would need a token in the app, or the repository (or a separate releases repository) made public, which is its own decision. The provider also talks to GitHub's API and parses its Atom feed, which needs `sax` (BlueOak-1.0.0, outside AGENTS.md's licence list).
2. **Generic HTTPS provider.** Any static HTTPS host works: a bucket, a web server, a CDN. The app fetches `latest.yml` and then the installer it names. No token, no API, YAML only, and the host can change without a code change because the URL is set at build time. The local test serves exactly this. Uploading is manual or scripted.

**Chosen: 2.** The feed URL comes from `CREWYARD_UPDATE_URL` at build time. Which host serves it is decided at release time.

### Signing

1. **electron-builder's built-in signtool route** (`WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`). The password goes on signtool's command line, and the `winCodeSign` download is needed.
2. **Our own hook** (`win.signtoolOptions.sign`) through Windows PowerShell's `Set-AuthenticodeSignature`. The PFX path and password reach PowerShell only through its environment. The key is loaded with `EphemeralKeySet`, which Microsoft documents as "created in memory and not persisted on disk", so nothing touches a certificate store or the user's key folder. A certificate in the store (an EV token, an HSM behind its CSP) is used where it is, by thumbprint. PowerShell 5.1 ships with Windows, so nothing is downloaded. It has no `/d` description and stamps Authenticode-style timestamps (`-TimestampServer`), not RFC 3161.
3. **Azure Trusted Signing** (electron-builder's `azureSignOptions`). This one only applies if the certificate turns out to be a cloud one. Nothing in this design blocks it.

**Chosen: 2.**

## Decision

### Build: `apps/desktop/scripts/release.cjs`, `scripts/sign-windows.cjs`, `electron-builder.config.cjs`

| Variable | Effect |
|---|---|
| `CREWYARD_SIGN=1` | Signs the app exe, every dll, the installer and its uninstaller through `sign-windows.cjs`, and turns on `forceCodeSigning`. Fails at once without a certificate. |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | The certificate: a `.pfx` path (or its base64) and its password. electron-builder reads both; the hook hands the password to PowerShell in its environment. |
| `CREWYARD_SIGN_CERT_SHA1` | Or a certificate in the Windows store, by thumbprint. |
| `CREWYARD_SIGN_PUBLISHER` | Who updates must be signed by, written into `app-update.yml`. Use the certificate's full subject DN. Without it, electron-builder 26 writes the bare CN, which is compared with the CN alone. |
| `CREWYARD_SIGN_TIMESTAMP_URL` | Timestamp server, default `http://timestamp.digicert.com`; `none` leaves the signature unstamped (offline test builds). |
| `CREWYARD_UPDATE_URL` | The feed. `https` anywhere; plain `http` only on `127.0.0.1` or `localhost`, for the local test. No credentials, query or fragment. |
| `CREWYARD_UPDATE_TEST_ROOT` | Local tests only: the SHA-1 thumbprint of a self-signed test certificate that the update check may accept although Windows does not trust it. Accepted only with a loopback feed and a signed build. |

These rules hold:

- **A feed on the network needs a signed build.** An unsigned build may only use a loopback feed.
- **An unsigned build stays unsigned:** `signExecutable: false` and `verifyUpdateCodeSignature: false`, even when a certificate happens to be in the environment. So signtool never sees a password, and `app-update.yml` names no publisher.
- **The hook signs with SHA-256 only** and reads every file back: it must carry our certificate's signature, Valid, or UnknownError for a self-signed test certificate.
- **A file that already has a valid signature from someone else keeps it.** Electron's `d3dcompiler_47.dll` stays signed by Microsoft.
- **Signing retries twice**, because timestamp servers fail now and then.
- **`crewyardRelease: { signed, testRoot }` goes into the asar's `package.json`.** The embedded ASAR integrity fuse protects the asar; `resources\app-update.yml` next to it has no such protection.

### App: `apps/desktop/src/main/updater/`

- **`feed.ts` decides whether updates are on.** They are off, with a reason the window shows:
  - `development`: not packaged;
  - `platform`: not Windows;
  - `no_feed`: no `app-update.yml`;
  - `not_installed`: no `Uninstall <name>.exe` next to the exe, so the copy runs from an unpacked folder. drawio-desktop gates the same way;
  - `invalid`: the feed is not a generic `https` (or loopback) URL, a signed build has no publisher, an unsigned build or a test root points at a non-loopback feed.
- **`engine.ts` drives electron-updater's `NsisUpdater`** with every automatic behaviour off: `autoDownload`, `autoInstallOnAppQuit`, `allowPrerelease`, `allowDowngrade` and the web installer.
  - Its `verifyUpdateCodeSignature` is replaced by ours (`signature.ts`).
  - The downloaded installer is checked again before it is offered, because a copy cached by an earlier session skips electron-updater's own check. A refused cached file is deleted.
  - electron-updater's log goes to `<profile>\logs\updater.log`, capped at 1 MB, and holds versions, URLs and paths only.
- **`signature.ts` runs the check:**
  - `Get-AuthenticodeSignature`, plus an `X509Chain` built with `AllowUnknownCertificateAuthority`, so the root is known even when Windows does not trust it;
  - PowerShell started by its absolute System32 path with `@crewyard/proc`'s `run` (no shell, no console window), the file path passed in the environment;
  - only the Status enum and chain status names are read, since Windows writes its messages in the user's language (Turkish on this machine).
- **What the check accepts:**
  - `Valid` from a publisher in `app-update.yml`. A DN must match every attribute it names; a bare name must equal the CN.
  - With a test root, `UnknownError` whose only chain problem is `UntrustedRoot` and whose root is exactly the pinned thumbprint.
  - Nothing else. `NotSigned`, `HashMismatch`, any other status, a foreign publisher, and a check that could not run all refuse the update.
- **`updater.ts` is the flow:** off, idle, checking, current, available, downloading, downloaded, error.
  - "Check automatically" is off by default and cannot be turned on without a feed. When it is on, the app checks a minute after start and then every 6 hours, and never downloads by itself. The switch lives in `<profile>\updates.json`, because it belongs to the installation, not to a database you might restore.
  - The window hears about progress at most every 250 ms.
- **"Restart to install" goes through the quit confirm** (`requestQuit("update")`). With agents running it names them and asks ("Stop agents and install" / "Not now"; Enter keeps them running). Without running agents the click is the consent. Then the daemon shuts down, and electron-updater starts the installer with `--updated /S --force-run` and quits. The installer replaces the app in the folder it was installed to and starts it again.
- **Window:**
  - Settings → Updates (section 08): version, feed, signature check, Check now, Check automatically, and the offered version with Download, progress, Cancel, "Downloaded and verified: signed by …", Restart to install, or the reason it was refused.
  - A status bar item appears only while an update is found, downloading or ready.
  - About → Third-party licences opens the shipped list.
  - Every string is in `en` and `tr`.
- **Network:** the main process makes outgoing HTTPS GETs of `latest.yml`, the installer and its blockmap, through Electron's `net`. Nothing listens.
- **`sax`** is aliased to `src/main/updater/no-xml.ts` in the main bundle. Only the GitHub provider parses XML, so the BlueOak-licensed parser does not ship.

### Licences: `electron.vite.config.ts`, `scripts/third-party-licenses.mjs`

- A Vite plugin records which npm packages each bundle (main with the daemon, preload, renderer) really contains:
  - modules that render to something;
  - CSS;
  - assets by the file they came from.
- `third-party-licenses.mjs` runs after `electron-vite build`. It writes `out/third-party/THIRD-PARTY-LICENSES.txt`, which holds each package's name, version, declared licence and every LICENSE, COPYING and NOTICE file it ships. It also writes `NOTICE.txt`.
- It fails the build for a licence outside MIT, Apache-2.0, ISC, BSD, 0BSD, OFL-1.1 (fonts) and CC0-1.0. The one exception is the Claude Agent SDK, which NOTICE already covers.
- The installer puts both files next to the exe, beside Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html`.
- The current build lists 52 packages.

## Verification on 2026-10-30 (Windows 11 Pro 10.0.26200)

- **`pnpm check` passes:** tokens, contrast, typecheck, lint with zero warnings, 1,123 tests and the build. The licence list has 52 bundled packages.
- **`pnpm e2e` passes all 13 flows.** The new one checks a development build: Settings → Updates says it does not update itself, Check now and the automatic switch are disabled, and check, download and install called through the bridge change nothing.
- **Unit tests:**
  - `feed.test.ts`: the YAML electron-builder writes, URL rules, every off reason;
  - `signature.test.ts`: DN parsing with quotes and escapes, publisher matching, every status, the test root and its limits, PowerShell 5.1's one-element arrays, and a check that cannot run refusing;
  - `updater.test.ts`: the flow, a refusal installing nothing, cancel, the progress throttle, automatic checks with fake timers (never a download), error mapping;
  - `release.test.ts` and `third-party-licenses.test.ts`.
- **`scripts/sign-windows.test.ts` signs real files.**
  - A throwaway certificate is made with .NET's `CertificateRequest` into a PFX in a temp folder whose path has spaces.
  - The hook signs a copy of Electron's `electron_wer.dll` with the password in the environment.
  - The updater's reader sees `UnknownError` with `UntrustedRoot` and accepts it with the pinned root.
  - It refuses without the root (`untrusted`), for another publisher (`wrong_publisher`), with one flipped byte (`HashMismatch`, `tampered`), and for the unsigned original (`not_signed`).
  - Microsoft's `d3dcompiler_47.dll` keeps Microsoft's signature.
  - Afterwards no certificate with that thumbprint is in any CurrentUser store.
- **An unsigned `pnpm package` works as before.**
  - The log says "file signing skipped via signExecutable configuration" for the exe, the uninstaller and the installer.
  - There is no `app-update.yml`.
  - `THIRD-PARTY-LICENSES.txt` and `NOTICE.txt` sit next to the exe.
- **`node apps/desktop/e2e/update/update-flow.mjs` passed all 26 checks** on its final run. It used a separate test identity ("Crewyard Update Test", its own appId, install folder, profile and updater cache), so the real `%LOCALAPPDATA%\Programs\crewyard` and `%APPDATA%\Crewyard` were never touched.
  - Two throwaway certificates exist only as PFX files.
  - Signed 0.1.0 and 0.1.1 were built: their installers, the app exe and `ffmpeg.dll` carry the test publisher's signature. An unsigned 0.1.1 was built too. `app-update.yml` names the feed and the publisher's full DN.
  - 0.1.0 was installed silently with `/D=` into the temp folder, and the licence files were in place. The script clicked through its window over the DevTools protocol.
  - Each refused offer was refused, and no "Restart to install" appeared:
    - a tampered 0.1.1 with a recomputed checksum (`tampered`);
    - a tampered one with the original checksum (`checksum`);
    - one re-signed by another, untrusted certificate (`untrusted`);
    - the unsigned build (`not_signed`).
  - The real 0.1.1 was downloaded and shown as "Downloaded and verified: signed by CN=Crewyard Update Test, O=Crewyard Test Only".
  - After "Restart to install", the installer replaced the app in place, the exe reads 0.1.1 and is signed, and Crewyard started again by itself. Settings then showed 0.1.1.
  - `updater.log` recorded each refusal and the passed check. The feed server only saw requests for `latest.yml`, the installer and a blockmap. The blockmap is not in the test feed, so electron-updater fell back from a differential to a full download.
  - The uninstaller removed the uninstall entry, and the profile, the updater cache and the temp folder (certificates included) were deleted.
- **Screenshots** of the Updates section in dark and light at 1280 and 1920 px are in the session notes folder, not in the repository. They cover the downloaded, downloading, refused, available (Turkish), current and off states, plus the real flow from the harness.

## Sources

| Source | Opened | Stars | Licence | Archived |
|---|---|---|---|---|
| https://github.com/electron-userland/electron-builder (metadata via `gh api`) | 2026-10-30 | 14,693 | MIT | no |
| `website/docs/features/auto-update.md`, `website/docs/features/signed-update-manifests.md`, `website/docs/features/code-signing/code-signing-win.md` on `master` of that repository | 2026-10-30 | same | MIT | no |
| electron-updater 6.8.11 as installed: `out/NsisUpdater.js`, `out/windowsExecutableCodeSignatureVerifier.js`, `out/BaseUpdater.js`, `out/AppUpdater.d.ts`, `out/types.d.ts` | 2026-10-30 | same repository | MIT | no |
| app-builder-lib 26.17.0 as installed: `out/codeSign/windowsSignToolManager.js`, `out/codeSign/certInfo.js`, `out/toolsets/windows.js`, `out/winPackager.js`, `out/publish/PublishManager.js`, `templates/nsis/multiUser.nsh` (`/D=` parsing) | 2026-10-30 | same repository | MIT | no |
| https://github.com/jgraph/drawio-desktop `electron-builder-win.json` (custom `sign` hook, `signExts: [".dll"]`, `signingHashAlgorithms: ["sha256"]`), `build/sign-trusted.mjs`, `src/main/update-mode.js` (update only an NSIS install), `src/main/electron.js` (`autoDownload = false`, `quitAndInstall(true, true)`) on `dev` | 2026-10-30 | 63,727 | GPL-3.0 | no |
| https://github.com/mattermost/desktop `src/main/updateNotifier.ts` on `master` (dropped electron-updater for a notify-only check of a text file over `net.fetch`) | 2026-10-30 | 2,281 | Apache-2.0 | no |
| https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-authenticodesignature?view=powershell-5.1 (`-Certificate` takes any `X509Certificate2`, `-TimestampServer`, SHA1 is the default hash) | 2026-10-30 | n/a | Microsoft docs | n/a |
| https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509keystorageflags?view=netframework-4.8 (`EphemeralKeySet`) | 2026-10-30 | n/a | Microsoft docs | n/a |

- No code was copied or ported. drawio-desktop is GPL-3.0 and was only read, to see how an app of that size wires a custom sign hook and gates updates on the NSIS uninstaller.
- The signing hook, the verifier, the DN parser, the YAML reader, the update flow, the licence collector and the test harness are our own.
- Option names, event names, error codes and file layouts of electron-builder and electron-updater are facts.

## Windows notes

- **Windows PowerShell 5.1** is started by its System32 path everywhere (hook, verifier, tests). It reports in the display language, so the code reads enums only.
- **Signed builds download nothing.** electron-builder's cache still held only the NSIS and 7-Zip bundles from the first unsigned build; no `winCodeSign` and no signtool were fetched.
- **`Set-AuthenticodeSignature` with `EphemeralKeySet`:**
  - it signs PE files without writing a key container: `%APPDATA%\Microsoft\Crypto` was unchanged after a test signing;
  - it leaves no certificate in any store: `sign-windows.test.ts` checks this.
- **NSIS's `/D=`** must come last and unquoted, spaces included (`multiUser.nsh`). The test harness passes it with `windowsVerbatimArguments`. An update needs no `/D=`: the new installer reads `InstallLocation` from the registry and replaces the app where it is.
- **The updater's cache** is `%LOCALAPPDATA%\crewyard-updater`.
- **The installer stays per-user** and never elevates (`allowElevation: false`). electron-updater would use `elevate.exe` only if starting the installer failed with `EACCES`.
  - electron-builder puts its own `resources\elevate.exe` into the archive after signing (`nsisUtil.js`), so it ships unsigned.
  - Crewyard never starts it.
- **SmartScreen:** electron-builder's Windows signing docs say that since 2024 Microsoft treats EV and OV certificates the same for SmartScreen reputation. An OV certificate is therefore enough to start building reputation.
- **Smart App Control** checks every binary that loads, hence `signExts: [".dll"]` (PLAN.md §16).

## Security notes

- **The PFX password** is passed only from the build's environment to PowerShell's environment. It is never on a command line, in a log (the hook prints file names and statuses) or in a file this repository writes. The temp PFX that electron-builder makes from a base64 `WIN_CSC_LINK` is its own and is removed with its temp folder.
- **The signature check fails closed.** It refuses when it cannot run, and when the publisher is missing from a signed build's `app-update.yml` the updater stays off.
- **The test root** needs a loopback feed in both places, at build time (`release.cjs`) and at run time (`feed.ts`), so a release build cannot carry one. It pins one exact self-signed root, and a tampered file is still `HashMismatch` under it.
- **Residual risk: `latest.yml` is not signed.** Someone who controls the feed can offer an older installer that is validly signed by us, under a higher version number. HTTPS and access control on the host are the mitigation for now. The fix is Ed25519-signed update manifests, once electron-builder 27 and electron-updater 7 leave alpha. The first release that embeds the public key protects every later one.
- **Finding outside this ADR's scope:** the packaged app honours `--remote-debugging-port`, which opens a DevTools listener on 127.0.0.1 when someone starts Crewyard with it. The test harness uses exactly that to drive an installed copy. A packaged release build should refuse it; a build with a test root may keep it for this test.

## Rollback

- **Updates in new builds:** build without `CREWYARD_UPDATE_URL`. With no `app-update.yml`, the updater stays off and says so.
- **Updates in installed copies:** keep serving a `latest.yml` whose version is the current one, so they find nothing newer.
- **Code:**
  - remove `src/main/updater/`, the `crewyard:update` and `crewyard:open-licenses` handlers and the `installUpdate` path in `src/main/index.ts`, the Updates section, `shell/status/update.tsx` and the `electron-updater` dependency;
  - remove `crewyardRelease` from `release.cjs`.
  - The `updates.json` and `logs\updater.log` left in profiles are harmless.
- **Signing:** drop `CREWYARD_SIGN`. Builds are unsigned as before ADR 0004's hook.
- **Licences:** remove the Vite plugin, `third-party-licenses.mjs`, `extraFiles` and the `build` script's second step.

## What a real release needs

1. **A code-signing certificate.**
   - Either an OV certificate as a PFX, given through `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`;
   - or a hardware-bound certificate in the Windows store, through `CREWYARD_SIGN_CERT_SHA1`;
   - or Azure Trusted Signing, which needs electron-builder's `azureSignOptions` instead of this hook.
   - In every case, set `CREWYARD_SIGN_PUBLISHER` to the certificate's full subject DN. Every later certificate must match it, or one release signed with the old certificate must list both DNs.
2. **An HTTPS feed host** for `latest.yml`, `Crewyard-Setup-<version>-x64.exe` and its `.blockmap`, uploaded together for each release, with write access limited to you.
3. **The build:** `CREWYARD_SIGN=1`, the certificate variables, `CREWYARD_UPDATE_URL`, then `pnpm package`, then upload `dist\latest.yml`, the installer and the blockmap. Do it on your machine, once per release; CI stays on ubuntu (AGENTS.md).
4. **Before the first public release:** adopt signed update manifests once electron-builder 27 is stable, and refuse `--remote-debugging-port` in packaged release builds.
