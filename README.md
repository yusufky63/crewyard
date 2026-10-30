# Crewyard

A local, Windows-first desktop app that runs and supervises coding agents (Claude Code, Codex, Gemini CLI, OpenCode) across several of your own accounts and API keys. It proposes a crew for each task, waits for your approval, watches limits, hands work to a backup agent when you allow it, and keeps GitHub under your control.

The plan and design package is at the top level; the app lives in `apps/` and `packages/` (see AGENTS.md for the layout).

| File | What it is |
|---|---|
| [PLAN.md](PLAN.md) | Requirements, decisions, architecture, adapters, accounts, limits, fallback, crews, GitHub, states, milestones |
| [DESIGN.md](DESIGN.md) | Design system: direction from the reference images, tokens, components, screens, interaction rules |
| [PRIOR_ART.md](PRIOR_ART.md) | What the strongest GitHub projects do, ranked by stars, and what we take or avoid |
| [AGENTS.md](AGENTS.md) | Rules for coding agents working in this repo |
| [catalog/](catalog/) | Provider catalog: `curated.json` (hand-picked providers, sources cited), `sync-catalog.mjs` (pulls models.dev), `providers.json` (snapshot of 2026-10-29) |
| [design/prototype.html](design/prototype.html) | Clickable visual prototype with sample data: Start, New project, Tasks, Inbox, Crew graph, Limits & usage, Providers, GitHub |
| [design/screens/](design/screens/) | Prototype screenshots, dark and light |
| [design/tokens/](design/tokens/) | Design tokens (base, dark, light) |
| [design/check-contrast.mjs](design/check-contrast.mjs) | WCAG contrast gate for the tokens |

## Viewing the prototype

Open `design/prototype.html` in a browser. Query parameters set the start state, for example `?theme=light&screen=limits`:

- `screen`: `start` (the default), `setup`, `tasks`, `inbox`, `graph`, `limits`, `providers`, `github`; `step=1`–`5` picks the setup step
- `theme`: `dark`, `light`; `density`: `compact`, `comfortable`
- `select=implement` opens the inspector on the graph's implementer node (it is closed by default)
- `menu=implement` opens that node's right-click menu; `full=1` opens the graph in full screen
- `item`: `d-approve`, `d-question`, `d-limit`, `d-pr` picks an Inbox item

Theme and density switches are in the status bar. In the Crew graph you can drag nodes, drag the background to pan, right-click a node (or `Shift+F10`) for actions, and press `F` for full screen.

## Refreshing the provider catalog

```bash
node catalog/sync-catalog.mjs
```

## Checking the tokens

```bash
node design/check-contrast.mjs
```

## Replaces

The 2026-10-29 draft package (`AI_MISSION_CONTROL_RESEARCH.md`, `UI_UX_DESIGN_SYSTEM.md`, `DESIGN_REFERENCE_LIBRARY.md`, `THEME_TOKENS.json`, `GITHUB_SOURCE_CATALOG.md`, `FEATURE_RESEARCH_TEMPLATE.md`, `AGENTS_RESEARCH_RULES.md`, `README_DESIGN_UPDATE.md`, `AI_MISSION_CONTROL_UI.svg`). PLAN.md §2 lists what changed and why.

## Development

```bash
pnpm install
```

```bash
node node_modules/.pnpm/electron@45.1.0/node_modules/electron/install.js
```

```bash
pnpm dev
```

```bash
pnpm check
```

`pnpm check` runs the token check, contrast check, typecheck, lint with zero warnings, tests and the build. CI runs the same on ubuntu for pull requests and pushes to `main`.

## Building the Windows installer

```bash
pnpm package
```

This builds the app and writes `apps/desktop/dist/Crewyard-Setup-<version>-x64.exe`. Nothing is uploaded or published. The installer:

- installs per user to `%LOCALAPPDATA%\Programs\crewyard`, without asking for admin;
- adds Start-menu and desktop shortcuts;
- keeps your data in `%APPDATA%\Crewyard` when you uninstall.

Install silently with `Crewyard-Setup-<version>-x64.exe /S`. Uninstall from Windows Settings, or silently with `"%LOCALAPPDATA%\Programs\crewyard\Uninstall Crewyard.exe" /S /currentuser`.

Builds are unsigned for now, so SmartScreen warns about an unknown publisher. To sign:

- set `WIN_CSC_LINK` (the `.pfx` path or its base64) and `WIN_CSC_KEY_PASSWORD` in the environment, never in a file in the repo;
- set `CREWYARD_SIGN=1` before `pnpm package`. A missing certificate then fails the build instead of producing an unsigned installer.

There is no auto-update yet: it needs a release host, which you have not chosen yet.

The icon is generated from the title-bar mark by `pnpm --filter @crewyard/desktop icon`.

[docs/adr/0004-packaging-and-recovery.md](docs/adr/0004-packaging-and-recovery.md) explains these choices and the crash recovery.

## Stress test

```bash
pnpm stress
```

Runs 20 tasks at once through admission control with the fake runner, three rounds in a row. It prints peak concurrency and retained memory. It is slow, so it is not part of `pnpm check`.
