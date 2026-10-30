# Coding-plan quota and limit buckets (A5, F7) — handover

Branch `claude/plan-quota-13113f`, 2026-10-30.

## What it does

- **Coding-plan quota as Reported** for Kimi Code, Z.ai, MiniMax and OpenCode Go keys
  (`packages/daemon/src/providers/plan-quota.ts`). One GET per key, parsed per window, classified by
  stated length or by the field that names the window, never by position. Zhipu reports the used
  share, MiniMax the remaining share. A failed read or a shape we do not know is stored as the key's
  problem and turns its windows Unknown through the orchestrator; "no coding plan" (Z.ai
  `success:false` with that message, OpenCode Go HTTP 403) is stored as `no_plan` and the key stays
  on its spend line as pay as you go.
- **Polling is opt-in** (`limits.planQuotaRefresh`, off by default) and runs through a second
  `IdleLimits` instance: same TTL, jitter, start-up spread and backoff as the Codex idle refresh,
  only for keys a task uses. The Limits screen lists every endpoint and its auth next to the switch.
  "Check" on a plan card reads once on the user's click.
- **Limit buckets.** `LimitSample.bucket` / `bucketLabel` (optional; absent is the main limit).
  Stored in `usage_sample_buckets` and read through the `usage_samples_bucketed` view (migration
  `limit-buckets`). A side table instead of a column so the migration is idempotent. The limit
  monitor arms 80/95% and the pace forecast per bucket; headroom and "reached" look at every bucket.
  Codex `account/rateLimits/read` now returns every entry of `rateLimitsByLimitId`.
- **UI.** Limits: one meter per bucket and window, each with its provenance and age; coding-plan
  cards with state and a Check button. Sidebar: several limits stack up to three 8-tick meters in
  the meter column, the line stays 28 px, the tooltip lists every window.

## Sources (opened 2026-10-30)

| Source | Stars | License | Archived | Used for |
|---|---|---|---|---|
| github.com/farion1231/cc-switch `src-tauri/src/services/coding_plan.rs` | 150k | MIT | no | endpoints, headers, field names, no-plan rules for all four |
| github.com/zai-org/zai-coding-plugins `plugins/glm-plan-usage/.../query-usage.mjs` (Z.ai's own) | 130 | Apache-2.0 | no | bare `Authorization` key, `TOKENS_LIMIT` / `TIME_LIMIT` ("MCP usage (1 Month)") |
| github.com/MoonshotAI/kimi-cli `src/kimi_cli/ui/shell/usage.py` | 11k | Apache-2.0 | yes | `limits[].window.{duration,timeUnit}`, `used` or `remaining` |

No provider documents its quota endpoint; MiniMax and OpenCode Go were checked only against
third-party tools (web search, 2026-10-30), which agree with cc-switch. No code was copied.

## Not done / follow-ups

- Fixtures are built from documented field names with test values; no live key was used (task
  rule). The first real response of each provider should be compared with its fixture.
- Live Codex `account/rateLimits/updated` notifications of buckets other than `codex` are still
  skipped (`limit.update` carries no bucket); the idle read covers them.
- Inbox and title-bar notices dedupe by `profileId|window`; two buckets with the same window can
  share one entry there. `LimitNoticePayload.bucket` is set, so those screens can key on it.
- Only the global hosts are mapped (the catalog has no cn coding-plan entries).

## Sidebar accounts block, two-part rows (follow-up)

- Each account: a 28 px name line (mark, name, value), then one full-width row per reported window
  or bucket: short label, 24-tick meter, %, and provenance with reset time underneath (it wraps to
  a second line where the language needs it, Turkish at 224 px).
- Hide rules in `shell/sidebar/accounts-model.ts`, tested in `accounts-model.test.ts`: no block
  without accounts; a key without a cap shows its spend as text only; a key with a cap gets one
  `cap` row; a plan shows only reported windows, or one Unknown row when nothing is known; a profile
  that must sign in or update and a local server show no meter.
- Shots: `sidebar-*` (plan with two buckets, Codex), `sidebar-keys-*` (key with cap, Unknown, key
  without cap), `sidebar-empty-*` (no block). `fixture=keys` and `fixture=empty` select the variants.
