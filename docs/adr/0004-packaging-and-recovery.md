# ADR 0004: Windows installer and crash recovery

Date: 2026-10-30. Status: accepted.

## Problem

Two things stand between Crewyard and daily use (PLAN.md M2, M6, §12):

1. **Agent processes outlive a killed app.** The daemon spawns every agent CLI. On Windows, killing a parent does not kill its children. So when the app is closed from Task Manager, or the daemon crashes, or the power goes out mid-run, the agent trees keep running. They hold worktrees and keep spending tokens. The orchestrator already labels such runs `interrupted` on the next start, but it deliberately never killed the recorded pid, because Windows reuses pids.
2. **There is no installer.** The app only runs from a dev checkout. PLAN.md §12 asks for a per-user install without admin, and a signed installer.

## Options

### Orphan cleanup

1. **Kill the recorded pid on start.** Simple, but wrong: the pid may now belong to something else. Microsoft's `Win32_Process` docs say a `ProcessId` "can be applied to a new process" after termination.
2. **Verify identity, then kill the tree.** Read image name, parent pid, command line and creation time of each recorded pid and of the daemon that owned the run. Kill only what passes every check; log the rest.
3. **A Windows job object with kill-on-close around every agent.** This is the most robust option, but Node has no job-object API: it needs a native module (against ADR 0001: no native rebuilds) or a helper exe we would have to sign.

### Installer

1. **electron-builder, NSIS one-click, per-user.** Installs to `%LOCALAPPDATA%\Programs`. It sets the Start-menu shortcut's AppUserModelID to `appId`, which the toasts need. It has signing hooks: certificate env vars, the Windows store, HSMs and Azure Trusted Signing.
2. **Electron Forge with Squirrel.Windows.** Also per-user. Its install folder is versioned and it adds an `Update.exe` stub. Squirrel's shortcut and AppUserModelID handling needs extra code in main. Forge also expects to own the build, and electron-vite already does that.

## Decision

**Orphan cleanup: option 2.** The code is in `packages/daemon/src/recovery/orphans.ts`. `entry.ts` calls it before it creates the handlers, which start the orchestrator.

A recorded pid is killed with `killTree` (`taskkill /T /F`) only when all of these hold:

- The image is one the run's runner starts: `cmd.exe`, the parent cross-spawn uses for `.cmd` shims; `node.exe`; or the runner's own exe.
- The process was created after the run row was written. The orchestrator writes that row before it spawns, and the check allows 1 s of clock slack.
- The daemon that owned the run is gone. The owner is found in the new `daemon_sessions` table, which holds each daemon's pid and start time. The owner counts as alive if its pid is held by a process at least as old as that daemon's start.
- The process is tied to the run in one of two ways:
  - its command line names the run's folder or profile folder;
  - or its parent pid is the dead owner and it is older than whatever holds that pid now. Microsoft documents exactly this check for `ParentProcessId`.

The parent check is needed because Codex and OpenCode take their folders from the cwd and the environment, which no other process can read.

The process data comes from CIM (`Get-CimInstance Win32_Process`, through `powershell.exe` at its System32 path). `wmic` is gone from Windows 11.

If the query fails, nothing is killed. Kills and skips go into the event log as `recovery.orphan_killed` and `recovery.orphan_skipped`, with the reason.

Kills are bounded, because each `taskkill /T` walks the whole process table and unbounded kills feed a filesystem stall (orca #24829):

- each pid is killed once;
- kills run one at a time, at most 16 per start;
- after a kill that takes longer than 5 s, the rest are skipped as `kill_stalled`.

**Data folder lock.** Main's single-instance lock covers one Electron app, not a dev build and the installed app on the same profile, or a restarted daemon while the old one is still dying (agent-orchestrator #3805, #3633).

- Before it opens the database, the daemon takes an OS file lock on `daemon.lock` in its data folder (`recovery/datadir-lock.ts`).
- It is taken through SQLite's exclusive locking mode, which on Windows is `LockFileEx`, so no native module is needed.
- Windows releases the lock when the holder dies.
- SQLite opens files without handle inheritance, so agent processes never carry the lock. A test kills the holder while its child keeps running and then takes the lock.
- A second daemon waits up to 3 s and then exits. The host restarts it with backoff.

**Windows shutdown.** At sign-out or restart, Windows ends children with status `0x40010004`, often before the app hears about it (orca #33536).

- `@crewyard/proc` exports `isShutdownExit` and `exitCodeWithin`.
- All four adapters end such a run as `interrupted` with detail `windows_shutdown`, not `failed`, so it stays resumable.
- Codex, ACP and Claude can lose their output stream before the exit status arrives, so they wait up to 2 s for it.

**Migrations keyed by id.** `MIGRATIONS` is a list of `{ id, sql }`, and `applied_migrations` records what ran.

- Before, migrations were applied by position. When parallel branches reorder or insert migrations, a database can skip one; agent-orchestrator #3476 hit this.
- A database from the positional scheme counts as having the first `user_version` of `core`, `providers` and `orchestrator`.
- Entries after those three must be idempotent (`create table if not exists`), because a positional database may already have them without a record. An `alter table add column` therefore needs a guard on `pragma table_info`.

**Installer: option 1.** electron-builder 26.17.0 (MIT) is a devDependency of `apps/desktop` only. The configuration is in `apps/desktop/electron-builder.config.cjs`:

- `appId` is `dev.crewyard.app`, the same as `app.setAppUserModelId` in main. The product name is Crewyard.
- NSIS runs with `oneClick`, `perMachine: false` and `allowElevation: false`, so it never asks for admin.
- `deleteAppDataOnUninstall` is false: your projects, profiles and database stay when the app is removed.
- electron-vite bundles main, the daemon, preload and the renderer. They only use Node and Electron built-ins at runtime, so no `node_modules` ship. The asar is about 5 MB.
- It packages the Electron already in `node_modules` (`electronDist`), so packaging needs no second download.
- The icon is generated by `apps/desktop/scripts/make-icon.mjs` from the title-bar mark (`.mark` in `app.css`) and the dark tokens.
- `publish: null`, and the script passes `--publish never`. Nothing is uploaded.
- **Electron fuses** (agent-orchestrator #6446):
  - off: `RunAsNode`, `NODE_OPTIONS` and `--inspect`;
  - on: embedded ASAR integrity, load-only-from-asar and cookie encryption.
  - Nothing needs Electron as plain Node: the daemon is a utility process, and Claude runs from its own installed binary.
  - `grantFileProtocolExtraPrivileges` stays on, because the renderer loads its ES modules from `file://`. Moving the renderer to a custom protocol would let us turn it off.

**Code signing** is a documented hook, not a fake certificate.

- Today's builds are unsigned.
- To sign, set `WIN_CSC_LINK` (path to the `.pfx`, or its base64) and `WIN_CSC_KEY_PASSWORD` as environment variables, and set `CREWYARD_SIGN=1`.
- `CREWYARD_SIGN=1` turns on `forceCodeSigning`, so a missing or broken certificate fails the build.
- A certificate in the Windows store or an HSM goes through `win.signtoolOptions` instead.

**Auto-update is not added.** It needs a release host (GitHub Releases, a private bucket or something else) and a signing certificate, because electron-updater checks the update's publisher. Both are open decisions for you.

## Verification on 2026-10-30 (Windows 11 Pro 10.0.26200)

- **`orphans.test.ts`** runs against real processes. A fake daemon (a Node launcher) spawns a detached agent and exits; cleanup kills the agent through the dead-parent check. A second agent is killed because its command line names its worktree. A process with no tie to the run is left running. So is a reused pid: the test's own process, created before the run.
- **`crash.test.ts`** runs the fixture daemon (`crash-child.ts`) as its own Node process with the fake runner. While a run streams and dedupe-keyed events are written every 2 ms, the test kills that process with `taskkill /F`. The WAL survives and `integrity_check` is `ok`.
  - Replaying every dedupe key adds nothing.
  - The run comes back `interrupted` and resumable. Recovery adds exactly one `run.recovered` event.
  - A second restart changes nothing. Resume then completes, and no (run, seq) pair is duplicated.
  - A copy of the database with its WAL cut 1000 bytes into the last frame, which is what a power cut leaves, opens with `integrity_check` `ok`, keeps every earlier commit and recovers the same way.
- **`pnpm stress`** pushes 20 runs at once through admission control, in 3 rounds. There are 4 projects with one profile each, `perProfile: 2` and `globalSlots: 6`.
  - Peak concurrent runs: 6 global and 2 per profile in every round. Both caps were reached and held.
  - Each round took about 5.8 to 7.9 s.
  - Heap after a forced GC: 27.9, 27.9 and 28.0 MB, against a 27.1 MB baseline; the peak during the runs was 48.6 MB.
  - RSS: 127, 133 and 140 MB.
  - Totals: 60 runs and 2,884 events.
  - The test is kept out of `pnpm check`. It needs `--expose-gc`, which its own config sets.
- **`pnpm package`** built `Crewyard-Setup-0.1.0-x64.exe` (122 MB).
  - `/S` installed it with no prompt to `%LOCALAPPDATA%\Programs\crewyard`, with an uninstall entry under HKCU only (none under HKLM) and Start-menu and desktop shortcuts.
  - The installed exe passed the smoke check (daemon round trip, Electron 45.1.0), and its Start screen rendered.
  - `Uninstall Crewyard.exe /S /currentuser` removed the folder, the shortcuts and the uninstall entry.
  - Rebuilt with fuses and the data folder lock:
    - the fuse wire reads as configured;
    - `ELECTRON_RUN_AS_NODE=1` is ignored and starts the app instead;
    - the installed app passed the smoke check six times in a row and rendered in light theme.
    - An earlier version awaited the lock before it registered the daemon's message listener. The utility process then sometimes exited with code 0 during startup. The listener is now registered before any await.
- **`store.test.ts`** checks migrations by id:
  - a migration inserted before ones already applied still runs;
  - a positional database at `user_version` 3 runs only the newer ids, and one that has everything reruns nothing destructive;
  - a failing migration rolls back unrecorded, and duplicate ids are refused.
- The adapter suites end a fixture agent that exits with `0x40010004` as `interrupted`, detail `windows_shutdown`.

## Sources

| Source | Opened | Stars | License | Archived |
|---|---|---|---|---|
| https://github.com/electron-userland/electron-builder (repository metadata via `gh api`) | 2026-10-30 | 14,692 | MIT | no |
| `website/docs/nsis.md`, `website/docs/features/code-signing/code-signing-win.md`, `website/docs/file-patterns.md` on `master` of that repo | 2026-10-30 | same repo | MIT | no |
| `app-builder-lib@26.17.0` type definitions as installed (`out/targets/nsis/nsisOptions.d.ts`, `out/options/winOptions.d.ts`, `out/configuration.d.ts`): the `oneClick`, `perMachine`, `allowElevation`, `deleteAppDataOnUninstall`, `signtoolOptions.sign` and `forceCodeSigning` semantics for the exact version we use | 2026-10-30 | same repo | MIT | no |
| https://github.com/hovancik/stretchly `package.json` `build` section (an Electron app shipping NSIS through electron-builder) | 2026-10-30 | 6,620 | BSD-2-Clause | no |
| https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process (`ProcessId` reuse, `ParentProcessId` and `CreationDate`) | 2026-10-30 | n/a | Microsoft docs | n/a |
| https://github.com/OrchestratorInc/agent-orchestrator issues #3476 (skipped migration), #3805 and #3633 (two daemons on one data folder), #6446 (fuses); `backend/internal/datadirlock/{datadirlock,flock_windows}.go` on `main` (LockFileEx, released on exit) | 2026-10-30 | 13.9k (PRIOR_ART.md) | Apache-2.0 | no |
| https://github.com/stablyai/orca issues #24829 (unbounded `taskkill /T`) and #33536 (`0x40010004` at Windows shutdown) | 2026-10-30 | 110k (PRIOR_ART.md) | MIT | no |
| `@electron/fuses` option docs in `app-builder-lib@26.17.0` `out/configuration.d.ts` (`FuseOptionsV1`) | 2026-10-30 | electron-builder repo | MIT | no |

No code was copied. The icon writer (PNG and ICO), the process query and the SQLite-based data folder lock are our own; agent-orchestrator's Go lock was read to learn the approach. The CIM field names and electron-builder option names are facts.

## Windows notes

- The packaged app reads `productName` from the asar's `package.json` (set through `extraMetadata`), so its profile is `%APPDATA%\Crewyard`. `pnpm dev` keeps using the unpackaged name (`%APPDATA%\@crewyard\desktop`), so a dev checkout and an installed copy never share a database.
- The install folder is named after the package name (`crewyard`). Shortcuts and the uninstall entry say "Crewyard".
- Unsigned builds trigger SmartScreen's "unknown publisher" warning, and Smart App Control can block them. Signing is the fix (PLAN.md §16).
- The orphan check costs one PowerShell start, about 1 s, and only on a daemon start that finds open runs with a pid.

## Security notes

- Killing processes is the riskiest thing this ADR adds. Every rule fails closed, and each rule has a unit test. The real-process tests prove that an unrelated process and a reused pid are left alone.
- CIM is queried by pid only. The command lines we read are compared in memory and never logged or stored; only the run id, the pid and the reason go into the event log.
- Signing secrets come only from environment variables at build time. The config file holds none, and `CREWYARD_SIGN=1` refuses to produce an unsigned build.
- The installer never elevates: `allowElevation: false` and `requestedExecutionLevel: asInvoker`.

## Rollback

- **Orphan cleanup:** remove the `cleanOrphans` call from `entry.ts`. The orchestrator's own recovery still labels runs `interrupted`. The `daemon_sessions` table is harmless if left in place.
- **Data folder lock:** remove the `acquireDataDirLock` call from `entry.ts`. The `daemon.lock` file left behind is harmless.
- **Migrations by id:** none needed for old databases, since `user_version` is left as it was. Reverting the code would apply migrations by position again.
- **Packaging:** delete `electron-builder.config.cjs`, `scripts/make-icon.mjs` and `build/`, remove the `package` and `icon` scripts, and remove the devDependency. Nothing at runtime depends on them.
