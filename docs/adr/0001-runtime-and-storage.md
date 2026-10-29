# ADR 0001: Electron runtime, utility-process daemon, node:sqlite

Date: 2026-10-30. Status: accepted.

## Problem

The app must run agent CLIs on Windows, keep state across restarts, and talk to four different agent protocols, three of which ship TypeScript clients (Claude Agent SDK, OpenCode SDK, ACP SDK). Native Node modules are a known source of Windows build failures.

## Options

1. **Electron + TypeScript everywhere; daemon as an Electron utility process; SQLite through Node's built-in `node:sqlite`.**
2. Tauri 2 (Rust) + a bundled Node sidecar for the agent SDKs; SQLite through `rusqlite`.
3. Electron + `better-sqlite3`.

## Decision

Option 1.

- Electron 45.1.0 ships Node 24.22.1 with SQLite 3.53.4. `node:sqlite` works there without flags and needs no rebuild against Electron's ABI. Checked on this machine on 2026-10-30 inside the Electron runtime and in system Node.
- The daemon runs as `utilityProcess.fork(out/main/daemon.js)`. The main process only relays typed messages (`packages/core/src/ipc.ts`). A crash restarts the daemon with backoff and fails the pending calls.
- Option 2 keeps a second runtime alive just for the Claude Agent SDK.
- Option 3 needs `electron-rebuild` on every Electron upgrade and a working MSVC toolchain.

## Consequences

- No ORM: schema migrations are plain SQL in `packages/daemon/src/store.ts`, tracked by `pragma user_version`.
- `node:sqlite` is still marked experimental upstream. If its API changes, only `store.ts` is affected.
- Child processes must go through `packages/daemon/src/spawn.ts`. Node refuses to start `.cmd` shims without a shell (`spawn EINVAL`, found by the smoke test); `cross-spawn` handles them without `shell: true`.

## Rollback

`Store` is the only SQLite consumer, so swapping in `better-sqlite3` is one file.
