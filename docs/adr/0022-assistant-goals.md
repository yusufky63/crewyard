# ADR 0022: The task assistant and Orchestra goals

**Status:** accepted, 2026-11-02. Owner request 2026-11-01. Amends ADR 0014 and ADR 0018 (a new own-draft tool, `draft_goal`) and ADR 0017 (two Autopilot tools, `create_goal` and `approve_goal_plan`). Takes the first item of PLAN.md §9.8 "Later" ("Autopilot and the task assistant creating and approving goals") from ADR 0019.

## Problem

The owner, 2026-11-01: "assistant task veya görev açamıyor mu veya diğer şeylere erişimi yok mu öyle bir tool yok diyor" (can't the assistant open tasks, doesn't it have access to other things, it says there is no such tool).

The conversation log showed two things:

- The assistant (DeepSeek Flash through Claude Code) said it had no tool to remove its own drafts. `discard_draft` existed (ADR 0018); the prompt named it in one long line with `edit_draft`, without saying when to use it or what id it takes.
- It said it had no tool for Orchestra goals. That was true: a goal could only come from the composer's `Plan goal` click, and Autopilot had no goal tools (ADR 0019 left them for later).

What must not change:

- `Plan goal` and `Approve and start` stay the person's clicks unless Autopilot is on, and each one shows its cost first (ADR 0019, PLAN.md D8).
- Autopilot's checks run in the daemon, per call, against stored state; the prompt explains and enforces nothing (ADR 0017).
- Nothing outward-facing gets a tool: push, pull request, merge into your branches, deletes, Inbox answers, spend past a cap.
- Agent text is data: capped, cleaned, shown as plain text.

## Options

### (a) A goal draft for the composer, plus two checked Autopilot tools that reuse the goal parts

- `draft_goal` (always available) puts a goal into the Tasks composer in Orchestra mode. The person reads it and presses `Plan goal`, which still shows the planning estimate and ceiling. No model call happens without that click.
- With Autopilot on, `create_goal` is `Plan goal` on Autopilot's behalf and `approve_goal_plan` is `Approve and start`, each checked per call against Autopilot's limits, going through the same GoalPlanner, GoalViews and GoalEditor paths as the clicks.
- For: one new place for a goal to come from (the composer) and two calls that land on paths that are already tested; every limit Autopilot has for tasks is applied to goals; the person sees the plan in the same review either way.
- Against: a goal is several tasks, so the checks are more than approve_crew's (every estimate, each task, the total, the hourly starts, At once); planning spends money before a plan exists, so the planning ceiling must be committed up front.

### (b) Let the assistant create goals directly without Autopilot

- For: one call instead of a draft and a click.
- Against: the planning run costs money; an assistant without Autopilot must never cause spend (ADR 0014: "Cannot start anything"). paperclip's board-operator guide, read for this ADR, keeps the same line: the CEO agent drafts a strategy, and nothing is broken into tasks or assigned until the board approves it.

## The choice

**(a).**

### `draft_goal` (no Autopilot needed)

| Part | Where |
|---|---|
| Tool, arguments, caps | `packages/core/src/assistant-tools.ts`: in `ASSISTANT_DRAFT_TOOLS` next to `edit_draft` and `discard_draft`. `text` is checked as `goals.create` checks yours (`parseGoalText`: cleaned, refused past 8,000 bytes, never cut); `planner` is a profile alias (at most 64 bytes); `budget_usd` is checked like a goal budget (`parseGoalLimits`). Unknown keys are refused. |
| Storage | `assistant_goal_drafts` (one migration, `assistant-goals`): per conversation, at most 10; a new `draft_goal` marks the open one discarded, so the composer never has two to choose from. |
| Handler | `packages/daemon/src/assistant/tools.ts`: refused while Orchestra is off or no profile can plan, from GoalPlanner's own preview, which writes nothing; an alias that cannot plan is refused with the ones that can. The result carries the planning estimate with its label. `discard_draft` takes a goal draft of this conversation too. The conversation view carries `goalDrafts` and the panel hears `assistant.changed`. |
| IPC | `assistant.discardGoalDraft` (your Discard) and `assistant.goalDraftPlanned` (Plan goal was pressed on it; only a goal of the draft's own project). |
| Composer | `screens/tasks/Composer.tsx`: the newest open goal draft lands by itself only while the box is empty, once per draft; what you typed is never replaced without your click. It switches to Orchestra, fills the text, picks the named planner, focuses the box and shows `From the assistant` with the planner and the suggested budget. `Plan goal` then links the card to the goal, and the plan review prefills the suggested budget, which you still approve. |
| Drafts column | `screens/tasks/assistant/GoalDraftCard.tsx`: `GOAL`, `Drafted by the assistant`, the text as plain text, `Open in composer` (goes to the project's Tasks screen from anywhere), `Discard`; once planned, `Planned` and `Open goal`. |
| Tool line | `toolLine.done.draft_goal` / `toolLine.refused.draft_goal` in en and tr: `Drafted a goal: <first line>`, `Hedef taslağı hazırladı: <ilk satır>`. |

### Autopilot's goal tools

Both are listed on every assistant connection with the other Autopilot tools and refused while Autopilot is off, killed or halted (ADR 0017). Each call, allowed or refused, is an `autopilot.<tool>` or `autopilot.refused` event with its reason and the goal id, so the Autopilot log links to the goal.

**`create_goal`** (text, optional planner alias, `basis`, `sources`, `reason`):

- created-per-hour cap: a goal counts as one created task;
- `basis` quotes your message in this conversation verbatim, as for `create_task`;
- Orchestra on (`orchestra_off`), a profile that can plan (`no_planner`, also for an alias that cannot);
- the planning estimate known and its ceiling (the planning run's own budget, which the composer states) inside what is left of the day limit (`planningFits`: `estimate_unknown`, `over_day_limit`);
- the planner key under its caps with the ceiling added (`key_cap`);
- a free concurrency slot (`concurrent`);
- then GoalPlanner's `create`, marked `by: "autopilot"`, so the first-goal card stays due for your own first goal and your remembered planner is not changed. The ceiling is committed against the day from then on, or the planning spend when that is more.

**`approve_goal_plan`** (goal id, optional revision, optional `max_parallel`, `reason`):

- a goal Autopilot created (`not_own`), only its first approval: replans and added tasks are revisions you approve (`wrong_status`);
- the latest revision ready (`plan_not_ready`), and the revision named, when one is, still the latest;
- `goalPlanFits` in core: every accepted task's estimate and the last review's known (`estimate_unknown`); each under the per-task limit (`over_task_limit`); the goal budget, which is the known total rounded up to the cent, inside what is left of the day limit (`over_day_limit`); the goal counts one start per task against the hourly cap (`rate_started`); `max_parallel` at most the concurrency limit, and with the tasks already active At once must fit it (`concurrent`). At once defaults to the smaller of 2 and the concurrency limit;
- every chosen key of every task's crew under its caps (`key_cap`);
- then GoalEditor's `approve`, the path `Approve and start` takes. The goal budget is the known total, so each task's share is its estimate and the existing share, reservation and cap rules hold it there. A plan of one task becomes an ordinary task (ADR 0019) and is recorded as one of Autopilot's tasks, counted once.

Approval is recorded before the call and undone if it fails, as approve_crew does, so a task that starts at once is already counted.

**Keeping the session going.** An Orchestrator `watchGoals` listener (beside `watchTasks`) hands the live session Crewyard's note when one of its goals' plans is ready (its tasks, kinds and Estimated costs, marked as planner output) or failed, and a goal task's status change like its own tasks'. Each fact is told once (`autopilot_goals.notified`). A stopped session is never started by a note.

**Never added:** a tool for replans, `Add task`, goal limits, pause, stop, decisions, accepting reports, merging into your branches, push or pull requests. The consent card lists the goal tools under "It may"; consents given before this change carry over, because the tools stay inside the same limits the card listed.

### The prompt

`packages/daemon/src/assistant/prompt.ts`, sent with every session, now says: `edit_draft` changes and `discard_draft` removes or replaces a draft, task or goal, with the `draft_id` that propose_task, draft_goal or list_drafts gives; call list_drafts before saying a draft cannot be changed; use draft_goal for work that needs several tasks; what it cannot do is the person's click or needs Autopilot, which the person turns on in the panel; never say a tool is missing without checking the tool list. A test keeps it under 4.2 KB.

## Sources

| Source | Opened | Stars | License | Archived |
|---|---|---|---|---|
| https://modelcontextprotocol.io/specification/2025-11-25/server/tools ("there SHOULD always be a human in the loop with the ability to deny tool invocations"; servers MUST validate inputs, implement access controls and rate limit; input validation errors as `isError: true` results so the model can self-correct; clients SHOULD log tool usage for audit) | 2026-11-02 | n/a (spec) | spec terms | no |
| https://github.com/paperclipai/paperclip `docs/guides/board-operator/delegation.md` (the CEO agent drafts a strategy for a goal; nothing is broken into tasks or assigned until the board approves it; budgets above 80% come back to the operator) | 2026-11-02 | 109,896 | MIT | no |

License checked with `gh api repos/paperclipai/paperclip --jq .license.spdx_id`. Ideas only; no code was copied or ported.

## Windows notes

Nothing new is spawned. The tools ride the assistant's existing named-pipe report server and ticket (ADR 0007, 0014); a planning run and goal tasks start through the existing adapters exactly as from your clicks. Tests keep spaces in repository and temp paths and Turkish text in goals and plan fields.

## Security notes

- `draft_goal` writes one row in this conversation and starts nothing; planning stays the person's click, which states the cost. The goal text is cleaned and capped in core, stored as text and rendered by React as text.
- Autopilot's goal checks are deterministic code in `packages/core/src/autopilot.ts` (`planningFits`, `goalPlanFits`) and `packages/daemon/src/assistant/autopilot.ts`, each refusal with a unit or daemon test. The goal goes through the same GoalPlanner and GoalEditor checks as a click, so a crew that fails validation, a stale or changed revision, a paused or stopped goal and the goal budget split refuse it as they would refuse you.
- Planner output in the note to the session is marked as data; the session can only act through the same checked tools.
- `by: "autopilot"` is set only from the Autopilot host; the `goals.create` handler builds its parameters field by field and never passes it.

## Rollback

Remove `draft_goal` from `ASSISTANT_DRAFT_TOOLS` and `create_goal` and `approve_goal_plan` from `AUTOPILOT_TOOLS`: sessions started afterwards no longer list them and any call is refused as unknown. Goals Autopilot created are ordinary goals and stay. The migration adds two tables, `assistant_goal_drafts` and `autopilot_goals`, that nothing else reads; events stay in the log and the timeline ignores unknown kinds.
