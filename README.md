# Crewyard

A local, Windows-first desktop app that runs and supervises coding agents (Claude Code, Codex, Gemini CLI, OpenCode) across several of your own accounts and API keys. It proposes a crew for each task, waits for your approval, watches limits and spend, hands work to a backup agent when you allow it, and keeps GitHub under your control.

Status: pre-release. It is built and tested on Windows 11. Linux and macOS are prepared for but not shipped, and there are no releases yet.

## What it does

- **Crews per task.** Describe a task and Crewyard proposes who plans, implements, tests and reviews it, with the reason for each pick and a cost estimate. Nothing starts until you approve.
- **Task assistant.** On the Tasks screen, `Assistant` or `Ctrl Shift A` opens a terminal-style chat with a read-only agent on a profile you pick. It reads the project, asks when something is unclear and proposes task drafts (kind, acceptance criteria or questions to research, size) as editable cards; `Add as draft` turns one into a task whose crew still waits for your approval. It never writes or starts runs, its spend counts against the key's daily cap (Estimated), and it stops when you close the panel or after it sits idle ([ADR 0014](docs/adr/0014-task-assistant.md)).
- **Reports and ready-made analyses.** A finished research, review or docs task shows its report on the row and in the inspector, with each finding's severity, file and line and the tasks it suggests as drafts you can add. Ready-made analyses (review the project, optimizations, bugs, security, dependencies and licences, test gaps) come as local templates, a few suggested for each project from what Crewyard already knows, with no model call.
- **Your own roles.** Markdown files in `.crewyard/roles/` (or global ones in Crewyard's data folder) change a built-in role's contract or add a role of your own. A role file can only narrow permissions, never widen them past the project's rules; a project lists the custom roles its crews may use in `.crewyard/project.json`. Settings → Roles shows each role's source and any file that was not used ([PLAN.md §9.1](PLAN.md#91-roles)).
- **Four runners, many providers.**
  - Claude Code (Anthropic or Anthropic-compatible API keys only; never a claude.ai sign-in), Codex, OpenCode, and Gemini CLI over ACP.
  - Providers come from a synced catalog (models.dev): DeepSeek, Kimi, GLM, Qwen, MiniMax, OpenRouter and others.
- **Limits and spend you can trust.**
  - Every quota or cost figure says whether it is Reported, Estimated or Unknown.
  - Spend caps are per key and per task, and a run stops and asks at the cap.
  - Estimates follow the provider's rules where it bills differently: DeepSeek's weekday peak hours, its per-request Search and Fetch, and the tokens Codex's own review spends.
- **Fallback and handoff.**
  - When a limit or a credit runs out, the task waits, asks, or hands over to a standby in the same worktree, by your rule for that task.
  - Switching between two accounts of the same provider is an opt-in.
- **Inbox.** Agent questions, tool approvals and limit decisions, with risk levels. High-risk commands are always approved one at a time.
- **Crew loops.**
  - The project's tests run at every turn boundary, and failures go back to the same session.
  - Reviews are pinned to the exact commit, and the merge gate takes only a pass verdict.
- **GitHub under your control.** A push queue, pull requests, merge gates and cleanup; every outward step waits for your click.
- **Windows shell.** The taskbar button shows how many requests wait for you and flashes when a new one arrives while the window is in the background; "Open in Crewyard" in Explorer, `Crewyard.exe <folder>` and a folder dropped on the window open a project or start a new one.
- **More:**
  - turn control (queue, steer, undo);
  - images and files on a task or a queued message (paste, drop or pick), passed to each runner its own way;
  - Best of N;
  - a Preview tab that shows the dev server a task's run serves on localhost and sends a picked element's HTML, styles and a screenshot of just that element to the agent's queue;
  - scheduled tasks;
  - idle agents that sleep and wake with your answer;
  - an MCP report server agents use to send checkpoints and follow-up proposals.

## Security model

- API keys are encrypted with Windows DPAPI and reach a runner only as an environment variable of its process. They never go on a command line, into a log, into git or into a URL, and agent shells cannot see them.
- Subscription tokens are never read; each CLI signs in through its own login.
- The dev-server preview loads only loopback addresses on the task's own ports, in an isolated in-memory session without access to the app.
- The app opens no TCP listener. The UI talks to the daemon over IPC; outside callers use a per-user named pipe with a token.
- Outward actions (push, pull request, merge, delete, spend past a cap) always wait for your approval in the app.

## Requirements

- Windows 11. Windows 10 has not been tried.
- Node.js 24 or newer, pnpm 9 (`corepack enable` gives the pinned version).
- Git.
- The GitHub CLI (`gh`), for the GitHub features.
- The agent CLIs you want to use, at the versions Crewyard was checked with. The Start screen checks them and shows the update command.

  | CLI | Checked with |
  |---|---|
  | Claude Code | 2.1.312 or newer |
  | Codex | 0.147.0 or newer |
  | Gemini CLI | 0.25.0 or newer |
  | OpenCode | exactly 1.19.5, or exactly 2.2.4 (npm `@opencode/cli`) |

## Development

```bash
pnpm install
```

pnpm skips Electron's download script, so run it once on a new machine:

```bash
node node_modules/.pnpm/electron@45.1.0/node_modules/electron/install.js
```

```bash
pnpm dev
```

```bash
pnpm check
```

`pnpm check` is the full gate: token check, contrast check, typecheck, lint with zero warnings, tests and the build. CI runs the same on ubuntu for pull requests and pushes to `main`.

```bash
pnpm e2e
```

`pnpm e2e` builds the app and drives it with Playwright for Electron against scripted fake runners. It needs a display, so it is not part of `pnpm check` or CI.

```bash
pnpm conformance
```

`pnpm conformance` (with `CREWYARD_CONFORMANCE=1`) runs the installed Claude Code, Codex, OpenCode and Gemini CLI through Crewyard's own adapters against a scripted model server on `127.0.0.1`. It covers start, plan, tool call, approve, deny, question, interrupt, resume, usage, limits and stop, and it costs nothing, so run it before accepting a new runner CLI version. A runner whose CLI is missing is skipped. A scenario the CLI itself cannot pass, such as a plan from Gemini CLI, shows `n/a` with the source that shows it, and fails once the CLI starts passing it. It is not part of `pnpm check` or CI.

Live tests with real runners and keys cost a few cents and run only when asked. CLAUDE.md lists the flags, and `packages/daemon/src/live/flows.live.ts` holds the flows.

## Repository layout

| Where | What |
|---|---|
| `apps/desktop` | The Electron app: main process, renderer screens, e2e tests |
| `packages/core` | Event model, adapter contract, state rules, catalog and project schemas, IPC contract |
| `packages/daemon` | The utility-process daemon: SQLite store, orchestrator, providers, GitHub, MCP, setup |
| `packages/proc` | Windows-safe process helpers |
| `packages/adapter-*` | One package per runner (`claude`, `codex`, `opencode`, `acp`), plus `fake` for tests |
| `packages/ui` | Design tokens and shared primitives |
| `catalog/` | Provider catalog: `curated.json` (hand-picked, sources cited), `sync-catalog.mjs`, `providers.json` |
| `design/` | Tokens, the contrast check and the original clickable prototype |
| `docs/adr/` | Architecture decision records |

## Documents

| File | What it is |
|---|---|
| [PLAN.md](PLAN.md) | Requirements, decisions, architecture, adapters, accounts, limits, fallback, crews, GitHub, states, milestones |
| [DESIGN.md](DESIGN.md) | Design system: tokens, components, screens, interaction rules |
| [PRIOR_ART.md](PRIOR_ART.md) | What the strongest open-source projects in this space do, and what we take or avoid |
| [AGENTS.md](AGENTS.md) | Rules for coding agents working in this repo |
| [NOTICE](NOTICE) | Third-party material and its licences |

## Refreshing the provider catalog

```bash
node catalog/sync-catalog.mjs
```

The running app also refreshes it from models.dev once a day. Providers → Versions lists the stored versions, lets you pin one so estimates stay on it, and compares catalog prices with LiteLLM's price table (differences above 10% are shown, never applied).

## Viewing the prototype

`design/prototype.html` is the clickable prototype the app was built from, with sample data. Open it in a browser. Query parameters set the start state, for example `?theme=light&screen=limits`:

- `screen`: `start` (the default), `setup`, `tasks`, `inbox`, `graph`, `limits`, `providers`, `github`; `step=1`–`5` picks the setup step
- `theme`: `dark`, `light`; `density`: `compact`, `comfortable`
- `select=implement` opens the inspector on the graph's implementer node
- `menu=implement` opens that node's right-click menu; `full=1` opens the graph in full screen
- `item`: `d-approve`, `d-question`, `d-limit`, `d-pr` picks an Inbox item

## Licence

This is a private repository with no open-source licence; all rights are reserved. Third-party material and its licences are listed in [NOTICE](NOTICE).


## Building the Windows installer

```bash
pnpm package
```

This builds the app and writes `apps/desktop/dist/Crewyard-Setup-<version>-x64.exe`. Nothing is uploaded or published. The installer:

- installs per user to `%LOCALAPPDATA%\Programs\crewyard`, without asking for admin;
- adds Start-menu and desktop shortcuts;
- adds "Open in Crewyard" to Explorer's right-click menu on folders and on the background of an open folder (`HKCU\Software\Classes\Directory\shell\Crewyard` and `Directory\Background\shell\Crewyard`, per user, removed on uninstall and kept across updates). On Windows 11 it sits under "Show more options";
- keeps your data in `%APPDATA%\Crewyard` when you uninstall;
- puts `THIRD-PARTY-LICENSES.txt` (every bundled npm package and its licence) and `NOTICE.txt` next to the exe. Settings → About opens the list.

`Crewyard.exe <folder>` opens a folder the same way from a terminal or a shortcut, also while Crewyard is already running, and so does dropping a folder on the Start screen or the title bar. A known project opens; a new folder opens New project at step 1, and nothing is written until Create project. WSL and network paths are refused.

Install silently with `Crewyard-Setup-<version>-x64.exe /S`. Uninstall from Windows Settings, or silently with `"%LOCALAPPDATA%\Programs\crewyard\Uninstall Crewyard.exe" /S /currentuser`.

Without settings the build is unsigned and has no update feed, so SmartScreen warns about an unknown publisher and the app never looks for updates. To sign:

- set `WIN_CSC_LINK` (the `.pfx` path or its base64) and `WIN_CSC_KEY_PASSWORD` in the environment, never in a file in the repo, or `CREWYARD_SIGN_CERT_SHA1` for a certificate in the Windows store;
- set `CREWYARD_SIGN_PUBLISHER` to the certificate's full subject DN;
- set `CREWYARD_SIGN=1` before `pnpm package`. A missing certificate then fails the build instead of producing an unsigned installer. The password reaches PowerShell through its environment, never a command line.

To turn on updates, also set `CREWYARD_UPDATE_URL` to an HTTPS folder, and upload `dist\latest.yml`, the installer and its `.blockmap` there for each release. The app checks when you press Check now in Settings → Updates (or on its own if you turn that on), downloads on your click, refuses anything not signed by the publisher, and installs on Restart to install.

`node apps/desktop/e2e/update/update-flow.mjs` (after `pnpm --filter @crewyard/desktop build`) tests signing and the whole update flow on this machine. It uses throwaway certificates, a feed on 127.0.0.1 and a separate test identity, and removes everything afterwards.

The icon is generated from the title-bar mark by `pnpm --filter @crewyard/desktop icon`.

[docs/adr/0004-packaging-and-recovery.md](docs/adr/0004-packaging-and-recovery.md) explains these choices and the crash recovery. [docs/adr/0011-signing-and-auto-update.md](docs/adr/0011-signing-and-auto-update.md) explains signing, updates and what a real release still needs.

## Stress test

```bash
pnpm stress
```

Runs 20 tasks at once through admission control with the fake runner, three rounds in a row. It prints peak concurrency and retained memory. It is slow, so it is not part of `pnpm check`.
