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
2. **One focus at a time.** One main view; the inspector and the bottom panel are closed by default and closing them never stops anything.
3. **Every number says where it came from.** Quota and cost values carry a provenance badge: `Reported` (the provider said so), `Estimated` (we computed it), `Unknown` (we never draw a percentage).
4. **Color is information.** Neutral greys carry the layout. Color means a state or a data series, never decoration. State is always shown with an icon or text too.
5. **Small but readable.** 13–14 px body, 11 px is the floor and only for mono labels. No 40 px headlines, no 48 px icons.
6. **Nothing starts without the user.** The crew proposal, pushes, merges, fallbacks in Ask mode and risky tool calls all wait for an explicit click. One recorded exception: Autopilot, which you turn on per project after a consent card, may approve crews of tasks it created within your limits ([ADR 0017](docs/adr/0017-autopilot.md)); pushes, merges, spend past a cap and the Inbox still wait for you, and every action it takes is logged with its reason.
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
│ ┌ ACCOUNTS 9 ┐│  Panel 280 (closed): assistant · terminal · events  │                         │
│ │            ││  · logs · problems                                  │                         │
│ │ one line   ││                                                     │                         │
│ └ each, scroll┘│                                                    │                         │
│ Settings      │                                                     │                         │
├ Status bar 28 ┴ daemon · agents running/tasks queued · need you · near limit · RAM ··· GitHub sync · Actions · quiet · theme · density ┤
```

- **Title bar** stays short: brand, project switcher, command search, notifications and native-sized Windows caption buttons (46 px wide, close turns `#C42B1C` on hover). It is custom (frameless window).
- **Status bar** holds system state, so the title bar never fills up:
  - left: daemon state, agents running and tasks queued, need you, near limit, RAM. The work item names its units (`6 agents running · 0 tasks queued`): it counts running agents, because one task can run several steps at once, while the Tasks filter counts running tasks; its tooltip says so;
  - right: last GitHub sync, Actions minutes, `Panel` (opens and closes the bottom panel, inside a project only), keep awake (only while that setting is on), quiet hours, theme, density.
  - Every item that has a screen opens it on click. Below 1180 px the lower-priority items (RAM, GitHub sync, Actions) hide.
- **Sidebar** is two framed blocks:
  - **Nav:** six destinations, counters only on Inbox. The active item gets bright corner ticks.
  - **Accounts:** pinned to the bottom, sorted most urgent first. The owner, 2026-10-31: "sol panelde limitler kısmında gereksiz yazıları kaldır ve hover edince daha detaylı çıksın ve sadece kullanılanlar ön planda olsun çünkü çok dar ve çok şey var" (remove the unnecessary text, show more on hover, put only the accounts in use in front, because the panel is narrow and holds too much). So:
    - **In use first.** An account is in use when a run on it has not ended, a known window is above 0% in its current period (near and over the limit included), or an API key spent something today. Those come first, each a 24 px name line (vendor mark, name, an accent dot while something runs, and today's $ for an API key) and one 16 px row per window or bucket it has reported: short label (`5 h`, `weekly`, `monthly`, a bucket name), 24-tick meter, % and a one-letter provenance mark (`R`/`E`/`?`, `B`/`T`/`?` in Turkish, in the provenance badge colours, the full word as screen-reader text). An API key with a daily cap gets one `cap` row; a key without a cap shows its spend as text. An account in use with nothing reported gets a single Unknown row (dashed meter, no %), never one per possible window. Reset times, sources as words and ages are not on the rows.
    - **The rest fold** into one line, `+5 not used`, which expands on click and remembers that in prefs. Folded accounts are one line each without a meter: a plan with nothing reported (`—`), a window at 0%, a key with no spend, a local server, and a profile that must sign in or update (`Sign in`, `Update`).
    - **Hover and keyboard focus** open the account's detail beside the sidebar (a real tooltip, `aria-describedby` on the row, `Esc` closes it, one at a time): every window and bucket with %, provenance and reset time, the newest reading's age, today's spend and the daily cap for a key, runs in progress, and the sign-in state with the plan and when it was checked.
    - With no accounts at all the block is not drawn (the Start checklist points to Providers). It scrolls on its own above about 236 px (34% of the window height), so many accounts never push the nav away. `ALL LIMITS` opens Limits, the place for the full view.
- **Pane sizes** (all through the shared `Splitter`, stored per window in prefs, never in the database, clamped on load and applied before the first paint so nothing shifts at start):
  - **Sidebar:** expanded at 224 px by default, resized by dragging its right edge between 184 and 360 px, or collapsed to the 56 px icon rail with the toggle at its foot or `Ctrl B` (tooltip says so). Dragging the edge under 136 px collapses it; dragging the rail's edge out expands it to the last width. In the rail each nav item is an icon with its name as tooltip and screen-reader text, Inbox keeps its count as a small badge, and the accounts block hides (the status bar keeps the near-limit count).
  - **Inspector:** 380 px by default, resized by dragging its left edge between 320 and 720 px, never so wide that the main view drops under 600 px. A toggle collapses it to a 44 px strip that keeps the selection (task title written vertically, expand and close buttons); ✕ still closes it. In Crew graph full screen it overlays the graph under the caption buttons.
  - **Inbox:** the request list is 360 px by default, 280–560 px, and the detail pane never gets narrower than 320 px.
  - **Bottom panel:** under the main view, inside a project only, closed by default. `Panel` in the status bar or `Ctrl J` opens and closes it (the shortcut moves focus into its tab list, closing returns focus to the toggle); `Ctrl Shift A`, ``Ctrl ` `` (or `Ctrl Shift T`) and `Ctrl Shift M` open it on the Assistant, Terminal and Problems tabs, and hide it again when it already shows that tab. 280 px high by default, resized by dragging its top edge between 160 and 640 px, never so high that the main view drops under 200 px; dragging it under 96 px or `Enter` on the handle closes it, and it opens again at its last height. Open state, height and tab are stored like the other panes.
- **Main view** grows with the window: it fills everything between the sidebar and the inspector, with a 28 px side gutter (`layout.gutter`) and no maximum width (owner, 2026-10-31: "iç kısımda her şey genişleyebilsin", then "grow with the window"; it used to stop at 1120 px, centered). Inside it:
  - Paths, titles, branch names, task context lines and table columns take the room there is and cut with an ellipsis, the full text in the tooltip; no fixed px caps.
  - Grids of tiles add columns rather than stretching one control: crew role and Best-of variant tiles keep about 220 px (`auto-fill`), the Start machine strip goes to one row of eight from 1880 px, Limits plan accounts flow into columns of at least 560 px, GitHub task pull requests into columns of at least 600 px, and Settings sections into two columns from 1880 px.
  - Running prose (hints, notes, descriptions, the Start lead) keeps a readable measure of 72ch (`layout.measure`, principle 5); one-line fact and key-hint lines are not prose and take the full width.
  - A single-line text field stops at 960 px (`layout.field-max`); buttons and short inputs keep their size.
- **Bottom panel** (owner, 2026-10-31: "ai chat, terminal, etkinlik ve hatalar gibi bir panel var mı, toplu şekilde gösterilen tabs'lı", one tabbed panel for the AI chat, a terminal, activity and errors) grew out of the Activity drawer. Five tabs, in this order: `Assistant`, `Terminal`, `Events`, `Logs`, `Problems`. Closing it, or switching tabs, only hides a view: nothing it shows stops, and its views read only while it is open. The note beside the tabs says what closing means for the tab in view.
  - **Assistant:** the task assistant ([ADR 0014](docs/adr/0014-task-assistant.md)), reachable on every project screen. Its rules are unchanged: its own `Stop and close`, `Esc` inside it and `Ctrl Shift A` while it shows stop it and hide the panel; hiding the panel any other way leaves it as it is (it still stops when idle). The Tasks screen's `Assistant` button opens the panel on this tab. Its message box takes focus only when its shortcut or button opened it, never when you arrow through the tabs.
  - **Terminal** ([ADR 0016](docs/adr/0016-terminal.md)): your own shell through ConPTY (`node-pty` in its own utility process, xterm.js in the window, colours from tokens). A toolbar picks the shell (Windows PowerShell first, then PowerShell 7 and Git Bash when installed, Command Prompt) and where it starts (`Project folder`, or `Task worktree` for the selected task's worktree), with the folder as text and `New terminal`; nothing starts before that click. Each shell gets a sub-tab (`Windows PowerShell 1`, a dot in accent while it runs) with a ✕; `Delete` on a sub-tab or the ✕ asks "End this shell?" while it runs (`Keep it` / `End shell`), then ends it and everything it started. Hiding the panel keeps shells running and their screens. Inside the terminal, Tab, Esc and Ctrl C go to the shell; `F6` returns focus to its sub-tab, and the panel's own shortcuts still work. The tab carries the number of running shells. The shell gets your environment minus every credential-shaped variable and Crewyard's own; at most 8 terminals; output is never stored or logged.
  - **Events:** the open project's event log, newest first, in pages of 50 (`Newer` / `Page n` / `Older`, keyset on the log's sequence, so an older page never shifts while events arrive). Filters: task, run (only the chosen task's runs; picking a run picks its task), kind (families such as `run.*` and each kind, with counts), and `Streamed text`, off by default, because message and thought deltas arrive a few words per event. Each row: time, kind, task and run, and the payload's most readable field (its text, command or title) cut to one line; `Show all` fetches the whole stored payload into a scrollable block. Payloads are agent and tool text, so they are only ever shown as text. Live updates are batched once a second: the newest page refreshes itself; an older page only offers `Show newest (n new)`, announced once.
  - **Logs:** Crewyard's own lines, newest first, from `<profile>\logs`: the main process (`main.log`), the daemon's stdout and stderr (`daemon.log`) and the updater (`updater.log`), with the rotated `.old` files. Filters by source and level, `Show older` in steps of 500 up to 2,000 lines, `Open folder`, refreshed every 5 s while the tab is open. Lines are redacted when written and again when read (`redactLogLine` in `packages/core`: API keys, OAuth and GitHub tokens, JWTs, `Authorization` and cookie headers, URL credentials, credential query parameters, secret-named variables and JSON fields). A runner's own output and credentials never reach these files.
  - **Problems:** one list, newest first (rows without a time, such as a file read now, after the dated ones), with the count on the tab (red while one of them is a failure). Each row: a severity icon with its word for screen readers (Failed in `state.danger`, Needs a look in `state.warning`), time, what happened, the task, and one line of detail as plain text with anything key-shaped hidden. Sources: steps whose newest run failed, with the provider's readable error (`402 · Insufficient Balance`) or our code in words; audit events whose kind ends in `failed` (`transcript.failed`, `git.failed`, `bootstrap.setup_failed`); open stall alerts; failing checks on the head of a task's open pull request; this project's `project.json` notice (newer, unusable, values replaced); role files and `customRoles` not used; shared agent-file copies that failed or whose original is gone; key checks that said invalid. Each row has one way to its fix: `Open task` (selects it and opens the inspector on the step), `Open Inbox`, `Open GitHub`, `Open Settings` (on the Projects, Roles or Instructions and skills section), `Open Providers`, or `Show events` for an event with no task. `Dismiss` hides a row while its cause stays the same; it shows again when the cause changes, or goes away and comes back. `Show n dismissed` brings them all back. Dismissals are per window and per project, like the other panel prefs.
- **Breakpoints:** below 1280 px the inspector overlays the main view (still resizable, up to the window minus 120 px); below 1180 px the sidebar is always the 56 px icon rail and its toggle and handle hide; below 1280 px the Inbox list and detail stack. 960 px is the minimum supported width.

## 5. Components

| Component | Default view | On demand | Notes |
|---|---|---|---|
| `TitleBar` | brand, project switcher, command search, notifications | notifications popover; takes a dropped folder on every screen | `-webkit-app-region: drag` except on controls, and not at all while files are dragged over the window |
| `Autopilot` | a strip under the `TaskAssistant` header: `AUTOPILOT` label, state (`OFF`, `ON` in accent, `STOPPED` or `HALTED` in warning), and while on today's committed spend against the day limit with `Estimated`, starts this hour and active tasks against their caps; `Turn on…` / `Limits` / `Turn off` at the end | the first `Turn on…` opens a consent card (`role=alertdialog`) with two lists, `It may` and `Stays with you, always`, and the four limit fields; `Autopilot log` (a `details`) lists every call newest first: time, action, a `REFUSED: <reason>` badge when refused, the task as a link, the agent's reason as a quoted line | [ADR 0017](docs/adr/0017-autopilot.md); only this strip changes its limits; agent reasons are plain text; a halt or the kill switch shows a warning banner; the assistant's conversation shows its calls as notices under the dashed rule; the task timeline shows each call with a `Bot` icon |
| `StatusBar` | daemon, slots, need you, near limit, RAM, GitHub sync, Actions, quiet hours, Autopilot (only while it is on somewhere: `Autopilot on in N projects` `Stop Autopilot`, or `Autopilot stopped` `Lift the stop`), theme, density | each item opens its screen | mono 11 px, items separated by hairlines |
| `Sidebar` | framed nav block (6 items, Inbox count), collapse toggle with `Ctrl B` at its foot | rail mode, drag the right edge to resize | active item marked by bright corner ticks; the rail keeps the Inbox count as a badge |
| `Splitter` | invisible 9 px handle over a pane edge (16 px in-flow between two columns); hairline on hover, 3 px accent line on focus and while dragging | drag; `Left`/`Right` move 16 px (`Up`/`Down` on the horizontal handle of the bottom panel), `Home`/`End` give the pane its min/max, `Enter` collapses or restores a collapsible pane; double-click resets | `packages/ui`; `role="separator"` with `aria-orientation`, `aria-valuenow`/`min`/`max` in px, `aria-controls` the pane, tooltip says how to reset; never animates |
| `ActivityDrawer` (the bottom panel) | closed; when open, tabs `Assistant`, `Terminal`, `Events`, `Logs`, `Problems` (counts on Terminal and Problems), a note on what closing means for the tab in view, ✕ | per tab: the assistant, terminals with their sub-tabs and close confirm, filters, paging, `Show all`, `Open folder`, problem rows with their fix and `Dismiss`; drag the top edge to resize | tabs after the WAI-ARIA tabs pattern (arrows move and select, `Home`/`End`), terminal sub-tabs too; a `region` named Panel; event, log, problem and terminal text is plain text, never markup or links; Esc inside a terminal goes to the shell |
| `AccountsBlock` | pinned to the sidebar bottom, most urgent first; accounts in use first with one compact row per reported window, bucket or cap (label, meter, %, provenance mark), the rest folded into `+N not used` | detail on hover and focus with every window, source, reset time, age, cap, spend and sign-in; the fold expands on click and is remembered | hidden with no accounts; 80/95% colours; a provenance mark on every value; Unknown is a dashed meter without %; a key without a cap has no meter |
| `BrandIcon` | the vendor's mark for a catalog provider id, a runner id or `git` / `github` | `label` turns it into a named image; otherwise it is decorative next to the visible name | `packages/ui`; data in `brand-icons.gen.ts`, never edited by hand |
| `ProjectTile` | index, line-art type glyph, name, path (ellipsized, full path in tooltip), state line, last opened | opens the project | dashed variant for `Import from C:\Projeler` |
| `Stepper` | numbered spec tiles, current one with accent ticks, finished ones labelled `Done` | any step is clickable | `Back` / `Next: <step>` / `Create project` in the pane footer |
| `ContextMenu` | opens on right-click, `Shift+F10` or the context-menu key on a graph node | items depend on the node state | arrow keys move, Esc closes and returns focus; disabled items say why; on a crew node the groups are open (inspector, Open changes, Open files), run (message, pause or resume, Check again or Retry step, Change AI, Hand off now, Wait for reset), crew (Edit step, Add a step after this, Remove step, Skip step, Add a follow-up step, Pause all, Resume all), copy, then Stop agent alone |
| `CrewBar` | above the graph: `Proposal`, step count, forecast with provenance, the first problem or "Nothing starts until you approve.", `Add step`, `Approve and start`; while running `Pause all`, `Resume all` and "n new steps wait for your approval" with `Approve new steps` | | hidden when nothing runs, nothing is paused and nothing waits; a disabled button has its reason as text beside it |
| `StepPanel` | docked at the right of the graph frame (380 px, inside full screen too) or beside the list: role select (custom roles marked as role files), every scored candidate with runner mark, alias, model, forecast, headroom, score and first reason, the chosen one marked `In use`; the standby chain in order; "Waits for" checkboxes; `Remove step` | drag candidates into the chain or between places; Alt+Up/Down moves the focused chain item; move and remove buttons on each | opens on click or Enter on a step that can still change (a proposal, a follow-up); Esc and ✕ close it and return focus to the node; a candidate that would break independence is disabled with "Same model as step 02"; a checkbox that would close a loop is disabled with the loop by step numbers |
| `ProvidersTable` | provider, newest models with price, runner chips, credential and limits | catalog refresh, catalog versions, add provider | runner chips are the runner's own mark (`BrandIcon`, 14 px in a 24 px frame), not its name: the owner asked on 2026-10-31 "Works with kısmında isimler değil iconlar olsun" (show icons, not names, in Works with). The frame carries the state and the color only repeats it: filled green works directly or natively, outline blue goes through the profile's config, dashed muted needs a converter; "No known route" draws no chip. Each chip is `role="img"` named "Claude Code: works directly", one tab stop per row with arrow keys, Home and End between runners, and a tooltip on hover and focus (Escape closes it) with the runner name, how it connects (Anthropic base URL, Codex `model_providers` entry, OpenCode provider entry, needs a converter) and whether a profile can use it. The column header's info button opens the legend for the three frames; the legend also stays under the table. A runner without a mark shows its name in the same frame |
| `CatalogDialog` | stored catalog versions (hash, generated date, models.dev sha, origin, In use / Pinned / Newest chips) and the LiteLLM price check (model, price field, catalog and LiteLLM price per 1M, signed difference) | pin, unpin, check now | Pinned in the accent chip; a failed or missing price check shows the Unknown badge and no table, never "0 differences" |
| `Composer` | task text, repo, branch, `Ready-made` (fills the text with a preset analysis and sets the kind to Research), crew mode, on-limit mode, `Attach`, `Ctrl Enter` | full options (model pinning, budget, labels); images and files by `Ctrl V`, drop or the picker, shown as 40 px thumbnails with the name and size, each removable | submitting opens the crew proposal, it never starts work; thumbnails have alt text ("Attached image: name"); a refused upload says why under the list; the inspector's message box has the same `Attach`, disabled per kind with the reason when the run's runner cannot take it; the proposal and the queue show the attachments read-only |
| `TaskAssistant` | the bottom panel's Assistant tab; `Assistant` beside the composer or `Ctrl Shift A` on any project screen opens the panel on it: a header line (profile picker, or profile · runner · model while it runs, state, spend with its provenance badge, `[ NEW CONVERSATION ]`, `Stop and close`), the conversation in mono on `bg.sunken` (`YOU` and `AGENT` gutters, tool reads as dim `·` lines, Crewyard's notices under a dashed rule), a `>` message box (Enter sends, Shift Enter adds a line), and a Drafts column of numbered spec tiles, headed by `READY-MADE TASKS` (up to three `For this project` with their reasons, the others as ghost buttons) and `Suggest tasks for this project` with its Estimated cost | each draft editable (title, kind, size, description, acceptance criteria or, for research, questions one per line) with `Add as draft` and `[ DISCARD ]`; an added draft shows `Open task`; in the panel the drafts column stays beside the conversation (at least 260 px) | [ADR 0014](docs/adr/0014-task-assistant.md); its read and own-draft tools ([ADR 0018](docs/adr/0018-assistant-read-tools.md), owner 2026-10-31: "asistana çok daha fazla tool ekle erişebilsin hemen hemen her şeye", give the assistant many more tools so it can reach almost everything) show as tool lines Crewyard stores as data (tool, outcome, subject) and the panel words in your language (`Read task: Fix login`, `Görevi okudu: Fix login`, `Could not read task`), and an open draft card takes the agent's `edit_draft` in every field you have not typed in; agent text is plain text, never markup, each reply capped at 32 KB; a plan profile shows tokens with `Plan`, an unpriced one `Unknown` and no number; the log is a focusable `role=log` with no live region of its own, one polite announcement per finished reply; the one panel whose close stops something, so the control says `Stop and close` (§7) |
| `TaskReport` | on a finished research, review or docs row: the summary's first line, `n findings`, `n suggested tasks`, `[ OPEN REPORT ]` | in the inspector's Details: `REPORT` with its source (Findings, Review verdict, Plan, Final message) and verdict, the summary, findings (severity word in its state colour, title, `file:line` in mono, detail) and `Suggested tasks` as the same draft cards as the assistant's | agent text as plain text only, capped; severity is a word, never colour alone; adding a draft opens its crew proposal, nothing starts |
| `CrewProposal` | 1 spec tile per role: index, line-art icon, role, runner · model, account, one-line reason, meter; under the tiles, "Instructions and skills each step reads": per step the project files its runner reads, the bridged ones and what is shared into its profile | "Hide reasons", edit a role, swap account | footer: fallback chain + Manual/Ask/Auto, estimate disclaimer, `Approve and start` |
| `SpecTile` | hairline + 4 corner ticks | hover ticks ink, selected ticks accent | standby/fallback tiles use a dashed border on `bg.canvas` |
| `TickMeter` | 48 ticks, fill = used share, threshold ticks at 80% and 95%, handle at value | tooltip with source and reset time | fill turns amber past 80% and red past 95%; `Unknown` draws dashed empty ticks and no handle; `role="meter"` |
| `SegmentedBar` | one segment per series with 4 px gaps | legend with value and share | always paired with a legend and an `aria-label` sentence |
| `TaskRow` | title, repo, branch, runner dots, elapsed, one status line | steps with durations, limit banner, diff stat, PR | rows never auto-expand on new events; expanding one never shifts another |
| `StatusLabel` | icon + text in the state color | | see the mapping table below |
| `LimitBanner` | amber soft fill, source, reset time, `Hand off now`, `Let it finish` | | appears on the row and in the inspector, plus one Windows toast |
| `InboxItem` | kind icon, title, who asked, time | full detail pane | approvals show command, working directory, scope and policy |
| `GraphNode` | role, runner, status, model · account, one fact line | inspector on click, context menu on right-click | fixed 180 × 100, or 180 × 120 when it carries a crew-loop line (fix attempt n of max, or the reviewer's verdict); draggable, snaps to 12 px; `Alt` + arrows move it by keyboard; moving a node only changes the layout, never who does the work; a follow-up waiting for approval is dashed, a skipped step sits on `bg.canvas` with its runner struck through; while some step can still change, 10 px connect handles show on the left and right edges |
| `GraphEdge` | `reports to` (solid), `depends on` (dotted), `fallback` (amber dashed) | `messages`, `files` edge sets via the segmented control; a dependency into a step that can still change carries a 20 px ✕ remove button at its label point | orthogonal with one rounded elbow, recomputed while a node is dragged; selected path in accent; leader lines carry mono annotations (limit, reset); a connection being drawn is the dotted `depends on` line in accent |
| `GraphView` | fit to width | drag the background to pan, `Ctrl` + wheel or +/− to zoom, fit, `Reset layout`, full screen (`F`, `Esc` leaves) | layout is saved per task; full screen keeps the inspector available as an overlay |
| `Inspector` | header, status, tabs Details / Conversation / Changes / Usage / Files / Preview, meters, facts, worktree, actions, and in Details the task timeline: one lane per run to scale (working in the runner hue, waiting on you amber, limited red, paused grey, handing off half-height amber) and the events newest first in pages of 40, tool calls folded per burst, a cut output marked `Truncated, <size>` with its full text one click away | transcript loads only on the Conversation tab; Files (read-only, the task's own worktree only): `Mentioned by the agent` first (files of the worktree that tool calls, approvals, diffs and messages named, most recent first, click to preview), then a lazy tree (folders load when opened; gitignored ones such as `node_modules` and links are marked, links never followed; one tab stop, arrows move, Right/Left open and close, Enter opens), then a preview: Markdown rendered as text-only elements (raw HTML stays text, images are named and never fetched, links show their target and never open), code and text in mono with line numbers and a `Wrap` toggle, cut at 256 KB with `Truncated, <size>`, images (png, jpg, gif, webp, svg as an image) up to 5 MB; drag the left edge to resize; collapse to a 44 px strip; Preview ([ADR 0013](docs/adr/0013-dev-server-preview.md)) lists the task's dev-server addresses (worktree port first, then loopback URLs its runs printed, newest first), loads one only on `Load` into a framed page under a toolbar (address, reload, `Pick element`, open in browser, unload), and shows a pick as plain text with a thumbnail of just the picked element (alt text names its selector, removable; none when nothing of it was in view), a note field and `Add to queue`, which queues the text and the image together | `Stop agent` is a danger text button, separate from `Pause`; collapsing, like closing, never stops anything; the page is a native view, hidden while a dialog or menu is open and cut to the visible part of the panel; Enter on the frame moves the keyboard into the page and Esc brings it back; unloading, switching task or closing the panel unloads the page and never stops the dev server or the agent |
| `AgentFilesSection` | Settings → Instructions and skills: the found files folded per tool (vendor mark, name, counts per kind), then `Shared` with a `Sync n copies` button, then the open project's bridge toggle and its files | a tool group opens into one row per item: kind, name, `Yours` / `This project`, path (ellipsized, full in the tooltip), size, description, warning lines (scripts, shell commands, front matter a copy drops, imports not followed, files not read), which runners can take it, `Preview` (plain text in a sunken block, never markup) and `Share` (runner segmented control, profile select with "every profile of the runner", a scripts tick when needed, `Share and copy`); each share lists its copies with a state word (Up to date in success, the others in warning, Original is gone in danger), when it was copied and where, `Sync`, `Stop sharing` (confirms) | nothing is copied before `Share and copy`, nothing again before `Sync`; groups are buttons with `aria-expanded`; subagents and project files say why they are not shared |
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
| **Tasks** (project home) | composer (with `Assistant`, which opens the bottom panel on the task assistant), crew proposal when drafting, filters `All / Running / Needs you / Ready for review / Merged / Done`, task rows | steps, limit banner, diff, PR link, inspector |
| **Inbox** | items that need an answer first, then limits, automatic account switches (each fact with its provenance badge, `Off for this task`, `Dismiss`) and GitHub notices | detail pane: approve once / allow in project / deny; question options + note |
| **Crew graph** | one task's crew: task → roles → PR, standby fallback, limit annotation; the crew bar above it | drag and drop, pan, zoom, full screen, right-click actions (pause, check again or retry, change AI or model, hand off now, wait for reset, skip, follow-up, pause all, open changes or files, stop), the step editor for a proposal or a follow-up (add, remove or change a step, its AI and model, standby order, dependencies, drawn edges), Messages and Files edge sets, list view for screen readers, inspector (owner, 2026-10-31: "crew graph da daha fazla yönetim olsa") |
| **Providers** | catalog providers with newest models and prices, which runners each works with, credential and limits, connected first; the catalog line says when a version is pinned | add provider, refresh catalog, Versions (pin or unpin a catalog version, LiteLLM price check), filters (connected, first-party, coding plans, aggregators, local) |
| **Limits & usage** | subscription windows per account with provenance, API spend (7 days) with segmented bar, balances and caps | alert thresholds, on-limit policy, Windows notifications; the `Usage ledger` tab: tokens in, out and cache reads by day, model, provider or task, dollars only for per-token keys (plans and local models show `Plan`), a segmented bar with legend, CSV and JSON export through a save dialog |
| **GitHub** | Actions minutes this month, branches waiting to push, worktrees, PR table with merge gate; each task PR's Feedback from GitHub block opens with `Send failing checks to the agent` (disabled with the reason on the line below it when there is nothing to send) | checks and logs, review comments sent back to the agent, failing checks queued for the owning step (never sent before you see them; `Continue with the queued messages` for a finished step), worktree cleanup; PR state is read again when the window regains focus (at most every 30 s) |
| **Settings** | accounts and API keys (aliases only), roles, policies, theme, density; the sections flow into two columns from 1880 px | per-project allowlist, price table version, diagnostics; under Projects, the projects whose `project.json` is newer, unusable or had values replaced; Instructions and skills ([ADR 0015](docs/adr/0015-agent-files-and-skills.md)): your own agent files per tool with preview and share, the shared copies with their state and `Sync`, and the open project's instruction bridge (off by default) |

## 7. Interaction rules

- **Taskbar badge:** a 16 px disc in `state.warning` with the count in `inverse.fg` (`9+` above nine), in the taskbar's own light or dark theme, drawn on whole pixels; no other color, no animation. It flashes the button once per new request, never repeatedly.
- **Close is not stop.** Closing the inspector, the bottom panel or the window keeps agents running (the tray icon stays), and hiding the panel keeps its terminals running too. `Stop agent` asks for confirmation and names what it stops. Two controls stop what they show, and say so: the task assistant's `Stop and close` (owner, 2026-10-31: it does no work of its own and keeps its conversation and drafts), and a terminal's own close, which ends its shell and asks first while it runs. Quitting the app ends every shell.
- **Approvals:** Windows toasts may offer `Approve once` only for low-risk, read-only or in-worktree commands. Anything else opens the Inbox. `Always allow` is never the default button.
- **Hand off dialog** shows what transfers (summary, diff, branch, open questions), whether it is a native resume or a new session, the target account's headroom, and the cost estimate. In Auto mode the same record is written and shown afterwards.
- **Pushes:** agents commit locally; pushes wait in GitHub → "Waiting to push" so CI runs once per finished change.
- **Keyboard:** `Ctrl K` command palette, `Ctrl B` collapses or expands the sidebar, `Ctrl Enter` submit composer or approve the focused crew, `Ctrl J` shows or hides the bottom panel, `Ctrl Shift A` opens it on the task assistant or stops the assistant and hides it (Enter sends in it), ``Ctrl ` `` or `Ctrl Shift T` and `Ctrl Shift M` open it on Terminal and Problems or hide it, `Delete` on a terminal's sub-tab closes it (asking while it runs) and `F6` inside a terminal returns to its sub-tab, `Esc` closes the topmost layer (menu, then the bottom panel while focus is inside it but not inside a terminal, then inspector, then full screen), `J/K` move in lists, `Enter` expands a row, `G T / G I / G G / G L / G P / G H` jump to screens; in the graph `Shift+F10` opens the node menu, `Alt` + arrows move a node, `F` toggles full screen. `?` or `F1` (and `Keys` in the status bar) opens the keyboard map. Every shortcut is declared once in `src/renderer/src/keys.ts`; handlers match through it and the map lists it, and a test fails when the two disagree.

## 8. Accessibility

- WCAG 2.2 AA: text 4.5:1, UI boundaries and focus 3:1 (checked by the script), 2 px focus ring with 2 px offset. Text fields, selects and the title-bar search have no ring: their own border turns accent and an inset 1 px accent line doubles it, so focus stays 2 px and visible inside the frame (owner, 2026-10-31: "searchbar ve selectbox daki outline leri kaldır").
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
