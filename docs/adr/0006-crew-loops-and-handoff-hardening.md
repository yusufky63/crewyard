# ADR 0006: Crew loops, pinned review, handoff by fork, handoff hardening

**Status:** accepted, 2026-10-30. Feature scan items A9, A11, A12, F5 and "done better than our plan".

## Problem

A crew ran each step once. An implementer could finish with failing tests and the task still read "review"; a reviewer's "changes" verdict was recorded and nothing happened. The reviewer read the live task worktree, which an implementer may still change, and nothing tied a verdict to the commit it read, so the merge gate could not know whether the head it merges was ever reviewed. A handoff always started the target cold from the written package, even between two profiles of the same runner and provider. And a few edges of the handoff protocol were open: late events from a source after the swap, no way to let a turn finish before handing off, open handoffs simply closed at daemon start, and a resume that failed for any reason could lead to a fresh session that dropped the conversation.

## Options

**Where the Test step runs.**
1. A tester agent (the existing role) runs the tests and reports.
2. The daemon runs the project's own test command (`.mission/project.json` `commands.test`) at the implementer's turn boundary, through `StartRequest.nextTurn`, and feeds a failure back as the next turn of the same session.

Chosen: **2**. It is deterministic, costs no tokens, and every adapter already calls `nextTurn` before it ends a run (ADR 0005), so the failure lands in the same conversation without a new run or a resume. The tester role stays for what it is good at (benchmarks, exploratory checks) and re-runs after a fix.

**How "changes" goes back.**
1. A new implementer run with the comments and the role prompt (a fresh session).
2. A native resume of the implementer's own session with the comments, as paperclip routes a change request back to the original executor and the same stage.

Chosen: **2**. The session that wrote the code keeps its context. When the runner cannot resume, the loop stops with `stop_no_resume` instead of replacing the session.

**Pinned review.**
1. Keep the reviewer in the task worktree and rely on the DAG to keep the implementer away.
2. A detached checkout (`git worktree add --detach <wt>.review-<sha8> <sha>`) of the exact head, removed when the review ends.

Chosen: **2**. The verdict is stored with that sha (`review_verdicts`); the merge gate (`reviewed` item) and the PR gate pass only on a pass verdict for exactly the PR head, so a later commit makes the old verdict stale by construction.

## Decisions

- **Stop rules.** One iteration budget per implementer step (`loop.maxIterations`, default 3, 1 to 10), counted over test failures and "changes" verdicts together; the spend caps that already exist (a cap reached ends the loop with `stop_spend_cap`); and stop early when the worktree tree is the same as at the last failing try (`stop_no_change`, compared by the tree id of a temp-index snapshot). A stopped loop ends the implementer run `failed` with `loop.<rule>` as its detail: no handoff, no retry, the task reads failed and waits for you.
- **Uncommitted work** at the end of an implementer run is committed by the daemon, so the commit the tests passed on is the commit the reviewer pins.
- **Re-runs.** A completed step runs again when a step it depends on completed again after it started (the review loop, or a fix sent from PR feedback), on the profile that last ran it, as a successor of its last run.
- **Records.** Every decision is a row in `loop_decisions` with a translatable reason, plus an audit event `loop.decision` for the timeline; test results (`test_results`, tail redacted and bounded) and verdicts are in `TaskDetail.loop`.
- **Codex native review (A12).** A reviewer on a runner with `capabilities.nativeReview` gets `StartRequest.review = { target: base_branch }` (the task's base branch, else its base commit). The Codex adapter sends `review/start` with `delivery: "inline"` instead of a first turn, then one more turn on the same thread with `outputSchema` that restates `exitedReviewMode.review` as our verdict schema (P0/P1 blocker, P2 major, P3 minor).
- **Handoff by fork (A11).** Only when source and target are the same runner and the same provider, the role has no independence constraint (never into a reviewer or security step), and the adapter has `fork()`. The written package is still written and is the fallback for any fork failure. Fork spend counts on the target run; the new session's totals become its usage baseline.
- **Run epochs.** Each run joins its step's epoch; a completed handoff bumps the step to the next epoch and the target holds it. Events from an older epoch are logged and their spend counts, but they change no state; their questions and approvals are cancelled, and answers to them are refused with `run.fenced`.
- **Drain or interrupt.** `runs.handoff` takes `stop`. Drain waits (at most 10 minutes) for the source's next turn boundary, holds that boundary so the runner does not end the run as completed, stops the source, then continues; interrupt is the old behaviour and the default.
- **Reconcile on start.** An open handoff is closed `interrupted` with its phase, as before, and the source, which still holds the step, gets a "handoff failed" Inbox item with detail `handoff_interrupted`. Leftover review checkouts are removed.
- **Never auto-replace a session with history.** A same-profile auto retry of a run that has a session but no native resume asks you instead. A resume replaces the session only when the runner itself says it is `gone` or `locked` (`sessionError`, or Claude's `session.gone:` / `session.locked:` end detail), with a fresh run of the same step fed the handoff package.

## Facts per runner (checked on 2026-10-30)

| Runner | Fork | Compact | Native review | Session gone / locked |
|---|---|---|---|---|
| Codex 0.147.0 | `thread/fork` with `path` (rollout file under the source CODEX_HOME; marked unstable) and the target's `model` | `thread/compact/start`, done at `contextCompaction` item / `turn/completed`; no summary text | `review/start` `{ threadId, target: { type: "baseBranch", branch } \| { type: "commit", sha, title }, delivery }`; output in `exitedReviewMode.review` (text). The review runs in a subagent thread whose `thread/tokenUsage/updated` codex never sends; its spend is only in that subagent's rollout (`session_meta` with `parent_thread_id` and `source: {subagent: "review"}`, then `token_count` totals), which `review-usage.ts` reads (checked live on 2026-10-30: two thirds of a DeepSeek bill) | "no rollout found for thread id", "failed to resolve rollout path" (JSON-RPC -32600), probed against the installed binary |
| Claude Code 2.1.306, SDK 0.3.312 | `forkSession(id, { dir, sessionStore })` with a store that reads the source profile's JSONL and writes the target's (the store option is `@alpha`) | `/compact` on the fork under the target key; summary from the `PostCompact` hook | none | `session.gone: No conversation found with session ID`, `session.locked: That session is running in the background` (only a live background session holds one) |
| OpenCode 1.19.5 | `opencode export` (source profile) then `opencode import` (target profile), then `POST /session/{id}/fork` | `POST /session/{id}/summarize { providerID, modelID }`, blocks until done | none | `session.get` 404 is gone |
| Gemini CLI (ACP) | none | none | none | none |

A fork carries no file-history snapshots (Claude) or per-profile snapshots (OpenCode), so Undo cannot reach turns from before the fork; git checkpoints still cover files.

## Windows notes

- The test command runs without a shell through `runSteps` (cross-spawn, hidden window, tree kill on timeout, `.cmd` shims resolved), 15 minutes at most.
- Review checkouts live next to the task worktree (`<wt>.review-<sha8>`), so paths stay as short as the worktree's; a checkout a file lock keeps is retried at the next daemon start.
- Paths with spaces are in every new test.

## Security notes

- Test output goes back to the agent bounded (6,000 characters) and redacted with the run's secret values, like every other error text.
- A forked or compacted session is resumed with the role's policy re-applied by each adapter (OpenCode sets the permission ruleset on a session that has none); fork never runs a tool (Codex refuses server requests, Claude denies every tool in the compaction query, OpenCode summarizes with no tools).
- The compaction summary is the runner's own text, shown as data; it carries no authority.
- `git worktree remove --force` is used only on the daemon's own detached review checkouts, which a read-only role reads; task worktrees are never removed this way.

## Rollback

All new state is in side tables (migration `crew-loops`): dropping the code paths leaves them unread. Setting `loop.maxIterations` to 1 and removing `commands.test` makes a crew behave as before except for the pinned checkout. `capabilities.fork` and `capabilities.nativeReview` can be turned off per adapter without touching the orchestrator.

## Sources

- BloopAI/vibe-kanban issue #1946 "Ralph Wiggum mode" (opened 2026-10-30; 28.5k stars, Apache-2.0, not archived): the ask for test-fix loops in a crew tool.
- paperclipai/paperclip `docs/guides/execution-policy.md` (opened 2026-10-30; 108.7k stars, MIT, not archived): changes requested return to the original executor and the same review stage, every outcome recorded.
- openai/codex `codex-rs/app-server/README.md` "Review delivery" (opened 2026-10-30; 131.6k stars, Apache-2.0, not archived), and the TypeScript schema generated from the installed codex-cli 0.147.0 (`ReviewStartParams`, `ReviewTarget`, `ThreadForkParams`, `ThreadCompactStartParams`, `ThreadItem`).
- code.claude.com/docs/en/agent-sdk/sessions, /agent-sdk/slash-commands, /hooks (opened 2026-10-30): fork, `/compact`, `compact_boundary`, `PostCompact.compact_summary`.
- opencode.ai/docs/cli and /docs/server (opened 2026-10-30), and anomalyco/opencode at v1.19.5 (MIT, not archived): export/import keep the id, fork copies messages but not permissions, summarize waits for the loop.

Nothing was copied; these were read for behaviour and facts only.
