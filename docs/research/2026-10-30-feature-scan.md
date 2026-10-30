# Feature scan: what the reference repos do that Crewyard does not (2026-10-30)

Six research passes read the repos below through the GitHub API (README, docs, source trees, releases, issues) and the runners' official docs. Nothing was cloned or run, and nothing is copied: we take ideas and facts (URLs, field names, flags) only (AGENTS.md). Paths and issue numbers are where each pass found the evidence; spot-check them before building. Items marked *inferred* were not verified.

Checked by hand on 2026-10-30: OpenCode v2.2.2 is a GitHub release (2026-10-29) while npm `opencode-ai` is still 1.19.5; agent-orchestrator #3476 (migration skipped after a version reorder) and PR #6641 (cost chips hidden, merged 2026-10-13) are as described; our adapter already allow-lists the Claude plan tools (`packages/adapter-claude/src/tools.ts`).

## 1. Fix in what we already have

| # | Finding | Evidence | Change | Size |
|---|---|---|---|---|
| F1 | Migrations applied by position break when parallel branches reorder them | agent-orchestrator #3476; our `store.ts` slices `MIGRATIONS` by `user_version` | Key migrations by id, record applied ids in a table, keep `user_version` only for the old ones | S |
| F2 | OpenCode 2.x has a redesigned server API (`/api/...`, `OPENCODE_PASSWORD`, user `opencode`) | opencode.ai/v2/docs/migrate-v1, release v2.2.2 | Detect the version at probe; keep 1.x, add 2.x behind its conformance run | M |
| F3 | Parallel DAG steps can each pass the cap check and overshoot together | paperclip `server/src/services/budget-reservations.ts` | Reserve the step's estimate before dispatch, release on end | M |
| F4 | Unpriced spend counts against no cap | omnigent `policies/builtins/cost.py` | A capped task on an Unknown-priced model needs an explicit click | S |
| F5 | Merge must take the reviewed head SHA | emdash `pull-requests/schemas.ts` (`commitHeadOid`), merge states CLEAN/DIRTY/BEHIND/BLOCKED/UNSTABLE | Merge only that SHA; route only unresolved, non-outdated comments | S |
| F6 | PR tracking breaks on renames and on merged PRs that vanish from `state=open` | agent-orchestrator `docs/scm-observer.md`, #4090, #6555 | Key PRs by node id, reconcile terminal states, detect squash merges | S |
| F7 | Stale limit readings and multi-bucket Codex limits | orca `rate-limits/claude-usage-window.ts`, `codex-rate-limit-window-classification.ts`; emdash `agents/impl/codex/usage.ts` (`rateLimitsByLimitId`) | Ignore older resets and lower usage within a window; classify by duration (300 / 10080 min); one meter per bucket; `observedAt` apart from `checkedAt` | S |
| F8 | Which errors should hand off | cc-switch `proxy/forwarder.rs` (400/405/406/413/414/415/422/501 never fail over), `circuit_breaker.rs`; LiteLLM `cooldown_handlers.py` | Add a "request invalid" class that never hands off; jittered backoff with a cap; no wait when switching profile | S |
| F9 | Read-only roles should be enforced by each runner's own engine, not only by denying tools | Codex `sandbox: read-only` / permission profiles; OpenCode `permission` deny; Claude `permissionMode: dontAsk` + PreToolUse hooks; Gemini plan mode + policy TOML | Use the native mechanism per runner, keep our tool denial as a second layer | S–M |
| F10 | Runners spawn their own subagents, which bypasses our DAG | Codex `agents.enabled`; Claude `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`; Gemini `experimental.enableAgents`; OpenCode `permission.task` | Turn built-in subagents off or cap them per role | S |
| F11 | Stop and approve can hit the wrong session after a handoff | openrig `docs/reference/checked-seat-stop.md` (409 `selection_changed`) | Send run id and session id with every stop or answer; refuse on mismatch | S |
| F12 | Windows child env misses variables | emdash #3315 (`SystemDrive`, `ProgramData`) | Allow-list the Windows system variables explicitly in every child env | S |
| F13 | Unbounded `taskkill /T` floods WMI and opens consoles | orca #24829 | Bound and dedupe kills | S |
| F14 | Windows shutdown kills children before the app hears about it | orca #33536 (0x40010004) | Record those runs as interrupted, not failed | S |
| F15 | Electron fuses are off | agent-orchestrator #6446 | Turn off RunAsNode and NODE_OPTIONS, enable ASAR integrity in the packaged app | S |
| F16 | Two app instances can open the same database | agent-orchestrator `datadirlock` after #3805, #3633 | OS file lock on the data folder in addition to the single-instance lock | S |
| F17 | Denials should tell the agent why | vibe-kanban `utils/approvals.rs` (`Denied { reason }`) | Deny with an optional reason, passed to the agent | S |
| F18 | Polling for quota scares users and can trip risk controls | cc-switch #3519 (opt-in since v3.16.2); claude-swap `poll_policy.py` | One scheduler, TTL and jitter, no startup burst, list every endpoint in Settings | S |

## 2. Worth adding (not in PLAN.md)

Ranked by how many repos have it and how much it helps a Windows-first crew app.

| # | Idea | Seen in | Why for Crewyard | Size | Guardrails |
|---|---|---|---|---|---|
| A1 | **Worktree bootstrap**: setup and cleanup steps per project, an include-list for gitignored files (`.env`, caches), a stable port per branch, a disk meter, "park" (commit WIP, remove folder, keep branch) | agent-orchestrator `configuration/projects.mdx`; vibe-kanban `projects-repositories.mdx`, #765; emdash `emdash-config`; worktrunk `hook.md`, `step.md`; paseo `paseo.json` | Fresh worktrees lack `node_modules` and env files; open tasks hold gigabytes | M | Scripts are High-risk commands, approved once per command hash; copy, never symlink; never log copied secrets |
| A2 | **Diff review with line comments sent to the agent** in one batch | vibe-kanban `workspaces/changes.mdx`; emdash `draft-comments-store.ts`; agent-orchestrator v0.14.4 | Cheapest way to steer; we only have agent-written reviews | M | Send at a turn boundary as quoted data with file:line and hunk |
| A3 | **Schema-checked results** for the reviewer verdict, the planner plan and the handoff package | Claude `outputFormat: json_schema`; Codex `turn/start.outputSchema`; OpenCode `format`; sandcastle README | Handoffs and review gates stop parsing free text | S | Gemini has none: prompt JSON plus validation and one in-session retry |
| A4 | **Issue import** into the composer (GitHub first) | agent-orchestrator trackers; emdash `plugins/src/issues`; vibe-kanban #1677 | Tasks usually start from a ticket | S | Issue text is untrusted data shown in the crew proposal; never auto-start |
| A5 | **Coding-plan quota as Reported** for Kimi, Z.ai/Zhipu, MiniMax, OpenCode Go | cc-switch `services/coding_plan.rs` (table in §4) | Closes the "Unknown until confirmed" gap in PLAN §6.1 | S–M | Undocumented endpoints: on a shape change show Unknown, never 0; opt-in polling |
| A6 | **Key check and model discovery** (`GET /v1/models` with fallbacks) plus a latency check | cc-switch `services/model_fetch.rs`, `speedtest.rs` | Fills model slots and flags dead keys before a run | S | Never feeds the failover breaker |
| A7 | **Stall rules**: no events for N minutes, the same failure N times, an unanswered request | Agent Monitor `server/lib/alerts.js` | §7.3 covers limits only; hung runs go unnoticed | S | Three defaults, cooldown |
| A8 | **Best of N**: the same task on several profiles, compare, keep one | crystal `CreateSessionDialog.tsx`; orca `recipes/parallel-agents.mdx` | Four runners and many providers make this natural | M | N times spend and disk; estimate first, caps count the group |
| A9 | **Run until green**: implement → test → fix, with iteration and spend caps | vibe-kanban #1946; paperclip `execution-policy.md` (review loop-back) | Fits the DAG; reviewer "changes requested" returns to the same implementer | M | Stop when the diff stops changing |
| A10 | **Undo last turn** | Claude `rewindFiles`; Codex `thread/revert`; OpenCode revert; crystal checkpoints | A safe button next to Stop | M | Worktree git stays the source of truth |
| A11 | **Handoff by fork plus compact** instead of only a written package | Codex `thread/fork`, `thread/compact/start`; Claude `forkSession` + PostCompact hook; OpenCode summarize | Better context for the standby agent | M | Never fork into the reviewer (independence rule) |
| A12 | **Codex native review** (`review/start`) as a Review step | Codex `ReviewTarget.ts` | A built-in reviewer that reads the diff directly | M | Pin it to the head SHA |
| A13 | **Editable follow-up queue and "steer now"** | omnigent `QUEUE_STEER_DESIGN.md`; Codex `turn/steer`; vibe-kanban `queued_message.rs` | Type while the agent works; edit before it is sent | M | Persist the queue (vibe-kanban kept it in memory) |
| A14 | **Crew report tool over MCP** (checkpoint, needs input, stuck, done) | agent-orchestrator `skillassets/using-ao/commands/report.md` | A structured channel from agents to the orchestrator | M | Per-run token, no power to start runs; follow-ups arrive only as Inbox proposals |
| A15 | **Keep the machine awake while runs are active** (opt-in) | agent-orchestrator ADR 0005/0006 (macOS only) | Overnight runs die on sleep | S | Battery guard; Electron `powerSaveBlocker` (*inferred*) |
| A16 | **Profile presets with "when to use" notes** | paseo `agent-profiles.md`; vibe-kanban `agent-configurations.mdx` | Feeds the crew proposal's one-line reason | S | — |
| A17 | **Usage view by day, model, provider and task**, with export | cc-switch `usage_rollup.rs`; ccusage `daily --json` | M5 "per-model ledger" made concrete | M | Estimated label; split cache reads; dollars only for per-token keys (agent-orchestrator #6641) |
| A18 | **Transcript snapshot into the task folder** at handoff | Agent Monitor `snapshot-store.js` | CLIs expire their own transcripts (Claude: 30 days) | S | Atomic, never shrink |

Later, not now: recurring tasks with a free precheck (orca `cli/automations.mdx`), hibernating idle agents (orca `agents/hibernation.mdx`), multi-repo projects (orca #1099), dev-server preview (vibe-kanban, emdash; needs an isolated partition and no listener of ours), phone alerts with title only (agent-orchestrator ADR 0004 shows why full remote access is a risk), taking over in the agent's own terminal (agent-orchestrator, L), MCP management across runners (emdash, cc-switch).

Rejected: local format-conversion proxy (cc-switch's is ~50 files and binds a port; breaks the no-listener rule), anything that relays subscription tokens (slopus/happy, claude-code-router OAuth import), deeplinks that carry scripts (cc-switch usage scripts).

## 3. Windows pitfalls to add to tests

- `.cmd` shims beating `.exe`, re-parsed flags, ConPTY refusing `.cmd` (agent-orchestrator #3409, #7212, #3504; emdash #1703).
- Hooks through `sh -c` or `>NUL` under Git Bash (agent-orchestrator #3410, emdash #3011).
- Domain user names in branch prefixes, `!` in folder names, case-only duplicate repos (claude-squad #220, vibe-kanban #3126, #2164).
- Orphaned worktree admin refs and dangling `origin/HEAD` (emdash #3247, #3198): prune before create.
- One locked file failing `git diff --numstat` for all (orca #33953): fall back per file.
- Slow boot with many worktrees (agent-orchestrator #4064) and cold probes past their deadline (#6444): keep boot O(1), cache probes single-flight.
- `CLAUDE_CONFIG_DIR` ignored by hook writers (Agent Monitor #393): always pass the profile folder.
- Large outputs freezing the UI (vibe-kanban #2166, Agent Monitor #223, #341): virtualize, truncate, stream.
- Unsigned or EDR-flagged installers (agent-orchestrator #7232, orca #27818).

## 4. Facts for the quota code (from cc-switch, `src-tauri/src/services/`)

| Provider | Endpoint | Auth header | Fields | Source |
|---|---|---|---|---|
| Kimi Code | `GET https://api.kimi.com/coding/v1/usages` (global host *inferred* `api.kimi.ai`) | `Authorization: Bearer` | `limits[].detail.{limit,remaining,resetTime}` = 5 h; `usage.{limit,remaining,resetTime}` = weekly; values may be strings | `coding_plan.rs:155-262` |
| Z.ai / Zhipu | `GET https://api.z.ai/api/monitor/usage/quota/limit` (cn: `open.bigmodel.cn`) | `Authorization: <key>` (no Bearer) | `data.limits[]`: `type` TOKENS_LIMIT, `unit` 3 = 5 h, 6 = weekly, `percentage` used, `nextResetTime` ms; `success:false` "no coding plan" = pay as you go | `coding_plan.rs:290-500` |
| MiniMax | `GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains` (cn: `api.minimaxi.com`) | Bearer | `model_remains[]` where `model_name=="general"`: `current_interval_remaining_percent` (remaining), `end_time` ms, weekly status and percent | `coding_plan.rs:539-841` |
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | Bearer | `usage.{rolling,weekly,monthly}.{status,percent,resetsAt}`; 403 = key valid, no plan; changed shape on 2026-08-11 | `coding_plan.rs:842-960` |
| StepFun | `GET https://api.stepfun.com/v1/accounts` | Bearer | `balance`, `total_cash_balance`, `total_voucher_balance` | `balance.rs:153-163` |
| SiliconFlow | `GET https://api.siliconflow.{cn,com}/v1/user/info` | Bearer | `data.{balance,chargeBalance,totalBalance}`; CNY on .cn, USD on .com | `balance.rs:211-265` |
| OpenRouter | `GET https://openrouter.ai/api/v1/credits` | Bearer | `data.{total_credits,total_usage}` | `balance.rs:288-299` |
| Novita | `GET https://api.novita.ai/v3/user/balance` | Bearer | `availableBalance` in 0.0001 USD | `balance.rs:364-375` |

Percent direction differs per provider (Zhipu reports used, MiniMax reports remaining). Classify windows by duration, not by order.

## 5. Corrections to PRIOR_ART.md

- orca: 1,166 open issues mention "windows" (242 in the title), not "200+".
- ccusage is now written in Rust; claude-code-router (37.9k stars, MIT) is now a desktop gateway.
- vibe-kanban: the company stopped on business grounds; cloud data was removed after 30 days, local workspaces keep working. Lesson: keep data local, documented and fully exportable.
- New strong repos not covered before: paperclipai/paperclip (MIT), getpaseo/paseo (Apache-2.0), omnigent-ai/omnigent (Apache-2.0), max-sixty/worktrunk (MIT/Apache-2.0), mattpocock/sandcastle (MIT), mvschwarz/openrig (Apache-2.0).
