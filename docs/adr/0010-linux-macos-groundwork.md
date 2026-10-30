# ADR 0010: Groundwork for Linux and macOS

Date: 2026-10-30. Status: accepted. Large tier (AGENTS.md): a new platform layer.

## Problem

The owner, 2026-10-30: "linux ve mac için hazırlıklar da yapabiliriz ama öncelik windows da" (we can prepare for Linux and macOS, but Windows comes first). Nothing ships for Linux or macOS yet, and no release is made. Windows must behave exactly as before.

Crewyard was written for Windows 11, and these parts of it are Windows-only:

| Area | Windows today | What breaks elsewhere |
|---|---|---|
| Process trees (`packages/proc`) | `taskkill /PID <pid> /T /F`; `.cmd` shims through cross-spawn; `windowsHide`; `where.exe $PATH:` | `killTree` sent SIGTERM to `-pid`, but children were never group leaders, so only the root died. `which` started a `which` binary, which minimal distributions lack. `ensureSystemEnv` copied only Windows variables. |
| API keys (ADR 0002) | DPAPI through Windows PowerShell 5.1 | The daemon refused to store keys. |
| Report server (ADR 0007) | named pipe plus a PowerShell byte relay | The socket was a plain file in `tmpdir()` with the umask's mode, and there was no relay. |
| Orphan cleanup (ADR 0004) | CIM process query, then `taskkill /T` | Skipped as `unsupported_platform`. |
| Machine check | Defender exclusions, `LongPathsEnabled`, case twins | Defender and long paths already returned "unavailable" / null. |
| Desktop shell | tray, `toastXml` toasts, close-to-tray, Start with Windows, caption overlay | All gated on `win32`. Off Windows, closing the window called `daemon.stop()`, which killed the daemon without stopping agent trees, so they were orphaned. |
| Packaging | NSIS only | No Linux or macOS target. |

## Options

1. **A seam per module, with the Windows branch left as it was.** Each Windows-only call gets a POSIX branch next to it. Every helper takes the platform as an argument, so both branches run under test on any machine. Everything is our own code, on Node and Electron built-ins.
2. **Cross-platform libraries in place of our own code**: `tree-kill` for trees, `keytar` for secrets, an IPC library for sockets.
   - This changes the Windows path, which the owner ruled out.
   - `keytar` is a native module. ADR 0001 avoids native rebuilds per Electron ABI.
   - None of these fixes the relay problem: the packaged app cannot run as Node (the `runAsNode` fuse is off, ADR 0004).

**Chosen: 1.** The sections below give each seam's own two options.

## Decisions

### Process trees (`packages/proc/src/platform.ts`)

Options:

- **(a) Process groups.** `start()` and `run()` pass `detached: true` off Windows, so every child leads its own group and session (Node `child_process` docs). `killTree` signals the group.
- **(b) Walk the tree from `ps` without groups** (the `tree-kill` approach). This misses processes whose parent already exited, because init adopts them.

**Chosen: (a), plus the walk from (b).** `killTreePosix`:

1. Reads `ps -A -o pid= -o ppid=` before it signals anything. Once the root exits, its children move to init and the links are lost.
2. Sends SIGTERM to `-pid`, to `pid` and to every descendant. Descendants that started their own group are reached this way too.
3. Polls with signal 0 for 2 s, then sends SIGKILL to whatever is left.

Why SIGTERM first:

- agent-orchestrator notes that Claude Code stops its own sub-groups on SIGTERM. Going straight to SIGKILL would leave those groups running.
- vibe-kanban and emdash also give a grace period before SIGKILL.
- macOS answers EPERM for a group made only of zombies. The liveness probe therefore counts EPERM as "still there" (agent-orchestrator `tree_unix.go`).
- `ps` is started with `execFile`, not `run()`. `run()` kills a timed-out child with `killTree`, which would call `ps` again.

Never on Windows:

- `detached` on Windows means a new console window, so it is never set there.
- `taskkill` is unchanged.

Binary lookup:

- Off Windows, `which()` searches in-process (`findOnPosixPath`) instead of starting `which`.
- Empty and relative PATH entries are dropped. POSIX reads them as the current folder, the same hole `$PATH:` closes for `where.exe`.
- After PATH, each runner's own install folders are searched. An app started from the Dock, Finder or a desktop launcher gets a short PATH:
  - `~/.local/bin`: Claude Code's native installer;
  - `~/.opencode/bin`: OpenCode's install script;
  - `/opt/homebrew/bin`: Homebrew on Apple silicon;
  - `/home/linuxbrew/.linuxbrew/bin`: Homebrew on Linux;
  - `/usr/local/bin`, `/usr/bin`, `/bin` and, on Linux, `/snap/bin`.
- vibe-kanban and emdash instead run the user's login shell (`$SHELL -ilc`) to read its PATH. We do not: that runs the user's rc files inside the daemon, and emdash had to guard against AppImage fork bombs it caused (their #1679). It stays the documented next step if fixed folders prove too few.

System variables:

- `ensureSystemEnv` copies `POSIX_SYSTEM_VARS` off Windows: `HOME`, `PATH`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY` and `WAYLAND_DISPLAY`.
- POSIX names compare with exact case. Windows names still compare without case.
- An adapter's own `HOME` override, the ACP profile home, is kept.

### API keys (`providers/host-protector.ts`, `apps/desktop/src/main/secrets.ts`)

Options:

- **(a) Electron `safeStorage`, which uses the macOS Keychain and the Linux Secret Service or KWallet, called by the main process for the daemon.**
- **(b) The daemon calls the OS keyring CLIs itself** (`/usr/bin/security` on macOS, `secret-tool` on Linux) to hold one master key, and encrypts with AES-GCM in `node:crypto`.

**Chosen: (a).**

- `secret-tool` is not installed on a fresh Ubuntu desktop. The 24.04.5 desktop manifest lists `libsecret-1-0` and `gnome-keyring`, but not `libsecret-tools`.
- A Keychain item made by `security` trusts `/usr/bin/security`, so any process of the same user reads the master key without a prompt. `safeStorage`'s item is tied to the app.
- (b) would also be crypto code of our own.

ADR 0002 rejected (a) on Windows for two reasons:

- The main process would interpret messages.
- Windows ties the key to Chromium's `Local State` in `userData`.

The second reason does not hold on macOS or Linux, where the key lives in the system keychain. The first is accepted as one narrow exception:

- Core `host.ts` defines `host.request` / `host.response` with two methods, `secret.protect` and `secret.unprotect`.
- The daemon posts them on its parent port. `DaemonHost` answers them only when main passed a handler, which it does off Windows only.
- The data is base64. Main keeps nothing: no cache, no log, no file.

Details:

- It uses the async API (`isAsyncEncryptionAvailable`, `encryptStringAsync`, `decryptStringAsync`). Electron 45's own typings mark the sync calls deprecated. The Electron docs say they go away in 46.
- On Linux it refuses `basic_text` (Chromium's fallback with a hard-coded password) and `unknown` (asked before `ready`). emdash refuses `basic_text` too. VS Code keeps such secrets in memory only.
- Blobs start with `CYS1`. A DPAPI blob copied from Windows is refused with "add it again" instead of failing inside Chromium.
- In plain Node (tests, the live scripts), or when the app found no keychain, `defaultProtector()` stays `unsupportedProtector`: keys are refused, never written in the clear (ADR 0002).
- The daemon answers `host.response` before it awaits startup, so a startup step that waits on a key cannot deadlock.
- `HostClient` gives up after 60 s. The first use after login can wait on a Keychain or keyring prompt.
- Keys still leave the daemon only as child environment variables or an `Authorization` header.

### Local ingress and the report relay (`packages/daemon/src/local-socket.ts`, `mcp/pipe.ts`, `mcp/relay.ts`)

The socket. Options:

- **(a) A Unix domain socket in a private folder:**
  - Linux: `$XDG_RUNTIME_DIR/crewyard`. The XDG spec makes that folder per user and 0700.
  - otherwise `<tmpdir>/crewyard-<uid>`, which on macOS is the per-user `TMPDIR`;
  - `/tmp/crewyard-<uid>` when the path would not fit.
- **(b) A Linux abstract socket.** It never touches the file system, but it is Linux-only and has no permission bits at all.

**Chosen: (a).**

- The folder is what protects the socket. macOS does not check a socket file's own mode on connect, and Node creates the file with the umask before we can change it.
- The daemon creates the folder 0700. A folder already there must be a plain folder (not a symlink) owned by us; a looser mode is tightened. Then the socket is chmod 0600 after `listen`.
- agent-orchestrator does the same: 0700 folder, 0600 socket, random name, refuse an over-long path. It also uses a `/tmp` symlink, which our no-symlink rule rules out.
- Paths must fit `sun_path`: 103 bytes on macOS, 107 on Linux (Node net docs). Socket names off Windows are therefore `mcp-<pid>-<16 hex>`.
- The Windows pipe name and code path are unchanged. `endpointPath()` returns the same `\\.\pipe\crewyard-mcp-<pid>-<24 hex>`.
- `server.close()` unlinks the file. A crash leaves it behind, under a random name in a folder the system clears at logout (XDG) or reboot (tmp).
- The external ingress pipe of PLAN.md §4 is not built yet. When it is, it uses `endpointPath()` too.

The relay. Options:

- **(a) The system Perl, `/usr/bin/perl`, with core modules only** (`IO::Socket::UNIX`, `IO::Select`), as a one-line `-e` script.
- **(b) The app's own executable in a relay mode.** Every relay would be a whole Electron main process: much heavier than PowerShell's ~40 MB. It would also need to skip the single-instance lock, and on macOS it may show a Dock icon.

**Chosen: (a).**

- macOS ships `/usr/bin/perl`. Linux distributions that package git install Perl with it, because git's own scripts need it.
- The script mirrors the PowerShell relay: hello line with the ticket from env, byte copy both ways, exit when either side closes, no secret in its arguments.
- Checked on this machine with Git for Windows' Perl 5.42 (Cygwin AF_UNIX on both ends): `perl -c` passes, bytes pass unchanged (Turkish text included), it exits 0 when its stdin closes, and exits 1 with no server.
- Without `/usr/bin/perl`, `reportServerSpec` throws, and the run starts without MCP. That is the fallback ADR 0007 already had for a pipe that cannot listen.

### Orphan cleanup (`recovery/orphans.ts`)

- Linux and macOS get `listPosixProcesses`: three `ps -o … -p <pids>` calls under `LC_ALL=C`, because `comm` and `args` may hold spaces.
- `lstart` is parsed as local time. `comm` is reduced to its file name, since macOS prints a full path.
- The decision rules are unchanged and fail closed.
- Off Windows, a dead daemon's children are adopted by init, so the parent rule rarely matches. Only a command line that names the run's folder leads to a kill; everything else is skipped as `identity_unverified`.
- Matching on a working folder (`/proc/<pid>/cwd`, `lsof -d cwd`) is the follow-up. See "What blocks shipping".

### Machine check

- Defender reads `unavailable` and long paths read null off Windows. The Start screen leaves both rows out (N/A), as it already did. A test now pins it.
- **Case twins stay on everywhere.** This differs from the request: on Linux two folders differing only by case are legitimate. But Crewyard's own store and path matching ignore case (`projects.path collate nocase`, the `samePath` helpers), so two such projects would still collide. The refusal stays until project paths are keyed per platform, which needs a table rebuild.

### Desktop shell (`apps/desktop/src/main/platform.ts`)

`desktopFeatures(platform, interactive)` holds one row per platform. `main/index.ts` reads it instead of `isWin`.

| | Windows (as before) | macOS | Linux |
|---|---|---|---|
| Tray | notification area | menu bar | none: GNOME shows no tray icons without an extension, and Electron cannot tell |
| Notifications | `toastXml` with buttons | title and text; a click opens the item | same, through libnotify |
| Close with agents running | hide to tray | hide; the Dock icon brings the window back (`activate`) | quit confirm that names the agents |
| Start at login | Run key | login item | none: Electron's login items are Windows and macOS only |
| Caption overlay | yes | no (traffic lights) | yes |

In screenshot, smoke and e2e runs every row is off, as before, except the caption overlay. A real session off Windows now quits through `requestQuit`: confirm, `app.shutdown`, then the trees are stopped. Before, `window-all-closed` called `daemon.stop()` and orphaned them.

### Packaging (`apps/desktop/electron-builder.config.cjs`)

- **mac:** dmg and zip for arm64 and x64, `identity: null` (unsigned), `notarize: false`, category `public.app-category.developer-tools`.
- **linux:** AppImage and deb for x64, category `Development`, executable `crewyard`.
- `pnpm package:mac` and `pnpm package:linux` run only on that OS, because `electronDist` is the Electron pnpm installed there.
- The config passes electron-builder 26.17.0's own schema check (`validateConfiguration`).
- Nothing was built or downloaded for these targets.

### CI

- `ci.yml` already runs `pnpm check` on ubuntu for `push` to `main` and for pull requests. It is the Linux test job: the real-process POSIX tests (process groups, the 0600 socket, the Perl relay round trip) are `runIf(!win32)` and run there. No new job was needed; it got a comment.
- `macos-test.yml` is new and runs `pnpm test` on `macos-latest`, on `workflow_dispatch` only. macOS minutes count ten times Linux ones on a private repository. It has `concurrency` with `cancel-in-progress` and `timeout-minutes`.
- Crewyard's own workflow check passes both files. A first draft put the macOS job in `ci.yml` behind `if:`; the check flagged it as a costly runner on push, so it moved to its own file.
- No CI run was started.

## Sources (all opened 2026-10-30)

| Source | Stars | Licence | Archived | What we learned |
|---|---|---|---|---|
| github.com/BloopAI/vibe-kanban, `crates/utils/src/process.rs`, `command_ext.rs`, `shell.rs`, `assets.rs` (main) | 28,520 | Apache-2.0 | no | group spawn and SIGINT → SIGTERM → SIGKILL on the group; a no-window helper for Windows; login-shell PATH refresh; per-OS data folders |
| github.com/generalaction/emdash, `packages/core/src/primitives/exec/node/process-tree-terminator.ts`, `services/pty/api/posix-pty-terminator.ts`, `apps/emdash-desktop/src/main/host/secrets/encrypted-app-secrets-store.ts`, `linux-secret-storage.ts`, `lib/userEnv.ts`, `electron-builder.config.ts`, `.github/workflows/release-linux.yml` (main) | 6,121 | Apache-2.0 | no | `-pid` signals with a grace period; descendants that left the group; refusing `basic_text`; `--password-store` on non-KDE desktops; login-shell env with AppImage guards; mac and linux targets; Linux builds in a container |
| github.com/OrchestratorInc/agent-orchestrator, `backend/internal/process/tree_unix.go`, `pkg/agentruntime/process_unix.go`, `internal/browserruntime/listen_unix.go`, `internal/browserstream/listen_unix.go`, `internal/datadirlock/flock_unix.go`, `internal/adapters/agent/binaryutil/binaryutil.go` (main) | 13,916 | Apache-2.0 | no | Setpgid, SIGTERM first (Claude Code's sub-groups), EPERM on zombie groups; 0700 folder, 0600 socket, length check; flock data lock; fixed binary folders after PATH |
| github.com/microsoft/vscode, `src/vs/platform/encryption/electron-main/encryptionMainService.ts`, `src/vs/platform/secrets/common/secrets.ts` (main) | 194,373 | MIT | no | in-memory secrets when no keyring answers; the backend names |
| github.com/electron-userland/electron-builder, `packages/app-builder-lib/src/options/linuxOptions.ts`, `macOptions.ts`, `targets/FpmTarget.ts` at `electron-builder@26.17.0`, and the installed `app-builder-lib@26.17.0` `out/targets/FpmTarget.js`, `out/options/macOptions.d.ts` | 14,693 | MIT | no | target names; `identity: null` skips signing, `"-"` is ad hoc; deb needs a homepage and a maintainer email; deb default depends include `libsecret-1-0` |
| github.com/anomalyco/opencode, `install` on branch `v1` (via opencode.ai/install) | 223,247 | MIT | no | `INSTALL_DIR=$HOME/.opencode/bin` |
| electronjs.org/docs/latest/api/safe-storage; Electron 45.1.0 `electron.d.ts` as installed | | MIT | | main process only; Keychain, Secret Service, KWallet; `basic_text`; async API, sync deprecated |
| electronjs.org/docs/latest/api/app, `api/tray`, `tutorial/notifications`, `tutorial/custom-title-bar` | | MIT | | data folders per OS; Linux StatusNotifier tray; macOS notifications need a signed app; caption overlay on Windows and Linux |
| nodejs.org/api/net.html, nodejs.org/api/child_process.html | | MIT | | `sun_path` limits, unlink on close; `detached` makes a group and session leader off Windows |
| specifications.freedesktop.org/basedir/latest/ | | | | `XDG_RUNTIME_DIR`: per user, 0700, removed at logout, may be cleaned after 6 h without atime updates |
| ss64.com/mac/security.html, docs.ruby-lang.org MacOSBackend | | | | `security -i` reads commands from stdin (the rejected option (b)) |
| manpages.ubuntu.com noble `secret-tool(1)`; releases.ubuntu.com 24.04.5 desktop manifest | | | | `secret-tool` lives in `libsecret-tools`, absent from the desktop install |
| code.claude.com/docs/en/setup | | | | native installer launcher at `~/.local/bin/claude` on macOS and Linux |
| docs.brew.sh/Installation | | | | `/opt/homebrew` on Apple silicon, `/home/linuxbrew/.linuxbrew` on Linux |

No code was copied or ported. Command flags, `ps` columns, Electron API names and paths are used as facts.

## Windows notes

- Every Windows branch is the code that was there:
  - `taskkill`, `where.exe $PATH:`, `.cmd` handling, `windowsHide`;
  - DPAPI from the daemon, the PowerShell relay, the CIM query;
  - `toastXml`, tray, close-to-tray, Start with Windows.
- `desktopFeatures("win32", true)` and `("win32", false)` are pinned by a test to what the old `desktop` flag gave.
- `ensureSystemEnv(…, "win32")` keeps the case-insensitive rule. Its existing tests now pass the platform, so they also pass on the Linux CI job.
- `DaemonHost` receives no host handler on Windows. A host request would be refused, and the Windows daemon never sends one.

## Linux notes

- Keys need a running Secret Service (GNOME Keyring, KeePassXC) or KWallet. Without one, keys are refused with a clear message.
- Tiling window managers can make Chromium pick `basic_text` even with a Secret Service running. emdash passes `--password-store=gnome-libsecret` there. That switch is the follow-up if testers hit it.
- AppImage and the Chromium sandbox on distributions that restrict unprivileged user namespaces are untested.
- `XDG_RUNTIME_DIR` files may be cleaned after 6 h without an atime update. A daemon up for days could lose its report socket. Not handled yet.

## macOS notes

- Unsigned builds:
  - Apple silicon needs at least an ad-hoc signature to start an arm64 app.
  - Notifications need a signed app (Electron docs), so unsigned builds get none.
  - Keychain may prompt again after each update.
- The renderer's 40 px title bar has no room reserved for the traffic lights yet.
- Finder launches give a short PATH, which the fixed folders cover. `LANG` may be unset, which matters only for CLIs that do not default to UTF-8.

## Security notes

- **No TCP listener**, as before. Off Windows the socket's folder is 0700 and ours, and the socket is 0600. Each connection still needs a live run ticket (ADR 0007).
- **Process groups** make `killTree` reach a runner's whole tree. A recorded pid reused by another process is still guarded by the orphan rules, which are unchanged. The 2 s grace is far shorter than pid reuse takes in practice; emdash re-checks start times before SIGKILL, which is a possible hardening.
- **The host channel:**
  - carries only the two secret methods; anything else is refused;
  - is checked for base64 on both sides;
  - is answered only for the daemon child that asked (a restarted daemon gets nothing stale);
  - never logs payloads.
- **Keys are never stored unprotected:** `basic_text`, `unknown`, no keychain, or plain Node all refuse.
- **The relay**, like PowerShell, holds no secret in its arguments; the ticket and socket path are in the server's env only. It is started by absolute path, never from PATH or the worktree.
- **Binary lookup** never searches the current folder.

## What is untested on real Linux or macOS

Nothing here ran on a real Linux or macOS machine. WSL has only Docker's internal distribution, so nothing was installed or run there.

What did run on Windows:

- every POSIX branch, with the platform passed in or mocked;
- the Perl relay through Cygwin.

What runs only on POSIX, and will first run on the Linux CI job:

- the real-process tests: the group kill of a grandchild, the 0700/0600 socket, the Perl relay round trip through the daemon.

The rest of the suite has never run on Linux either, because there is no GitHub remote yet. Some older tests may assume Windows paths.

## What blocks shipping on Linux or macOS

1. Real-machine runs of the four adapters (conformance suite, PLAN.md §5.4) on each OS.
2. Orphan identity off Windows: match the run's working folder and require a session leader before killing.
3. Icons: `.icns` for macOS and a PNG set for Linux (`scripts/make-icon.mjs` writes `.ico` only).
4. deb needs a `homepage` and a maintainer email, which do not exist yet.
5. macOS signing and notarization (also what makes notifications work), or at least ad-hoc signing for Apple silicon.
6. The title bar on macOS (traffic lights).
7. A Linux tray decision (StatusNotifier detection) and XDG autostart.
8. The Start screen's default import folder is `C:\Projeler`; it needs a home-based default.
9. Wording that names Windows or DPAPI (Settings → Data, the provider dialog) needs per-platform text, in English and Turkish.
10. `safeStorage`'s `shouldReEncrypt` is ignored; blobs are not rewritten after a keychain key rotation.
11. Case-sensitive project paths on Linux (store collation).

## Rollback

- **Process groups:** set `ownGroup` to false and route `killTree` back to its old `process.kill(-pid)` lines. Windows is not affected either way.
- **Secrets:**
  - drop the `useHostProtector` line in `entry.ts` and the `hostSecrets` argument in `main/index.ts`; POSIX goes back to refusing keys;
  - `host.ts` and `secrets.ts` are then unused;
  - blobs written by `safeStorage` stay on disk and are refused, not misread, by any other protector.
- **Socket:** `pipePath()` can go back to `join(tmpdir(), …)`; `ensurePrivateDir` and `restrictSocket` do nothing on Windows.
- **Relay:** `reportServerSpec` off Windows can throw unconditionally, which restores "no MCP off Windows".
- **Orphans:** make `processListerFor` return null off Windows.
- **Desktop shell:** `desktopFeatures` returning the "none" row off Windows restores the old behaviour, except the quit path; keep that part.
- **Packaging and CI:** delete the `mac` and `linux` blocks, the two `package:*` scripts and `macos-test.yml`.
