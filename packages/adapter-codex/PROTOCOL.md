# Codex app-server protocol notes

`src/protocol/` is generated from codex-cli 0.147.0 by `node scripts/gen-protocol.mjs` (run it again after a CLI upgrade and read the diff). Decisions are in [ADR 0002](../../docs/adr/0002-codex-app-server-adapter.md).

## Rate-limit payload recorded from codex-cli 0.147.0 (2026-10-30)

`account/rateLimits/read` on a ChatGPT Plus account, saved as `src/__fixtures__/rate-limits-0.147.json`:

- `rateLimits` (the default bucket, `limitId: "codex"`):
  - `primary`: `{ usedPercent: 0, windowDurationMins: 300, resetsAt: <unix seconds> }`.
  - `secondary`: `{ usedPercent: 43, windowDurationMins: 10080, resetsAt: <unix seconds> }`.
  - `credits`: `{ hasCredits, unlimited, balance: "0" }`.
  - `individualLimit`, `spendControlReached`, `planType: "plus"`, `rateLimitReachedType: null`.
- `rateLimitsByLimitId.codex`: the same snapshot.
- `rateLimitResetCredits`: `{ availableCount: 0, credits: [] }`.

`account/read` returned `{ account: { type: "chatgpt", email, planType: "plus" }, requiresOpenaiAuth: true }`. The `initialize` user agent starts with our client name: `crewyard/0.147.0 (Windows 10.0.26200; x86_64) ...`.

`scripts/live.mjs` (`CREWYARD_LIVE=1`) repeats these three calls and never starts a model turn.

## Codex on DeepSeek (live, 2026-10-30)

Test setup:
- A throwaway `CODEX_HOME` whose `config.toml` sets `model_provider = "deepseek"`.
- `[model_providers.deepseek]` with `base_url = "https://api.deepseek.com"`, `env_key = "DEEPSEEK_API_KEY"` and model `deepseek-flash`.
- The key was passed only through the run's environment.

Results:
- `wire_api = "responses"` works. A one-word reply streamed, `usage.update` reported a context window of 258,400, and the run ended `completed`.
- `wire_api = "chat"` is refused by codex 0.147 while loading config ("no longer supported").
- `probe()` reports `signedIn: true`, because a custom provider needs no OpenAI account. `limits()` reports Unknown.
- One codex turn sends about 14,800 input tokens (system prompt and tools) even for a one-word answer. On a repeat, about 9,500 of them were served from DeepSeek's cache.

## 0.147.0 vs 0.166.0 (npm latest on 2026-10-30)

Compared the generated 0.147 types with the 0.166 `schema/typescript` files in openai/codex (tag `rust-v0.166.0`). Everything this adapter uses is the same or only has additions:

- Same in both: `RateLimitWindow`, `FileChangeRequestApprovalParams`, `ToolRequestUserInputParams` / `Question`, `ThreadTokenUsage`, `TokenUsageBreakdown`, `LoginAccountResponse`, both approval decision types, `TurnPlanStep`.
- 0.166 adds:
  - `RateLimitSnapshot.normalModelSlug`;
  - a required `kind` on `CommandExecutionRequestApprovalParams` (we do not read it);
  - `Account` gets `workspaceName` and a `gcp` variant;
  - `LoginAccountParams` gets an `amazonBedrockAccessKeys` variant;
  - `ThreadItem` gets a `functionCallOutput` variant (mapped to nothing, like other unknown items);
  - `TurnStartParams` gets `disabledPluginIds`, `turnTrigger`, `parentTurnId`, `rootTurnId`, `toolOutput`, `serviceTierForTurn`.
- Server requests: 0.166 drops `currentTime/read`. We never handled it; unknown requests get `-32601`.
- Client methods we call are present in both: `initialize`, `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`, `account/read`, `account/rateLimits/read`, `account/login/start`, `account/login/cancel`, `windowsSandbox/readiness`.

The 0.166 repository schema leaves out experimental methods. A method missing from it is not proof that it was removed.

## Mapping summary

| codex | AgentEvent |
|---|---|
| `turn/started` | `run.state: running` |
| `turn/completed` | `run.ended`: `completed` / `stopped` (interrupted) / `limit` (`usageLimitExceeded`) / `failed` |
| `item/agentMessage/delta`, completed message without deltas | `message.delta` |
| `item/reasoning/summaryTextDelta`, `textDelta` | `thought.delta` |
| `item/started` (command, file change, MCP, dynamic tool, web search, image view) | `tool.call` |
| `item/completed` of the same | `tool.update` (output tail: 8,000 chars) |
| `turn/plan/updated` | `plan.update` |
| `turn/diff/updated` | `diff.update` (per-file +/- counts) |
| `thread/tokenUsage/updated` | `usage.update`. `tokensIn` excludes cached tokens. Context used is the last request's total. Cost is Unknown. |
| `account/rateLimits/updated` | `limit.update`, Reported. Only windows present in the update. Default bucket only. |
| `error` with `willRetry` | `run.state` (`rate_limited` for usage or overload) |
| `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` | `request.approval` + `run.state: waiting_approval` |
| `item/tool/requestUserInput` | `request.question` + `run.state: waiting_input` |
| `serverRequest/resolved` for a pending request | `run.state: running` (the Inbox item can be dropped) |
