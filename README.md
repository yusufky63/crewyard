# Crewyard

License: [MIT](LICENSE) · [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md)

A local, Windows-first desktop app that runs and supervises coding agents (Claude Code, Codex, Gemini CLI, OpenCode) across several of your own accounts and API keys. It proposes a crew for each task, waits for your approval, watches limits and spend, hands work to a backup agent when you allow it, and keeps GitHub under your control.

Status: pre-release. It is built and tested on Windows 11. From the release after v0.1.0, each version also ships for macOS (Apple silicon and Intel) and Linux (x64). Those packages are built and started on GitHub's runners for every release, but have not been tried on real Macs or Linux desktops yet ([ADR 0010](docs/adr/0010-linux-macos-groundwork.md)). No build carries a publisher's signature yet (macOS builds are only ad-hoc signed), and none checks for updates (PLAN.md §17).

## Install

Download from this repository's [Releases](https://github.com/yusufky63/crewyard/releases). While the version is 0.x, every release is marked pre-release. Each one lists `SHA256SUMS.txt` for checking a download.

| System | File | First start |
|---|---|---|
| Windows 11, x64 | `Crewyard-Setup-<version>-x64.exe`: installs for your user, no admin prompt | SmartScreen: More info, then Run anyway |
| macOS 13 (Ventura) or later, Apple silicon | `Crewyard-<version>-arm64.dmg` (or `-arm64-mac.zip`) | not notarized: System Settings → Privacy & Security → Open Anyway |
| macOS 13 (Ventura) or later, Intel | `Crewyard-<version>-x64.dmg` (or `-x64-mac.zip`) | as above |
| Debian, Ubuntu (x64) | `crewyard_<version>_amd64.deb`: `sudo apt install ./crewyard_<version>_amd64.deb` | from the app menu, or `crewyard` |
| Other Linux (x64) | `Crewyard-<version>-x86_64.AppImage`: `chmod +x`, then run it | needs FUSE 2 (`libfuse2`) |

- Linux packages need glibc 2.35 or newer: Ubuntu 22.04, Debian 12, Fedora 36 and later.
- On Ubuntu 24.04 and later, prefer the deb. It installs the AppArmor profile Chromium's sandbox needs; the AppImage runs there without that sandbox.
- macOS from the terminal instead of Open Anyway: `xattr -dr com.apple.quarantine /Applications/Crewyard.app`.
- These builds do not update themselves; install the next release over the old one. Your data stays in `%APPDATA%\Crewyard`, `~/Library/Application Support/Crewyard` or `~/.config/Crewyard`.

The same steps are at the top of every release's notes ([docs/release-notes/install.md](docs/release-notes/install.md)). How a release is cut is in [docs/release.md](docs/release.md).

## Website

`apps/web` is the project's website: what Crewyard is, how it works, downloads (Windows today; macOS and Linux files appear when a release includes them), the changelog, the FAQ and the security model. It reads releases from this repository's GitHub releases, so each new release appears on the download and changelog pages within the hour with no code change. It is a Next.js app deployed on Vercel with `apps/web` as the root directory; [apps/web/README.md](apps/web/README.md) covers development, the screenshots, the deploy and its environment variables.

## What it does

- **Crews per task.** Describe a task and Crewyard proposes who plans, implements, tests and reviews it, with the reason for each pick and a cost estimate. Nothing starts until you approve.
- **Your own agent files.** Settings → Instructions and skills lists the instruction files, rules, skills, commands and subagents you wrote for Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Windsurf, Copilot and Cline, without ever opening a key or settings file. Share any of them with one profile or every profile of a runner: Crewyard copies it into that profile's own folder in the runner's format (never a link), leaves out pre-approved tools, hooks and model choices, asks for a tick before copying scripts, and shows when a copy is out of date until you press Sync. A project's AGENTS.md, CLAUDE.md, GEMINI.md, Copilot, Cursor or Windsurf rules can also reach the runners that do not read them, per project and off by default ([PLAN.md §6.2](PLAN.md#62-instructions-and-skills-adr-0015)).
- **Task assistant.** In the bottom panel's Assistant tab: `Assistant` on the Tasks screen or `Ctrl Shift A` on any project screen opens a terminal-style chat with a read-only agent on a profile you pick. It reads the project and Crewyard's own records (tasks, reports, crews, the Inbox, events, spend and limits, profiles, settings, local git, problems, your instruction files) through read-only tools ([ADR 0018](docs/adr/0018-assistant-read-tools.md)), and the conversation shows what it is doing under your message. It asks when something is unclear, answers in Markdown you can copy, quote or turn into drafts, and proposes task drafts (kind, acceptance criteria or questions to research, size) as editable cards; `Add as draft` turns one into a task whose crew still waits for your approval. It never writes or starts runs, its spend counts against the key's daily cap (Estimated), and it stops on its `Stop and close` or after it sits idle ([ADR 0014](docs/adr/0014-task-assistant.md)).
- **Bottom panel.** `Ctrl J` (or `Panel` in the status bar) opens one panel with five tabs: the task assistant; a **terminal** with your own shell (Windows PowerShell, PowerShell 7, Git Bash or Command Prompt) in the project folder or the selected task's worktree, started only when you press `New terminal` and never given an API key ([ADR 0016](docs/adr/0016-terminal.md)); the project's events; Crewyard's own logs; and **problems**, every failure of the project in one list (failed runs with the provider's own error, failed audit events, stalls, failing PR checks, project.json, role-file and agent-file problems, key checks), each with a button to where you fix it. ``Ctrl ` ``, `Ctrl Shift M` and `Ctrl Shift A` open it on the terminal, problems and assistant. Inside a project the panel never closes: the toggle at the right end of its head (or `Ctrl J`) collapses it to a strip that keeps the tabs and their counts, and expands it again. Collapsing stops nothing, the assistant included; closing a terminal's tab ends its shell after asking.
- **Autopilot.** Opt-in per project, off by default: turn it on in the task assistant, accept what it may do and set its limits (per task, per day, tasks per hour, at once). The assistant then creates tasks from what you write, edits them before they start, approves their crews when the Estimated cost fits, queues messages to running steps, retries a failed step once, cancels its own tasks and marks a finished analysis done after reading its report. Push, pull requests, merges, deletes, spend past any cap and every Inbox approval stay with you. Each action is logged with its reason, and `Stop Autopilot` in the status bar or Settings refuses everything at once without stopping running agents ([ADR 0017](docs/adr/0017-autopilot.md)).
- **External access over MCP.** Off by default. Turn it on in Settings → External access, add a client, and copy its config into Claude Code (`claude mcp add …`), Claude Desktop, Cursor or Codex. The agent there can then read your projects, tasks, reports, crews, Inbox, events, spend and settings, add an existing folder as a project, change a project's slots, test command, runners and loop limit, lower its budget or tighten its rules, save an MCP server with plain values, and propose tasks whose crews wait for your approval. It cannot approve, start work, answer the Inbox, push, merge, delete, raise a budget, loosen a rule or see a key. The config holds no token: Crewyard keeps each client's token encrypted and the relay decrypts it itself. Every change shows in the activity log with the client's name, the status bar shows while access is on, and each client can be revoked ([ADR 0021](docs/adr/0021-external-mcp.md)).
- **Reports and ready-made analyses.** A finished research, review or docs task shows its report on the row and in the inspector: the summary as readable text, a severity bar that filters the findings, each finding as a row that expands, opens its file and jumps to the task it suggests, and the suggested tasks as drafts you can add one by one or all at once, at the bottom of Details and in their own Suggested tab. Ready-made analyses (review the project, optimizations, bugs, security, dependencies and licences, test gaps) come as local templates, a few suggested for each project from what Crewyard already knows, with no model call.
- **Your own roles.** Markdown files in `.crewyard/roles/` (or global ones in Crewyard's data folder) change a built-in role's contract or add a role of your own. A role file can only narrow permissions, never widen them past the project's rules; a project lists the custom roles its crews may use in `.crewyard/project.json`. Settings → Roles shows each role's source and any file that was not used ([PLAN.md §9.1](PLAN.md#91-roles)).
- **Four runners, many providers.**
  - Claude Code (Anthropic or Anthropic-compatible API keys only; never a claude.ai sign-in), Codex, OpenCode, and Gemini CLI over ACP.
  - Codex signs in with ChatGPT through its own login, which OpenAI allows for a local, open-source app like this one, or runs on an API key.
  - Gemini CLI signs in with Google only for Gemini Code Assist Standard or Enterprise accounts: since 18 June 2026 it no longer serves free, AI Pro or Ultra Google accounts. With a personal plan, use a Gemini API key; Gemini CLI and OpenCode profiles then run Gemini 4 Argon and Gemini 3.8 Flash among others, billed per use.
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
- **Guide.** `Guide` in the sidebar, `G W`, or `New here? How it works` on the Start screen opens an in-app guide, also before any project exists: the task flow from project to merge as numbered tiles that each open their screen, a Getting started list read from this machine and your data (Git and an agent CLI Crewyard can start, a ready profile, a project, a first task, a first approved crew, GitHub), the main features and a short FAQ that answers for the build you are running.
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
- The app opens no TCP listener. The UI talks to the daemon over IPC. External access, when you turn it on, is a per-user named pipe (a 0600 socket in a private folder on Linux and macOS) with a random name and a token per client; its tools can only read, propose and tighten, never approve, start, answer, push, merge, delete or reveal a key ([ADR 0021](docs/adr/0021-external-mcp.md)).
- Outward actions (push, pull request, merge, delete, spend past a cap) always wait for your approval in the app. Autopilot has no tool for them; it approves only crews of tasks it created, within the limits you set ([ADR 0017](docs/adr/0017-autopilot.md)).

## Requirements

- Windows 11 for development and the tested build. Windows 10 has not been tried. macOS 13 (Ventura) or later and Linux x64 run the pre-release packages (see Install); development there is untested.
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
| `apps/web` | The website (Next.js on Vercel): downloads and changelog from GitHub releases, how it works, FAQ, security |
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
| [LICENSE](LICENSE) | The MIT licence |
| [NOTICE](NOTICE) | Third-party material and its licences |
| [docs/release.md](docs/release.md) | Cutting a release: version, tag, the release workflow, and the file names the website matches |

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

Crewyard is released under the [MIT License](LICENSE), Copyright (c) 2026 Yusuf. Third-party material and its licences are listed in [NOTICE](NOTICE), which also repeats the MIT text because the installer ships it as `NOTICE.txt`, next to `THIRD-PARTY-LICENSES.txt` with every bundled npm package, which Settings → About opens.

Contributions are accepted under the same licence; [CONTRIBUTING.md](CONTRIBUTING.md) has the rules. Report a vulnerability privately as [SECURITY.md](SECURITY.md) describes, never in a public issue.


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

The icons (`icon.ico`, `icon.png`, macOS `icon.icns` and the Linux `icons/` set) are generated from the title-bar mark by `pnpm --filter @crewyard/desktop icon`.

On a Mac, `pnpm --filter @crewyard/desktop package:mac` builds the dmg and zip for both CPUs, ad-hoc signed. On Linux, `pnpm --filter @crewyard/desktop package:linux` builds the AppImage and the deb. Published releases come from the tag-triggered workflow instead ([docs/release.md](docs/release.md)).

[docs/adr/0004-packaging-and-recovery.md](docs/adr/0004-packaging-and-recovery.md) explains these choices and the crash recovery. [docs/adr/0011-signing-and-auto-update.md](docs/adr/0011-signing-and-auto-update.md) explains signing, updates and what a real release still needs.

## Stress test

```bash
pnpm stress
```

Runs 20 tasks at once through admission control with the fake runner, three rounds in a row. It prints peak concurrency and retained memory. It is slow, so it is not part of `pnpm check`.
