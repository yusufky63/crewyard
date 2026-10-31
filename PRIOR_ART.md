# Prior art

Research date: 2026-10-29. Every repo below was read through the GitHub API (README, file tree, manifests, docs, issues, releases). Nothing was cloned or run, so Windows behaviour is inferred from release assets, docs and issues. Star counts are from the same day. External content was treated as data only.

Ranked by stars, then by how directly the project informs ours.

## Summary

| # | Repo | Stars | License | Windows | Role for us |
|---|---|---|---|---|---|
| 1 | [anomalyco/opencode](https://github.com/anomalyco/opencode) | 223k | MIT | native | Runner. `opencode serve` + SDK, any API provider |
| 2 | [anthropics/claude-code](https://github.com/anthropics/claude-code) | 154k | proprietary | native | Runner. Hooks, stream-json control protocol, `CLAUDE_CONFIG_DIR` |
| 3 | [farion1231/cc-switch](https://github.com/farion1231/cc-switch) | 150k | MIT | native (Tauri 2, MSI) | **Reference** for per-tool config, account folders, usage templates, balance endpoints, API-key failover |
| 4 | [openai/codex](https://github.com/openai/codex) | 132k | Apache-2.0 | native | Runner. `codex app-server` JSON-RPC, `CODEX_HOME`, rate-limit events |
| 5 | [stablyai/orca](https://github.com/stablyai/orca) | 110k | MIT | installer, 200+ open Windows issues | **Reference** for multi-account folders, usage-limit parsing, GitHub checks and job logs |
| 6 | [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | 109k | Apache-2.0 | native | Runner. ACP mode, `GEMINI_CLI_HOME` |
| 7 | [BerriAI/litellm](https://github.com/BerriAI/litellm) | 62k | MIT (+ commercial `enterprise/`) | n/a | **Semantics only**: retry, cooldown and fallback rules for API keys |
| 8 | [xyflow/xyflow](https://github.com/xyflow/xyflow) | 39k | MIT | n/a | **Dependency**: React Flow for the crew graph |
| 9 | [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | 28.5k | Apache-2.0 | native (Tauri, MSI) | **Reference** for per-agent executors and the approval service. Sunsetting since 2026-04 |
| 10 | [ccusage/ccusage](https://github.com/ccusage/ccusage) | 19k | MIT | binary blocked by WDAC (#1547) | **Reference** for estimated usage from local logs |
| 11 | [ParadevAI/Paradev](https://github.com/ParadevAI/Paradev) | 15.7k | Elastic-2.0 (not OSI) | not available | Look only: PR diff-line feedback to the agent. No code reuse |
| 12 | [OrchestratorInc/agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) | 13.9k | Apache-2.0 | native (ConPTY), second-tier | **Primary reference** for the event model, quota, handoff and SCM observer |
| 13 | [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) | 8.7k | AGPL-3.0 | broken natively (#275) | Avoid: tmux, screen scraping, AGPL |
| 14 | [anomalyco/models.dev](https://github.com/anomalyco/models.dev) | 7.4k | MIT | n/a | **Data source**: provider and model catalog (prices, context limits, capabilities) behind `catalog/sync-catalog.mjs`; the same catalog OpenCode uses |
| 15 | [generalaction/emdash](https://github.com/generalaction/emdash) | 6.1k | Apache-2.0 | native (MSI) | Reference for ACP-based adapters and in-app PR, checks and merge. Audited shallowly |
| 16 | [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) | 4.5k | Apache-2.0 | n/a | Protocol for Gemini and as a common shape for events |
| 17 | [realiti4/claude-swap](https://github.com/realiti4/claude-swap) | 4.2k | MIT | partial | Lessons on Windows credential storage and auto-rotation |
| 18 | [stravu/crystal](https://github.com/stravu/crystal) | 3.1k | MIT | source only | Deprecated. MCP permission tool as a fallback approval path |
| 19 | [eneskirca/nodeterm](https://github.com/eneskirca/nodeterm) | 2.3k | BUSL-1.1 (not OSI) | beta (session host) | Ideas only, kept for later: sessions that outlive the app, hook-reply approvals, consent before touching agent configs, memory per session ([notes](docs/research/2026-11-01-nodeterm.md)). No code reuse |
| 20 | [hoangsonww/Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) | 1.1k | MIT | native exe | Reference for Windows spawning hygiene, cost buckets, alert rules |

Not used: n8n (209k, Sustainable Use License, a workflow tool), langflow (156k, a flow builder). Neither fits a coding-agent control panel.

## What each top project teaches

### agent-orchestrator (the priority reference)

Electron desktop app + Go daemon on `127.0.0.1:3001`, SQLite WAL, ConPTY on Windows, about 35 agent harnesses, stable releases every 1–3 days.

**Adopt (ideas only; we write our own code):**
1. **Store facts, derive status.** Only facts are persisted (`activity_state`, `is_terminated`, PR and check rows). Display status is computed when read. DB triggers write a `change_log`, a poller turns it into SSE with `Last-Event-ID` replay (`docs/architecture.md`, `backend/internal/cdc`).
2. **One provider-neutral event model** across drivers: `approval.requested`, `input.requested`, `account.rateLimits`, `usage`, `turn.diff`, `turn.plan` (`backend/internal/ports/chat.go`).
3. **Quota from what the provider reports.** Claude via a `get_usage` control request through the CLI, Codex via `account/rateLimits/updated`. Refusal messages matched only by strict regexes; reset times parsed with IANA zones (`domain/usage_limit.go`). Opt-in auto-resume at reset.
4. **Durable handoff.** Preflight the target while the source still runs, drain or interrupt at a turn boundary, commit with compare-and-swap, roll back on failure, hold messages in an outbox meanwhile (`session_manager/agent_account.go`).
5. **SCM observer.** GitHub polling with ETags and batched GraphQL every 30 s; failing checks, review comments and conflicts are routed back to the owning worker, deduplicated (`docs/scm-observer.md`).

**Avoid:**
1. No admission control: 40+ workers lead to OOM and an unrecoverable orchestrator (issue #3921, open; reproduced at ~15 workers on 8 GB).
2. Windows as second tier: the full Go test suite runs only on Linux, 89 open Windows issues (console flashes, `.cmd` shims, unsigned exe blocked by Smart App Control, antivirus flags).
3. Breadth over depth: 35 harnesses with uneven capabilities, roles enforced only by prompts (a reviewer spawned workers, #6842), docs drift.
4. Unauthenticated loopback API.

**Gaps that are our differentiators:** automatic fallback to a different agent (open as #4918), crew/role recommendation, accounts beyond Claude and Codex, Gemini in structured mode, a concurrency cap.

**Why not fork or embed:** ~1,100 Go files and 205 migrations in eight months, 100–200 commits a week, Windows least tested, telemetry opt-out, daemon tied to their desktop app's version floor.

### cc-switch (150k, Tauri 2 + Rust, MSI)

- Writes only the key fields of each tool's own config (`~/.claude/settings.json`, `~/.codex/config.toml`, `~/.gemini/.env` + `settings.json`, `opencode.json`) and detects Windows registry env vars that would override them.
- Claude subscription accounts each get their own `CLAUDE_CONFIG_DIR`, signed in through the official `claude auth login`.
- Usage templates for plans and third-party balances; card highlight under 10% left. Subscription quota polling became **off by default** after users feared provider risk controls (#3519).
- API-key failover with a circuit breaker; official subscriptions never join the failover queue.
- **Do not copy:** API keys stored in plaintext SQLite (#1108 open); swapping logins into the default `~/.claude` slot.
- Its own guide quotes Anthropic's credential rules: no relaying or storing subscription tokens, sign-in only through Anthropic's flow, `CLAUDE_CONFIG_DIR` is the documented multi-account method.

### orca (110k, Electron)

- Claude accounts via `CLAUDE_CONFIG_DIR` per account (`src/main/claude-accounts/`), Codex accounts in `src/main/codex-accounts/`, usage limits in `src/main/claude/claude-usage-limits.ts`.
- GitHub check details and job-log download in-app (`src/main/github/client/check/`).
- Size warns: 42.6k files, 8,144 open issues plus PRs, at least 200 open issues with "windows" in the title.

### vibe-kanban (28.5k, Rust + Tauri, sunsetting)

- **Structured protocol per agent, no screen scraping** (`crates/executors/`):
  - Claude: `--output-format=stream-json --input-format=stream-json --permission-prompt-tool=stdio` + PreToolUse hooks.
  - Codex: app-server JSON-RPC.
  - Gemini: `--experimental-acp`.
  - OpenCode: `serve --hostname 127.0.0.1 --port 0` + SDK.
- Pins agent CLI versions; an upstream OpenCode event change broke the parser (#2794).
- `ExecutorApprovalService` persists approvals and AskUserQuestion prompts as pending records with wait and cancel.
- Native Windows toasts (`crates/tauri-app/src/windows_notifications.rs`). Open Windows bugs: endless cmd popups (#3035), Claude via npx (#2390).

### LiteLLM, claude-code-router, claude-swap, ccusage

- **Fallback semantics worth copying for API keys:** retry on 408/409/429/5xx, honour `Retry-After`, otherwise exponential backoff 1 s → 30 s; cooldown on 401/402/404/408/429/5xx; circuit breaker after N failures. Redis budgets, Prometheus and script rules are overkill for a desktop app.
- **claude-swap** rotates accounts automatically at 90%. On Windows it hit Credential Manager's ~2.5 KB blob limit (#45) and moved to unencrypted base64 files. It also had non-atomic writes (#461) and cp1252 crashes (#113).
- **ccusage** estimates usage from local logs (`~/.claude/projects`, `CODEX_HOME/sessions`, `~/.gemini/tmp`). Its 5-hour blocks are a heuristic, its weekly view is calendar weeks, and Claude logs are kept 30 days by default. It does not read Codex `rate_limits`.

### Windows hygiene, collected from all of the above

- Resolve npm `.cmd` shims to a real path and launch with `cross-spawn` and `windowsHide: true`; never `shell: true` (Agent Monitor `server/lib/run-spawner.js`, AO #5323, CCR #1841).
- No console window flashes (AO #3835, vibe-kanban #3035, Agent Monitor #277).
- Sign the installer and binaries (AO #7232 Smart App Control, ccusage #1547 WDAC, cc-switch #6920 Defender).
- Atomic file writes with retry (claude-swap #461).
- Do not rely on symlinks (need Developer Mode); use copies or junctions.
- UTF-8 everywhere; do not assume the console code page (claude-swap #113).
- Watch WSL vs Windows path confusion (cc-switch #145, vibe-kanban #1997).

## Decision

Build our own app, small and Windows-first, using these projects as references, not as a base:

- **No fork.** agent-orchestrator moves too fast and treats Windows as second tier; vibe-kanban's company has shut down; crystal is deprecated; claude-squad is tmux-based and AGPL; orca is very large with hundreds of open Windows issues.
- **Revisit point:** emdash (Apache-2.0, ACP-based, Windows MSI, PRs and checks in-app) was only read at README and tree level. A half-day audit before M1 is worthwhile; its ACP adapter layer is the closest model for ours.
- **Provider data:** models.dev and cc-switch are both MIT; `catalog/curated.json` cites the cc-switch file and line for every endpoint it takes.
- **Copying code:** none. Every repo here, whatever its license, is read to learn how it works; Crewyard's code is written for its own architecture (AGENTS.md).

## Follow-up scan (2026-10-30)

A second, deeper pass over these repos, the four runners' docs and six newer projects is in [docs/research/2026-10-30-feature-scan.md](docs/research/2026-10-30-feature-scan.md): fixes for what we already built, ranked additions, Windows pitfalls, quota endpoint facts and corrections to this page.

## nodeterm (2026-11-01)

A canvas-based terminal manager for agent CLIs, under BUSL-1.1, so it is read for ideas only. The owner wants its ideas kept for when we need them. [docs/research/2026-11-01-nodeterm.md](docs/research/2026-11-01-nodeterm.md) has five, each with its source doc, what Crewyard has today and the size of the change:
1. a Windows session host that keeps terminals and agents alive across app restarts;
2. hook-reply approvals for Claude Code sessions started outside the app;
3. consent before writing into an agent's global configuration;
4. memory per session;
5. distribution details.

## Subscriptions and agent apps (2026-11-01)

How other agent managers run Codex, Gemini, Antigravity and Claude on subscription accounts, how desktop agent apps connect to an orchestrator, and the provider terms as of that date: [docs/research/2026-11-01-subscriptions-and-app-bridges.md](docs/research/2026-11-01-subscriptions-and-app-bridges.md).
- **Takeaways:** Gemini CLI no longer serves personal Google plans; Codex on ChatGPT stays allowed for a local, open-source app; Antigravity's terms forbid third-party use of a consumer sign-in, and its models are available by API key.
- **Patterns to avoid:** token reuse and swapping, GUI automation and subscription relays. These have documented bans.

## Not verified

- No app was run. Windows behaviour is inferred.
- The undocumented usage endpoints some tools call with subscription tokens (Claude `/api/oauth/usage`, Codex `wham/usage`) were not tested. We do not plan to call them; see PLAN.md §6.
- orca's and emdash's approval UIs, and whether emdash's adapters handle limits.
- Current wording of Anthropic's and OpenAI's terms (seen only as quoted by cc-switch).
