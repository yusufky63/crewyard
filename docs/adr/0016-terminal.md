# ADR 0016: A terminal in the bottom panel

**Status:** accepted, 2026-10-31. The owner asked: "ai chat, terminal, etkinlik ve hatalar gibi bir panel var mı, toplu şekilde gösterilen tabs'lı" (is there one panel with tabs that shows AI chat, terminal, activity and errors together?). The Activity drawer grows into that panel (DESIGN.md §4); this ADR covers its one new subsystem, the terminal.

## Problem

Looking at what an agent did often ends in a shell: `git log` in the worktree, running the tests by hand, starting the dev server. Today that means leaving Crewyard for Windows Terminal and finding the worktree folder. DESIGN.md §4 said the drawer has no terminal because `node-pty` is not shipped; PLAN.md §2 always listed `node-pty` and ConPTY "for the optional terminal view".

A terminal is unlike everything else Crewyard starts:

- **It is not an agent.** You type every command. No approvals, risk rules, budgets or limits apply, and nothing in it is reported to a runner.
- **It must never carry a key.** Crewyard holds API keys (ADR 0002) and hands them only to the child environment of the runner that needs them. A shell you type into must not inherit any of them, nor Crewyard's own variables.
- **It needs a native module.** A real terminal (colours, cursor keys, `vim`, `git add -p`, Ctrl C) needs a pseudo console: ConPTY on Windows, a pty on Linux and macOS. Node has none built in.

## Options

### Where the pseudo console lives

1. **In the main process.** One hop less, but a crash in native code would take the window and the daemon's parent with it, and the main process would hold a native module it otherwise does not need.
2. **In the daemon.** The daemon already owns child processes. But it owns agents, and a native crash there stops every running agent; it also holds decrypted keys while it launches runs, which is the last place a shell should start from.
3. **In its own utility process, the pty host**, started by main on the first terminal you open and relayed by main. VS Code runs its terminals the same way (`src/vs/platform/terminal/node/ptyHostMain.ts`, a separate process started by `nodePtyHostStarter.ts`). A crash ends the shells and nothing else; main restarts the host on the next open.

**Chosen: 3.** It isolates the native code and keeps the shell away from the process that handles keys.

### Which pseudo console library

1. **`node-pty`** (microsoft/node-pty): ConPTY on Windows 10 1809 and later, forkpty elsewhere; used by VS Code, Hyper and most Electron terminals.
2. **Writing our own ConPTY binding.** A native addon of our own to build, sign and maintain for every Electron update.

**Chosen: 1.**

### Which renderer

1. **`@xterm/xterm`** (xtermjs/xterm.js): the terminal emulator VS Code uses; theme colours, fonts and size come from options, so tokens can drive it.
2. **A hand-made view** that only prints text. No cursor addressing, no colours; `vim` or `git add -p` would not work, which is most of why you open a terminal.

**Chosen: 1**, with `@xterm/addon-fit` to fit rows and columns to the panel.

## The choice

### Dependencies (added with `pnpm add -E` in `apps/desktop`)

| Package | Version | License | Why |
|---|---|---|---|
| `node-pty` | 1.1.0 | MIT (`LICENSE` file; GitHub reports `NOASSERTION` because the file holds two MIT notices) | pseudo console |
| `@xterm/xterm` | 6.0.0 | MIT | terminal emulator in the renderer |
| `@xterm/addon-fit` | 0.11.0 | MIT | fit to the panel |

### Native build against Electron 45

`node-pty` 1.1.0 is a Node-API addon (`node-addon-api`), so one binary works under every Node and Electron ABI and needs no rebuild against Electron 45. Its install script (`scripts/prebuild.js`) finds the bundled prebuilds for `win32-x64`, `win32-arm64`, `darwin-x64` and `darwin-arm64` and skips `node-gyp`; Linux has no prebuild and builds from source on install (needs `python3`, `make` and a C++ compiler, as for any native addon). `pnpm-workspace.yaml` lists it under `onlyBuiltDependencies` so the install script runs. Electron's own `npmRebuild` stays off.

### Packaging (electron-builder)

The installer ships no `node_modules` (ADR 0004): everything else is bundled by electron-vite. A native module cannot be bundled and cannot load from inside `app.asar` (Windows loads a `.node` file from a real path, and `node-pty` starts a worker thread from a script file). So:

- `out/main/pty-host.js` is bundled like the daemon, with `node-pty` left external;
- `electron-builder.config.cjs` copies `node-pty`'s runtime files to `resources\native\node-pty` with `extraResources`: `package.json`, `LICENSE`, `lib\**\*.js` without tests, and `prebuilds\<platform>-<arch>` without `.pdb` files. This is the same effect as an `asarUnpack` entry (the files sit next to the archive, not in it), without shipping a `node_modules` tree;
- the pty host loads it from `process.resourcesPath\native\node-pty` when packaged and from `node_modules` otherwise (`apps/desktop/src/main/terminal/load.ts`);
- `scripts/third-party-licenses.mjs` adds `node-pty` to `THIRD-PARTY-LICENSES.txt`, since the bundler never sees it.

`pnpm package` is the check: the installed app opens a terminal.

### What the shell gets (`apps/desktop/src/main/terminal/env.ts`)

The shell starts with your own environment, as main received it from Windows, minus:

- every variable whose name looks like a credential (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `AUTH`, `COOKIE`, `SESSION_ID`, private keys), and every variable whose value looks like one (API key prefixes, JWTs, URL credentials), both found by `redactLogLine` in `packages/core`, the same rules that keep keys out of the logs. Crewyard cannot tell a key it stored from one you exported yourself, so both are dropped; set one again inside the shell if you need it there;
- Crewyard's own variables (`CREWYARD_*`) and those of Electron and Node that would change how a child starts (`ELECTRON_*`, `NODE_OPTIONS`, `NODE_CHANNEL_FD`, Chromium's crash pipe);
- variables a parent Claude Code session sets (`CLAUDECODE`, `CLAUDE_CODE_*`), so an agent CLI started by hand in the terminal is not treated as nested.

It adds `TERM=xterm-256color` and `COLORTERM=truecolor`, and on Git Bash `CHERE_INVOKING=1`. The pty host itself is forked with the same scrubbed environment, so even its own process never holds a key. Keys never pass through it: it is not handed `StartRequest.env` or anything the daemon decrypts. A test feeds every secret shape the redaction knows and checks that none reaches the shell's environment while `PATH`, `SystemRoot` and the other system variables do.

### Lifecycle

- **Never started on its own.** The Terminal tab shows `New terminal`; nothing runs until you press it. Opening the panel, switching to the tab or restarting the app starts nothing. The pty host process starts with the first terminal.
- **Where it starts.** In the open project's folder, or in the selected task's worktree when you pick that (`Project folder` / `Task worktree` in the tab's toolbar). Main checks that the folder is absolute and exists before spawning.
- **Hiding is not stopping.** Closing the panel or switching tabs hides the view; the shell keeps running and its output keeps arriving (DESIGN.md §7).
- **Closing a terminal ends its shell.** The ✕ on a terminal's own tab asks first while its shell is running ("End this shell?"), then ends it and every process it started (`killTree`). A shell that exited closes without asking.
- **Reload and quit.** A reloaded window has no terminals, so main ends the shells of that window; quitting ends the pty host and every shell under it.
- **Limits:** at most 8 terminals at once; output is passed through, never stored or logged; the scrollback is 5,000 lines in the window only.

### Windows notes

- ConPTY needs Windows 10 1809 (build 18309 is where `node-pty` turns it on) or later; Crewyard targets Windows 11 (README), where it is always there. `node-pty` is asked for its bundled `conpty.dll` and `OpenConsole.exe` (`useConptyDll`), the same newer ConPTY Windows Terminal uses, which also avoids `node-pty` forking a helper script on kill: in the packaged app the `runAsNode` fuse is off, so a forked script would start a second Crewyard instead.
- **Shells:** Windows PowerShell 5.1 by default (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo`), then PowerShell 7 (`pwsh.exe`) and Git Bash (`<Git>\bin\bash.exe --login -i`, from where `git.exe` is installed) when they are found, and Command Prompt. Paths are resolved, never looked up through a shell (`which` in `packages/proc`); `shell: true` is never used.
- **UTF-8:** ConPTY hands us UTF-8; the console's code page decides how a program's own bytes are read. PowerShell starts with `[Console]::OutputEncoding` and `$OutputEncoding` set to UTF-8 without BOM, Command Prompt with `chcp 65001`, Git Bash with `LANG=C.UTF-8` unless you set `LANG`.
- **Paths with spaces** work: the shell is a resolved executable path and the folder is the `cwd` option, never part of a command line. Tests use folders with spaces.
- **Keys inside the terminal:** Ctrl C, Esc and the arrow keys go to the shell. Only the panel's own shortcuts (Ctrl J, Ctrl Shift A, Ctrl \`, Ctrl Shift M) are taken back by the app; Esc inside a terminal never closes the panel.

### Security notes

- No TCP listener: renderer to main is Electron IPC, main to pty host is the utility process port.
- Only the main window's page may open, write to or close a terminal; each terminal belongs to the page that opened it.
- Terminal output is untrusted text drawn by xterm.js into its own elements; links in it are not made clickable.
- The terminal is not an agent: no approvals apply, and nothing typed or printed reaches a runner, the event log or the logs.

## Rollback

Revert the commits. The Terminal tab disappears and the panel keeps Assistant, Events, Logs and Problems. Remove `node-pty`, `@xterm/xterm` and `@xterm/addon-fit` from `apps/desktop/package.json`, the `onlyBuiltDependencies` entry and the `extraResources` entry. Nothing is stored: no table, no file, no setting outside the window's own prefs (which keep the last tab; an unknown tab falls back to Events).

## Sources

| Source | Opened | Stars | License | Archived |
|---|---|---|---|---|
| github.com/microsoft/node-pty, `lib/windowsPtyAgent.js`, `lib/windowsConoutConnection.js`, `lib/utils.js`, `scripts/prebuild.js`, `LICENSE` (read from the 1.1.0 package) | 2026-10-31 | 2,056 | MIT | no |
| github.com/xtermjs/xterm.js, npm `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0 | 2026-10-31 | 21,305 | MIT | no |
| github.com/microsoft/vscode, `src/vs/platform/terminal/node/nodePtyHostStarter.ts`, `terminalProcess.ts`, `terminalEnvironment.ts` (pty host as its own process, `useConptyDll` as an option) | 2026-10-31 | 194,400 | MIT | no |

Nothing was copied; these were read to learn the approach.
