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
| An LLM orchestrator spawns workers | Crewyard is the orchestrator: a deterministic scheduler runs a crew plan you approved. Orchestra (§9.8) adds an LLM-written plan of several tasks that you approve once; the daemon, not a model, decides what runs next | agent-orchestrator shows the cost of LLM-driven spawning: runaway workers (#3921), roles enforced only by prompts (#6842) |
| Loopback HTTP API | UI talks to the daemon over Electron IPC; external ingress only through a per-user named pipe with a token | A localhost port is reachable from any web page you open |
| Quota "if available" | Quota only from the agent's own reporting channel, labelled Reported / Estimated / Unknown | Calling undocumented usage endpoints with subscription tokens conflicts with provider credential rules (PRIOR_ART.md) |
| "completed" vs "merged" ambiguous | One canonical state model (§13) | |
| Five-repo research gate for every feature | Tiered gate (AGENTS.md) | Counting sources invites made-up research |

## 3. Key decisions

**D1. Build our own, use others as references.** No fork (reasons in PRIOR_ART.md). Ideas come mostly from agent-orchestrator (Apache-2.0) and vibe-kanban's executors (Apache-2.0). We read them to learn how they work and write our own code; nothing is copied or ported (AGENTS.md).

**D2. Electron + TypeScript end to end.**
- The Claude Agent SDK exists only for Node and Python; the OpenCode SDK and ACP client are TypeScript; the Codex app-server is JSON-RPC over stdio and is easy to drive from Node. A Rust (Tauri) or Go core would still need a Node sidecar for Claude.
- Electron gives Windows toasts with buttons (`toastXml`), tray, single-instance lock, auto-update and ConPTY via `node-pty` for the bottom panel's Terminal tab (`node-pty` 1.1.0, a Node-API addon with prebuilt binaries, so no rebuild against Electron; it runs in its own utility process and ships beside `app.asar`, [ADR 0016](docs/adr/0016-terminal.md)).
- Rejected: Tauri 2 + Node sidecar (two runtimes, sidecar bundling), Go daemon like agent-orchestrator (same problem), browser-only app (no tray, no toasts, ports exposed).

**D3. Native protocol per agent, one internal event model shaped like ACP.** Details in §5. A generic ACP driver covers Gemini and future agents.

**D4. An account is an isolated config folder.** Each account runs its CLI with its own `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME` or OpenCode data folder. Subscription sign-in (ChatGPT for Codex, Google for Gemini CLI) always happens through the CLI's own login flow. Claude never uses a claude.ai sign-in; each Claude profile gets an Anthropic API key from our secret store. Crewyard never reads, copies or relays subscription tokens, and never touches your default `~/.claude`, `~/.codex` or `~/.gemini`.

**D5. Store facts, derive status.** SQLite in WAL mode holds facts and an append-only event log. Display status is computed when read. A change feed pushes updates to the UI, and the UI can replay from a sequence number after a reconnect.

**D6. Small harness set behind conformance tests.** Four agents, pinned CLI versions, a recorded-transcript test suite per adapter. A new agent CLI version is accepted only after its suite passes.

**D7. Admission control from day one.** A run queue with a global cap, a per-account cap and a memory check. Nothing spawns without a free slot.

**D8. Nothing outward-facing happens without you.** Starting a crew, pushing, opening a PR, merging, deleting a worktree, spending past a budget and Ask-mode fallbacks all need an explicit click. Auto mode is opt-in per task and still writes an audit record. Two opt-ins may start a crew without a click, each audited: a schedule you set up (ADR 0008), and Autopilot (§9.7, [ADR 0017](docs/adr/0017-autopilot.md)), which approves crews of tasks it created only under the budget and rate limits you set per project.
- **Orchestra (§9.8, [ADR 0019](docs/adr/0019-orchestra-goals.md)):** `Plan goal` starts only a read-only planning run whose estimate and ceiling the composer shows; the first goal in a project shows what Orchestra does before that. `Approve and start` on the plan approves the crew of every task you accepted. A task that waits for others starts when they are done and merged into the goal's branch, which is checked out only in Crewyard's own worktree. A research result that a writing task builds on is passed on only after you accept it. A revised plan, a replan, an added task and spend past any cap need your click again.
- **Solo:** `Start` is the approval. The composer shows the profile, model and estimate before the click, and an Unknown estimate, or one a cap would hold, turns `Start` into `Propose`.
- Pushing, PRs, merging into your branches, deleting, spending past a cap and Inbox approvals stay with you in every mode, with Autopilot on or off.

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
  - On Linux and macOS (prepared, not shipped; [ADR 0010](docs/adr/0010-linux-macos-groundwork.md)) every child leads its own process group. Stop sends SIGTERM to the group and to each descendant, then SIGKILL after 2 s.
  - Without a tray (Linux), closing the window goes to the same quit confirm.
- **Ingress:** besides IPC there is one per-user local endpoint protected by a token, never a TCP port.
  - On Windows it is the named pipe `\\.\pipe\crewyard-<user-sid>`, restricted to the current user.
  - On Linux and macOS it is a Unix domain socket, 0600, in a 0700 folder of the user's own: `$XDG_RUNTIME_DIR/crewyard` on Linux, the per-user temp folder otherwise (ADR 0010).
  - It is used by Claude Code hooks (to observe sessions you started outside the app), by a small `mc` CLI, and by the report server every run gets.
  - The report server (ADR 0007) is a byte relay the runner starts, one ticket per run process, a random endpoint name per daemon start: Windows PowerShell 5.1 on Windows, the system Perl (`/usr/bin/perl`) elsewhere.
  - Only the report server is built so far.
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

Electron, React 19, TypeScript, Vite, TanStack Router and Query, Zustand, `@xyflow/react` (graph), TanStack Virtual (long lists), Radix primitives, lucide-react, `better-sqlite3` + drizzle, zod (event and adapter schemas), pino with redaction, `cross-spawn`, `node-pty` and `@xterm/xterm` (Terminal tab only, ADR 0016), electron-builder (signed NSIS installer), Vitest, Playwright for Electron. Add everything with `pnpm add -E` at setup time; this plan does not pin versions in advance.

### 4.3 Data model

| Table | Holds |
|---|---|
| `projects`, `repos` | local path, default branch, GitHub remote, per-project policies and allowlist |
| `providers`, `models` | catalog snapshot: provider id, group, endpoints, env names, balance/quota support; models with context, output, price, reasoning, open weights |
| `credentials` | alias, provider, kind (`api_key`, `plan_signin`, `local`), secret reference, daily and per-task caps |
| `profiles` | runner + provider + credential + default model + config folder; what crew proposals choose from |
| `crew_member_roles` | the role a crew member was proposed with when it came from a role file (§9.1); built-in roles live in code |
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
| `assistant_conversations`, `assistant_messages`, `assistant_drafts` | the task assistant (§9.6): one open conversation per project with its profile, native session and spend, its lines, and the drafts it proposed with their status and the task each became |
| `goals` | Orchestra (§9.8): project, your text verbatim, title, base branch and sha, budget, `max_parallel`, `max_tasks`, planner profile, the integration task (goal branch owner) or the task a one-task plan became, approved revision, paused, stopped, halted with reason, replans and revisions used |
| `goal_plans` | one row per plan revision: cause (`initial`, `revise`, `replan`, `add`), your note, the hidden planning task, the checked plan JSON, error, superseded and approved times; no status column, it is derived from the planning task's runs |
| `goal_tasks`, `goal_task_deps` | each goal task's plan key, position, mode, priority, basis quote and whether it matched, reason, planned paths, whether it writes, edited, accepted, discarded, released, joined sha and time, report accepted; the dependencies between them with their source (`plan`, `user`, `overlap`) |
| `goal_joins`, `goal_decisions` | each merge into the goal branch (sha before and after, `joined` or `conflict`, conflicted paths); decisions that wait for you (conflict, prerequisite, stop rule, stuck, changes, report, profile gone) with the answer |
| `events` | append-only: seq, at, project, task, run, kind, source, redacted payload, dedupe key |
| `agentfile_shares`, `agentfile_copies`, `agentfile_bridges` | your own agent files shared into profile folders (item, runner, one profile or all, scripts allowed), each copy's source and written hashes, and the per-project instruction bridge (§6.2) |

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

**Attachments.** `UserInput` and `StartRequest` carry `attachments` (images and files) next to the text, and `capabilities.attachments` says which kinds a runner takes. Each runner gets them through its own documented input:

| Runner | Images | Files (PDF, text) |
|---|---|---|
| Claude Code | `image` blocks (base64) in the streamed user message (agent-sdk/streaming-vs-single-mode) | `document` blocks: base64 for a PDF, a text source for text files |
| Codex | `localImage` items by path in `turn/start` and `turn/steer` | none documented: the file reaches it as a path in the text |
| OpenCode | `file` parts with a `file://` URL to our copy (`FilePartInput`, @opencode-ai/sdk 1.19.5) | same; text files as `text/plain`, which OpenCode reads through its Read tool |
| ACP (Gemini CLI) | an `image` block when initialize said `promptCapabilities.image` | an embedded `resource` when it said `embeddedContext`; otherwise a `resource_link`, which every agent must accept |

The daemon lists every attachment with the path of its copy in the turn's text, so a kind a runner cannot take still reaches it as a file to read (the way omux turns a pasted image into a path). Where a runner cannot take a kind, attaching that kind to its queue is disabled with the reason, and the crew proposal names the steps that will get a path instead.

### 5.2 Per agent (verified against official sources on 2026-10-29; OpenCode 2.x and the conformance fixes on 2026-10-31)

| | Claude Code | Codex | Gemini CLI | OpenCode |
|---|---|---|---|---|
| Transport | Agent SDK `query()` (TypeScript), runs the installed `claude` binary; `ANTHROPIC_BASE_URL` points it at Anthropic or an Anthropic-compatible provider | `codex app-server`, JSON-RPC over stdio | `gemini --acp` (ACP over stdio) | `opencode serve --hostname 127.0.0.1 --port 0`, HTTP + SSE, Basic auth as `opencode` with a random password per launch. Crewyard drives exactly 1.19.5 (`@opencode-ai/sdk` 1.19.5) and exactly 2.2.4 (`/api/...` routes, `OPENCODE_PASSWORD`, its own client; fake suite and live run 2026-10-31), chosen by the version read at probe; another 2.x is not offered to crews (docs/adr/0012) |
| Events | `SDKMessage` stream (assistant, result, tool, hook, task, `rate_limit_event`) | `turn/*`, `item/*`, `thread/tokenUsage/updated`, `turn/diff/updated`, `turn/plan/updated` | `session/update` (message, tool call, `usage_update`); ACP's `plan` update is mapped, but Gemini CLI 0.66.0 never sends one (`acpSession.ts`), so `capabilities.plan` is false and a view must say the plan is not reported, never show an empty one | 1.19.5: `GET /event`; 2.x: `GET /api/event`, turns end with `session.execution.*`. Live only; we re-read session state after reconnects |
| Questions | `AskUserQuestion` via `canUseTool` | `item/tool/requestUserInput` (experimental); 0.147 refuses it in Default mode unless the thread config sets `features.default_mode_request_user_input` (under development), which every thread does | `ask_user`; ACP mapping unverified, conformance test required | 1.19.5: `question.asked` + `/question/{id}/reply`; 2.x: forms, `/api/session/{id}/form/{id}/reply` with one value per field |
| Approvals | `canUseTool` allow/deny + `PreToolUse` hook | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` | `session/request_permission` | `permission.asked` → `once` / `always` / `reject`. Session rules: 1.19.5 `permission` list; 2.x an ordered `permissions` list of `{ action, resource, effect }` (`bash` is `shell`, `task` is `subagent`), last match wins in both |
| Interrupt, resume | `interrupt()`, `resume` / `forkSession` | `turn/interrupt`, `thread/resume` / `thread/fork` | `session/cancel`, `session/load` | 1.19.5 `POST /session/{id}/abort`, answered only after the turn's idle, so the server stays up until the answer arrives; 2.x `POST /api/session/{id}/interrupt`; sessions persist |
| Model switch | `setModel()` | per `turn/start` | `unstable_setSessionModel` | 1.19.5: per prompt; 2.x: `POST /api/session/{id}/model` |
| Usage | `usage`, `modelUsage`, `total_cost_usd` (local estimate) | `thread/tokenUsage/updated` incl. context window | tokens from `PromptResponse.usage` (unstable ACP; Gemini counts per prompt, we keep the session's running totals), the context window from `usage_update{used,size}`; until counts arrive only the window is reported, never zero tokens | per-session tokens and cost (2.x: `session.usage.updated`) |
| Subscription limits | **Not used**: Claude runs on API keys (§6); we track spend against caps and back off on API rate-limit errors (`Retry-After`) | **Reported**: `account/rateLimits/updated` (primary/secondary window, used %, resets at) | **Not exposed**: shown as Unknown | Only OpenCode's own plans; third-party providers via balance endpoints (§7.2) |
| Account folder | `CLAUDE_CONFIG_DIR` per profile for settings and history, `ANTHROPIC_API_KEY` from the secret store | `CODEX_HOME` (keyring entry keyed by folder hash) | `GEMINI_CLI_HOME` + `GEMINI_FORCE_FILE_STORAGE=true` (its OAuth keychain entry is otherwise shared) | `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` under the profile folder (proven on 1.19.5, 2026-10-30, and on 2.2.4, 2026-10-31) |
| Windows notes | native; no sandbox on native Windows | `windowsSandbox/*` readiness methods | PowerShell example for home override in docs | default service port differs on Windows; we always pass `--port 0` |

### 5.3 Internal event model

ACP's `session/update` kinds plus our own fields:

`message.delta`, `thought.delta`, `tool.call`, `tool.update`, `plan.update`, `diff.update`, `request.question`, `request.approval`, `usage.update`, `limit.update`, `run.state`, `run.ended`.

Every event carries `runId`, `seq`, `at`, `source` (adapter + CLI version) and a redacted payload. Adapters keep raw protocol frames in a rolling debug log, off by default.

Attachments never go into events: the bytes would blow past `MAX_EVENT_JSON` (`packages/core/src/event-caps.ts`). An upload (paste, drop, file picker, or a screenshot Crewyard takes itself) is checked by the daemon (PNG, JPEG, GIF or WebP by signature, up to 5 MB; PDF by signature or a text file whose content is text, up to 10 MB; 8 per task or message), written atomically to `<data>\attachments\staged\<id>\<name>`, and moved to `<data>\tasks\<task>\attachments\<id>\<name>` when the task is proposed or the message is queued. Events and audit entries carry only the ids; uploads nothing took are removed after a day, and deleting a queued message deletes its files. The handoff package lists the task's attachments and those of messages still queued, with their paths.

### 5.4 Conformance suite (per adapter, gate for every CLI upgrade)

Start a run in a temp repo, receive a plan and a tool call, approve once, deny once, answer a question, interrupt, resume, read usage, read limits, stop and confirm no process remains. Recorded frames replay in CI; the live suite runs locally on Windows before an agent version bump.

`pnpm conformance` (`packages/daemon/src/conformance`) runs these scenarios for free against the installed CLIs, through our own adapters. A scripted model server on `127.0.0.1`, port 0, inside the test process stands in for the provider. It speaks each runner's wire format: Responses for Codex (a `[model_providers]` block written by `writeCodexConfig`), Anthropic Messages for Claude Code (`ANTHROPIC_BASE_URL`), Chat Completions for OpenCode (its inline openai-compatible provider), and Gemini's `streamGenerateContent` for Gemini CLI (`GOOGLE_GEMINI_BASE_URL`, honoured since gemini-cli PR #25357). Each run writes a report and the requests each CLI sent, so a version bump that changes a tool name or a stream shows up as a named failure. The paid live suite stays for real provider behaviour.

First run, 2026-10-31, on Windows 11: of 44 scenarios, 36 passed, 4 did not apply and 4 failed. The failures, and what changed the same day:

- Codex 0.147.0, answer a question: `request_user_input` answered "unavailable in Default mode". Only Plan mode allows it, unless the `default_mode_request_user_input` feature is on (`request_user_input_available_modes`, codex-rs/tools/src/tool_config.rs at rust-v0.147.0). Plan mode also stops edits, so every thread now sets `features.default_mode_request_user_input` in its config. The feature is marked under development; with it codex still waits for the answer and sends `isBlocking: false`.
- OpenCode 1.19.5, interrupt: `interrupt()` rejected with `fetch failed (ECONNRESET)`. OpenCode answers `POST /session/{id}/abort` only after the turn's idle (handlers/session.ts and session/run-state.ts at v1.19.5), and the adapter closed the server on that idle. The server now stays up until the abort is answered, at most 5 s.
- Gemini CLI 0.66.0, plan: a known gap in the CLI. Its ACP session never sends a `plan` update (packages/cli/src/acp/acpSession.ts at v0.66.0, and on main); `write_todos` asks for approval and arrives as a plain tool call with no input. `capabilities.plan` is false for it, and the scenario reports `n/a`, turning into a failure once a plan arrives.
- Gemini CLI 0.66.0, read usage: tokens showed 0. Gemini sends its counts only in `PromptResponse.usage` (unstable in ACP), per prompt; `usage_update` has the context window alone. The ACP adapter now reads the response and keeps the session's running totals, also across resumed runs; until counts arrive, it reports the context window only.

Other notes from that run: a Codex interrupt ends the run `stopped` with detail `interrupted`, while the other adapters say `interrupted`; both count as resumable. Claude Code 2.1.314 passes everything; limits do not apply (API keys only), and its task tools are deferred behind ToolSearch, so a model loads `TaskCreate` before it can plan. Gemini CLI has no question tool to test.

Second run, 2026-10-31, after these changes: 39 pass, 5 `n/a`, no failures. Codex 0.147.0 11 of 11 pass; Claude Code 2.1.314 10 pass, 1 `n/a` (limits); OpenCode 1.19.5 10 pass, 1 `n/a` (limits); Gemini CLI 0.66.0 8 pass, 3 `n/a` (plan, a known CLI gap; question; limits).

Open, because it needs the orchestrator: the run view does not carry `capabilities.plan` yet, so the Inspector still hides the plan section for Gemini instead of saying it is not reported; and Gemini's running totals live in the daemon's memory, so a session resumed after a daemon restart counts from zero and its first report can count less than it spent.

## 6. Accounts and credentials

- **Claude is API-key only.** Anthropic's Agent SDK terms say third-party products may not offer claude.ai login or rate limits without Anthropic's approval. Because the app may be shared later, Claude profiles always use an Anthropic API key, from the first build. Several Claude profiles means several keys (for example one per Anthropic workspace), each with its own daily and per-task cap. If Anthropic ever approves claude.ai login for the app, it becomes a separate profile kind; nothing else changes.
- **Adding a subscription account (Codex, Gemini CLI, OpenCode providers):** Settings → Accounts → Add → choose runner → Crewyard creates `<data>\profiles\<runner>\<alias>\` (`<data>` is `%APPDATA%\Crewyard\data` on Windows; §12.1 for the others) and starts that CLI's own login with the profile env set (for Codex through the app-server's `account/login/start`). When the probe sees a signed-in state, the account is ready. Removing an account deletes only that folder, after confirmation.
- **Adding an API key:** stored encrypted with DPAPI (user scope) in `<data>\secrets\<credential id>.bin`; on Linux and macOS with Electron `safeStorage` (ADR 0010). Not Windows Credential Manager, which caps entries at about 2.5 KB (claude-swap #45). Keys reach child processes only through environment variables, never on a command line, never in logs (pino redaction + a secret scanner on debug logs).
- **Keys stay with the runner process, not the agent's commands.** Each runner gets only the one variable it reads the key from. Each runner's own mechanism then keeps that variable from the commands the agent runs (checked 2026-10-30, live run in the PR notes):
  - **Claude Code:** we set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (documented in code.claude.com/docs/en/env-vars). Claude Code then strips its Anthropic credentials and other credential-named variables from Bash commands, hooks and stdio MCP servers.
  - **Codex:** the profile's `config.toml` and every `thread/start` set `[shell_environment_policy] ignore_default_excludes = false`. That drops `*KEY*`, `*SECRET*` and `*TOKEN*`. `exclude` also names the key variables. codex 0.147 defaults to passing everything.
    - Codex logs each spawned command's environment at TRACE into `<profile>/logs_2.sqlite`, and 0.147 has no setting to lower that level. So the policy is also what keeps the key out of that file.
    - Logs written before this fix are deleted once per data folder.
    - Backups and exports copy only Crewyard's database, never profile folders.
  - **OpenCode:** it has no scrub setting. Its shell tool, `!` commands and terminal run with the server's environment plus whatever `shell.env` plugin hooks return. A plugin we write into the profile's config folder sets the key variables and the server password to empty there. A hook can only add or override, so the agent sees the name with an empty value.
    - 1.x plugins do not run in OpenCode 2.x. There the guard is a 2.x plugin on `ctx.shell.hook("create.before")`, named in the launch's inline config, and the adapter checks through `GET /api/plugin` that it is active before a run starts; a server without it runs nothing (docs/adr/0012). The live run on 2.2.4 (2026-10-31) showed the key and both password variables empty in the agent's shell commands; whether the hook also covers `!` commands typed in OpenCode's own UI and its terminals is not verified, and Crewyard drives neither.
  - **Gemini CLI:** `security.environmentVariableRedaction.enabled` in the profile's settings.json (Gemini CLI 0.24 and later) drops credential-named variables from its shell tool.
  - **Not covered:** a runner process necessarily holds its own key. An agent that can read that process's memory, or that runs a tool which talks to the provider through the runner, is outside what environment rules can stop.
- **What the UI shows:** alias, runner, plan label, last probe time, never a key or token.
- **Shared settings across accounts:** copied, not symlinked (symlinks need Developer Mode on Windows).
- **Your own agent files:** instruction files, skills and commands you wrote for any runner or for Cursor, Windsurf, Copilot or Cline reach a profile only as copies you chose, and a project's instruction file reaches the other runners only through the bridge you turn on (§6.2, [ADR 0015](docs/adr/0015-agent-files-and-skills.md)).
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
- **Refresh:** on start and every 24 hours, with ETag. Each snapshot is versioned by hash, every spend record stores the catalog version its price came from (`spend.catalog_version`), and you can pin a version. Prices that differ from LiteLLM's table by more than 10% show up in diagnostics.
  - **Pinning** (Providers → Versions): the stored versions are listed with hash, generated date, models.dev sha and origin. While one is pinned, the background refresh still downloads and stores new data but does not switch; estimates and new spend rows use the pinned hash, and the header says "Pinned", or "newer version downloaded" when one is waiting. Unpinning switches to the newest download. The served, pinned and newest versions are never pruned (`packages/daemon/src/providers/catalog.ts`).
  - **LiteLLM cross-check** (same dialog): BerriAI/litellm's `model_prices_and_context_window.json` (MIT; per-token USD, `litellm_provider`, `mode`) is fetched with the catalog refresh at most daily, or by hand, with ETag and a 30 s timeout. Only the chat entries of mapped providers are kept, converted to USD per million. Catalog providers map to LiteLLM providers through an explicit, tested table (`packages/daemon/src/providers/litellm.ts`); the China endpoints, Zhipu and coding plans stay out because they are priced differently. A model matches under `<prefix><id>` first, then the bare id, and only under the mapped provider. Input, output and cache-read prices more than 10% away from LiteLLM's (relative to LiteLLM's, strictly above; a LiteLLM zero is listed without a percentage) are listed against the active version. It never changes a price. A failed download shows Unknown, never zero differences.
- **Balances and plan quota:**
  - Reported balance endpoints: DeepSeek, OpenRouter, Novita, StepFun, SiliconFlow.
  - Coding-plan quota for Kimi Code, Z.ai, MiniMax and OpenCode Go is read with the key from the endpoints cc-switch calls (checked against Z.ai's own plugin and Kimi's CLI on 2026-10-30; `packages/daemon/src/providers/plan-quota.ts`) and shows as Reported. None is documented by its provider, so a response we do not recognise or a failed read shows Unknown, never 0, and "no coding plan" shows as pay as you go. Background reads are opt-in on the Limits screen, with the endpoints listed next to the switch.
- **Adding a provider:** pick it from the catalog, paste the key (stored with DPAPI), run the probe (a free model-list call where the provider has one), then choose which runners may use it.
- **Key check and model discovery** (`packages/daemon/src/providers/key-check.ts`): when a key is added or replaced, and on `Check key`, one `GET …/models` per candidate URL (the OpenAI-compatible base, then the Anthropic-compatible base without its `/anthropic`, `/api/coding` or similar suffix; DashScope's `/apps/anthropic` lists under `/compatible-mode/v1/models`). 401/403 (Gemini: 400 with an invalid-key reason) marks the key invalid; a list that also answers without the key is public and leaves the key Unknown. Listed models the catalog lacks can be picked as a profile's model and for Claude Code's haiku, sonnet and opus slots. A profile whose model the last check did not list for its key is not proposed for crews.
  - Google's list still names models it refuses to new API users. For example, gemini-2.5-flash-lite answers 404 "no longer available to new users".
  - So for Gemini, each listed catalog model also gets one `countTokens` call. That call ran with a key that had no credit left, so it is not billed. A 404 leaves the model out of the key's list. `Check speed` is a warm-up plus one timed GET without the key (8 s timeout, slow above 6 s); it is shown only and never feeds handoff or fallback.
- **Profile presets:** a profile can carry a "when to use" note (80 characters, shown first in the crew proposal's reason, never sent to an agent), an effort level where the runner takes one (Claude Code on Anthropic through `CLAUDE_CODE_EFFORT_LEVEL`, Codex on OpenAI through `model_reasoning_effort`), and a read-only preset that keeps it to roles that never write.

### 6.2 Instructions and skills ([ADR 0015](docs/adr/0015-agent-files-and-skills.md))

Every profile runs in its own config folder (D4), so your personal setup reaches a run only through Settings → Instructions and skills.

- **Discovery** reads an allowlist of locations under your home and in the open project: Claude Code (`CLAUDE.md`, `rules`, `skills`, `commands`, `agents`), Codex (`AGENTS.md`, `skills`, `prompts`, `agents`), Gemini CLI (`GEMINI.md`, `skills`, `commands`, `agents`), OpenCode (`AGENTS.md`, `skills`, `commands`, `agents`), the cross-tool `AGENTS.md` and `.agents/skills`, Cursor, Windsurf, Copilot and Cline rules. It never opens a credential, token, `.env*` or settings file, never follows a link, and caps sizes (256 KB a file; a skill 5 MB, 200 files, 4 levels). It writes nothing.
- **Sharing** copies an item you choose into the profiles you choose (one, or every profile of a runner), in that runner's own place and format: instruction files joined into the profile's memory file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`), skills as folders, commands as Markdown or Gemini CLI TOML. Subagents are never shared (runs have none), nor are commands for Codex (deprecated prompts that only its terminal UI expands). A copy loses `allowed-tools`, hooks, a model of its own and similar front matter; a skill with scripts or a command with shell snippets needs an explicit tick. A file Crewyard did not write is never overwritten. Each copy shows Up to date, Changed since the copy, Changed in the profile, Not copied or Original is gone, and only `Sync` copies again.
- **Bridge**, per project, off by default (Settings, or the New project wizard's Agents step): `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursorrules` and `.windsurfrules` reach the runners that do not read them, at each run start: Claude Code in its system prompt, Codex as `project_doc_fallback_filenames` (folders without AGENTS.md only), Gemini CLI as `context.fileName` in a per-run system-defaults file, OpenCode as `instructions` in its inline config. Nothing is written into the project.
- The crew proposal names, per step, the project files its runner reads, the bridged ones and what is shared into its profile.
- Found while checking (not fixed): Codex and OpenCode 2.x read `~/.agents/skills` from the real home whatever profile runs them, and Gemini CLI loads a project's `.env` into its own environment.

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

When you submit a task in Crew mode, the app proposes a crew; nothing starts until you approve. Orchestra, the composer's default, plans a goal into several such tasks first (§9.8); Solo starts one agent on your click.

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

### 9.0 Managing the crew in the Crew graph

The owner asked for it on 2026-10-31: "crew graph da daha fazla yönetim olsa" (more management in the Crew graph). Every change below is its own explicit action, never a side effect of moving a node, and the rules live once in `@crewyard/core` (`crew-edit.ts`): the renderer uses them to disable a control with its reason, the daemon (`orchestrator/crew-manage.ts`, IPC `crew.*`) applies them before it writes.

- **While the crew is a proposal:** add a step (any role of the project's role set, custom roles from `.crewyard/roles` included), remove one (whatever waited for it waits for its dependencies instead), change its role or its profile and model (from every candidate scored for the role, with reasons, estimate and headroom), draw or remove a `depends on` edge (drag from one step's right edge to another's left edge, the edge's remove button, or the step editor's checkboxes), and order the standby chain (drag, or Alt+Up/Down). Refused: a dependency that closes a loop (the loop is named by step numbers), a profile that puts a step on the model of a role it must stay independent of (both directions; the standby chain one way, as the proposal does), more than 12 steps or 4 standby. The worktree's write lease follows the role: a read-only role never gets it. The forecast is summed again after each edit. A changed profile counts as a preference, as on approval; role and dependency changes are not learned. Nothing starts until `Approve and start` (D8).
- **While it runs:** Retry a failed step (the same `runs.retry` as Check again), Skip a step that has not started (the confirm names what waits for it; those steps go on without its result, and a skipped step never runs), Pause all and Resume all (every open run, one by one, through the normal pause and resume), Hand off now and Wait for reset (they answer the same limit question the Inbox shows), open the step's Changes or Files tab in the inspector directly, and add a follow-up step after a finished one. A follow-up is a proposal edit of its own: it waits, dashed and marked `waits for your approval`, until `Approve new steps`; until then it can be edited or removed, and the steps already approved keep their place and profile.
- **Where:** a step that can still change opens the step editor beside the graph (inside full screen too); the crew bar above the graph holds the forecast, Add step and Approve and start, or Pause all, Resume all and the follow-ups waiting; the node menu (right-click, `Shift+F10`) has every action with the reason when it is off, and the list view opens the same menu and editor.

The first version is rule-based and deterministic; it learns only from your own accept/reject history. No hidden model calls happen without a configured key.

### 9.1 Roles

Roles are Markdown files with YAML front matter (`.crewyard/roles/*.md` in a repo, or global), so you can add your own. The seven built-ins below are the defaults.

| Role | Permissions (enforced by our approval layer, not by the prompt) | Output contract |
|---|---|---|
| Planner | read-only | plan with steps, acceptance criteria, risks |
| Implementer | write inside its worktree, run allowlisted commands | commits in the worktree, summary |
| Reviewer | read-only; may run tests | verdict (`pass` / `changes`), comments with file and line |
| Tester | run commands inside the worktree | results, benchmark numbers with environment |
| Researcher | read-only, web allowed | findings, schema-checked: a summary and findings with severity, file and line and a suggested task each (§9.6); no code changes |
| Docs | write only under doc paths | changed docs |
| Security | read-only | findings with severity and evidence |

**Role files.** The file name is the role id (lowercase letters, digits and dashes, up to 32 characters): `reviewer.md` overrides the built-in reviewer, `perf-check.md` adds a role. The front matter maps to the role template; the Markdown body is the agent-facing output contract, put in every prompt of the role. Example, `.crewyard/roles/perf-check.md`:

```markdown
---
title: Performance check        # required for a new role, at most 60 characters
policy:
  writes: none                  # none | docs (doc paths only) | worktree
  allowCommands: [pnpm bench]   # commands it may run without asking
  network: denied               # denied | ask | allowed
needsReadOnly: true             # must stay true when writes is none
prefersReasoning: false         # reasoning models score higher
independentOf: [implementer]    # never on the same model as these roles
tokenShare: 0.15                # share of the task's expected tokens, 0.01 to 1 (estimates only)
---
Benchmark numbers for the changed code paths before and after the change, with the machine and
command they ran on. Do not change any file.
```

- **Where.** Global files in `roles` under Crewyard's data folder (`%APPDATA%\Crewyard\data\roles`), then the project's `.crewyard\roles`. A repo file wins over a global one, which wins over the built-in. Every field is optional except `title` for a new role; a left-out field keeps the value of the role it overrides, and a new role starts read-only with no commands and no network. An override with an empty body keeps the contract it overrides.
- **Overrides only narrow.** A file that replaces a built-in or a global role may change its title, contract, `prefersReasoning` and `tokenShare`, and may only narrow the rest: no wider `writes` (none < docs < worktree) or `network` (denied < ask < allowed), no command the replaced role lacks, `needsReadOnly` stays on if it was on, and `independentOf` keeps every entry. To get a different policy, add a role under a new name.
- **The project's rules win.** A run gets the role's policy narrowed by `.crewyard/project.json`: a custom role keeps only the commands it lists that the project also allows (`rules.allowCommands` and the build and test commands), and the lower of its network and the project's. Built-ins and their overrides keep the built-in rules. Enforcement is the approval layer plus each runner's own engine (sandbox, permission mode or ruleset), never the prompt.
- **Fail closed.** A file that does not parse, uses an unknown field, has a wrong value, widens what it overrides, is over 16 KiB or has a contract over 4,000 characters is not used; the role it would have replaced stays in effect. At most 32 files per folder are read, in name order. Settings → Roles lists every role with its source and file, and every file that was not used with the reason. The front matter is read with js-yaml's safe loader (plain data only).
- **Crew templates.** The classifier templates use built-ins (and their overrides) only. A project opts custom roles in with `customRoles` in `.crewyard/project.json`; each entry adds one step to the templates of the listed task kinds and sizes, after the listed steps, and is left out of a template that lacks any of them:

  ```json
  "customRoles": [
    { "role": "perf-check", "kinds": ["code"], "sizes": ["M", "L"], "after": ["implementer"] }
  ]
  ```

  At most 8 entries; a bad entry drops the whole list (not the rest of the config) and Settings says why. The wizard has no field for it and keeps it as written. The opt-in lives in the project's rules rather than in the role file so that adding a file alone never changes who works on a task.
- **What runs is what you approved.** The proposal stores each file-defined role as it read it, and the crew runs with that copy; editing the file later affects only new proposals. The proposal names the file each such role came from.

A run cannot create other runs. If an agent asks for more work, the request becomes an Inbox item.

**Instruction files and skills are not permissions.** What a run reads from CLAUDE.md, AGENTS.md, GEMINI.md, rules, skills and commands, its own or shared or bridged (§6.2), is untrusted instruction text. It never changes a role's policy, the approval layer, the allowlist or the spend caps; copies Crewyard makes lose `allowed-tools`, hooks and a model of their own, and hooks and settings with commands are never imported.

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

### 9.5 Dev-server preview ([ADR 0013](docs/adr/0013-dev-server-preview.md))

- The inspector's Preview tab shows the web app a task serves: the worktree's bootstrap port (`CREWYARD_PORT`) and loopback URLs (`localhost`, `127.0.0.1`, `[::1]`) its runs printed in tool output. Nothing loads until you click `Load`.
- The page is a `WebContentsView` owned by main, in an in-memory partition of its own, sandboxed, with no preload and no way to Crewyard's IPC. Main checks every load, navigation and redirect against the task's ports, which it reads from the daemon itself; new windows, downloads, permission requests and device pickers are refused. Crewyard opens no listener.
- `Pick element` takes the clicked element's outer HTML (16 KB at most), selector, size and a fixed list of computed styles. You see it as text, add a note, and `Add to queue` puts it in the step's queue (ADR 0005) as quoted page data, never as instructions. A screenshot of the element waits for image attachments on `UserInput`.
- Unloading the page, switching task or closing the inspector never stops the dev server or the run.

### 9.6 Task assistant ([ADR 0014](docs/adr/0014-task-assistant.md))

- **What:** a terminal-style chat in the bottom panel's Assistant tab, on every project screen (`Assistant` beside the composer, `Ctrl Shift A`) with a read-only agent that turns what you describe into task drafts. A research request becomes a `research` draft whose questions are its acceptance criteria.
- **How:** one runner session per project, started through the profile's own adapter in the project folder, on a profile you pick (ready, read-only enforcement and MCP; the read-only preset, then the cheapest, is the default). It gets Crewyard's report server with `propose_task`, the read tools and none of your MCP servers. Drafts are checked and capped in core (`parseTaskDraft`), stored, and shown as editable cards. No model is called without that profile's configured key or sign-in.
- **Read tools ([ADR 0018](docs/adr/0018-assistant-read-tools.md)):** with Autopilot on or off, it can read the project's tasks, a task, its report and crew, its drafts, what waits in the Inbox, a task's events, spend and limits per key alias (each number labelled), profiles, project settings and roles, local git (no fetch), problems and your instruction files and skills; `edit_draft` and `discard_draft` change only its own open drafts. Results are cleaned, redacted and capped at 16 KB, 30 calls a minute; each call is a tool line worded in your language (`Read task: Fix login`, `Görevi okudu: Fix login`), and a ready-made task you picked stays yours. Crew runs never get these tools.
- **Nothing starts:** `Add as draft` calls `propose()`, so the task gets a crew proposal that waits for your approval like any other (D8). Unless you turn on Autopilot (§9.7), the assistant has no tool that creates a task or a run; it never writes a file.
- **Read-only:** the reviewer's policy with nothing allowed (`writes: none`, no commands, network denied), so each runner's engine is in its read-only mode; our layer denies every approval and cancels every question. Reads that need no approval still work.
- **Spend:** priced like runs, written to the key's ledger with no task, shown with its label (Estimated, Reported, Unknown, or Plan for a sign-in). The key's daily cap is checked before it starts, before each message goes and after each usage update; reaching it stops the assistant. It needs a free global slot and the minimum free memory, like a run, but takes no project slot.
- **Reports:** a finished research, review or docs task shows its result: the summary's first line on the row with `Open report`, the whole report in the inspector (the researcher's checked findings, a reviewer's verdict, a planner's plan, or the last run's final message), as capped text. Every researcher run ends with `ResearchFindings` (§9.1 output contracts): a summary and findings with severity, file and line and a suggested task. Each suggested task and each open `propose_followup` of the task is a draft card under the report; adding one goes through the crew approval like any other.
- **Ready-made tasks:** six local templates, no model call (review and comment, optimizations, bugs and problems, security issues, dependencies and licences, test coverage gaps), each a research task with the findings contract, in the composer's `Ready-made` and the assistant's drafts column. Up to three are put first for the project from local facts (test command, dependency manifest, commits in the last 14 days, a remote). `Suggest tasks for this project` asks the chosen profile once, its Estimated cost shown before the click.
- **Conversation:** while a turn runs, a live row at the end of the log says what it does (starting, thinking, the latest call) and for how long. Replies are text-only Markdown (no HTML, links never open) with Copy, Quote and `Make drafts from this` (a visible, priced message); tool calls fold into one line per burst. `Open task` on an added draft goes to the task on Tasks with the inspector on it.
- **Lifecycle:** the session stays open between messages and stops on `Stop and close`, `Stop` in the message box, `Esc` in the panel, `New conversation`, or after the hibernation setting's idle minutes. The conversation and drafts are kept; the next message resumes the native session where the runner can, otherwise starts a new one with the recent conversation quoted as data.

### 9.7 Autopilot ([ADR 0017](docs/adr/0017-autopilot.md))

- **What:** an opt-in mode of the task assistant, per project and off by default, that runs the task flow within limits you set: it creates tasks, edits ones that have not started, approves their crews under budget, queues messages to running steps, retries a failed step once, cancels its own tasks and marks a finished analysis done after reading its report.
- **Consent and limits:** turning it on the first time shows what it may do and what stays with you, and records the consent. Limits: per task ($1.00), per day ($5.00), tasks started and created per hour (4), concurrent tasks (2). Only your click changes them.
- **Reads:** `list_tasks` and `read_task` are the assistant's read tools (§9.6) and work with Autopilot off or stopped; reading one of its own reports with `read_task` or `read_report` is still recorded for `complete_task`, and neither read creates the report's suggested drafts.
- **Checks, per call, in the daemon:** on, consented, not killed, not halted; only tasks it created; an estimate that is known (never Unknown), under the per-task limit and, with today's committed spend, under the per-day limit; every chosen key under its own caps; the hourly and concurrency caps; then admission control (D7) like any crew. A created task quotes your own message verbatim as its basis and records its sources (reports, issues, files and agent output are data).
- **Stays with you:** push, PR, merge, deleting a worktree or branch, spend past any cap, Inbox approvals (Medium and High risk included), sign-in, and Autopilot's own settings. No tool exists for them; Autopilot sees them as "waiting on you" and waits.
- **Kill switch:** `Stop Autopilot` in the status bar and Settings refuses every call at once; it never stops running agents. Two failed steps with the same failure within 24 hours halt it in that project until you turn it on again.
- **Records:** every call, allowed or refused, is an `autopilot.*` event with its reason (timeline, Activity, the panel's Autopilot log); toasts are batched per project.

### 9.8 Orchestra: goals planned once, run in order ([ADR 0019](docs/adr/0019-orchestra-goals.md))

The owner asked for it on 2026-10-31: "orkestra olsun default ve kullanımı diğer popüler github repolarında nasıl yapıldığına da bak, yönetimi kolay olsun, yani önce araştır sonra en uygun şekilde ekle" (make Orchestra the default, look at how popular GitHub repos do it, make it easy to manage; research first, then add it in the most suitable way). About thirty tools were read first; the options and the sources that were re-opened and cited are in the ADR.

- **Three modes.** The composer's `How to run` control offers Orchestra, Crew and Solo.
  - It opens on **Orchestra** in every project with a profile that can plan (ready, read-only enforcement, structured output); otherwise on Crew, with Orchestra disabled and its reason.
  - It reopens on Orchestra or Crew, whichever you last submitted in that project. **Solo is never remembered**, so a later `Ctrl Enter` never starts a paid run you did not pick this time.
  - Ready-made analyses and imported issues always run as one Crew task. A goal that reads like one small change gets the hint "Looks like one small change" with `Use Crew`; nothing switches by itself.
  - **Solo** proposes a one-step crew and approves it in the same call (`tasks.start`); the step is the kind's main role, and code still runs until green. An Unknown estimate, or one a cap would hold, returns the proposal instead.
- **Planning.** `Plan goal · ~$x Estimated` starts one read-only planning run, a hidden research task with one step of the `goal-planner` role.
  - The role is outside the built-in role list and saved as the member's role snapshot; a role file with that name is refused. It gets no user MCP servers and no `propose_followup`.
  - Its own budget is min(project per-task cap, max(3 × estimate, $0.25)), the ceiling shown under the button. The estimate is a fixed heuristic of 80,000 input and 8,000 output tokens at the catalog price until measured runs correct it (§17, open items).
  - Before the first goal in a project, a card says what Orchestra does and what stays with you, and sets the project's default goal budget. Nothing is spent before you click `Plan goal` on it.
  - The result is a strict `GoalPlan`: a summary and 1 to 8 tasks (8 is every goal's cap; 12 is only the parser's absolute ceiling, and nothing in the app raises a goal above 8), each with key, title, kind, mode, size, description, acceptance criteria, the words of your goal it rests on, dependencies on earlier tasks only, up to 20 planned paths, a reason and a priority. Core `parseGoalPlan` cleans and caps every field and refuses rather than cuts; one corrective turn follows a refusal once D7 admission lets it start, and a second refusal fails the plan with the parser's words. A basis that does not match your words is shown as "Not tied to your words", not refused.
- **The plan review** replaces the crew proposal slot. Tasks are numbered tiles grouped by step; each shows its kind, Solo or Crew switch and estimate, and folds out its description, files, what it waits for, its budget share and its reason.
  - You can edit a task, draw or remove a "waits for" (a loop is refused and named), skip a task (the tasks that wait for it are skipped too) and `Revise` with a note to the planner. Edited tasks are kept on Revise. At most 5 revisions before approval, each a paid planning run with its price on the button.
  - Two tasks that could run at the same time and plan to change overlapping files are put in order automatically; `Run side by side anyway` removes that order. A writing task with no planned files goes after the other writing tasks.
  - The total sums the accepted tasks and the last review; Unknown is never summed into a number. The goal budget is prefilled (the project default, or the total rounded up × 1.5); `Approve` is disabled only when the budget does not cover the known total or a task with an Unknown estimate has no budget of its own.
  - `Approve and start n tasks` (`Ctrl Enter`) approves the revision once, idempotently. `Run as one task` turns the goal into one ordinary Crew task before approval, and a plan of one task becomes an ordinary task with no goal branch.
- **Running.** The goal scheduler runs at the start of every scheduling pass, each goal inside its own try/catch.
  - A task's crew stays unapproved until the scheduler releases it; `tasks.approve` refuses goal tasks. Release re-checks the crew; a profile that went away becomes a decision, never a substitute.
  - Ready tasks are released by priority, at most 2 at once per goal (1 to 4), and then go through D7 admission, the per-step budget hold, their share of the goal budget, key caps and the project daily cap like any task.
  - A writing prerequisite (code or docs) counts once it is merged into the goal branch. A research or review prerequisite that a writing task waits for counts once it is done and you pressed `Accept report`. A failed, cancelled or skipped prerequisite never counts: its dependents hold and a decision asks you.
  - Each goal task branches from the goal branch tip, and its prompt quotes the goal, its place in the plan, accepted reports it builds on, the commits of writing prerequisites and the planned files of siblings running beside it.
  - Two goal tasks failing the same way, or three failed goal tasks, halt the goal until you resume it. A goal with open tasks, none active and none releasable reads Stuck, with the chain named.
- **The goal branch.** A goal with a writing task gets a hidden integration task that owns a worktree on `crewyard/goal/<words>-<id6>`.
  - A writing task whose own gates passed is test-merged with `git merge-tree --write-tree` (Git 2.38 or newer) and, when clean, merged with `git merge --no-ff` in that worktree. Nothing is pushed.
  - A conflict names the files and offers `Send to the implementer` (a follow-up that re-runs Test and Review), `I will merge it myself` with `Check again`, or `Leave it out`.
  - When every accepted writing task has joined, the integration task's reviewer, the last review of all changes, runs pinned to the branch head. `pass` makes the goal Ready for review and opens the existing PR gate on that branch; `changes` raises a decision with `Replan` and never plans by itself.
  - Goal task branches stay out of the push queue; only the goal branch is offered for push and PR.
- **After approval.** `Pause goal` pauses running steps at their next turn boundary and starts no new goal run; `Stop goal…` names what it cancels and keeps worktrees and branches. `Add task` is a one-task revision with no planner call. `Replan` is a paid planning run, at most 3 per goal; done, running, released, joined and edited tasks are frozen. Every revision needs `Approve and start` again.
- **Where it shows.** A goal is a group row in the task list with its status, `n of m` and spend against its budget; its tasks count under the goal, never on their own under Needs you or Ready for review. The goal view puts what needs you first. Goal decisions have their own list in the Inbox. A goal toasts once when it first needs you, once when it is ready for a pull request and once when it halts or finishes; goal tasks raise no per-task done toast.
- **Switches.** Settings → Orchestra holds `Orchestra` (on by default; off hides it in the composer and refuses new goals, while approved goals keep running in their order) and `Pause all goals`, the global kill switch, also in the command palette. Pause and `Pause all goals` hold goal tasks, the last review and planning tasks, approved goals and goals still planning alike, keep a queued corrective turn waiting, and pause running steps, planning runs included, at their next turn boundary. While it is on, the status bar shows `Goals paused` with `Resume`; lifting it is your click.
- **Never:** a planner or goal task with a tool that creates a task, goal or run; a task started that is not accepted in an approved revision or whose prerequisites are not satisfied; a report passed to a writing task before you accept it; a limit stop counted as done; a replan, relaunch or cross-task retry on its own; a push, PR, merge into your branches or delete; spend past a share or cap; an approval carried from one task to another. Goal, plan, report and agent text are capped, cleaned, quoted and shown as plain text.
- **Later:** Autopilot and the task assistant creating and approving goals, a clarifying-questions round, tracking the files a task actually changes, running the test command on the merged branch, `Undo last merge`, a pooled goal budget, `Clean up goal…`, moving tasks into and out of goals, stacked per-task PRs, per-step crew edits on a plan tile before approval (`Edit crew` is not built), `Archive finished` for goals, `Raise the limit to 12 and retry` for a plan refused for too many tasks (the cap is fixed at 8 per goal today), and an admission check in `messages.followUp`, which today launches the conflict fix you send to the implementer, and PR feedback, without D7 (the planner's corrective turn already waits for admission).

## 10. GitHub

- **Auth:** reuse the `gh` CLI login (token read at startup, kept in memory). No new token is stored.
- **Observer:** REST and GraphQL with ETag conditional requests, only for repos with active tasks, every 60 s while a task is in review, plus a manual refresh and a refresh when the app window regains focus (at most once every 30 s; the watched projects and the open one if it has an open PR). No polling loops on CI.
- **PR flow:** a PR is created only after the review gate passes and you click. Merge needs every gate: tests passed, branch up to date, no open questions, your approval. Merge method follows the repo setting.
- **Feedback routing:** failing check summaries (with a job-log excerpt) and review comments are routed to the run that owns the branch, deduplicated, if you enable it for the project.
- **Send failing checks to the agent:** a button on the task's PR (GitHub screen and inspector), with or without routing. It reads the PR head's checks again, then for each failing GitHub Actions job the failed steps' log (same 5-logs-per-PR cap as routing), trimmed to its last 60 lines. One message goes into the owning step's queue (turn control): check name, job, failed step and link, the log in a fence it cannot close, marked as untrusted CI output. Other checks and commit statuses are listed with their links only. It is queued, never sent: an unfinished step takes it at its next turn boundary, a finished one when you click `Continue with the queued messages`; until then you can edit or delete it. Failures already sent for that head, by routing or an earlier click, are left out (by check run id, so a re-run that fails again is new), and routing never sends what you queued. The button is off with the reason when there is no open PR, its checks were not read, no run owns the branch, nothing failed, or everything already went.
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
- **Guide** (owner, 2026-10-31: "bunlardan bağımsız öğretici veya docs ve how it works", a tutorial or docs and how it works, independent of the other screens): a screen of its own, linked from Start as `New here? How it works`, last in the sidebar and on `G W`, that also opens without a project. It explains the flow of §9–§10 as numbered tiles that each open their screen, keeps its own Getting started list that stays after the first task (this machine can run tasks, a ready profile, a project open, a first task, a first approved crew, GitHub), each fact read from existing IPC and `Unknown` when a read fails, and covers the assistant, Autopilot, the bottom panel, fallback, limits and provenance, agent files, Crew graph editing and the keyboard, with a short FAQ. It describes only what exists (DESIGN.md §6).

**New project wizard.** Five steps; nothing is written until `Create project`.

1. **Folder:** local folder, clone, or empty folder (`git init`).
   - Detection: git state, project type from marker files (for example `project.godot` + `*.csproj`, `package.json` + lockfile, `Cargo.toml`), suggested build and test commands, and the worktree location.
   - Path-length check: the longest worktree path must stay under 260 characters unless long paths are on.
2. **Agents:** which runners may work in this project. Only runners that passed conformance on this machine can be picked. An option, off by default, offers the project's instruction files to every runner (§6.2).
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

The result is `.crewyard/project.json` in the repo: name, commands, allowed runners, profile ids, caps, rules, worktree path. It never contains keys or tokens. Secrets stay in the DPAPI store and profiles stay in Crewyard's own data folder (`%APPDATA%\Crewyard\data` on Windows).

Worktree setup and cleanup commands (the Worktrees step) run without a shell in the task worktree. They and the agent get `CREWYARD_REPO` (the main checkout), `CREWYARD_WORKTREE`, `CREWYARD_BRANCH` and, with a port range, `CREWYARD_PORT` plus the chosen variable.

`project.json` is never treated as missing just because Crewyard cannot read all of it, since a file that read as "no config" would be overwritten on the next save:
- A value this build does not know falls back and is listed in the wizard: `rules.fallback` to its default, an unknown runner is skipped, and security fields go to their most restrictive value (`rules.toastApprovals` to `none`, `rules.network` to `ask`, `github.pushNeedsApproval` stays true).
- Keys this build does not know survive a save.
- A higher `version` comes from a newer Crewyard. It is used as far as it is understood and never written, and the wizard and Settings say so.
- A file that cannot be used (not JSON, no version, a value that breaks its rule, a secret-like key) runs the project on the defaults with toast approvals off. The wizard shows the problem, and `Create project` asks before replacing it, keeping the old file as `project.json.bak`.

## 12. Windows specifics

- Resolve `.cmd` shims to real paths, spawn with `cross-spawn`, `windowsHide: true`, never `shell: true`.
- UTF-8 for all child IO; never depend on the console code page.
- Atomic writes with retry for every config file we create.
- Paths with spaces, long paths (`\\?\` prefix where needed), OneDrive-redirected folders.
- Signed installer and binaries; per-user install, no admin needed ([ADR 0004](docs/adr/0004-packaging-and-recovery.md), [ADR 0011](docs/adr/0011-signing-and-auto-update.md)):
  - `CREWYARD_SIGN=1` signs the exe, every dll, the installer and the uninstaller, with a PFX from environment variables or a certificate in the Windows store; the password never reaches a command line;
  - updates come from a generic HTTPS feed set at build time, are checked on your click (or by an opt-in automatic check), and install only on "Restart to install";
  - a signed build installs only updates that Windows verifies as signed by its publisher, and refuses when the check cannot run;
  - the licences of every bundled npm package and NOTICE ship next to the exe;
  - a packaged build quits at startup when started with `--remote-debugging-port` or `--remote-debugging-pipe`, so no DevTools listener opens; only a local update-test build with a test root keeps them.
- Windows toasts with an AppUserModelID; tray; start with Windows as an opt-in.
- Taskbar badge: the taskbar button carries an overlay with the number of open requests (approvals, questions and handoff decisions, the Inbox count) minus muted projects, with a screen-reader description, cleared at 0. A new request flashes the button (`flashFrame`) while the window is not in front, never for what was already waiting at start, and stops when the window gets focus. The flash follows toast suppression (notifications off, quiet hours, muted project); the count stays during quiet hours, like the tray dot. The overlay is drawn in code from the warning and ink tokens of the taskbar's theme. Electron hands Windows a 16 px icon clipped to a circle whatever size is passed, so it is drawn pixel-exact for 100% and Windows scales it at 150 and 200%. macOS shows the count as the Dock badge (unchecked on a Mac); Linux shows nothing.
- Open a folder from anywhere: `Crewyard.exe <folder>` (first start, and through `second-instance` while running: the second start parses its own argv and hands the folder over as `additionalData`), Explorer's "Open in Crewyard" on a folder or a folder background (written per user under `HKCU\Software\Classes\Directory\shell` and `Directory\Background\shell` by the installer's `nsis.include` script, removed on uninstall, kept across updates; the classic menu, so "Show more options" on Windows 11), and a folder dropped on the Start screen or the title bar. Every path goes through one check in the main process: Chromium and Electron switches in argv are skipped, relative paths resolve against the caller's folder, `C:"` (Windows' reading of `"C:\"`) is repaired, and the folder must exist; WSL, UNC and device paths are refused with a reason on the Start screen. A known project opens; an unknown folder opens New project at step 1 with the folder filled in, and nothing is written before Create project. The packaged-build refusal of remote debugging switches runs before any of this.
- Keep the PC awake while runs are active, as an opt-in (Settings → Startup): Electron `powerSaveBlocker("prevent-app-suspension")` from the first active run to the last, released on battery at or below a threshold (default 30%) or with an unknown charge; its state shows in the status bar.
- Detect and refuse WSL paths for Windows-native runs; WSL support is out of scope for v1.
- The inspector's Files tab reads a task worktree only through the daemon, confined to its root: a path with `..`, a drive, a UNC prefix, a `:` stream or a device name is refused by its text, and again after `realpath` when a junction or symlink leads outside (compared case-insensitively). Listings stop at 1,000 entries, text at 256 KB, images at 5 MB; it never writes.
- Known risks to test: antivirus scanning slowing worktrees, Smart App Control blocking unsigned helpers, `node-pty` native build matching Electron (1.1.0 is Node-API with prebuilds, so the same binary loads in every Electron; `pnpm package` checks it ships).

### 12.1 Linux and macOS (prepared, not shipped)

Windows comes first and behaves exactly as above. Every Windows-only call has a POSIX branch next to it ([ADR 0010](docs/adr/0010-linux-macos-groundwork.md)). Each helper takes the platform as an argument, so both branches run under test on Windows.

| Windows | Linux and macOS |
|---|---|
| `taskkill /T /F` | process group per child (`detached`), SIGTERM to the group and its descendants, SIGKILL after 2 s |
| `where.exe $PATH:`, `.exe` beats `.cmd` | in-process PATH search without the current folder, then each runner's install folders (`~/.local/bin`, `~/.opencode/bin`, Homebrew), because Dock and launcher starts get a short PATH |
| Windows system variables, compared without case | `HOME`, `PATH`, `TMPDIR`, `SHELL`, `LANG`, the D-Bus and display variables, exact case |
| DPAPI from the daemon (ADR 0002) | Electron `safeStorage` (Keychain, Secret Service or KWallet), called by the main process for the daemon; Chromium's `basic_text` fallback is refused |
| named pipe, PowerShell relay | Unix socket 0600 in a private 0700 folder, Perl relay |
| orphan check through CIM | the same rules through `ps`; kills only when the command line names the run |
| Defender, long paths | N/A: left out of the machine check |
| case twins | still refused: Crewyard compares project paths without case on every platform |
| tray, `toastXml` toasts, close-to-tray, Start with Windows | macOS: menu bar, plain notifications, Dock reopen, login item. Linux: plain notifications, no tray, so close asks to quit |
| NSIS per-user | unsigned dmg and zip (macOS), AppImage and deb (Linux); never built or published yet |

CI checks the POSIX branches on the existing ubuntu job. A macOS test workflow runs only by hand.

What still blocks a Linux or macOS release:

- conformance runs on real machines;
- orphan identity by working folder;
- icons;
- signing (macOS);
- the macOS title bar;
- a Linux tray and autostart;
- per-platform wording and default folders.

The full list is in the ADR.

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

**Derived goal status** (Orchestra, §9.8; first match wins). A plan revision is `planning` while its planning task has an unfinished run, `failed` when its error is set or that run ended without a result, and `ready` when its plan is set and it is neither superseded nor approved.

| Status | Rule |
|---|---|
| `stopped` | you stopped it |
| `needs_you` | the goal has no plan revision at all (reads as a failed plan, with Retry planning) |
| `planning` | the latest revision is planning |
| `finished` | the goal was run as one task |
| `needs_you` | with a reason, in this order: the latest revision failed or is ready, the goal is halted, a goal decision is open, a goal task or the last review needs input or hit a limit, one of them failed with no retry pending, a report waits to be accepted, no task is left to run (every accepted task cancelled or left out, or a goal branch with no writing task left), the last review was cancelled (stuck), or it is stuck (accepted unfinished tasks, none active, none releasable) |
| `paused` | you paused it (Pause goal, or Pause all goals) |
| `running` | a goal task is running, queued or handing off, the last review is busy, or an accepted task is not released yet |
| `finished` | Merged: the goal's integration task has a merged PR |
| `ready_for_review` | the goal has a branch, every accepted writing task joined it, and the last review passed on its head |
| `finished` | Done: a goal with no branch whose accepted tasks are all done |

A goal that is still planning reads `planning` even while `Pause all goals` holds its planning run; the status bar's `Goals paused` says why nothing moves.

A goal task keeps its own task status: a waiting goal task derives `proposed` but is shown as "Waits for …" under its goal, and a joined one stays `review` and reads "In goal branch".

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
- 2026-10-30: the code is kept in a private GitHub repository, pushed when a piece of work is finished rather than after every step; releases come once everything is done. Windows stays first; Linux and macOS are prepared for but not shipped yet (owner: "linux ve mac için hazırlıklar da yapabiliriz ama öncelik windows da"; the platform seams are in [ADR 0010](docs/adr/0010-linux-macos-groundwork.md) and §12.1).
- 2026-10-30: signing and auto-update are prepared and tested before any release ([ADR 0011](docs/adr/0011-signing-and-auto-update.md)). The feed is electron-updater's generic HTTPS provider, its URL set at build time, so the host can be any static HTTPS server and the private code repository needs no token in the app. "Check automatically" is off by default; downloading and installing always wait for a click. A signed build refuses any update that is not signed by its publisher. Signing goes through our own hook, because electron-builder 26's signtool route puts the PFX password on a command line.
- 2026-10-30: the Crew graph hides React Flow's attribution link (`proOptions.hideAttribution`); React Flow is MIT and its licence notice ships with the app.
- 2026-10-31: `project.json` is read tolerantly and written conservatively (§11.1): unknown values fall back (security fields fail closed), unknown keys survive saves, a newer version is read-only, and an invalid file is replaced only after asking, with a `.bak` copy. omux fixed the same class of bug in 0.6.1.
- 2026-10-31: your own agent files and other AI tools' rules and skills come into Crewyard (§6.2, [ADR 0015](docs/adr/0015-agent-files-and-skills.md)). In the owner's words: "kullanıcının kendi agent dosyaları, rules veya diğer AI'larda hazırlamış olduğu skills'ler veya benzeri şeyleri de ekle; diğer örnek aldığımız repoları da incele, varsa ekle, nasıl kullanıyorlarsa" (add the user's own agent files, rules and skills prepared in other AI tools, and similar things; look at the reference repos and add it the way they use it). Unlike agent-orchestrator and orca, which link the user's whole folder (hooks included) into every account, Crewyard copies only what you pick, per runner or profile, never links, strips granting front matter, needs a tick for scripts, and syncs only on your click. A project's instruction file reaches the other runners through each runner's own setting, off by default per project.
- 2026-10-31: role files (§9.1) are loaded from `.crewyard\roles` and the data folder's `roles`. An override may only narrow the role it replaces, a custom role never gets more than the project's rules allow, and custom roles join the crew templates only through `customRoles` in project.json, so a role file added to a repo cannot by itself change who works on a task. A proposal keeps a copy of each file-defined role, so a later edit to the file never changes an approved crew.
- 2026-10-31: a task assistant on the Tasks screen, in the owner's words: "tasks kısmında veya crew kısmında vs ai ile chat ile yönetmek olsa yani görevleri veya araştırılacak şeyleri ai ile de yapılandırabilsek terminal ile" (manage tasks through a chat with an AI on the Tasks or Crew screen, so tasks and things to research can be structured with AI too, in a terminal-style view). It runs as a read-only session of one of your runners rather than a direct provider call, only drafts tasks, and is the one panel that stops what it shows when closed (§9.6, [ADR 0014](docs/adr/0014-task-assistant.md)).
- 2026-10-31: finished analyses show their result, and findings become tasks. The owner, after "projeyi incele" ended as a review whose verdict nobody could see: "taska kısmında projeyi incele yazdım ve sonuç hiçbir şeyi değiştirmedi, arayüzde sadece done yazdı; bunun yerine task önerisi veya task açma gibi şeyler olmalı, ve hazır olarak projeyi incele ve yorumla, optimizasyon öner, sorunları bul, güvenlik sorunlarını bul gibi hazır tasklar olsa veya projeye göre otomatik oluşturulsa; yeni ekleyeceğimiz şeyde onlar olsun" (I typed "review the project" in Tasks and the result changed nothing, the UI only said done; instead there should be task suggestions or opening tasks, and ready-made tasks like review and comment on the project, suggest optimizations, find problems, find security issues, or ones generated for the project; put them in the new feature). Researchers now end with checked findings, reports show on the row and in the inspector, suggested tasks are draft cards, and six ready-made analyses come as local templates ranked by local facts (§9.6, ADR 0014 addendum).
- 2026-10-31: the owner asked for a release before the open items below were settled ("tüm projeyi bitir ve merge ve push et ve release yayınla": finish the project, merge, push and publish a release). v0.1.0 is therefore a GitHub pre-release in the private repository: an unsigned NSIS installer built without an update feed, so SmartScreen names an unknown publisher and the app never looks for updates. Open item 1 still decides the certificate and the feed host; the first release that has both is the first signed one, and v0.1.0 installs cannot update to it on their own.
- 2026-10-31: the task assistant reads almost everything. The owner asked: "drafts ve mesajlar kısmında agent kısmı ve asistana çok daha fazla tool ekle erişebilsin hemen hemen her şeye" (give the agent and the assistant in the drafts and messages part many more tools so it can reach almost everything). It got fifteen narrow tools on its report server: thirteen reads (tasks, a task, report, crew, drafts, Inbox, events, spend and limits, profiles, project, local git, problems, agent files) and edit and discard of its own open drafts, all working with Autopilot off. Nothing it reads can start work; that stays with you or with Autopilot's checked tools (§9.6, [ADR 0018](docs/adr/0018-assistant-read-tools.md)).
- 2026-10-31: one bottom panel with tabs. The owner asked: "ai chat, terminal, etkinlik ve hatalar gibi bir panel var mı, toplu şekilde gösterilen tabs'lı" (is there one panel with tabs that shows AI chat, terminal, activity and errors together?). The Activity drawer grew into it, with `Assistant` (the task assistant, now on every project screen, its rules unchanged), `Terminal` (your own shell through ConPTY, never started on its own, never given a key; [ADR 0016](docs/adr/0016-terminal.md)), `Events`, `Logs` and `Problems` (every failure of the project in one list, each with the way to its fix, dismissable until its cause changes or comes back). Closing the panel stops nothing; a terminal's own close ends its shell and asks first.
- 2026-10-31: Autopilot (§9.7, [ADR 0017](docs/adr/0017-autopilot.md)). In the owner's words: "şimdi ai ile görev açıp görevleri düzenleyip tamamlayabilir miyim, yani kendim bir şey yapmasam bile ai ile yönetebilir miyim" (can I now open, edit and complete tasks with AI, so that I can manage everything through it even when I do nothing myself?). It is per project and off by default, acts only on tasks it created, approves crews only under the budget and rate limits you set, and has no tool for anything outward-facing: push, PR, merge, deletes, spend past a cap and Inbox approvals stay with you (D8 amended).
- 2026-10-31: the bottom panel collapses instead of closing. The owner: "assistant paneli açılır kapanır butonu var ama onu daha iyi yapmak için toggle olarak sol ve sağ paneldeki gibi üstte buton olsun ve tam kapanmasın ona basınca" (the assistant panel has an open/close button; make it a toggle at the top like the left and right panels have, and pressing it should not close the panel completely). Its ✕ became a collapse toggle at the right end of its head; inside a project the panel is either expanded or a 36 px strip with its tabs and counts, collapsed by default. `Ctrl J`, the status bar item, the tab shortcuts and a drag under 96 px expand and collapse it. Collapsing stops nothing, the task assistant included: only its own `Stop and close` (and `Esc` inside it) stops it ([ADR 0014](docs/adr/0014-task-assistant.md) update).

- 2026-11-01: Orchestra is the default mode (§9.8, [ADR 0019](docs/adr/0019-orchestra-goals.md)). In the owner's words: "orkestra olsun default ve kullanımı diğer popüler github repolarında nasıl yapıldığına da bak, yönetimi kolay olsun, yani önce araştır sonra en uygun şekilde ekle" (make Orchestra the default, look at how popular GitHub repos do it, make it easy to manage; research first, then add it in the most suitable way). After reading about thirty tools, Crewyard lets a read-only planner write a goal's plan once and lets the daemon, not a model, run it: one approval per plan, tasks in dependency order at most 2 at once, overlapping files ordered automatically, finished work merged into one goal branch in Crewyard's own worktree, a last review pinned to its head, and one pull request that you open. Crew stays one click away and Solo starts one agent on your click. D8 and DESIGN.md principle 6 are amended; Settings → Orchestra turns new goals off, and `Pause all goals` holds every goal at once.

**Open**
1. Before the first release: which code-signing certificate (OV as a PFX, a hardware-bound one in the Windows store, or Azure Trusted Signing) and which HTTPS host serves the update feed (ADR 0011, "What a real release needs").
2. Before sharing: confirm OpenAI's and Google's terms for ChatGPT and Google sign-in through a third-party app (§6). The owner will check them (2026-10-30).
3. Before the first release: correct Orchestra's planning estimate (a fixed 80,000 input and 8,000 output tokens, §9.8) from real planning runs; the live flow `goal` (`packages/daemon/src/live/flows.live.ts`) records them next to the heuristic.
