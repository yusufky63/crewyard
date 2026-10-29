# Mission Control

A local, Windows-first desktop app that runs and supervises coding agents (Claude Code, Codex, Gemini CLI, OpenCode) across several of your own accounts and API keys. It proposes a crew for each task, waits for your approval, watches limits, hands work to a backup agent when you allow it, and keeps GitHub under your control.

This folder is the plan and design package. There is no application code yet.

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
