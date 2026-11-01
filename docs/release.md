# Cutting a release

One version tag builds Crewyard for Windows, macOS and Linux and publishes the files as one GitHub release. The workflow is [`.github/workflows/release.yml`](../.github/workflows/release.yml); the decisions behind it are in [ADR 0010](adr/0010-linux-macos-groundwork.md) and [PLAN.md §17](../PLAN.md#17-decisions-log-and-open-questions).

GitHub Releases is the download host. The website lists releases from GitHub's public API, so a published release shows up there without a deploy.

## What a release contains

| Platform | File | Built on |
|---|---|---|
| Windows 11, x64 | `Crewyard-Setup-<version>-x64.exe` (per-user NSIS installer) | `windows-latest` |
| macOS 13 or later, Apple silicon | `Crewyard-<version>-arm64.dmg`, `Crewyard-<version>-arm64-mac.zip` | `macos-15` |
| macOS 13 or later, Intel | `Crewyard-<version>-x64.dmg`, `Crewyard-<version>-x64-mac.zip` | `macos-15-intel` |
| Linux, x64 | `Crewyard-<version>-x86_64.AppImage`, `crewyard_<version>_amd64.deb` | `ubuntu-22.04` |
| all | `SHA256SUMS.txt` (`<sha256>  <file>` per line) | |

- `<version>` is the tag without its `v`: tag `v0.2.0` gives `Crewyard-Setup-0.2.0-x64.exe`.
- Only a version with a pre-release part (`v0.3.0-rc.1`) is published as a GitHub pre-release. Plain versions, `0.x` included, are normal releases and GitHub marks the newest one Latest. (Until 2026-11-01 every `0.x` version was a pre-release; the owner asked for v0.2.0 to be the latest release.)
- The builds are unsigned on Windows, and ad-hoc signed but not notarized on macOS. The release notes start with [docs/release-notes/install.md](release-notes/install.md): the SmartScreen and Gatekeeper steps, and which Linux file to pick.
- None of these builds checks for updates (no update feed, ADR 0011). Users download the next release by hand.
- The names are fixed in [`apps/desktop/scripts/release-assets.cjs`](../apps/desktop/scripts/release-assets.cjs). `electron-builder.config.cjs` takes them from there, the workflow refuses to publish any other set, and a test pins them to electron-builder's own naming rules.

### For the website

Match assets by these patterns, never by position in the list:

| Download | Pattern |
|---|---|
| Windows | `^Crewyard-Setup-(.+)-x64\.exe$` |
| macOS Apple silicon | `^Crewyard-(.+)-arm64\.dmg$` (zip: `^Crewyard-(.+)-arm64-mac\.zip$`) |
| macOS Intel | `^Crewyard-(.+)-x64\.dmg$` (zip: `^Crewyard-(.+)-x64-mac\.zip$`) |
| Linux AppImage | `^Crewyard-(.+)-x86_64\.AppImage$` |
| Linux deb | `^crewyard_(.+)_amd64\.deb$` |
| Checksums | `^SHA256SUMS\.txt$` |

Read releases from `GET https://api.github.com/repos/yusufky63/crewyard/releases`:

- Take the first entry with `draft: false`. Unauthenticated callers never see drafts anyway.
- Do not use `/releases/latest`. It skips pre-releases, so a newer pre-release would never show there.
- Each asset carries `browser_download_url`, `size` and `digest` (`sha256:<hex>`, the same value as in `SHA256SUMS.txt`).
- While the repository is private the API answers 404. Show no download then; never show a made-up version.

## Before the first release (once)

1. Make the repository public, as decided on 2026-10-31. The MIT `LICENSE` (Copyright (c) 2026 Yusuf) is already in the repository; the workflow refuses to build when it is missing or no longer matches the licence and copyright the packages declare (`LICENCE` in `apps/desktop/scripts/release-assets.cjs`). While the repository is private, macOS minutes count ten times and Windows minutes twice against the 2,000 free minutes a month. One run has two macOS jobs of very roughly 15 minutes each, so about 300 billed minutes before Windows and Linux. On a public repository these minutes are free.
2. Do a dry run: GitHub → Actions → release → Run workflow, on `main`. It builds and checks all four packages and keeps them as workflow artifacts for three days. It creates no release and no tag. Nothing has ever been built on macOS or Linux before this, so try each package on a real machine:
   - start it;
   - open a project;
   - open a terminal in the bottom panel;
   - add an API key (Keychain or Secret Service).

## Cutting it

Run these on `main` with a clean tree. The commands work in Windows PowerShell 5.1 and in Git Bash.

1. Run the full gate: `pnpm check`, plus the Windows checks in AGENTS.md (`pnpm package`, screenshots for UI work).
2. Bump the version in **both** `apps/desktop/package.json` and the root `package.json`, to the same value. A test fails when they differ, and the workflow refuses a tag that does not match both.
3. Optional: write the notes in `docs/release-notes/v<version>.md`, for example `docs/release-notes/v0.2.0.md`. Without the file, the release gets GitHub's generated list of merged changes. The install steps are added in front either way.
4. Commit (`git commit -am "Release 0.2.0"`) and push `main`, with the owner's approval.
5. Tag that commit and push the tag:

   ```powershell
   git tag -a v0.2.0 -m "Crewyard 0.2.0"; git push origin v0.2.0
   ```

The tag push is the release. Nothing else triggers the workflow.

## What the workflow does

1. **prepare** (ubuntu):
   - checks the tag (`v<major>.<minor>.<patch>[-pre]`, equal to both versions);
   - refuses a tag whose release is already published;
   - creates a **draft** release with the notes, or reuses the draft a previous run made.
2. **build** (four jobs, one per OS and CPU, each on its own native runner). Each job:
   - runs `pnpm install --frozen-lockfile`, Electron's download script, `pnpm --filter @crewyard/desktop build` and `electron-builder --publish never`;
   - checks the package with `apps/desktop/scripts/release-check.mjs`:
     - the expected file names;
     - node-pty for this OS and CPU: macOS gets `lipo`, an executable `spawn-helper` and a valid ad-hoc signature; Linux gets `pty.node` needing glibc 2.35 or older;
     - a shell started through the packaged node-pty;
   - starts the packaged app once with `CREWYARD_SMOKE=1` on a throwaway profile (a virtual display on Linux);
   - hands the files on as a workflow artifact.

   These jobs have no write token. They run dependency install scripts, so their files reach the release only through the next job.
3. **publish** (ubuntu, only when all four builds passed):
   - downloads the four artifacts;
   - checks the set is exactly the files above;
   - writes `SHA256SUMS.txt`;
   - uploads everything to the draft;
   - checks the draft carries exactly those files at the same sizes;
   - publishes it (`draft: false`, pre-release only for a `-pre` tag).

There are no caches (dependencies and Electron come from the registry and Electron's checksums on every run) and no secret other than `GITHUB_TOKEN`. A tag pushed again cancels the run still going for it.

## Once it is published

- The release page lists eight files. Download one and check it against `SHA256SUMS.txt`.
- On a Windows machine, install the `.exe` over the previous version: the app starts and your projects are still there.
- The website shows the new version, with no deploy needed. If it caches the API response, allow for its revalidation time.

## When something fails

- **A build failed:**
  - read its log and fix the cause on `main`;
  - move the tag: `git tag -d v0.2.0; git push --delete origin v0.2.0`, then tag the fixed commit and push again;
  - the draft is reused and its files are replaced.

  A flaky runner needs no new commit: use "Re-run failed jobs". The builds keep their files for five days, so within that time a re-run of a failed publish job reuses them; after that, use "Re-run all jobs".
- **"already published":** a published release is never rebuilt. Bump the version and tag again.
- **"unexpected" files on the draft:** someone added files by hand. Delete them from the draft and re-run the failed jobs.
- **The tag does not match the versions:** delete the tag, fix the versions, commit, and tag again.
- Nothing is published until every check passes. A failed run leaves at most a draft, which only people with push access can see.

## Building locally

- `pnpm package` on Windows builds the installer into `apps/desktop/dist`.
- `pnpm --filter @crewyard/desktop package:mac` (on a Mac) builds dmg and zip for both CPUs. For the CPU that is not the Mac's own, electron-builder downloads the matching Electron.
- `pnpm --filter @crewyard/desktop package:linux` (on Linux) builds the AppImage and the deb. Linux packages are built on Linux, because `pty.node` is compiled there by `pnpm install`.
- `node apps/desktop/scripts/release-check.mjs build windows-x64 apps/desktop/dist <folder>` and `... smoke windows-x64 apps/desktop/dist` run the same checks as CI. The smoke run uses a throwaway profile, never your own data.

## Signing later

- **Windows:** ADR 0011 covers the certificate and the update feed (`CREWYARD_SIGN=1`, `CREWYARD_UPDATE_URL`). They would become repository secrets read by the Windows build job only.
- **macOS:** a Developer ID certificate replaces `identity: "-"`, and `hardenedRuntime` and `notarize` turn on with it. The Gatekeeper step in the release notes then goes away. Until then, notifications stay off on macOS: Electron needs a signed app for them.
- **Linux:** nothing to sign. Users who want to check a download use the checksums.
