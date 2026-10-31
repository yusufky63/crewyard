# Crewyard: design system

This file is the single source for UI decisions. It overrides the house-design skill where the two differ (see "Deviations from house style" at the end).

- Tokens: [design/tokens/base.json](design/tokens/base.json), [dark.json](design/tokens/dark.json), [light.json](design/tokens/light.json)
- Contrast gate: `node design/check-contrast.mjs` (exit 1 on any failing pair)
- Working prototype: [design/prototype.html](design/prototype.html), screenshots in [design/screens/](design/screens/)

The prototype shows sample data and says so in its title bar. It is a visual reference, not production code.

## 1. Direction: blueprint instrument panel

The three reference images are combined, not copied:

| Reference | What we take | What we leave |
|---|---|---|
| R1 "Agent-first billing" field guide | Near-black canvas, hairline borders, square **spec tiles** with corner ticks, numbered mono labels (`01`), 1px line-art icons, dotted leader lines with mono annotations | The logo construction, angle labels as decoration, hero-size titles |
| R2 cost estimate panel | **Tick meters** (vertical ticks, every sixth taller, white handle), segmented spend bar with gaps, mono uppercase eyebrows, one large number with a dim unit, pill segmented controls | The monthly/annual discount toggle, made-up totals, sliders as inputs |
| R3 task composer and list | One composite composer (text + repo + branch + crew + start), filter tabs with counts, compact rows that expand into steps with durations, diff stat, "Checks passed" | Showing "merged" for work that is only ready for review |

One surface language keeps this coherent: **square hairline frames with four corner ticks** (R1).

- Every framed surface uses it: panels, spec tiles (crew roles, graph nodes), the sidebar's nav and accounts blocks, the search field, tabs, segmented controls, menus, banners and buttons.
- Ticks are drawn by one masked pseudo-element per frame (`--tick-mask` in the prototype), so no extra markup is needed.
- Tick color carries meaning: `ink.muted` at rest, `ink.primary` on hover and for the active nav item, `accent` for the selected graph node, `state.warning` on warning banners.
- Nothing is rounded except status dots, the spinner and keycaps (2 px).

## 2. Principles

1. **Show what needs the user first.** Questions, approvals, limits and merge decisions are always one click away. Normal telemetry stays out of the first view.
2. **One focus at a time.** One main view; the inspector and the activity drawer are closed by default and closing them never stops anything.
3. **Every number says where it came from.** Quota and cost values carry a provenance badge: `Reported` (the provider said so), `Estimated` (we computed it), `Unknown` (we never draw a percentage).
4. **Color is information.** Neutral greys carry the layout. Color means a state or a data series, never decoration. State is always shown with an icon or text too.
5. **Small but readable.** 13–14 px body, 11 px is the floor and only for mono labels. No 40 px headlines, no 48 px icons.
6. **Nothing starts without the user.** The crew proposal, pushes, merges, fallbacks in Ask mode and risky tool calls all wait for an explicit click.
7. **Calm motion.** Only the running spinner, panel open/close (180 ms) and meter fill. `prefers-reduced-motion` stops the spinner.

## 3. Foundations

### Type

| Role | Font | Size / weight |
|---|---|---|
| UI text | Geist, fallback Segoe UI Variable, Segoe UI | 14 (comfortable) / 13 (compact), 400 |
| Row and card titles | Geist | 15, 500 |
| Section / page titles | Geist | 17 / 21, 600, tracking -0.015em |
| Headline metric | Geist | 30, 500, one per panel |
| Labels, ids, numbers, paths | Geist Mono, fallback Cascadia Mono, Consolas | 11 uppercase +0.08em (labels), 12–13 (values) |

Labels are uppercase, but what the user typed or the disk holds (paths, repo names, task titles) keeps its own case inside a label (`.as-typed`): uppercasing would change it, and Turkish casing would turn `i` into `İ`.

Geist and Geist Mono are OFL-1.1. Bundle the font files with the app; do not load them from the network at runtime. The fallbacks are tuned so the app still looks right before fonts load (the headless screenshots in `design/screens/` render with the fallbacks).

### Color roles

| Role | Dark | Light | Use |
|---|---|---|---|
| `bg.canvas` / `surface` / `raised` / `sunken` | `#0E0E10` / `#151517` / `#1C1C1F` / `#0A0A0B` | `#F6F6F7` / `#FFFFFF` / `#F0F0F2` / `#F3F3F5` | App, panels, hover/selected, logs |
| `line.default` / `tick` / `strong` | `#26262B` / `#3A3A41` / `#62626C` | `#E4E4E8` / `#CFCFD5` / `#8A8A94` | Dividers / ticks and grid / input boundaries (3:1) |
| `ink.primary` / `secondary` / `muted` | `#EDEDEF` / `#A6A6AE` / `#8C8C95` | `#111113` / `#4B4B53` / `#62626B` | Text; muted passes 4.5:1 on every background |
| `inverse.bg` / `fg` | `#EDEDEF` / `#0E0E10` | `#111113` / `#FFFFFF` | The one primary button per view |
| `accent` | `#7AA2FF` | `#2E5BD6` | Running, focus ring, selection, links |
| `state.success` / `warning` / `danger` (+ `-soft`) | `#4CC38A` / `#F0B44C` / `#F47A72` | `#137A50` / `#935600` / `#BE2F28` | Passed or done / needs you or near a limit / failed or limit reached |
| `series.claude` / `codex` / `gemini` / `opencode` | `#EE7D48` / `#35B8A4` / `#5DA9EC` / `#A585F2` | `#C9561F` / `#0D8574` / `#2C78BD` / `#7650D2` | One hue per runner, used for dots, meters and charts, always next to a text label |

The primary button is monochrome (inverted ink), so blue, amber, red and green stay free for state. `check-contrast.mjs` verifies text pairs at 4.5:1, chip text on soft fills at 4.5:1, and input borders, focus ring and chart marks at 3:1, in both themes.

### Space, radius, density

- Spacing scale 4 / 8 / 12 / 16 / 20 / 24 / 32.
- Radius: 0 for every frame and control; 2 for keycaps; round only for status dots and the spinner.
- Density: comfortable (body 14, row 52, control 34, padding 16) and compact (13 / 40 / 30 / 12). Switching density never moves the graph viewport.

### Buttons

| Variant | Look | Use |
|---|---|---|
| Primary | inverse fill, Geist Mono 12 px uppercase (+0.06em), corner ticks 4 px *outside* the fill | the one main action of a view: `APPROVE AND START`, `REVIEW AND MERGE` |
| Secondary | transparent, hairline border, corner ticks; hover fills `bg.raised` and brightens ticks | `PAUSE`, `HAND OFF`, `CONNECT`, `FULL SCREEN` |
| Ghost | bracket text `[ EDIT CREW ]`, brackets in `ink.muted` | low-emphasis actions, also in table rows |
| Danger | bracket text in `state.danger`, hover `danger-soft` | `[ STOP AGENT ]`; always confirms first |
| Small | 28 px high, 11 px label | toolbars, table rows |

Icons inside buttons are 14 px.

**Vendor marks.** Wherever a provider, runner or tool is named (account lines, provider rows, runner chips, graph nodes, crew tiles, the machine check), its own logo sits before the name through `BrandIcon`. Marks are monochrome in `ink.secondary` at 16 px (14 px inside buttons and chips), never in brand colors, because color here means state. The glyphs are generated by `pnpm logos:sync` from models.dev (provider ids match the catalog) and simple-icons; an id without a logo shows the name alone, never a stand-in.

## 4. Layout

```
┌ Title bar 40 ─ brand · project · search (Ctrl K) ········· notifications · ─ □ ✕ ────────────┐
├ Sidebar 224 ──┬ Main (fills the rest, 28 px gutters) ──────────────┬ Inspector 380 (closed) ┤
│ ┌ Tasks      ┐│  Page head: title 21 + mono context line            │ opens on selection,     │
│ │ Inbox (n)  ││  View content                                       │ Esc or ✕ closes it      │
│ │ Crew graph ││                                                     │ "Closing this panel     │
│ │ Limits     ││                                                     │  does not stop the      │
│ │ Providers  ││                                                     │  agent."                │
│ └ GitHub     ┘│                                                     │                         │
│ ┌ ACCOUNTS 9 ┐│  Activity drawer 280 (closed): events, logs,        │                         │
│ │ one line   ││  terminal                                           │                         │
│ └ each, scroll┘│                                                    │                         │
│ Settings      │                                                     │                         │
├ Status bar 28 ┴ daemon · agents running/tasks queued · need you · near limit · RAM ··· GitHub sync · Actions · quiet · theme · density ┤
```

- **Title bar** stays short: brand, project switcher, command search, notifications and native-sized Windows caption buttons (46 px wide, close turns `#C42B1C` on hover). It is custom (frameless window).
- **Status bar** holds system state, so the title bar never fills up:
  - left: daemon state, agents running and tasks queued, need you, near limit, RAM. The work item names its units (`6 agents running · 0 tasks queued`): it counts running agents, because one task can run several steps at once, while the Tasks filter counts running tasks; its tooltip says so;
  - right: last GitHub sync, Actions minutes, keep awake (only while that setting is on), quiet hours, theme, density.
  - Every item that has a screen opens it on click. Below 1180 px the lower-priority items (RAM, GitHub sync, Actions) hide.
- **Sidebar** is two framed blocks:
  - **Nav:** six destinations, counters only on Inbox. The active item gets bright corner ticks.
  - **Accounts:** pinned to the bottom, sorted most urgent first. Each account is a 28 px name line (vendor mark, name, value: the fullest plan window's %, today's $ for an API key, an action such as `Sign in`, or `—`), then one full-width row per window or bucket it has reported: short label (`5 h`, `weekly`, `monthly`, a bucket name), 24-tick meter, %, and a line with provenance and reset time. An API key with a daily cap gets one `cap` row; a key without a cap shows its spend as text only. A plan with nothing reported yet gets a single Unknown row (dashed meter), never one per possible window; a profile that must sign in or update shows no meter. With no accounts at all the block is not drawn (the Start checklist points to Providers). It scrolls on its own above about 236 px (34% of the window height), so many accounts never push the nav away. `ALL LIMITS` opens Limits.
- **Pane sizes** (all through the shared `Splitter`, stored per window in prefs, never in the database, clamped on load and applied before the first paint so nothing shifts at start):
  - **Sidebar:** expanded at 224 px by default, resized by dragging its right edge between 184 and 360 px, or collapsed to the 56 px icon rail with the toggle at its foot or `Ctrl B` (tooltip says so). Dragging the edge under 136 px collapses it; dragging the rail's edge out expands it to the last width. In the rail each nav item is an icon with its name as tooltip and screen-reader text, Inbox keeps its count as a small badge, and the accounts block hides (the status bar keeps the near-limit count).
  - **Inspector:** 380 px by default, resized by dragging its left edge between 320 and 720 px, never so wide that the main view drops under 600 px. A toggle collapses it to a 44 px strip that keeps the selection (task title written vertically, expand and close buttons); ✕ still closes it. In Crew graph full screen it overlays the graph under the caption buttons.
  - **Inbox:** the request list is 360 px by default, 280–560 px, and the detail pane never gets narrower than 320 px.
- **Main view** grows with the window: it fills everything between the sidebar and the inspector, with a 28 px side gutter (`layout.gutter`) and no maximum width (owner, 2026-10-31: "iç kısımda her şey genişleyebilsin", then "grow with the window"; it used to stop at 1120 px, centered). Inside it:
  - Paths, titles, branch names, task context lines and table columns take the room there is and cut with an ellipsis, the full text in the tooltip; no fixed px caps.
  - Grids of tiles add columns rather than stretching one control: crew role and Best-of variant tiles keep about 220 px (`auto-fill`), the Start machine strip goes to one row of eight from 1880 px, Limits plan accounts flow into columns of at least 560 px, GitHub task pull requests into columns of at least 600 px, and Settings sections into two columns from 1880 px.
  - Running prose (hints, notes, descriptions, the Start lead) keeps a readable measure of 72ch (`layout.measure`, principle 5); one-line fact and key-hint lines are not prose and take the full width.
  - A single-line text field stops at 960 px (`layout.field-max`); buttons and short inputs keep their size.
- **Breakpoints:** below 1280 px the inspector overlays the main view (still resizable, up to the window minus 120 px); below 1180 px the sidebar is always the 56 px icon rail and its toggle and handle hide; below 1280 px the Inbox list and detail stack. 960 px is the minimum supported width.

## 5. Components

| Component | Default view | On demand | Notes |
|---|---|---|---|
| `TitleBar` | brand, project switcher, command search, notifications | notifications popover; takes a dropped folder on every screen | `-webkit-app-region: drag` except on controls, and not at all while files are dragged over the window |
| `StatusBar` | daemon, slots, need you, near limit, RAM, GitHub sync, Actions, quiet hours, theme, density | each item opens its screen | mono 11 px, items separated by hairlines |
| `Sidebar` | framed nav block (6 items, Inbox count), collapse toggle with `Ctrl B` at its foot | rail mode, drag the right edge to resize | active item marked by bright corner ticks; the rail keeps the Inbox count as a badge |
| `Splitter` | invisible 9 px handle over a pane edge (16 px in-flow between two columns); hairline on hover, 3 px accent line on focus and while dragging | drag; `Left`/`Right` move 16 px, `Home`/`End` give the pane its min/max, `Enter` collapses or restores a collapsible pane; double-click resets | `packages/ui`; `role="separator"` with `aria-valuenow`/`min`/`max` in px, `aria-controls` the pane, tooltip says how to reset; never animates |
| `AccountsBlock` | pinned to the sidebar bottom, most urgent first; per account a name line and one meter row per reported window, bucket or cap | scrolls on its own; tooltip with every window, source and age | hidden with no accounts; value shows % (plan window), $ (API key today) or `—`; 80/95% colours and a provenance label on every meter row; a key without a cap has no meter |
| `BrandIcon` | the vendor's mark for a catalog provider id, a runner id or `git` / `github` | `label` turns it into a named image; otherwise it is decorative next to the visible name | `packages/ui`; data in `brand-icons.gen.ts`, never edited by hand |
| `ProjectTile` | index, line-art type glyph, name, path (ellipsized, full path in tooltip), state line, last opened | opens the project | dashed variant for `Import from C:\Projeler` |
| `Stepper` | numbered spec tiles, current one with accent ticks, finished ones labelled `Done` | any step is clickable | `Back` / `Next: <step>` / `Create project` in the pane footer |
| `ContextMenu` | opens on right-click, `Shift+F10` or the context-menu key on a graph node | items depend on the node state | arrow keys move, Esc closes and returns focus; disabled items say why |
| `ProvidersTable` | provider, newest models with price, runner chips, credential and limits | catalog refresh, catalog versions, add provider | runner chips: works directly (green), through config (blue), needs a converter (dashed) |
| `CatalogDialog` | stored catalog versions (hash, generated date, models.dev sha, origin, In use / Pinned / Newest chips) and the LiteLLM price check (model, price field, catalog and LiteLLM price per 1M, signed difference) | pin, unpin, check now | Pinned in the accent chip; a failed or missing price check shows the Unknown badge and no table, never "0 differences" |
| `Composer` | task text, repo, branch, crew mode, on-limit mode, `Ctrl Enter` | full options (model pinning, budget, labels) | submitting opens the crew proposal, it never starts work |
| `CrewProposal` | 1 spec tile per role: index, line-art icon, role, runner · model, account, one-line reason, meter | "Hide reasons", edit a role, swap account | footer: fallback chain + Manual/Ask/Auto, estimate disclaimer, `Approve and start` |
| `SpecTile` | hairline + 4 corner ticks | hover ticks ink, selected ticks accent | standby/fallback tiles use a dashed border on `bg.canvas` |
| `TickMeter` | 48 ticks, fill = used share, threshold ticks at 80% and 95%, handle at value | tooltip with source and reset time | fill turns amber past 80% and red past 95%; `Unknown` draws dashed empty ticks and no handle; `role="meter"` |
| `SegmentedBar` | one segment per series with 4 px gaps | legend with value and share | always paired with a legend and an `aria-label` sentence |
| `TaskRow` | title, repo, branch, runner dots, elapsed, one status line | steps with durations, limit banner, diff stat, PR | rows never auto-expand on new events; expanding one never shifts another |
| `StatusLabel` | icon + text in the state color | | see the mapping table below |
| `LimitBanner` | amber soft fill, source, reset time, `Hand off now`, `Let it finish` | | appears on the row and in the inspector, plus one Windows toast |
| `InboxItem` | kind icon, title, who asked, time | full detail pane | approvals show command, working directory, scope and policy |
| `GraphNode` | role, runner, status, model · account, one fact line | inspector on click, context menu on right-click | fixed 180 × 100, or 180 × 120 when it carries a crew-loop line (fix attempt n of max, or the reviewer's verdict); draggable, snaps to 12 px; `Alt` + arrows move it by keyboard; moving a node only changes the layout, never who does the work |
| `GraphEdge` | `reports to` (solid), `depends on` (dotted), `fallback` (amber dashed) | `messages`, `files` edge sets via the segmented control | orthogonal with one rounded elbow, recomputed while a node is dragged; selected path in accent; leader lines carry mono annotations (limit, reset) |
| `GraphView` | fit to width | drag the background to pan, `Ctrl` + wheel or +/− to zoom, fit, `Reset layout`, full screen (`F`, `Esc` leaves) | layout is saved per task; full screen keeps the inspector available as an overlay |
| `Inspector` | header, status, tabs Details / Conversation / Changes / Usage, meters, facts, worktree, actions, and in Details the task timeline: one lane per run to scale (working in the runner hue, waiting on you amber, limited red, paused grey, handing off half-height amber) and the events newest first in pages of 40, tool calls folded per burst, a cut output marked `Truncated, <size>` with its full text one click away | transcript loads only on the Conversation tab; drag the left edge to resize; collapse to a 44 px strip | `Stop agent` is a danger text button, separate from `Pause`; collapsing, like closing, never stops anything |
| `MachineStrip` | `This machine` with a one-line summary (all passed / n need attention), checked time, `Check again`, then one spec tile per check (agent CLIs, Git, GitHub CLI, long paths, Defender): state icon, vendor mark, short name, index, one status line | the problem's fix inside its tile (`Copy update`, `Copy sign-in`, `Open steps`); `Details` opens the full panel under the tiles with the reason and the command for each | ticks turn amber on a problem; a missing agent CLI is neutral (one is enough); commands are copied, never run |

### Status labels

| Canonical state (see PLAN.md) | Label | Color | Icon |
|---|---|---|---|
| `proposed` | Waiting for approval | ink | crew |
| `queued` | Queued | warning | clock |
| `running` | Running · current step | accent | spinner |
| `needs_input` | Waiting for your answer / approval | warning | question / terminal |
| `limited` | Limit reached · resets 16:40 | danger | gauge |
| `handing_off` | Handing off to … | warning | swap |
| `review` | Ready for review | success | check |
| `merged` | Merged | ink | pull request |
| `done` | Done (work without code) | success | check |
| `failed` | Failed · reason | danger | x |
| `cancelled` | Stopped by you | muted | square |

A failure's reason is our code in words, or for a provider's error its HTTP status and the provider's own message (`Failed · 402 · Your prepayment credits are depleted…`), read from the Anthropic, OpenAI, Google, DeepSeek and OpenRouter error bodies. The runner's raw text is untrusted: it is capped, shown as plain text (never HTML, its URLs never become links), whole in the tooltip and in the inspector, and stored as the runner wrote it.

"Ready for review" and "Merged" are different filters. A code task is never shown as Done before it is merged.

## 6. Screens

| Screen | First view | Second level |
|---|---|---|
| **Start** (no project open) | while files are dragged over the window, one drop zone covers the view (solid canvas, accent frame with ticks, what a drop does) and the title bar shows "Drop a folder here to open it" in an accent hairline; a folder that cannot be opened leaves a warning banner with the reason and `Dismiss` above the hero; hero line across the full width, `New project` / `Open folder` / `Clone from GitHub` right beside the lead (not at the far edge of a wide window); the last project as one wide tile across the full width; then Recently used (the other projects, newest first, one line each) and Getting started beside `Import from C:\Projeler` (the repo git touched last first); the This machine strip last, across the full width (owner, 2026-10-31: "Bu bilgisayar kısmını alt kısma al") | all projects, install guides, the full machine panel; the sidebar hides, and the 32 px hero is used only here |
| **New project** | five numbered step tiles (Folder, Agents, Accounts & budget, Rules, GitHub), one step pane, Back / Next | edit detected commands, create a private repo, CI template; nothing is written until `Create project`. An existing `project.json` is the first Folder row: values it replaced (warn), from a newer Crewyard and read-only (warn), or unusable with the reason (bad). Replacing an unusable one asks first, in a row above the footer |
| **Tasks** (project home) | composer, crew proposal when drafting, filters `All / Running / Needs you / Ready for review / Merged / Done`, task rows | steps, limit banner, diff, PR link, inspector |
| **Inbox** | items that need an answer first, then limits, automatic account switches (each fact with its provenance badge, `Off for this task`, `Dismiss`) and GitHub notices | detail pane: approve once / allow in project / deny; question options + note |
| **Crew graph** | one task's crew: task → roles → PR, standby fallback, limit annotation | drag and drop, pan, zoom, full screen, right-click actions (pause, check again, change AI or model, hand off, wait for reset, stop), Messages and Files edge sets, list view for screen readers, inspector |
| **Providers** | catalog providers with newest models and prices, which runners each works with, credential and limits, connected first; the catalog line says when a version is pinned | add provider, refresh catalog, Versions (pin or unpin a catalog version, LiteLLM price check), filters (connected, first-party, coding plans, aggregators, local) |
| **Limits & usage** | subscription windows per account with provenance, API spend (7 days) with segmented bar, balances and caps | alert thresholds, on-limit policy, Windows notifications; the `Usage ledger` tab: tokens in, out and cache reads by day, model, provider or task, dollars only for per-token keys (plans and local models show `Plan`), a segmented bar with legend, CSV and JSON export through a save dialog |
| **GitHub** | Actions minutes this month, branches waiting to push, worktrees, PR table with merge gate | checks and logs, review comments sent back to the agent, worktree cleanup |
| **Settings** | accounts and API keys (aliases only), roles, policies, theme, density; the sections flow into two columns from 1880 px | per-project allowlist, price table version, diagnostics; under Projects, the projects whose `project.json` is newer, unusable or had values replaced |

## 7. Interaction rules

- **Taskbar badge:** a 16 px disc in `state.warning` with the count in `inverse.fg` (`9+` above nine), in the taskbar's own light or dark theme, drawn on whole pixels; no other color, no animation. It flashes the button once per new request, never repeatedly.
- **Close is not stop.** Closing the inspector, the drawer or the window keeps agents running (the tray icon stays). `Stop agent` asks for confirmation and names what it stops.
- **Approvals:** Windows toasts may offer `Approve once` only for low-risk, read-only or in-worktree commands. Anything else opens the Inbox. `Always allow` is never the default button.
- **Hand off dialog** shows what transfers (summary, diff, branch, open questions), whether it is a native resume or a new session, the target account's headroom, and the cost estimate. In Auto mode the same record is written and shown afterwards.
- **Pushes:** agents commit locally; pushes wait in GitHub → "Waiting to push" so CI runs once per finished change.
- **Keyboard:** `Ctrl K` command palette, `Ctrl B` collapses or expands the sidebar, `Ctrl Enter` submit composer or approve the focused crew, `Esc` closes the topmost layer (menu, then inspector, then full screen), `J/K` move in lists, `Enter` expands a row, `G T / G I / G G / G L / G P / G H` jump to screens; in the graph `Shift+F10` opens the node menu, `Alt` + arrows move a node, `F` toggles full screen. `?` or `F1` (and `Keys` in the status bar) opens the keyboard map. Every shortcut is declared once in `src/renderer/src/keys.ts`; handlers match through it and the map lists it, and a test fails when the two disagree.

## 8. Accessibility

- WCAG 2.2 AA: text 4.5:1, UI boundaries and focus 3:1 (checked by the script), 2 px focus ring with 2 px offset.
- Targets at least 28 px in compact and 34 px in comfortable.
- The graph has an equivalent list view (`Show as list`). Meters expose `role="meter"` with values; unknown quota is announced as unknown.
- Live updates are batched: one polite announcement per state change, never per token.

## 9. QA matrix

Dark and light × compact and comfortable × 960 / 1280 / 1440 / 1920 / 2560 px × 100 / 150 / 200% Windows scaling. States to capture per screen: empty, running, needs input, near limit, limit reached, review, merged, offline daemon, expired sign-in, unknown quota. Screenshot regression runs in CI on Linux against fixed fixtures; Windows-only behaviour (title bar, toasts, tray) is checked by hand before each release.

## Deviations from house style

| House style | Here | Why |
|---|---|---|
| DM Sans / Space Grotesk / JetBrains Mono | Geist / Geist Mono | Closest to the technical grotesk + mono pairing of R1 and R2 |
| One brand color as primary button | Monochrome primary, accent only for running/focus | Four runner series and four states already need color |
| Body 15 px | 14 / 13 px | Dense desktop tool, many rows per screen |
| Cards radius 8 | Radius 0 everywhere | R1's square frames are the chosen look |
| Ticks on one key module per view | Corner ticks on every framed surface, muted; bright only when active or selected | Requested explicitly; the R1 reference uses them on every tile |
| Sans-serif button labels | Geist Mono uppercase button labels, bracket ghost buttons | Matches R1's `[ Request early access ]` |
| Three state colors | Three states + accent for running | "Running" must be distinct from "needs you" at a glance |

Everything else from house style still applies: no gradients, glass, blur, glow, colored shadows, emoji or "coming soon" text.
