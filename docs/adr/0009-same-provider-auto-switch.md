# ADR 0009: Automatic switching between accounts of the same provider

**Status:** accepted, 2026-10-30. Decides open question 1 of PLAN.md §17 and changes the rule in PLAN.md §6 ("Same-provider account switching") and §8.

The owner decided on 2026-10-30: "evet olsun kullanıcı isterse açık bıraksın ve otomatik geçiş olur" (yes, it should exist; if you want it, you leave it on and the switch happens automatically). It is off by default.

## Problem

- A step stops when its account hits a limit (a Codex 5-hour window, Reported), when its prepaid credit runs out (a 402 or "insufficient balance", `failures.ts`), or when its key reaches its daily or per-task spend cap. With two accounts of the same provider (Codex · work and Codex · personal, or two DeepSeek keys), the obvious next move is the second account.
- PLAN.md §6 allowed this only by hand and left the automatic version undecided, because providers' terms can treat several accounts used to get past per-account limits as abuse (§16). cc-switch made its own subscription quota polling opt-in after users feared provider risk controls (PRIOR_ART.md, cc-switch #3519).
- The fallback code (§8) had no idea of "the same provider". Auto mode took the first standby target that passed preflight, and that could be another account of the same provider, with no opt-in at all. That contradicted §6.

## Options

**How the other account takes over.**

1. Swap the credential under the running process. cc-switch's failover moves its local proxy's route to the next provider in a queue; claude-swap moves another account's login into Claude Code's default slot while sessions run. No new process, but it means handling a CLI's credential slot, which Crewyard never does (PLAN.md D4, AGENTS.md security rules), and one run would then spend on two accounts with no clear line between them.
2. Hand the step to the other account's profile through the durable handoff of §8.2: stop at a turn boundary, commit the work in progress, then start the target in the same worktree, by a fork of the session where the runner can (same runner and provider) or with the handoff package. Each account keeps its own config folder and key; nothing touches a credential.

Chosen: **2**. agent-orchestrator moves a session between accounts the same way: it checks the target account while the source still runs, drains or interrupts the turn, resumes under the new account, and changes the session's binding only after that works.

**What turns it on.**

1. The setting only unlocks same-provider targets for tasks in Auto mode. Manual and Ask keep asking.
2. The setting is its own trigger. On a limit, credit or key-cap stop, the next account of the same provider that passes preflight takes over, whatever the task's fallback mode. When none passes, the task's mode decides as before. A task can turn it off for itself.

Chosen: **2**. It is what the owner asked for ("when it is on, the switch happens automatically"). It also keeps two questions apart: the fallback mode decides moves to another provider or runner, and this setting decides moves between accounts of one provider. With option 1 the setting would do nothing under the default Manual mode.

## Decisions

- **Setting:** `app.accountSwitch` `{ enabled, termsAcceptedAt }` in Settings → Fallback, off by default. Turning it on the first time shows the provider-terms note; accepting it records the time, and the daemon refuses `enabled: true` before that (`settings.terms`). Later toggles do not show the note again.
- **Per task:** on unless you turn it off, in the crew proposal or from the Inbox entry of a switch (`tasks.setAccountSwitch`, table `task_account_switch`). The global setting off wins.
- **Same provider, other account:** same runner, same catalog provider id, a different account. An API key is its credential; a plan sign-in is its profile, since every profile has its own config folder (D4). Two profiles on one key are one account. Local providers never switch.
- **Triggers:** `limit` (the runner said the limit was reached), `credit` (an empty prepaid balance) and `spend_cap` (the key's daily or per-task cap). Never the task's own budget, because a second key does not make that budget bigger; never a model without a price; never a crash or a transient error. In Wait for reset mode, a reset within the task's wait still wins: you chose to wait for that account.
- **Order:** the step's standby chain first, then the other accounts of the provider by crew score. The first one that passes preflight takes over.
- **Preflight**, the rules every handoff target already passes (§8.2 step 2): ready (signed in, key present, adapter registered), allowed in the role (read-only preset) and independent of the reviewer's model, more than 20% headroom (Unknown passes and is recorded as Unknown), its key under its daily and per-task caps, the task budget not spent. Three more: never a Claude subscription (Claude runs on API keys only, §6); only the same kind of account, a plan sign-in for a plan sign-in and an API key for an API key, so a switch never starts paying per token where nothing was paid (claude-swap rotates onto API-key accounts only when asked); and never an account this step already left (no switching back and forth; claude-swap needs a cooldown and a margin for the same reason).
- **Auto mode** never moves to another account of the same provider by itself; only this setting does, with the rules above. Manual and Ask still list those accounts in the Inbox, to pick by hand.
- **Records:** every switch is a row in `account_switches`: what stopped the source (window, used %, provenance, cap), the target's headroom and the step's estimate on it (each with Reported, Estimated or Unknown), the accounts it skipped and why, and the handoff it opened (mode `auto`). The audit log gets `account.switched`, or `account.switch_refused` when no account passed. The Inbox lists switches under "Switched accounts" until you dismiss them, with "Off for this task"; the task timeline shows both events with their labels.

## Sources (opened 2026-10-30 through the GitHub API)

| Source | Stars | License | Archived | What we took |
|---|---|---|---|---|
| OrchestratorInc/agent-orchestrator `backend/internal/session_manager/agent_account.go`, `backend/internal/service/chat/account_switch.go`, `backend/internal/service/chat/usage_limit.go`, `backend/internal/domain/agent_account.go` | 13,912 | Apache-2.0 | no | An account move goes through the same durable handoff as other moves: preflight the target account while the source runs, drain or interrupt, resume, change the binding only once it works. The stopped turn is shown as "Switched account", not as a failure. Its auto-resume after a usage limit is consent per turn, and its limit readings "can extend a known deadline, never shorten it or create consent". It has no automatic switch between accounts. |
| farion1231/cc-switch `docs/user-manual/en/4-proxy/4.3-failover.md`, `src-tauri/src/proxy/failover_switch.rs`, `src/i18n/locales/en.json` (`confirm.failover`, `providerCard.reason.noFailover`) | 150,358 | MIT | no | Automatic failover is its own switch, off by default, with a confirmation the first time it is turned on. The queue is ordered by you. Official subscription accounts never join it. Every failover is logged with time, old provider, new provider and reason, and a second identical switch while one runs is skipped. |
| realiti4/claude-swap `README.md` ("Automatic switching"), `src/claude_swap/autoswitch.py` | 4,264 | MIT | no | It rotates Claude subscription logins at a usage threshold, with a cooldown and a margin so it does not flip back and forth, lets you hold an account out of rotation, and rotates onto API-key accounts only when asked. We never rotate logins and never use a Claude subscription, but took three rules: an account the step left is not taken again, a task can be held out, and a plan never moves onto a paid key by itself. |

Licences were checked with `gh api repos/OWNER/REPO --jq .license.spdx_id`. No code was copied or ported; the rules above are written for this architecture.

## Windows notes

- Nothing new is spawned: the target starts through the same adapters and handoff path as any handoff (`cross-spawn`, `windowsHide`, process trees killed with `taskkill /T /F`).
- No credential files are read, copied or moved between config folders. claude-swap hit Windows Credential Manager's blob size limit and non-atomic writes doing that (PRIOR_ART.md); this design never touches them.
- The setting is one row in the `settings` table and the records are rows in the same SQLite WAL database; nothing is written outside the data folder except the handoff package, which every handoff already writes atomically.

## Security notes

- No token or key is read, copied or logged. Each account keeps its own config folder and DPAPI secret, and the target run gets only its own environment from the profile directory.
- A Claude subscription is never a target, even if one were ever stored.
- Provider terms: the switch is opt-in, the note is shown before it can be turned on, a task can be held out, and every switch is visible in the Inbox and the timeline.
- Spend: never past the task budget, the target key must be under its own caps, and the target's estimate is reserved like any handoff's.
- Records hold profile ids, aliases, provider ids and numbers; no secret, no prompt text.

## Rollback

- Turn the setting off: no new switches happen, Auto mode still excludes other accounts of the same provider, and Manual and Ask keep offering them by hand.
- Revert the code: the tables `account_switches` and `task_account_switch` are read only by this feature and can stay; older builds ignore the `app.accountSwitch` settings key, because settings are read per key with defaults.
