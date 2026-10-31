# ADR 0017: Autopilot, the task assistant running the task flow within your limits

**Status:** accepted, 2026-10-31. Owner request the same day. Changes PLAN.md D8 for one opt-in case.

## Problem

The owner, 2026-10-31: "şimdi ai ile görev açıp görevleri düzenleyip tamamlayabilir miyim, yani kendim bir şey yapmasam bile ai ile yönetebilir miyim" (can I now open, edit and complete tasks with AI, so that I can manage everything through it even when I do nothing myself?).

Today the task assistant (ADR 0014) only proposes drafts. You click `Add as draft`, then `Approve and start` on the crew; a finished analysis waits for you to read it. D8 says starting a crew needs an explicit click; the only exception is a schedule you set up, which auto-approves its crew and audits it (ADR 0008). So "manage it through AI" means a click per task and per crew, which is exactly the part the owner wants handed over.

What must not change, whatever we choose:

- **Outward actions always go through you in the app** (AGENTS.md security): push, pull request, merge, deleting a worktree or a branch, and spend past a cap. Medium and High risk tool approvals stay in the Inbox (PLAN.md §11). Signing in to an account is yours (D4).
- **Agent text is data** (§9.3). Issue text, agent output and file contents can never instruct Crewyard to do anything.
- **D7 admission** still decides when a step may start.
- **Every quota or cost number carries its label**; nothing hides spend.

## Options

### (a) A per-project Autopilot that acts through narrow, checked tools on the assistant's session

The assistant keeps its read-only runner session. When you turn Autopilot on for a project, its report-server connection may also call a short list of task-flow tools (create, edit, approve within budget, queue a message, retry once, cancel its own task, mark a finished analysis done). Each call is checked by the daemon against your limits before anything happens, then goes through the Orchestrator's public methods, the same ones your clicks use, and is written to the audit log with the agent's reason. Everything outward-facing stays out of reach: there is no tool for it.

- For: the agent never gets a capability we did not list; every check is ours, deterministic and tested, not the model's judgment; the crew still runs under the same scheduler, admission control, budgets and Inbox; turning it off (or the kill switch) takes effect on the next call because the check runs per call.
- Against: the tools are listed on every assistant connection (MCP clients read the list once per session), so a session started with Autopilot off still sees them and is refused; the agent's choices between allowed actions are still the model's, so the limits must be tight by default.

### (b) Auto-approval rules without an agent ("approve every crew under $X")

A rule in Settings approves any proposed crew under a price, like the schedule's auto-approval.

- For: no model in the loop at all; trivially auditable.
- Against: it answers only one click of the owner's request. Nobody opens, edits, follows up on or closes tasks, and nobody reads the reports; you would still drive every step.

### (c) A blanket "trust the assistant" mode

Cline's auto-approve, read for this ADR, has per-category toggles (read, edit, safe commands, all commands, browser, MCP) and a "YOLO" switch that approves everything; its `maxRequests` cap is kept in the settings type only "for backward compatibility" and the feature behind it was removed. OpenHands has confirmation policies (`AlwaysConfirm`, `ConfirmRisky` at a risk threshold, `NeverConfirm`).

- For: simple to explain.
- Against: a blanket mode is exactly what AGENTS.md rules out for outward actions, and a cap that can be removed is not a guard.

## The choice

**(a)**, off by default, per project, with a global kill switch. From Cline we take the per-category list and the explicit opt-in, and not the "approve everything" switch; from OpenHands, that Unknown risk is treated as needing a person (here: an Unknown estimate never fits a budget).

### What Autopilot may do (when on)

New report-server tools on the assistant's connection, beside `propose_task`. Each one takes a `reason`, which is stored with the action.

| Tool | Does | Checked |
|---|---|---|
| `list_tasks`, `read_task` | reads the project's tasks, a task's steps, what waits on you, and a finished analysis's report | Autopilot on; a report read is recorded |
| `create_task` | a task with a proposed crew, budget set to the per-task limit | a verbatim `basis` quote from one of your messages in this conversation; `sources` recorded; created-per-hour cap |
| `edit_task` | title, description, kind, acceptance criteria of a task it created that has not started | still a proposal; a kind change proposes the crew again |
| `approve_crew` | approves the crew of a task it created | estimate known (Estimated or Reported, never Unknown) and under the per-task limit; today's committed spend plus it under the per-day limit; every chosen key under its own daily and per-task caps; started-per-hour cap; concurrent-task cap; then admission control as for every crew |
| `queue_message` | a message into the queue of a running step of its task | the step has not ended; the message goes at the next turn boundary like yours |
| `retry_step` | retries a failed required step once | the step failed (not paused for a limit or cap); one retry per step |
| `cancel_task` | cancels a task it created | not already finished |
| `complete_task` | marks a finished research, review or docs task done | the steps have ended and Autopilot read the report after that; never a code task |

Autopilot acts on tasks it created. Your own tasks stay yours: it can read them, never approve, edit, cancel or close them. It still works read-only in the repository; code is written by the crew it approves.

"Mark done" for a non-code task: its status already reads Done once its steps end (PLAN.md §13). What was missing was the person reading the report and accepting it. `complete_task` records that acceptance, with the reason, on the report ("Marked done by Autopilot"), and frees the task's concurrency slot: an analysis whose report nobody accepted still counts as active, so Autopilot cannot start new work faster than it reads what it already has.

### What stays with you, always

There is no tool for: push, pull request, merge, deleting a worktree or branch, answering an Inbox request (so Medium and High risk approvals, questions, handoffs and budget pauses wait for you), spend past any cap (a task's budget, a key's daily or per-task cap), account sign-in, and any change to Autopilot's own settings or limits. Those stay in the Inbox and the GitHub screen; Autopilot sees them in `read_task` as "waiting on you" and waits. A code task it approved ends in Ready for review, and its pull request waits for your click.

### Turning it on, and the kill switch

- **Per project, off by default.** `Autopilot` in the assistant panel. Turning it on the first time shows what it may do, what stays with you, and the limits; `Turn on` records the consent with its time (`autopilot_projects.consent_at`), like the same-provider switch (ADR 0009). The daemon refuses `enabled: true` without it (`autopilot.consent`).
- **Limits** (defaults): $1.00 per task, $5.00 per day, 4 tasks started per hour (and 4 created), 2 concurrent tasks. Only the panel (your click, over IPC) changes them; no tool can.
- **Kill switch:** `Stop Autopilot` in the status bar (shown while any project has it on) and in Settings. It refuses every Autopilot call at once in every project and tells live assistant sessions. It never stops running agents: steps already started finish under their own budgets, and you stop them as usual. Turning it back on is yours.
- **Stop rule:** when two failed steps of Autopilot's tasks in a project end with the same failure within 24 hours, Autopilot halts in that project (`repeated_failure`, a toast and a log entry) until you turn it on again.

### Untrusted text

Issue text, agent output, reports and file contents are data. A task Autopilot creates must quote, verbatim, something you wrote in this conversation (`basis`, at least 8 characters, matched after whitespace normalisation), and it records its `sources` (a report, an issue, a file, agent output) next to it. So a finding in a report can become a task only when you asked for that kind of work in your own words, and the task says where it came from. Arguments are cleaned and capped in core like drafts (`parseAutopilotCall`), refused rather than cut.

### Records

- `autopilot_projects` (enabled, consent, limits, halt), `autopilot_tasks` (who created it, basis message and quote, sources, approved, report read, marked done with reason), and the kill switch as the `autopilot.killed` settings row.
- Every call, allowed or refused, is an event `autopilot.<tool>` (or `autopilot.refused`) in the event log with its reason, so it is in the task's timeline, in Activity → Events, and in the Autopilot log of the assistant panel. Turning it on or off, limit changes, the kill switch and halts are events too.
- Toasts are batched: one per project per 30 seconds of actions ("Autopilot took 3 actions"); a halt toasts at once.

### Keeping the session going

While Autopilot is on, each status change of one of its tasks (done, failed, needs you, ready for review, cancelled) is handed to the live assistant session at its next turn boundary as Crewyard's own short note, and the idle stop is held while it has active tasks. A stopped session is not started again by itself: no model call happens without a message from you or a live session you started.

## Sources

| Source | Opened | Stars | License | Archived |
|---|---|---|---|---|
| https://modelcontextprotocol.io/specification/2025-06-18/server/tools ("there SHOULD always be a human in the loop with the ability to deny tool invocations"; servers MUST validate inputs, implement access controls and rate limit; clients SHOULD log tool usage for audit) | 2026-10-31 | n/a (spec) | spec terms | no |
| https://docs.cline.bot/features/auto-approve (per-category auto-approve toggles, YOLO mode approves everything with no confirmation) | 2026-10-31 | n/a (docs) | n/a | n/a |
| https://github.com/cline/cline `apps/vscode/src/shared/AutoApprovalSettings.ts` (`actions` per category; `maxRequests: 20` kept only as a legacy field, "Max requests limit feature has been removed") | 2026-10-31 | 71,090 | Apache-2.0 | no |
| https://docs.openhands.dev/sdk/guides/security (risk levels LOW, MEDIUM, HIGH, UNKNOWN; `AlwaysConfirm`, `ConfirmRisky`, `NeverConfirm`; UNKNOWN is confirmed by default) | 2026-10-31 | 92,321 (OpenHands/OpenHands) | MIT | no |

Licences checked with `gh api repos/OWNER/REPO --jq .license.spdx_id`. Ideas only; no code was copied or ported.

## Windows notes

Nothing new is spawned: the assistant session is the ADR 0014 runner session, and the tools ride its existing named-pipe report server and ticket. The crews it approves start through the same adapters (`cross-spawn`, `windowsHide`, process trees killed with `taskkill /T /F`). New state is rows in the same SQLite WAL database.

## Security notes

- Every check is in the daemon, per call, against stored state: on, consent, kill switch, halt, ownership, status, budget, caps, rates. The prompt explains the rules and enforces none of them.
- The tool list is fixed and contains no outward action; a call to any other name is refused by the MCP session before it reaches us. Tests cover push, merge, answering requests and spending past a cap being refused.
- Spend: only Estimated or Reported estimates fit; a task's budget is the per-task limit, so the existing budget pause hands spend past it to you in the Inbox; key caps are checked before approval and enforced while running as for every run.
- Tickets stay per assistant process (`assistant:` prefix); a crew run can never call these tools.
- Limits and the switch change only through IPC from the window.

## Rollback

Turn Autopilot off or press the kill switch: every call is refused, tasks it created stay ordinary tasks, running steps go on. Reverting the code leaves three tables and a settings row nothing else reads; events stay in the log and the timeline ignores unknown kinds.
