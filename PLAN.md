# Crewyard: product and architecture plan

**Status:** plan, 2026-10-29. Replaces the earlier draft package (`AI_MISSION_CONTROL_RESEARCH.md`, `UI_UX_DESIGN_SYSTEM.md` and the rest).
**Scope:** a local, Windows 11 first desktop app that runs and supervises four agent runners (Claude Code, Codex, Gemini CLI, OpenCode) on models from any provider you have a key or plan for: Anthropic, OpenAI, Google, DeepSeek, Moonshot Kimi, Zhipu GLM, Alibaba Qwen, MiniMax, Xiaomi MiMo, OpenRouter and more (§6.1). Built for your own use first, designed so it can be shared later; for that reason Claude Code never uses a claude.ai sign-in, only API keys (§6).
**Related:** [PRIOR_ART.md](PRIOR_ART.md) (what we learned from the strongest repos), [DESIGN.md](DESIGN.md) (UI system), [design/prototype.html](design/prototype.html) (visual reference).

## 1. What the app must do

| # | Requirement | Where it lives | Milestone |
|---|---|---|---|
| R1 | Connect Claude Code, Codex, Gemini CLI, OpenCode | Agent adapters (§5) | M1–M3 |
| R2 | Several accounts, several API keys, several agents and many AI providers, managed in one place | Accounts, profiles and the provider catalog (§6) | M1–M2 |
| R3 | Warn when a running job's tokens or quota run out, notify when they are getting low | Limits and notifications (§7) | M1–M2 |
| R4 | If you enabled it, continue automatically on a backup agent | Fallback and handoff (§8) | M3 |
| R5 | Full control of GitHub state | GitHub (§10) | M4 |
| R6 | Answer agent questions and approvals | Inbox (§11) | M1 |
| R7 | When a task is created, suggest which agent takes which role; start only after you approve | Crew proposal (§9) | M3 |
| R8 | Different agent types (roles) | Roles (§9.1) | M3 |
| R9 | High-quality visuals based on the reference images | DESIGN.md, Crew graph, Limits | M0–M5 |
| R10 | Windows first, stable | §12, plus a Windows check on every milestone | all |
| R11 | A start screen with new and recent projects, and a guided setup for each new project | First run and project setup (§11.1) | M0 |

## 2. What changed from the earlier draft

| Earlier draft | Now | Why |
|---|---|---|
| Graph-first, nine overlapping documents, Tauri + Node sidecar undecided | Tasks-first, four documents, Electron + TypeScript | Every agent client library we need is TypeScript; one runtime is simpler on Windows (§3) |
| An LLM orchestrator spawns workers | Crewyard is the orchestrator: a deterministic scheduler runs a crew plan you approved | agent-orchestrator shows the cost of LLM-driven spawning: runaway workers (#3921), roles enforced only by prompts (#6842) |
| Loopback HTTP API | UI talks to the daemon over Electron IPC; external ingress only through a per-user named pipe with a token | A localhost port is reachable from any web page you open |
| Quota "if available" | Quota only from the agent's own reporting channel, labelled Reported / Estimated / Unknown | Calling undocumented usage endpoints with subscription tokens conflicts with provider credential rules (PRIOR_ART.md) |
| "completed" vs "merged" ambiguous | One canonical state model (§13) | |
| Five-repo research gate for every feature | Tiered gate (AGENTS.md) | Counting sources invites made-up research |

## 3. Key decisions

**D1. Build our own, use others as references.** No fork (reasons in PRIOR_ART.md). Ideas come mostly from agent-orchestrator (Apache-2.0) and vibe-kanban's executors (Apache-2.0). We read them to learn how they work and write our own code; nothing is copied or ported (AGENTS.md).

**D2. Electron + TypeScript end to end.**
- The Claude Agent SDK exists only for Node and Python; the OpenCode SDK and ACP client are TypeScript; the Codex app-server is JSON-RPC over stdio and is easy to drive from Node. A Rust (Tauri) or Go core would still need a Node sidecar for Claude.
- Electron gives Windows toasts with buttons (`toastXml`), tray, single-instance lock, auto-update and ConPTY via `node-pty` for the optional terminal view.
- Rejected: Tauri 2 + Node sidecar (two runtimes, sidecar bundling), Go daemon like agent-orchestrator (same problem), browser-only app (no tray, no toasts, ports exposed).

**D3. Native protocol per agent, one internal event model shaped like ACP.** Details in §5. A generic ACP driver covers Gemini and future agents.

**D4. An account is an isolated config folder.** Each account runs its CLI with its own `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME` or OpenCode data folder. Subscription sign-in (ChatGPT for Codex, Google for Gemini CLI) always happens through the CLI's own login flow. Claude never uses a claude.ai sign-in; each Claude profile gets an Anthropic API key from our secret store. Crewyard never reads, copies or relays subscription tokens, and never touches your default `~/.claude`, `~/.codex` or `~/.gemini`.

**D5. Store facts, derive status.** SQLite in WAL mode holds facts and an append-only event log. Display status is computed when read. A change feed pushes updates to the UI, and the UI can replay from a sequence number after a reconnect.

**D6. Small harness set behind conformance tests.** Four agents, pinned CLI versions, a recorded-transcript test suite per adapter. A new agent CLI version is accepted only after its suite passes.

**D7. Admission control from day one.** A run queue with a global cap, a per-account cap and a memory check. Nothing spawns without a free slot.

**D8. Nothing outward-facing happens without you.** Starting a crew, pushing, opening a PR, merging, deleting a worktree, spending past a budget and Ask-mode fallbacks all need an explicit click. Auto mode is opt-in per task and still writes an audit record.

**D9. Runner, provider and key are separate.** A *runner* is the agent program (Claude Code, Codex, Gemini CLI, OpenCode). A *provider* is where the model comes from (Anthropic, DeepSeek, Kimi, OpenRouter...). A *credential* is a key or a plan sign-in. A *profile* combines one of each plus a default model and its own config folder. Claude Code can run on DeepSeek, Kimi, GLM, Qwen, MiniMax and others through their Anthropic-compatible endpoints; Codex can run on OpenAI-compatible providers; OpenCode runs on everything in the catalog.

**D10. Provider data comes from a synced catalog, not hand-written tables.** `catalog/sync-catalog.mjs` pulls models, prices, context limits and capabilities from models.dev (MIT, the catalog OpenCode uses) and merges `catalog/curated.json`, which adds Anthropic-compatible endpoints and balance endpoints taken from cc-switch (MIT, file and line cited). The app ships a snapshot and refreshes it in the background.

## 4. Architecture

```
┌──────────────────────────── Electron app (tray resident) ─────────────────────────────┐
│ Renderer (React)            Main process                 Daemon (utility process)     │
│  Tasks · Inbox · Graph  ◄──► window, tray, toasts,  ◄──►  scheduler + admission        │
│  Limits · GitHub ·          updater, single instance       adapters host               │
│  Settings                   (typed IPC over MessagePort)   limits engine               │
│                                                            GitHub observer             │
│                                                            SQLite WAL + event log      │
└──────────────────────────────────────────────┬─────────────────────────────────────────┘
                                                │ child processes, windowsHide, own env
        ┌──────────────────┬────────────────────┼──────────────────┬───────────────────┐
  Claude Agent SDK    codex app-server     gemini --acp       opencode serve      git / gh
  (claude.exe)        (JSON-RPC stdio)     (ACP stdio)        (127.0.0.1:0, Basic  (worktrees,
  API key, own dir    CODEX_HOME           GEMINI_CLI_HOME     auth, random pass)   PRs, checks)
```

- **Process ownership:** every agent process is a child of the daemon. The daemon tracks process trees and kills them with `taskkill /PID <pid> /T /F` on stop, so nothing respawns or lingers. Closing the window hides it to the tray; quitting from the tray asks first and names the running agents.
- **Ingress:** besides IPC there is one named pipe `\\.\pipe\mission-control-<user-sid>`, restricted to the current user and protected by a token. It is used by Claude Code hooks (to observe sessions you started outside the app), by a small `mc` CLI, and by the report server every run gets (ADR 0007: a PowerShell byte relay the runner starts, one ticket per run process, a random pipe name per daemon start). No TCP port is opened.
- **Recovery:** on start the daemon reloads facts, marks runs whose process is gone as `interrupted`, and offers native resume (Claude `resume`, Codex `thread/resume`, OpenCode session, ACP `session/load`) instead of silently restarting anything.

### 4.1 Repository layout

```
mission-control/
  apps/desktop/          Electron main, preload, renderer
  packages/core/         domain types, state derivation, policies, crew scorer (pure, no IO)
  packages/daemon/       scheduler, adapters host, SQLite, limits engine, GitHub observer
  packages/adapters/     claude/  codex/  opencode/  acp/  (gemini uses acp/)
  packages/ui/           tokens to CSS variables, primitives (SpecTile, TickMeter, ...)
  design/                tokens, prototype, screenshots, contrast check
  docs/adr/              one file per decision that changes this plan
```

### 4.2 Stack

Electron, React 19, TypeScript, Vite, TanStack Router and Query, Zustand, `@xyflow/react` (graph), TanStack Virtual (long lists), Radix primitives, lucide-react, `better-sqlite3` + drizzle, zod (event and adapter schemas), pino with redaction, `cross-spawn`, `node-pty` (terminal view only), electron-builder (signed NSIS installer), Vitest, Playwright for Electron. Add everything with `pnpm add -E` at setup time; this plan does not pin versions in advance.

### 4.3 Data model

| Table | Holds |
|---|---|
| `projects`, `repos` | local path, default branch, GitHub remote, per-project policies and allowlist |
| `providers`, `models` | catalog snapshot: provider id, group, endpoints, env names, balance/quota support; models with context, output, price, reasoning, open weights |
| `credentials` | alias, provider, kind (`api_key`, `plan_signin`, `local`), secret reference, daily and per-task caps |
| `profiles` | runner + provider + credential + default model + config folder; what crew proposals choose from |
| `roles` | built-in and user role templates (§9.1) |
| `tasks` | title, description, repo, base branch, kind (`code` / `research` / `review`), fallback mode, budget |
| `crews`, `crew_members` | proposal per task: role, runner, model, account, reason, standby chain, approved_at |
| `runs` | one agent session: role, account, model, native session id, worktree, started/ended, end reason |
| `requests` | pending questions and approvals: kind, payload, risk, created, answered, answer |
| `usage_samples` | account, window (`5h`, `weekly`, `daily`, `context`), used %, resets at, source, observed at |
| `spend` | run, tokens in/out/cache/reasoning, cost, `estimated` or `billed`, price table version |
| `worktrees` | lease: task, owner run, path, branch, created, last heartbeat, clean/dirty |
| `pull_requests`, `checks` | number, state, head, mergeable, check runs, ETag |
| `handoffs` | from run, to run, reason, package path, mode (`native_resume` / `new_session`), outcome |
| `account_switches` | same-provider account switches (§8.3): from run, from and to profile, trigger, the numbers on both sides with provenance, accounts passed over, handoff |
| `events` | append-only: seq, at, project, task, run, kind, source, redacted payload, dedupe key |

## 5. Agent adapters

### 5.1 Contract

```ts
interface AgentAdapter {
  id: "claude" | "codex" | "opencode" | "acp";
  probe(profile: Profile): Promise<Probe>;            // installed, version, signed in, capabilities
  start(req: StartRequest): Promise<RunHandle>;       // cwd = worktree, model, account env, role policy
  events(run: RunHandle): AsyncIterable<AgentEvent>;  // normalized, see 5.3
  send(run: RunHandle, input: UserInput): Promise<void>;
  answer(run: RunHandle, requestId: string, answer: Answer): Promise<void>;
  interrupt(run: RunHandle): Promise<void>;
  resume(ref: NativeSessionRef, req: StartRequest): Promise<RunHandle>;
  setModel?(run: RunHandle, model: string): Promise<void>;
  limits?(profile: Profile): Promise<LimitSample[]>;  // only from the agent's own channel
  stop(run: RunHandle): Promise<void>;                // kills the process tree
}
```

Unsupported operations are visible in the UI as disabled controls with a reason, never hidden.

### 5.2 Per agent (verified against official sources on 2026-10-29)

| | Claude Code | Codex | Gemini CLI | OpenCode |
|---|---|---|---|---|
| Transport | Agent SDK `query()` (TypeScript), runs the installed `claude` binary; `ANTHROPIC_BASE_URL` points it at Anthropic or an Anthropic-compatible provider | `codex app-server`, JSON-RPC over stdio | `gemini --acp` (ACP over stdio) | `opencode serve --hostname 127.0.0.1 --port 0`, HTTP + SSE, Basic auth with a random password per launch |
| Events | `SDKMessage` stream (assistant, result, tool, hook, task, `rate_limit_event`) | `turn/*`, `item/*`, `thread/tokenUsage/updated`, `turn/diff/updated`, `turn/plan/updated` | `session/update` (message, tool call, plan, `usage_update`) | `GET /api/event` (live only; we re-read session state after reconnects) |
| Questions | `AskUserQuestion` via `canUseTool` | `item/tool/requestUserInput` (experimental) | `ask_user`; ACP mapping unverified, conformance test required | forms: `/api/session/{id}/form` + reply |
| Approvals | `canUseTool` allow/deny + `PreToolUse` hook | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` | `session/request_permission` | `permission.asked` → reply `once` / `always` / `reject` |
| Interrupt, resume | `interrupt()`, `resume` / `forkSession` | `turn/interrupt`, `thread/resume` / `thread/fork` | `session/cancel`, `session/load` | `POST .../interrupt`, sessions persist |
| Model switch | `setModel()` | per `turn/start` | `unstable_setSessionModel` | `POST .../model` |
| Usage | `usage`, `modelUsage`, `total_cost_usd` (local estimate) | `thread/tokenUsage/updated` incl. context window | `usage_update{used,size}` | per-session tokens and cost |
| Subscription limits | **Not used**: Claude runs on API keys (§6); we track spend against caps and back off on API rate-limit errors (`Retry-After`) | **Reported**: `account/rateLimits/updated` (primary/secondary window, used %, resets at) | **Not exposed**: shown as Unknown | Only OpenCode's own plans; third-party providers via balance endpoints (§7.2) |
| Account folder | `CLAUDE_CONFIG_DIR` per profile for settings and history, `ANTHROPIC_API_KEY` from the secret store | `CODEX_HOME` (keyring entry keyed by folder hash) | `GEMINI_CLI_HOME` + `GEMINI_FORCE_FILE_STORAGE=true` (its OAuth keychain entry is otherwise shared) | `OPENCODE_CONFIG_DIR`, `OPENCODE_DB`; isolation to be proven by a test |
| Windows notes | native; no sandbox on native Windows | `windowsSandbox/*` readiness methods | PowerShell example for home override in docs | default service port differs on Windows; we always pass `--port 0` |

### 5.3 Internal event model

ACP's `session/update` kinds plus our own fields:

`message.delta`, `thought.delta`, `tool.call`, `tool.update`, `plan.update`, `diff.update`, `request.question`, `request.approval`, `usage.update`, `limit.update`, `run.state`, `run.ended`.

Every event carries `runId`, `seq`, `at`, `source` (adapter + CLI version) and a redacted payload. Adapters keep raw protocol frames in a rolling debug log, off by default.

### 5.4 Conformance suite (per adapter, gate for every CLI upgrade)

Start a run in a temp repo, receive a plan and a tool call, approve once, deny once, answer a question, interrupt, resume, read usage, read limits, stop and confirm no process remains. Recorded frames replay in CI; the live suite runs locally on Windows before an agent version bump.

## 6. Accounts and credentials

- **Claude is API-key only.** Anthropic's Agent SDK terms say third-party products may not offer claude.ai login or rate limits without Anthropic's approval. Because the app may be shared later, Claude profiles always use an Anthropic API key, from the first build. Several Claude profiles means several keys (for example one per Anthropic workspace), each with its own daily and per-task cap. If Anthropic ever approves claude.ai login for the app, it becomes a separate profile kind; nothing else changes.
- **Adding a subscription account (Codex, Gemini CLI, OpenCode providers):** Settings → Accounts → Add → choose runner → Crewyard creates `%APPDATA%\MissionControl\profiles\<runner>\<alias>\` and starts that CLI's own login with the profile env set (for Codex through the app-server's `account/login/start`). When the probe sees a signed-in state, the account is ready. Removing an account deletes only that folder, after confirmation.
- **Adding an API key:** stored encrypted with DPAPI (user scope) in `%APPDATA%\MissionControl\secrets\<alias>.bin`. Not Windows Credential Manager, which caps entries at about 2.5 KB (claude-swap #45). Keys reach child processes only through environment variables, never on a command line, never in logs (pino redaction + a secret scanner on debug logs).
- **Keys stay with the runner process, not the agent's commands.** Each runner gets only the one variable it reads the key from. Each runner's own mechanism then keeps that variable from the commands the agent runs (checked 2026-10-30, live run in the PR notes):
  - **Claude Code:** we set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (documented in code.claude.com/docs/en/env-vars). Claude Code then strips its Anthropic credentials and other credential-named variables from Bash commands, hooks and stdio MCP servers.
  - **Codex:** the profile's `config.toml` and every `thread/start` set `[shell_environment_policy] ignore_default_excludes = false`. That drops `*KEY*`, `*SECRET*` and `*TOKEN*`. `exclude` also names the key variables. codex 0.147 defaults to passing everything.
    - Codex logs each spawned command's environment at TRACE into `<profile>/logs_2.sqlite`, and 0.147 has no setting to lower that level. So the policy is also what keeps the key out of that file.
    - Logs written before this fix are deleted once per data folder.
    - Backups and exports copy only Crewyard's database, never profile folders.
  - **OpenCode:** it has no scrub setting. Its shell tool, `!` commands and terminal run with the server's environment plus whatever `shell.env` plugin hooks return. A plugin we write into the profile's config folder sets the key variables and the server password to empty there. A hook can only add or override, so the agent sees the name with an empty value.
  - **Gemini CLI:** `security.environmentVariableRedaction.enabled` in the profile's settings.json (Gemini CLI 0.24 and later) drops credential-named variables from its shell tool.
  - **Not covered:** a runner process necessarily holds its own key. An agent that can read that process's memory, or that runs a tool which talks to the provider through the runner, is outside what environment rules can stop.
- **What the UI shows:** alias, runner, plan label, last probe time, never a key or token.
- **Shared settings across accounts:** copied, not symlinked (symlinks need Developer Mode on Windows).
- **Before sharing the app:** check OpenAI's terms for ChatGPT sign-in through the Codex app-server (its docs describe embedding Codex in other products) and Google's terms for Gemini CLI sign-in in a third-party app. Neither was verified in this plan.
- **Same-provider account switching** (for example Codex · work → Codex · personal when one hits its limit) works by hand from the Inbox, and automatically once you turn it on: Settings → Fallback, off by default, and turning it on shows the provider-terms note once. The rules are in §8.3 and [ADR 0009](docs/adr/0009-same-provider-auto-switch.md). Auto mode alone never moves to another account of the same provider. Automatic fallback to a *different* agent or provider (§8.1) does not need this setting.

### 6.1 Providers and the catalog

The first snapshot, `catalog/providers.json`, was built on 2026-10-29 from models.dev (sha `d645251e1d2a24ed`). It holds 34 providers and 1,061 models that support tool calls.

| Group | Providers | Claude Code | Codex | OpenCode |
|---|---|---|---|---|
| First-party | Anthropic | native | none | native |
| | OpenAI | needs conversion | native | native |
| | Google | needs conversion | none (Gemini CLI is native) | native |
| | DeepSeek, Moonshot Kimi (global, cn), Zhipu GLM (z.ai, bigmodel), Alibaba Qwen (intl, cn), Xiaomi MiMo, LongCat | direct | config | native |
| | MiniMax (intl, cn) | direct | none (its catalog endpoint is Anthropic-style) | native |
| | StepFun | none | config | native |
| | Mistral, xAI | needs conversion | config | native |
| Coding plans | Kimi Code, Z.ai Coding, MiniMax Coding, Alibaba Coding, StepFun Step Plan, OpenCode Go | direct | config (MiniMax: none) | native |
| Aggregators | OpenRouter, Novita | direct | config | native |
| | SiliconFlow, Fireworks, DeepInfra | none | config | native |
| | Together, Vercel AI Gateway | none | none | native |
| | Groq, Nvidia | needs conversion | config | native |
| Local | Ollama | direct | config | config |
| | LM Studio | none | config | native |

- **direct:** the profile starts Claude Code with `ANTHROPIC_BASE_URL`, the key in `ANTHROPIC_AUTH_TOKEN` and the provider's models mapped to `ANTHROPIC_MODEL` and the default haiku/sonnet/opus slots, the same way cc-switch's presets do. Third-party endpoints may lack some Claude Code features (web search, server-side tools). Every provider passes the conformance suite (§5.4) before it is offered, and missing features show in the profile.
- **config (Codex):** the profile's own `config.toml` (under its `CODEX_HOME`) gets a `[model_providers.<id>]` entry with the base URL and `env_key`. Codex speaks the Responses API, so a provider that only offers Chat Completions is offered only after it passes the conformance suite.
  - An OpenAI profile with an API key gets such an entry too, `openai-api-key` pointing at `https://api.openai.com/v1`. The reason: codex 0.147's app-server ignores `OPENAI_API_KEY` for its built-in `openai` provider, and it ignores a user entry named `openai`.
  - An OpenAI profile that signs in with ChatGPT stays on the built-in provider.
- **Model ids:** a profile stores the catalog's model id (models.dev's), never a runner's own spelling. OpenCode gets `{ providerID: <catalog provider id>, modelID: <catalog model id> }`. A typed `provider/model` is taken back to the catalog id when the profile is saved. An OpenCode provider marked `config` (Ollama) gets an inline provider block with its base URL and no key.
- **needs conversion:** not in v1. Those providers run through OpenCode, which speaks every catalog provider natively, or through Codex. A local format converter (like cc-switch's proxy or LiteLLM) is a later option and would need its own ADR.
- **Excluded on purpose:** the dozens of relays in cc-switch's presets that resell other providers' subscriptions. You can still add any endpoint yourself as a `custom` provider.
- **Refresh:** on start and every 24 hours, with ETag. Each snapshot is versioned by hash, every spend record stores the catalog version its price came from, and you can pin a version. Prices that differ from LiteLLM's table by more than 10% show up in diagnostics.
- **Balances and plan quota:**
  - Reported balance endpoints: DeepSeek, OpenRouter, Novita, StepFun, SiliconFlow.
  - Coding-plan quota for Kimi Code, Z.ai, MiniMax and OpenCode Go is read with the key from the endpoints cc-switch calls (checked against Z.ai's own plugin and Kimi's CLI on 2026-10-30; `packages/daemon/src/providers/plan-quota.ts`) and shows as Reported. None is documented by its provider, so a response we do not recognise or a failed read shows Unknown, never 0, and "no coding plan" shows as pay as you go. Background reads are opt-in on the Limits screen, with the endpoints listed next to the switch.
- **Adding a provider:** pick it from the catalog, paste the key (stored with DPAPI), run the probe (a free model-list call where the provider has one), then choose which runners may use it.
- **Key check and model discovery** (`packages/daemon/src/providers/key-check.ts`): when a key is added or replaced, and on `Check key`, one `GET …/models` per candidate URL (the OpenAI-compatible base, then the Anthropic-compatible base without its `/anthropic`, `/api/coding` or similar suffix; DashScope's `/apps/anthropic` lists under `/compatible-mode/v1/models`). 401/403 (Gemini: 400 with an invalid-key reason) marks the key invalid; a list that also answers without the key is public and leaves the key Unknown. Listed models the catalog lacks can be picked as a profile's model and for Claude Code's haiku, sonnet and opus slots. A profile whose model the last check did not list for its key is not proposed for crews.
  - Google's list still names models it refuses to new API users. For example, gemini-2.5-flash-lite answers 404 "no longer available to new users".
  - So for Gemini, each listed catalog model also gets one `countTokens` call. That call ran with a key that had no credit left, so it is not billed. A 404 leaves the model out of the key's list. `Check speed` is a warm-up plus one timed GET without the key (8 s timeout, slow above 6 s); it is shown only and never feeds handoff or fallback.
- **Profile presets:** a profile can carry a "when to use" note (80 characters, shown first in the crew proposal's reason, never sent to an agent), an effort level where the runner takes one (Claude Code on Anthropic through `CLAUDE_CODE_EFFORT_LEVEL`, Codex on OpenAI through `model_reasoning_effort`), and a read-only preset that keeps it to roles that never write.

## 7. Limits, usage and notifications

### 7.1 Sources and labels

| Label | Meaning | Examples |
|---|---|---|
| **Reported** | the agent or provider said it through an official channel | Codex `account/rateLimits/*`; balances from DeepSeek, OpenRouter, Novita, StepFun, SiliconFlow; coding-plan quota (Kimi Code, Z.ai, MiniMax, OpenCode Go); Anthropic's usage and cost reporting if you add an admin key (to be confirmed in M2) |
| **Estimated** | computed by us | tokens × catalog price (versioned) for every API key, times the provider's peak factor inside its peak hours (curated.json `peak`: DeepSeek bills twice the listed price on weekdays 01:00–04:00 and 06:00–10:00 UTC), plus the web searches and page fetches a provider's server runs and bills per request (curated.json `requests`: DeepSeek's Search and Fetch APIs, $0.75 per 1,000 each from 2026-11-01 00:00 Beijing time, counted from Claude Code's `modelUsage[*].webSearchRequests` and Codex's `webSearch` items; Claude Code's WebFetch and OpenCode's webfetch run locally and are never billed), context fill from token counts and the catalog's context limit |
| **Unknown** | no trustworthy source | Gemini CLI quota, Codex in API-key mode, absolute token caps behind percentages |

Every value shows its label and age. Unknown never becomes a percentage.

### 7.2 What is tracked per account and per run

- Subscription windows: 5-hour, weekly, model-specific weekly where reported.
- API keys: balance (where the provider has an endpoint), spend today and this task against caps.
- Per run: context window fill, tokens in/out/cache/reasoning, elapsed, estimated cost.

### 7.3 Notification rules

| Trigger | Default | Where |
|---|---|---|
| A window passes 80% | once per window; re-arms after reset or below 70% | sidebar meter turns amber, row banner, one Windows toast |
| **Ahead of pace**: at the current burn rate the window fills before it resets | once per run | banner: "At this pace Codex · work hits its limit in about 25 min, before the 16:40 reset." |
| A window passes 95% | once | toast marked critical, Inbox item |
| Limit reached (provider says rejected / limit reached) | always | run pauses at a turn boundary, Inbox item, toast with `Hand off` and `Wait for reset` |
| Context window above 80% | once per run | inspector meter, suggestion to compact or hand off |
| API budget cap reached | always | run pauses; never continues on a paid key without your click |

Toasts are deduplicated and batched (at most one per account per window state). Quiet hours and per-project mute are settings.

## 8. Fallback and handoff

### 8.1 Policy per task

- **Manual** (default): pause at a turn boundary and ask in the Inbox.
- **Ask**: same, but the Inbox item already names the proposed target with its headroom and estimate; one click continues.
- **Auto**: continue on the next target in the chain whose preflight passes, then tell you what happened. Another account of the same provider is never such a target; only §8.3 moves there.
- **Wait for reset**: if the same account resets within a set time (default 20 min), resume there at reset instead of switching. This is agent-orchestrator's auto-resume idea.

### 8.2 Handoff protocol (adapted from agent-orchestrator's durable handoff)

1. **Detect:** limit reached, budget cap, auth expired or the agent crashed.
2. **Preflight the target** while the source is still alive: installed, signed in, headroom above 20% on its windows, budget left, role permissions satisfied.
3. **Stop the source at a turn boundary.** If a tool call is in flight, wait for it or interrupt it; never replay a half-finished tool call.
4. **Checkpoint:** commit work in progress in the worktree as a local commit (`wip: handoff from <run>`). Nothing is pushed.
5. **Build the handoff package:** task goal and acceptance criteria, approved plan, completed steps, `git diff --stat` and the WIP commit, failing tests, open questions, the reason for the handoff, the transcript path. Stored under the task folder and shown in the UI.
6. **Start the target:** native resume if it is the same runner and account; a fork of the source session (compacted with the target model where the runner can) if it is the same runner and provider and the role has no independence rule; otherwise a new session in the same worktree with the package as its first message. The package is written in every case and is the fork's fallback. Cross-provider handoff never claims to carry hidden model state.
7. **Commit or roll back:** the handoff record flips only after the target confirms it read the package and `git status` matches. On failure the source run stays paused and you get an Inbox item.
8. **Report:** an event, a line in the task row, and a toast in Auto mode.

Hardening (ADR 0006): a manual handoff either interrupts the turn or drains it (lets it finish first). A completed handoff moves the step to a new epoch, so late events from the source change nothing and its requests are cancelled. An open handoff found at daemon start is closed with its phase, and the source, which still holds the step, asks you. A session with history is replaced only when the runner says it is gone or locked, and then by a fresh run fed the package.

### 8.3 Same-provider account switch ([ADR 0009](docs/adr/0009-same-provider-auto-switch.md))

- **Opt-in:** Settings → Fallback, off by default. Turning it on the first time shows the provider-terms note and records that you accepted it; the daemon refuses to turn it on before that. While it is on, every task may switch; you hold one task out in its crew proposal or from a switch in the Inbox. The global setting off wins.
- **When:** a limit reached, an empty prepaid credit, or the key's own daily or per-task cap. Never the task's budget (a second key does not make it bigger), a model without a price, a crash or a transient error. In Wait for reset mode a reset inside the task's wait still wins.
- **Whatever the mode:** the switch comes before the task's fallback mode. When no account passes, the mode decides as before (Manual and Ask list the other accounts to pick by hand; Auto moves only to another runner or provider).
- **Same provider:** the same runner and catalog provider, another account. An API key is one account however many profiles use it; a plan sign-in is its profile, which has its own config folder (D4). Local providers never switch.
- **Which account:** the step's standby chain first, then the other accounts by crew score. The first one that passes the preflight of §8.2 step 2 (signed in, more than 20% headroom with Unknown passing, its key under its caps, the task budget left, the role's rules and independence) takes over. Never a Claude subscription, only the same kind of account (plan sign-in for plan sign-in, API key for API key, so a plan never starts paying per token on its own), and never an account the step already left.
- **How:** the §8.2 handoff with mode `auto`, a fork of the session where the runner can. Each account keeps its own config folder and key; Crewyard never moves a sign-in or a key.
- **Records:** each switch is a row with what stopped the source, the target's headroom and the step's estimate there, each with its Reported, Estimated or Unknown label, and the accounts passed over with why. The Inbox lists it under "Switched accounts" until you dismiss it; the timeline shows it, and also a refusal when no account passed.

## 9. Crew proposal (role suggestion)

When you submit a task, the app proposes a crew; nothing starts until you approve.

1. **Classify the task** (cheap and local first: keywords, touched paths, task kind; optionally a small model through your cheapest key) into `code` / `research` / `review` / `docs` and size `S` / `M` / `L`.
2. **Pick role templates** for that class. Example for code M: Plan → Implement → Test ∥ Review → PR.
3. **Score candidates** for each role across every signed-in account:
   - capability fit: role needs vs runner capabilities (the reviewer must support read-only enforcement) and model data from the catalog (context window, reasoning, tool calls);
   - headroom on plan windows, preferring Reported over Estimated;
   - cost: catalog price × expected tokens for the task size, against the task budget;
   - history from our own event log: acceptance rate per runner × role × repo;
   - independence: the reviewer must use a different model, preferably a different provider, than the implementer;
   - your pins and exclusions.
4. **Explain** each choice in one line ("Strongest on C# changes here, 7 of 8 accepted") and show the headroom meter.
5. **Standby chain:** for every role, the next two candidates become its fallback chain (§8).
6. **Approve, edit or cancel.** Edits are remembered as preferences.

The first version is rule-based and deterministic; it learns only from your own accept/reject history. No hidden model calls happen without a configured key.

### 9.1 Roles

Roles are Markdown files with YAML front matter (`.crewyard/roles/*.md` in a repo, or global), so you can add your own.

| Role | Permissions (enforced by our approval layer, not by the prompt) | Output contract |
|---|---|---|
| Planner | read-only | plan with steps, acceptance criteria, risks |
| Implementer | write inside its worktree, run allowlisted commands | commits in the worktree, summary |
| Reviewer | read-only; may run tests | verdict (`pass` / `changes`), comments with file and line |
| Tester | run commands inside the worktree | results, benchmark numbers with environment |
| Researcher | read-only, web allowed | report with sources, no code changes |
| Docs | write only under doc paths | changed docs |
| Security | read-only | findings with severity and evidence |

A run cannot create other runs. If an agent asks for more work, the request becomes an Inbox item.

### 9.2 Crew loops (ADR 0006)

- **Run until green:** before an implementer of a code task finishes, the daemon runs the project's test command in its worktree; a failure goes back to the same session as the next turn.
- **Review loop:** a reviewer's `changes` verdict returns its comments to the same implementer session (native resume), then Test and Review run again.
- **Stop rules:** at most `loop.maxIterations` fix attempts per step (default 3), the spend caps, and stop when the worktree did not change since the last failing try. A stopped loop leaves the step failed and waiting for you.
- **Pinned review:** reviewers read a detached checkout of the exact head; the verdict is stored with that sha, and the merge gate passes only a pass verdict for the PR head. Codex reviewers use its own `review/start`; codex does not report that review's token usage, so the adapter reads it from the review subagent's rollout and adds it to the run's totals, while the review runs, so spend caps see it.
- **Records:** every decision is recorded with its reason and shown in the timeline and the crew graph.

### 9.3 Crew reports and MCP servers (ADR 0007)

- **Report server:** every run gets Crewyard's own stdio MCP server with `report` (checkpoint, needs input, stuck, done) and `propose_followup`. Reports show in the timeline; needs input, stuck and follow-ups are Inbox items. A follow-up becomes a task only when you click, and then only as a draft whose crew waits for your approval. The agent's text is untrusted data, capped and shown as text.
- **Your servers:** Settings → MCP servers holds stdio servers per project or for all projects, in Crewyard's database, never in the project folder. Secret env values go through DPAPI. Each run gets them through its runner's own config. Read-only roles get only the tools a server marks read-only, or what you chose for that server. Package runners with a floating tag (`npx pkg@latest`) or no exact version are flagged.
### 9.4 Best of N ([ADR 0008](docs/adr/0008-best-of-schedules-hibernation.md))

- A code task can run its implement step on 2 to 4 profiles at once (composer option). Each variant is a hidden task of its own with its own worktree, bootstrap and run-until-green loop; the proposal shows every variant's estimate and the group's total, and no variant may share a reviewer's model.
- The group starts all at once or not at all: N free slots and memory, and every paid estimate reserved against the parent's caps in one step. The parent's budget and per-task caps count every variant.
- When the variants finish, the Tasks screen and the inspector compare them side by side (files changed, tests in each worktree, loop verdict, spend). Keeping one, after a confirm, moves its worktree and session to the parent, where test, review and PR continue; the others are stopped and parked.

## 10. GitHub

- **Auth:** reuse the `gh` CLI login (token read at startup, kept in memory). No new token is stored.
- **Observer:** REST and GraphQL with ETag conditional requests, only for repos with active tasks, every 60 s while a task is in review, plus a manual refresh. No polling loops on CI.
- **PR flow:** a PR is created only after the review gate passes and you click. Merge needs every gate: tests passed, branch up to date, no open questions, your approval. Merge method follows the repo setting.
- **Feedback routing:** failing check summaries (with a job-log excerpt) and review comments are routed to the run that owns the branch, deduplicated, if you enable it for the project.
- **Pushes wait for you:** agents commit locally. GitHub → "Waiting to push" lists branches with commit counts and the workflows a push would trigger; one click pushes once.
- **Actions minutes guard:** shows minutes used this month and the Windows multiplier, when the token has billing access; otherwise Unknown.
- **Workflow check:** warns when a repo's workflows break your CI rules: `push` on all branches, no `concurrency` with `cancel-in-progress`, missing `timeout-minutes`, Windows/macOS runners on push, `schedule` in a private repo.
- **Worktrees:** one per code-writing run under `C:\Projeler\.crewyard\worktrees\<repo>\<task>`. Cleanup only after merge, only when clean with nothing unpushed and no live process, and only after you confirm.

## 11. Inbox: questions and approvals

- Every question and approval becomes a persisted `request` with source run, kind, payload, risk and timestamps. Answering from the Inbox, the inspector or a toast resolves the same record.
- **Risk classes:**
  - Low: read-only commands and allowlisted build/test commands inside the worktree.
  - Medium: network access, writes outside the worktree but inside the project.
  - High: destructive git (`reset --hard`, `push --force`, branch delete), anything outside the project, credential or `.env` paths, package installs.
- Toasts offer `Approve once` only for Low. Medium and High open the Inbox. `Always allow in this project` adds a scoped allowlist entry and is never the default button.
- An allowlist entry matches one command with plain arguments only. Anything with shell syntax (chaining, pipes, redirection, substitution, `%VAR%`, a newline) never matches, in the daemon's risk classes and in every runner's own rules (`matchesAllowlist`, `SHELL_SYNTAX` in `packages/core/src/risk.ts`), so `pnpm test && curl …` is never approved on `pnpm test`.
- Unanswered requests keep the run paused, never time out into an approval.
- **Turn control** ([ADR 0005](docs/adr/0005-turn-control.md)):
  - Messages typed while an agent works wait in the step's persisted queue, shown as queued, editable, reorderable and deletable; the next turn boundary takes them as one turn, or `Steer now` adds one to the running turn where the runner documents a way (Codex), otherwise the button is disabled with the reason.
  - `Undo last turn` puts the worktree back to the git checkpoint taken before the turn, after the runner's own rewind where it has one (Claude file checkpoints, Codex thread rollback, OpenCode revert). It shows every file it changes first, asks to confirm, and never runs while a turn does.
  - Stall alerts: a running turn quiet for N minutes, the same failure N runs in a row, or a request unanswered for N minutes becomes an Inbox item and a notice, with a cooldown; defaults in Settings.
  - At handoff and at run end the runner's own transcript is copied into the task folder, and the handoff package cites the copy.

- **Scheduled tasks** ([ADR 0008](docs/adr/0008-best-of-schedules-hibernation.md)): a task template proposes a task daily or weekly at a time in an IANA time zone, created disabled. An optional precheck command gates each run by its exit code; a skip costs nothing. A schedule never overlaps its own previous run, catches up at most 3 missed slots after sleep or a restart, and goes through crew approval unless its template says "auto-approve this crew" (audited). The timer lives in the daemon: nothing runs while the app is closed.
- **Hibernation** (ADR 0008): a live run idle for N minutes (Settings, on by default, 30, with an off switch) has its process stopped. Idle means no turn running and nothing of ours at work, or a turn held only by your unanswered question or approval; at a turn boundary with nothing queued a run already ends, so the waiting run is the one that matters.
  - Only runners whose resume by session id is proven (Claude Code, Codex, OpenCode); Gemini CLI and other ACP agents only when they reported `loadSession`. Otherwise the process stays up.
  - `hibernated` is its own state: never failed or stopped, no admission slot, its spend reservation kept, kept across a daemon restart. The timeline marks where it slept and woke.
  - Its Inbox item stays open and says the agent is hibernated and answering resumes it; an answer from a toast works the same. It wakes by session id on your answer, a message, or when its step continues, taking a slot again (it waits for one if none is free). A resume the runner refuses ends the run failed, and the usual retry or handoff follows.
  - The runner's pending call died with the process, so your answer goes to the session as text. An "allow once" grants the woken session's repeat of exactly that call: the same command text byte for byte except its ends, the same folder, paths and network flag, once, for that run, until the resumed turn ends or 15 minutes pass. A deny or cancel grants nothing (the deny reason goes to the agent as text); "allow always" keeps the project allowlist path, which never matches shell syntax.

### 11.1 First run and project setup

**Start screen** (shown when no project is open, and from the project switcher):

- **Actions:** `New project`, `Open folder`, `Clone from GitHub`.
- **Recent projects:** numbered tiles showing path, branch state, running agents, open questions and last opened. A last tile offers `Import from C:\Projeler`: it scans for git repositories that are not added yet. The scan root is a setting.
- **This machine** check, re-run on demand:
  - agent CLIs found and their conformance status;
  - git and `gh` sign-in;
  - Windows long paths enabled;
  - a Defender exclusion for the worktree folder, with steps shown and never applied silently.
- **Getting started** checklist until the first task finishes: agents detected, a plan account signed in, GitHub connected, a Claude Code API key added, a first task run with a suggested crew.

**New project wizard.** Five steps; nothing is written until `Create project`.

1. **Folder:** local folder, clone, or empty folder (`git init`).
   - Detection: git state, project type from marker files (for example `project.godot` + `*.csproj`, `package.json` + lockfile, `Cargo.toml`), suggested build and test commands, and the worktree location.
   - Path-length check: the longest worktree path must stay under 260 characters unless long paths are on.
2. **Agents:** which runners may work in this project. Only runners that passed conformance on this machine can be picked.
3. **Accounts and budget:** which profiles crew proposals may use here, plus a daily cap and a per-task cap for API keys.
4. **Rules:**
   - fallback default (Manual, Ask or Auto) and the number of slots;
   - commands allowed without asking, and network access (Ask by default);
   - which approvals may come from Windows notifications (low risk only).
5. **GitHub:**
   - remote: use the existing one or create a private repo through `gh`;
   - pushes wait for approval;
   - an optional CI workflow template that already follows your CI rules (ubuntu, `push` on `main` only, `concurrency` with `cancel-in-progress`, `timeout-minutes`, no `schedule`);
   - Actions-minutes warning at 80%.

The result is `.crewyard/project.json` in the repo: name, commands, allowed runners, profile ids, caps, rules, worktree path. It never contains keys or tokens. Secrets stay in the DPAPI store and profiles stay in `%APPDATA%\MissionControl`.

## 12. Windows specifics

- Resolve `.cmd` shims to real paths, spawn with `cross-spawn`, `windowsHide: true`, never `shell: true`.
- UTF-8 for all child IO; never depend on the console code page.
- Atomic writes with retry for every config file we create.
- Paths with spaces, long paths (`\\?\` prefix where needed), OneDrive-redirected folders.
- Signed installer and binaries; per-user install, no admin needed ([ADR 0004](docs/adr/0004-packaging-and-recovery.md), [ADR 0011](docs/adr/0011-signing-and-auto-update.md)):
  - `CREWYARD_SIGN=1` signs the exe, every dll, the installer and the uninstaller, with a PFX from environment variables or a certificate in the Windows store; the password never reaches a command line;
  - updates come from a generic HTTPS feed set at build time, are checked on your click (or by an opt-in automatic check), and install only on "Restart to install";
  - a signed build installs only updates that Windows verifies as signed by its publisher, and refuses when the check cannot run;
  - the licences of every bundled npm package and NOTICE ship next to the exe.
- Windows toasts with an AppUserModelID; tray; start with Windows as an opt-in.
- Keep the PC awake while runs are active, as an opt-in (Settings → Startup): Electron `powerSaveBlocker("prevent-app-suspension")` from the first active run to the last, released on battery at or below a threshold (default 30%) or with an unknown charge; its state shows in the status bar.
- Detect and refuse WSL paths for Windows-native runs; WSL support is out of scope for v1.
- Known risks to test: antivirus scanning slowing worktrees, Smart App Control blocking unsigned helpers, `node-pty` native build matching Electron.

## 13. Canonical states

**Facts per run:** `started_at`, `ended_at`, `end_reason` (`completed` / `failed` / `stopped` / `limit` / `interrupted`), `last_activity_at`, `pending_request_id`, `limit_state`, `handoff_id`. A hibernated run (`run_hibernation`) is open, not stopped, and holds no admission slot.

**Derived task status** (first match wins):

| Status | Rule |
|---|---|
| `proposed` | crew exists and is not approved |
| `failed` | a required run failed and no retry or handoff is pending |
| `needs_input` | any run has a pending request |
| `limited` | an active run hit a limit and no handoff is in progress |
| `handing_off` | a handoff record is open |
| `running` | any run is active |
| `queued` | approved, waiting for a slot |
| `review` | code task: implementation finished, PR not merged |
| `merged` | code task: PR merged |
| `done` | non-code task finished |
| `cancelled` | you stopped it |

Labels, colors and icons for each status are in DESIGN.md §5.

## 14. Milestones

Each milestone ends with: typecheck, lint with `--max-warnings=0`, tests, build, the contrast script, screenshots in both themes at 1280 and 1920 px, and a manual run on Windows 11.

| Milestone | Scope | Done when |
|---|---|---|
| **M0 Foundations** | monorepo, Electron shell (custom title bar, status bar, tray, single instance), daemon process, SQLite + event log + change feed, design tokens and primitives, Start screen with recent projects and the `C:\Projeler` import, New project wizard writing `.crewyard/project.json`, machine check (CLIs, git, `gh`, long paths), Tasks screen on real data | a project is created and reopened from the Start screen; restart keeps state; no console window flashes; empty states designed |
| **M1 One agent end to end** | Codex adapter (app-server), ChatGPT sign-in per profile, worktree per task, live steps, Inbox for questions and approvals, toasts, pause/stop/resume, diff view, limit meters and 80/95% notifications from `account/rateLimits/updated` | a task runs, asks for an approval, gets answered from a toast, finishes with a diff; two Codex accounts run side by side without sharing state |
| **M2 Claude Code, OpenCode, providers** | Claude adapter (Agent SDK) on Anthropic and Anthropic-compatible keys (DeepSeek, Kimi, GLM, Qwen, MiniMax), OpenCode adapter on catalog providers, catalog sync, Providers screen, DPAPI secrets, daily and per-task caps, balances, spend ledger, conformance suites per runner × provider, admission control | Claude Code runs the same task on Anthropic and on DeepSeek; three runners in parallel under the cap; a run stops at its budget cap and asks; killing the app leaves no agent processes |
| **M3 Crews, roles, fallback, graph** | role templates and enforcement, crew proposal and approval, deterministic DAG scheduler, standby chains, handoff protocol with Manual/Ask/Auto/Wait, ahead-of-pace warning, Gemini via ACP behind its conformance gate, Crew graph with list view | a limit hit mid-task hands off in Ask mode and in Auto mode, and the target continues in the same worktree |
| **M4 GitHub** | PR create, review gate, merge, check summaries and logs routed back, push queue, Actions minutes guard, workflow check, worktree cleanup | a task goes from proposal to merged PR with every outward step approved by you |
| **M5 Usage and polish** | Limits & usage full view, per-model ledger, timeline per task, keyboard map, compact density pass, 200% scaling pass | QA matrix in DESIGN.md §9 passes |
| **M6 Hardening** | crash and power-loss recovery, 20-run stress test, auto-update, signed installer, backup and export of the database. Signing and auto-update are built and tested end to end on this machine with a throwaway certificate and a local feed ([ADR 0011](docs/adr/0011-signing-and-auto-update.md)); a real certificate and a feed host are still to be chosen before the first release | a week of daily use without manual DB fixes; a signed release updates itself from the real feed |

## 15. Testing

- `packages/core`: unit tests for state derivation, policies, crew scoring and limit rules (pure functions, fast).
- Adapters: recorded-frame replay tests in CI; live conformance suite locally on Windows.
- App: Playwright for Electron with a fake adapter that scripts runs, questions and limits deterministically.
- Visual: screenshot regression on fixed fixtures.
- **CI follows your budget rules:** ubuntu runners, `push` only on `main`, other branches via `pull_request`, `concurrency` with `cancel-in-progress`, `timeout-minutes` on every job, Windows build only on tags or `workflow_dispatch`, no `schedule`. The Windows check that matters runs on your machine before each release.

## 16. Risks

| Risk | Mitigation |
|---|---|
| Agent CLIs change their protocols (vibe-kanban #2794, OpenCode V2 rename) | pinned versions, conformance gate, adapters isolated per package |
| ACP is young (v1 schema 1.27, v2 in alpha) | use it only for Gemini and the generic driver; keep native adapters for the other three |
| Provider terms on subscriptions | Claude on API keys only; ChatGPT and Google sign-ins only through the official CLIs; no token handling by us; same-provider auto-switch opt-in, off by default, behind a terms note (§8.3); OpenAI and Google terms checked before sharing |
| Claude on API keys costs money per token | daily and per-task caps, estimate shown in the crew proposal, paid fallbacks only inside the caps, cheaper Anthropic-compatible providers available to Claude Code |
| Anthropic-compatible endpoints differ in features and behaviour | conformance suite per runner × provider, missing features shown in the profile, nothing offered before it passes |
| Catalog data is wrong or changes | versioned snapshots, price cross-check against LiteLLM, pinning, the price version stored with every spend record |
| Too many parallel agents exhaust RAM | admission control (D7), measured per-agent memory, stress test in M6 |
| Estimated numbers mistaken for real ones | provenance label on every value, Unknown state, versioned price table |
| Windows antivirus and Smart App Control | signed binaries, per-user install, documented exclusions for the worktree folder |
| Scope creep toward 35 agents | four agents until M6; a fifth only through the generic ACP driver and its conformance suite |

## 17. Decisions log and open questions

**Decided**
- 2026-10-29: the app may be shared later, so Claude Code runs on API keys only, from the first build (§6). M1 starts with Codex, which has the richest reported limits; Claude Code moves to M2.
- 2026-10-29: runners and providers are separate (D9). Providers are not limited to the four vendors: the catalog (D10, §6.1) brings DeepSeek, Kimi, GLM, Qwen, MiniMax, MiMo, OpenRouter and others, with data from models.dev and cc-switch.
- 2026-10-30: other projects, whatever their license, are read only to learn how they work; Crewyard's code is our own and nothing is copied or ported (AGENTS.md, D1).
- 2026-10-30: automatic switching between accounts of the same provider exists, as an opt-in that is off by default. In the owner's words: "evet olsun kullanıcı isterse açık bıraksın ve otomatik geçiş olur" (yes, it should exist; if you want it, you leave it on and the switch happens automatically). Rules in §8.3, decision in [ADR 0009](docs/adr/0009-same-provider-auto-switch.md).
- 2026-10-30: the name is Crewyard everywhere (owner: "crewyard olsun her yerde"). The working name Mission Control is gone; a project's config moved from `.mission\project.json` to `.crewyard\project.json` and new worktrees go to `.crewyard\worktrees`. Configs in the old place are still read and move on the next save; existing worktree roots stay where their config puts them.
- 2026-10-30: the code is kept in a private GitHub repository, pushed when a piece of work is finished rather than after every step; releases come once everything is done. Windows stays first; Linux and macOS are prepared for but not shipped yet.
- 2026-10-30: signing and auto-update are prepared and tested before any release ([ADR 0011](docs/adr/0011-signing-and-auto-update.md)). The feed is electron-updater's generic HTTPS provider, its URL set at build time, so the host can be any static HTTPS server and the private code repository needs no token in the app. "Check automatically" is off by default; downloading and installing always wait for a click. A signed build refuses any update that is not signed by its publisher. Signing goes through our own hook, because electron-builder 26's signtool route puts the PFX password on a command line.
- 2026-10-30: the Crew graph hides React Flow's attribution link (`proOptions.hideAttribution`); React Flow is MIT and its licence notice ships with the app.

**Open**
1. Before the first release: which code-signing certificate (OV as a PFX, a hardware-bound one in the Windows store, or Azure Trusted Signing) and which HTTPS host serves the update feed (ADR 0011, "What a real release needs").
2. Before sharing: confirm OpenAI's and Google's terms for ChatGPT and Google sign-in through a third-party app (§6). The owner will check them (2026-10-30).
