# ADR 0008: Best of N, scheduled tasks, hibernation

**Status:** accepted, 2026-10-30. Feature scan item A8 and two items of its "later" list (recurring tasks with a free precheck, hibernating idle agents).

## Problem

- **Best of N.** With four runners and many providers, the same implement step can be tried on several profiles and the best result kept. The crew ran each step on one profile. Two things blocked the obvious version: a task owns exactly one worktree (`worktrees.task_id` is unique, and the bootstrap, park and PR code key on the task), and every cap and reservation was per task, so N parallel attempts would each pass the checks alone.
- **Scheduled tasks.** Recurring chores (dependency checks, weekly reviews) had to be typed again each time. There was no timer, and no way to skip a run cheaply when there is nothing to do.
- **Hibernation.** A run that sits waiting holds a process (hundreds of MB for a CLI with its model session) and an admission slot. In Crewyard a run releases its process at every turn boundary with nothing queued: the run ends and later resumes by session id. So the only idle live process is a run waiting on your answer to a question or an approval, often overnight.

## Options

**Where a variant lives.**
1. Extra runs of the same crew step, each in a second worktree table. Requests, spend and status come for free, but `worktrees`, `worktree_bootstrap`, park, undo, the test gate and the review checkout all assume one worktree per task and would each need a second path.
2. One hidden task per variant, with a crew of one (the implement step), created when the group starts. Its own worktree, bootstrap, run-until-green loop, queue, undo and stall rules come from the code that already does this for a task. Caps, reservations, spend and status are routed to the parent.

Chosen: **2**. The parent's budget and per-task caps count every variant (`budgetTask`: spend rows and reservations of a variant run carry the parent's task id; the parent's spend sums its variants' runs). Kept: the variant's worktree row moves to the parent (`update worktrees set task_id`; its id, and every run that names it, stay valid), its bootstrap row moves with it, and a completed run of the parent's implement step records the adoption (`end_detail = best_of.kept`, the variant's native session id, cost 0 since the variant run already counted it). The reviewer pins that worktree's head, and a "changes" verdict resumes the kept variant's own session there.

**Group admission.**
1. Start variants one by one as slots free up.
2. Start every variant at once or none.

Chosen: **2**. A half-started group would hold slots while the rest waits, and the comparison would be skewed. `admitGroup` needs N project, global and per-profile slots and memory for N. Every paid variant's estimate is reserved against the parent in one transaction before any process starts. A group that could never start (more variants than slots, or an estimate over the task budget on its own) is refused at approval (`best_of.slots`, `best_of.over_budget`).

**Where the timer for schedules lives.**
1. The OS scheduler (Windows Task Scheduler) starting the app or a helper.
2. A timer in the daemon, which runs only while the app runs (also from the tray).

Chosen: **2**, as orca and agent-orchestrator do. Nothing runs while Crewyard is closed and nothing is registered with Windows; the UI says so. Missed slots after sleep or a restart are caught up, at most 3, one at a time and oldest first; older ones are recorded as `skipped_missed` with their count.

**Which runs hibernate.**
1. Exactly "no turn running and no open request": in this codebase that set is empty in practice (see Problem), so the feature would never act.
2. Also a run whose turn is held only by an open question or approval, idle for the window.

Chosen: **1 and 2**, confirmed by the lead session on 2026-10-30 with these limits. The generic rule stays, and a run waiting on you hibernates too. Its request stays open in the Inbox, which says the agent is hibernated and answering resumes it (a toast answer goes the same way). The runner's pending call dies with the process, so the answer goes to the resumed session as text: what it asked and what you answered, or "approved, make the same call again", or the deny reason. Bootstrap approvals and limit questions do not count; they have no live process.

The one-time grant (`policy.approved_while_hibernated`) is the sensitive part, so it is narrow: only an "allow once" answer to a command call; only that run; only the exact call (command text byte for byte apart from its ends, the same folder, paths and network flag); one use; gone at the end of the resumed turn or after 15 minutes, whichever is first. A deny or cancel grants nothing. "Allow always" keeps the project allowlist, which never matches shell syntax (`matchesAllowlist`). Tests cover a near-miss command, a second use, an expired grant, a dropped grant, and a deny.

## Decisions

- **Best of N.** 2 to 4 variants, implementer step only. At proposal the variants are the proposal's own implementer, then the best-ranked other profiles, preferring models the group does not have yet and never a reviewer's model: any variant may be kept, so the reviewer must be independent of all of them (also checked at approval). Edits at approval go through `tasks.approve { bestOf: { profileIds } }`. The crew estimate counts every variant.
- **Compare and keep.** `TaskDetail.bestOfGroup` lists each variant with its status, latest run, spend (provenance label), files changed against the base (`git diff --numstat <base>` read when its run ends), last test run in its own worktree, and loop decisions (the last one is its verdict). `tasks.keepVariant` takes only a variant whose implement run completed. The others are stopped (`best_of.discarded`), cancelled and parked (WIP committed, folder removed, branch kept). A park that fails (a cleanup step waiting for approval, a locked file) is recorded on the variant and the folder stays. The UI asks before keeping and names what it stops and parks.
- **Parent status.** `TaskFacts.bestOf` (`needs_input`, `running`, `choosing`, `failed`) is read from the variants' own statuses; "choosing" is needs input. Cancelling the parent cancels every variant.
- **Schedules.** Daily or weekly at `HH:MM` in an IANA time zone (the system's by default). Local times are mapped to instants with `Intl` offsets; a time in the spring DST gap runs just after it (02:30 becomes 03:30), a time that happens twice runs the first time. Created disabled; enabling counts slots from that moment. Optional precheck: one program with plain arguments (the setup-step rules, no shell), run in the project folder with a 5 to 600 s limit (default 60). Exit 0 goes on; anything else, an error or a timeout records `skipped_precheck`, and no agent starts. No overlap: while the schedule's last task is still active (proposed, queued, running, waiting on you), due slots wait. Every run is a normal proposal; "auto-approve this crew" approves it and writes `schedule.auto_approved` to the audit log (D8). Run now skips the precheck, never the overlap rule.
- **Hibernation.** Default on, 30 minutes, 1 to 1440, with an off switch (Settings, Startup section). Only runners whose resume by session id is proven (Claude Code, Codex, OpenCode), and Gemini CLI or another ACP agent only when its probe reported `loadSession`; anything else keeps its process. The timeline shows `run.hibernated` and `run.woke` (with what woke it). The run stays open (`run_hibernation` row without `woke_at`), is never stopped or interrupted, does not count in admission, keeps its spend reservation, and shows `hibernated`. It wakes on a message, on an answer to its request, or when its step continues (resume, retry); waking takes a slot again and waits for one if none is free. A daemon restart keeps it hibernated instead of marking it interrupted. A resume that fails ends the run failed and the usual retry or handoff follows.

## Sources (opened 2026-10-30 through the GitHub API)

| Source | Stars | License | Archived | What we took |
|---|---|---|---|---|
| stablyai/orca `docs/site/content/docs/agents/hibernation.mdx` | 110,393 | MIT | no | The idea: stop idle resumable agents after a window (default 30 min), relaunch by session id, never hibernate a non-resumable runner |
| stablyai/orca `docs/site/content/docs/cli/automations.mdx` | 110,393 | MIT | no | Precheck exit code gates a scheduled run, `skipped_precheck` status, Run now bypasses the precheck, IANA time zone |
| OrchestratorInc/agent-orchestrator `frontend/src/docs/content/configuration/lifecycle-automation.mdx` | 13,899 | Apache-2.0 | no | Automations run in the local daemon only while it runs and the machine is awake; at most three missed occurrences after a restart; no new run while the current one is active |
| stravu/crystal `frontend/src/components/CreateSessionDialog.tsx` | 3,130 | MIT | no | Several sessions from one prompt (`sessionCount`), grouped together |

No code was copied or ported; the rules above are written for this architecture.

## Windows notes

- Variant worktrees are created one after another: parallel `git worktree add` on one repository races for its lock files. Their bootstrap (setup steps, include list, port) runs per variant like any task worktree.
- The precheck runs through `runSteps` (cross-spawn, hidden window, `.cmd` shims resolved, tree kill on timeout), never through a shell; paths with spaces are in the tests.
- The timer is a plain `setInterval` (30 s) in the daemon; after sleep the next tick sees the missed slots. No Windows task, no wake timer.
- Hibernation stops a run's process tree through the adapter's `stop` (`taskkill /T` underneath).

## Security notes

- Schedules never start a crew on their own unless the template says so, and then every approval is audited; caps, Inbox approvals for risky commands, pushes and merges still wait for you. A precheck is a command you typed in the app; it gets the daemon's environment and no profile secrets, and its output tail is stored only in the schedule's run history.
- A hibernated approval is allowed again only for the exact command text and folder you approved, once.
- Variants run under the same role policy, risk classes and caps as any implementer.

## Rollback

All three are additive: migrations `best-of`, `schedules` and `hibernation` only create tables. Turning hibernation off in Settings stops new hibernations; a hibernated run still wakes as above. Disabling or deleting a schedule stops its timer. A Best of N task without a kept variant can be cancelled; its variants' branches stay. Reverting the code leaves the tables unused; a hibernated run would then be marked interrupted at the next start and offered for resume, like any run of a stopped daemon.
