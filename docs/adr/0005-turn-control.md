# ADR 0005: Turn control (follow-up queue, steer, undo, stall alerts, transcript snapshots)

**Status:** accepted, 2026-10-30. Feature scan items A7, A10, A13, A18.

## Problem

While an agent works you can only message it blind: the runner buffers the text, the UI shows it as sent, and nothing can be fixed or taken back. There is no undo for a turn that went wrong, a hung run or an unanswered question can sit unnoticed overnight, and the runners' own transcripts expire (Claude Code keeps 30 days) while our handoff package only pointed at them.

## Options

**Queue.**
1. Keep handing every message to the runner at once and show its internal queue. Simple, but nothing stays editable, and each runner behaves differently (Codex steers, the others queue a turn).
2. Hold every message in our own persisted, per-step queue (the outbox of `runs.message`) and give it to the runner only at a turn boundary, or at once on "Steer now" where the runner documents a way.

Chosen: **2**. Adapters call `StartRequest.nextTurn()` at each turn boundary, before they would end the run; the orchestrator returns the queued messages joined as one turn, or null. All queued messages go together rather than one per turn (omnigent flushes the head only): one turn instead of several, so less per-turn overhead and fewer cache misses. A delivered message is history and refuses every edit.

**Undo.**
1. Rely on each runner's own rewind.
2. Make a git checkpoint of the worktree before every turn and restore it on undo; call the runner's own rewind first where it has one, for its files and its conversation.

Chosen: **2**, because the runners cover different things: Claude Code's file checkpoints miss Bash edits and keep the conversation; Codex `thread/rollback` drops history but "does not revert local file changes"; OpenCode revert restores its own snapshot and history. Git covers files in every case, and the state undo replaces is kept under `refs/crewyard/undo/<turn>`.

## Facts per runner (checked on 2026-10-30)

| Runner | Steer | Undo, runner side | Transcript |
|---|---|---|---|
| Claude Code (SDK 0.3.312, CLI 2.1.306) | none documented: `SDKUserMessage.priority` exists in the types but is undocumented, so not used | `enableFileCheckpointing` + `extraArgs: { "replay-user-messages": null }` at start; on an ended session `claude -p --resume <session> --rewind-files <user message uuid>` (needs `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`), files only | `<CLAUDE_CONFIG_DIR>/projects/<project>/<session>.jsonl` |
| Codex (codex-cli 0.147.0) | `turn/steer` with `expectedTurnId` | `thread/resume` (no turn) then `thread/rollback { numTurns: 1 }`, history only; newer builds replace it with `thread/revert`, whose parameters the README does not document yet, so a missing method is reported, not guessed | `CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl` |
| OpenCode (1.19.5) | none documented | `POST /session/{id}/revert { messageID }` on a server of its own; files and history | `opencode export <session>` (JSON) |
| Gemini CLI (ACP) | none | none documented: Undo is disabled with the reason | none |

## Stall rules

Three rules with defaults in Settings (Notifications): no events for 10 minutes while a turn runs, the same failure class 3 runs in a row (last 24 hours only), a request unanswered for 30 minutes; cooldown 60 minutes; 0 turns a rule off. Each fires `stall.notice` and a persisted Inbox item (`stall_alerts`), which closes on its own when its condition goes away. Stall items do not change task status: the task is still running, only quiet.

## Transcript snapshots

At handoff and when a run ends, the runner's record is copied to `<dataDir>/tasks/<task>/transcripts/<runner>-<session>.<ext>`: atomic (temp file and rename with retry), never smaller than an earlier copy of the same session (a pruned or expired source keeps our copy), capped at 64 MB (past it, the newest part from a line start). The handoff package cites our copy.

## Sources

| Source | Opened | Stars | License | Archived |
|---|---|---|---|---|
| https://code.claude.com/docs/en/agent-sdk/file-checkpointing | 2026-10-30 | n/a | docs | n/a |
| `@anthropic-ai/claude-agent-sdk` 0.3.312 `sdk.d.ts` (`rewindFiles`, `RewindFilesResult`, `enableFileCheckpointing`) | 2026-10-30 | n/a | package | n/a |
| https://github.com/openai/codex `codex-rs/app-server/README.md`; `codex app-server generate-ts --experimental` (0.147.0: `TurnSteerParams`, `ThreadRollbackParams`) | 2026-10-30 | 131,588 | Apache-2.0 | no |
| `@opencode-ai/sdk` 1.19.5 `v2/gen/sdk.gen.d.ts` (`session.revert`), `opencode export --help` | 2026-10-30 | 223,093 (sst/opencode) | MIT | no |
| https://github.com/omnigent-ai/omnigent `docs/QUEUE_STEER_DESIGN.md` | 2026-10-30 | 11,120 | Apache-2.0 | no |
| https://github.com/BloopAI/vibe-kanban `crates/server/src/routes/sessions/queue.rs` (kept the queue in memory; ours persists) | 2026-10-30 | 28,509 | Apache-2.0 | no |
| https://github.com/hoangsonww/Claude-Code-Agent-Monitor `server/lib/alerts.js`, `server/lib/snapshot-store.js` | 2026-10-30 | 1,131 | MIT | no |

Ideas only; no code was copied or ported.

## Windows notes

- A git start costs a few hundred ms on this machine, so a checkpoint (about five git calls) adds about 2 s at each turn start in a task worktree. Read-only steps without a worktree take none.
- The checkpoint copies the real index into a temp file (`GIT_INDEX_FILE`), so git reuses file stats; the user's index, HEAD and files are untouched.
- Restored files come back the way git checks them out (`core.autocrlf`, `.gitattributes`). Files `.gitignore` excludes are neither saved nor touched.
- A file held open by another program can fail the restore; undo then reports `undo.partial` with the paths and keeps everything else.
- The rewind helpers (`claude -p`, `codex app-server`, `opencode serve`) are short-lived children through `@crewyard/proc`, with the profile's folder and key in their environment, never on the command line.

## Security notes

- Undo is confirmed in the app after a preview of every file it changes; it never runs while a turn runs or while another run works in the same worktree, and the daemon checks again on confirm (`undo.changed` if the step moved on).
- A rewind never starts a model turn (checked in the adapter tests: no `turn/start`, no prompt).
- Queued text is the user's own; the undo note is ours and marked as such in the queue.
- Stall alerts show rule, minutes, counts and the failure class only, never agent text.
- Transcript copies stay in the per-user data folder, like the event log.

## Rollback

The migration `turn-control` only adds tables (`outbox_queue`, `turns`, `stall_alerts`, `run_transcripts`). Reverting the code leaves them unused; outbox rows keep working through the old columns. Checkpoint refs live under `refs/crewyard/` in each task repo and can be removed with `git for-each-ref --format="%(refname)" refs/crewyard/ | xargs -n1 git update-ref -d`.
