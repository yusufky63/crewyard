# ADR 0019: Orchestra, Crew and Solo, with Orchestra as the default

**Status:** accepted, 2026-11-01. Proposed 2026-10-31, the day of the owner's request, and built the next day. Changes PLAN.md D8 and DESIGN.md principle 6. Rules in PLAN.md §9.8; screens in DESIGN.md §5.

## Problem

The owner, 2026-10-31: "orkestra olsun default ve kullanımı diğer popüler github repolarında nasıl yapıldığına da bak, yönetimi kolay olsun, yani önce araştır sonra en uygun şekilde ekle" (make Orchestra the default, look at how popular GitHub repos do it, make it easy to manage; research first, then add it in the most suitable way).

Before this change a task was one line in the composer: the classifier picked its kind and size, the scorer proposed a crew, you approved, and the steps ran in one worktree. A goal that needed several tasks was split by hand. Nothing recorded the goal, its budget or its progress, nothing ordered the tasks, and nothing warned when two parallel tasks would touch the same files. PLAN.md §2 rejected an LLM orchestrator that spawns workers (agent-orchestrator #3921, #6842). D8 said nothing starts without you except Autopilot and schedules.

What must not change:

- Outward actions (push, PR, merge, deleting a worktree or branch, spend past a cap) and Inbox approvals always go through you.
- Budgets and caps are checked by the daemon on every call, never by a prompt. D7 admission decides when a step starts.
- Every cost carries Reported, Estimated or Unknown. Agent text is data. Findings reach code only through your click (PLAN.md §9.6).

## Options

### (a) An LLM coordinator that spawns and steers workers (agent-orchestrator, Orca, Roo Code, Magentic)

- For: flexible; reacts to what workers find.
- Against: the failure modes we read are this design's own. Runaway fan-out (agent-orchestrator #3921). Roles escaping (#6842). Token burn by a coordinator that only delegates (Orca #35557). Stalls when the manager must advance the plan (paperclip #1280). Sequential-only approval spam (Roo #12330). It contradicts PLAN.md §2.

### (b) Manual decomposition only (Conductor, Vibe Kanban, Crewyard before this change)

- For: no model call; the person stays in control.
- Against: does not answer the request. No goal record, no dependencies, no overlap warning (Vibe Kanban #1700 asks for dependencies that start the next task).

### (c) An LLM-written plan, approved once, run by the daemon's deterministic scheduler (Gas Town staged convoys and reconciler, paperclip plan approval and blockers, Magentic-UI co-planning, Claude Code workflows' "who decides what runs next: the script")

- For:
  - One read-only model call produces a checked plan.
  - You see the whole plan, its order, the files each task plans to change and the total estimate before anything runs.
  - Tasks are ordinary tasks with crews, worktrees, budgets and D7.
  - Replans are bounded and need approval.
- Against:
  - A planning run per goal and per revision costs money. Mitigated by:
    - a stated ceiling;
    - a first-use card before the first spend;
    - free single-task routes for presets, issues and drafts;
    - single-task collapse.
  - A plan can be wrong. Mitigated by review, the last review of all changes, and bounded replans.
  - Every surveyed tool except Magentic-UI defaults to a single task. Orchestra as the default is the owner's choice; staging, caps and cost labels make it safe.

## The choice

(c). The composer has three modes: Orchestra (default), Crew and Solo. Solo is never remembered between submissions.

- **Default:** the composer opens on Orchestra in every project with a profile that can plan (ready, read-only enforcement, structured output); otherwise on Crew, with Orchestra disabled and its reason. It reopens on Orchestra or Crew, whichever you last submitted in that project. Ready-made analyses and imported issues always go to one Crew task; assistant drafts are proposed as one task, as before.
- **Planner:** a hidden planning task with one step of a read-only `goal-planner` role.
  - The role is a saved role snapshot, outside the built-in role list; a role file named `goal-planner.md` is refused.
  - It has no user MCP servers and no `propose_followup`.
  - It has its own budget: min(project per-task cap, max(3 × estimate, $0.25)), shown on the composer as the ceiling.
  - It returns a strict, simple `GoalPlan`: at most 8 tasks (the cap every goal gets; 12 is only the parser's absolute ceiling), dependencies only on earlier tasks, planned paths, and the words of the goal each task rests on (a soft check).
  - Core `parseGoalPlan` checks it again and refuses rather than cuts.
  - One corrective turn goes through `messages.followUp` once D7 admission lets it start; a second refusal fails the plan with the parser's words.
- **Approval:** one `Approve and start` per revision approves every accepted task, idempotently (`goals.approve` takes the revision and the accepted keys and checks them in one transaction).
  - `tasks.approve` refuses goal tasks (`task.goal_managed`).
  - A task's crew is approved only when the goal scheduler releases it.
  - The goal budget is always set (prefilled from the project default and the plan total) and is split into task budgets. The existing task-budget, reservation and unpriced-spend rules enforce it. A task with an Unknown estimate needs a budget typed on its tile.
  - A plan of one task becomes an ordinary task with no goal branch.
- **Scheduling:** a `GoalRunner` part, called once at the start of every scheduling pass, each goal inside its own try/catch.
  - It releases ready tasks in priority order, at most `max_parallel` (2, bounds 1 to 4) per goal.
  - A prerequisite is ready when:
    - a writing task has been merged into the goal branch;
    - a task that writes nothing is done and, when it feeds a writing task, its report is accepted by you.
  - It holds every goal task and planning task of a paused goal, and of every goal while `Pause all goals` is on, approved or still planning; a queued corrective turn waits too. Pause and `Pause all goals` pause the goal's running steps, planning runs included, at their next turn boundary.
  - Released tasks go through the normal dispatcher, D7 and caps.
- **Overlap:** planned paths compared before approval, and overlapping tasks put in order automatically (`Run side by side anyway` removes the order). `git merge-tree` before each merge.
- **Goal branch:** a hidden integration task owns a worktree on `crewyard/goal/<words>-<id6>`.
  - Finished writing tasks (code and docs) are merged into it with `git merge --no-ff` after a clean `merge-tree` check.
  - A conflict holds the dependent tasks and asks you. The fix goes to the implementer through `followUp`, which re-runs Test and Review.
  - The integration task's single reviewer step, the last review of all changes, is pinned to the branch head. The existing PR gate requires its `pass`.
  - You open the pull request through the existing task-bound flow.
  - Goal task branches are left out of the push queue; only the goal branch is offered for push and PR.
- **Replans:** only on your click. Finished, running, released, joined and edited tasks are frozen. At most 5 revisions before approval and 3 replans after it, each needing approval. `Add task` is a revision with no planner call. A `changes` verdict raises a decision with a Replan button and never plans by itself.
- **Limits:**
  - task shares of the goal budget;
  - key caps;
  - the project daily cap (`budget.dailyUsd`, enforced for the first time, as cap kind `project_daily`);
  - 2 at once per goal;
  - stop after two goal tasks fail the same way or three fail in total;
  - the `Pause all goals` kill switch.
- **Switches:** Settings → Orchestra holds the `Orchestra` switch (`orchestra.enabled`, on by default; off hides Orchestra in the composer and refuses new goals, while approved goals keep their scheduler) and `Pause all goals`, which is also in the command palette and shows as `Goals paused` in the status bar while it is on.
- **D8 amendment:**
  - `Plan goal` starts only the read-only planning run, with its estimate and ceiling on the composer. The first goal in a project shows what Orchestra does first.
  - `Approve and start` approves the accepted tasks. Tasks that wait for others start when those are done and merged.
  - A research result reaches a writing task only after you accept it.
  - Revisions, replans, added tasks and spend past a cap need your click again.
  - Solo's `Start` is its approval, and an Unknown estimate, or one a cap would hold, turns it into `Propose`.
  - Push, PRs, merges into your branches, deletes and Inbox approvals stay with you.

## What was built

The work landed in ten items on `orch/main` (design `§7.1`), merged in the order core model, TaskFlow, planner and runner, project daily cap, goal view, handlers, composer, end-to-end flows and these docs.

| Part | Where |
|---|---|
| Plan checks, task graph, overlap, budget split, stop rule, derived status, limits | `packages/core/src/goals.ts` (`parseGoalPlan`, `readySet`, `layers`, `wouldCycle`, `applyPlanRevision`, `overlapPairs`, `splitBudget`, `planningBudget`, `deriveGoalStatus`, `goalStopRule`, `GOAL_LIMITS`, `GOAL_SETTINGS`) |
| IPC | `packages/core/src/ipc/goals.ts` (`goals.*` and the `goals.changed` topic); `tasks.preview`, `tasks.start`, `TaskSummary.goal` and `task.goal_managed` in `ipc/tasks.ts` |
| Tables | one migration in `store.ts`: `goals`, `goal_plans`, `goal_tasks`, `goal_task_deps`, `goal_joins`, `goal_decisions` |
| Daemon parts | `orchestrator/goals/`: `planner.ts` (`GoalPlanner`), `prompt.ts`, `runner.ts` (`GoalRunner`), `join.ts` (merges), `edits.ts` (plan edits, approval, project defaults), `view.ts` (goal list and detail), `events.ts` (goal events and topic) |
| Handlers | `packages/daemon/src/handlers/goals.ts` |
| Screens | `screens/tasks/`: `Composer.tsx` (mode control, planner and who chips), `GoalIntro.tsx` (first-goal card), `GoalPlanReview.tsx`, `GoalView.tsx`, `GoalRow.tsx`; `screens/inbox/Goals.tsx`; `screens/settings/OrchestraSection.tsx`; `shell/status/goals.tsx`; goal toasts in `main/notify/rules.ts` |
| Tests | rules next to each module; `apps/desktop/e2e/orchestra.spec.ts` drives the whole flow on scripted runners and real git; the live flow `goal` in `packages/daemon/src/live/flows.live.ts` measures real planning runs |

Where the build differs from the proposal:

- **Settings → Orchestra was added.** The proposal had `orchestra.enabled` only as a settings row. A row nobody can change in the app is not a rollback lever, so Settings has the switch, beside `Pause all goals` (`goals.setEnabled`). Your choice is stored, so a later change of the shipped default never overrides it.
- **The project default goal budget** is set on the first-goal card and prefilled on each plan, where it can be changed before approval. The proposal also put it in Settings → Project; that field is not built yet, though `goals.setProjectDefaults` exists for it.
- **The planner you pick** on the planner chip is remembered per project by the daemon (`orchestra.planner.<projectId>`), because `goals.create` pins it there; the proposal kept it in renderer preferences.
- **The minimum Git version** for `merge-tree --write-tree` is 2.38.0 (`MIN_GIT_MERGE_TREE`); the machine check reports an older Git as outdated.
- **The planning estimate** is still the fixed heuristic (80,000 input and 8,000 output tokens at the catalog price). The end-to-end flow checks the spend label and the ceiling with scripted token counts; the live flow `goal` records real counts next to the heuristic. Correcting the heuristic from those numbers is still open before release (PLAN.md §17).
- **The task cap is fixed at 8 per goal.** The proposal let a plan refused for too many tasks offer `Raise the limit to 12 and retry` (bounds 1 to 12). That action is not built: `goals.max_tasks` is always written as 8 and nothing in the app changes it, so 12 is only the parser's absolute ceiling.
- **The planner's corrective turn waits for D7.** The proposal listed it with the launches that skip admission. It is queued and started from the dispatcher's pass only once admission (slots, memory, spend held) lets it, and it stays queued while the goal or every goal is paused.
- **Pause covers planning.** A paused goal's planning task starts no run, `Pause all goals` reaches goals that are still planning, and both pause a planning run in flight at its turn boundary, so the kill switch stops every goal's spend.
- **"A first approved crew"** in the Guide's Getting started list does not count a goal's hidden planning or integration task, because the daemon approves those, not you.

## Sources

Opened on 2026-10-31. Stars, license and archived from `gh api repos/OWNER/REPO` the same day; star counts drift by a few during a day. Ideas only; no code was copied or ported.

| Source | Opened | What it showed | Stars | License | Archived |
|---|---|---|---|---|---|
| https://github.com/OrchestratorInc/agent-orchestrator `backend/internal/session_manager/prompt.go`, `frontend/src/renderer/lib/spawn-orchestrator.ts`, issues #3921, #6842, #4951 | 2026-10-31 | LLM orchestrator splits in free text and spawns with `ao spawn`; relaunch only on a click ("loops against a metered API"); crash at 40+ workers, no cap; reviewer escapes its role; lifecycle events do not wake the orchestrator (closed, not planned) | 13,960 | Apache-2.0 | no |
| https://github.com/paperclipai/paperclip `packages/shared/src/validators/issue.ts`, `server/src/services/issues.ts`, `server/src/services/budget-reservations.ts`, `docs/guides/board-operator/delegation.md`, issues #3307, #1280, #7641 | 2026-10-31 | `suggest_tasks` 1–50 drafts with `clientKey`/`parentClientKey`; checkout refused while blocked; cycles refused; reservations before dispatch; strategy approval; passive CEO; manager does not advance; an import injected 20 concurrent runs per agent into 10 agents and ran a host out of memory (16 GB per the title, 32 GB per the body) | 109,367 | MIT | no |
| https://github.com/stablyai/orca `docs/site/content/docs/cli/orchestration.mdx`, `src/shared/nested-worker-depth.ts`, `src/main/runtime/orchestration/db/dispatch-context/dispatch-circuit-breaker.ts`, issues #35557, #30058 | 2026-10-31 | orchestration experimental; task statuses incl. `ready` and `blocked`; fences in code: depth 1, circuit break at 3; coordinator token use; per-run notifications asked for | 111,636 | MIT | no |
| https://github.com/Kilo-Org/kilocode `packages/kilo-docs/pages/code-with-ai/gastown/concepts.md`, `.../gastown/settings.md`, `.../agents/orchestrator-mode.md`, `.../automate/agent-manager-workflows.md` | 2026-10-31 | staged convoys default true; reconciler dispatches when dependencies met, no double-dispatch; landing review; max polecats 2, max review cycles 3; Orchestrator mode deprecated; "Do not run more than four or five agents at once"; "Merge slices in dependency order"; "Worktrees isolate the filesystem, not the semantics" | 27,818 | MIT | no |
| https://github.com/RooCodeInc/Roo-Code `packages/types/src/mode.ts`, `apps/docs/docs/features/boomerang-tasks.mdx`, issues #12330, #5376, #5776 | 2026-10-31 | Orchestrator with `groups: []`; approve creation and completion of each subtask; parallel execution requested (83 comments); aggregate cost requested; resume of multi-task trees | 24,254 | Apache-2.0 | **yes** |
| https://github.com/cline/kanban `src/prompts/append-system-prompt.ts`, `web-ui/src/types/board.ts` | 2026-10-31 | board agent "NOT a coding agent"; linked backlog tasks start when the prerequisite is done; auto-commit chains; `BoardDependency` | 1,376 | Apache-2.0 | no |
| https://github.com/github/spec-kit `templates/tasks-template.md`, `templates/commands/implement.md`, issues #4383, #3068 | 2026-10-31 | `[P]` = different files, no dependencies; Foundational phase first; same files run sequentially; halt on a non-parallel failure; detail lost between spec and tasks; parallel waves declined | 144,248 | MIT | no |
| https://github.com/microsoft/magentic-ui (branch `magentic-ui-0.1`) `src/magentic_ui/teams/orchestrator/orchestrator_config.py`, `_prompts.py` | 2026-10-31 | co-planning on by default; autonomous off; `max_replans` 3; `max_json_retries` 3; `needs_plan`; clarify at most once; two-sentence progress summary | 10,109 | MIT | no |
| https://github.com/microsoft/agent-framework `python/packages/orchestrations/agent_framework_orchestrations/_magentic.py` and https://learn.microsoft.com/en-us/agent-framework/user-guide/workflows/orchestrations/magentic | 2026-10-31 | plan review approve or revise; Python off, .NET `RequirePlanSignoff` on by default; stall → reset and replan, reviewed with `is_stalled`; untested outside the Magentic-One design | 14,419 | MIT | no |
| https://github.com/microsoft/autogen `.../_magentic_one/_magentic_one_group_chat.py` | 2026-10-31 | `max_turns` 20, `max_stalls` 3 | 61,653 | CC-BY-4.0 in the API (docs) | no |
| https://github.com/eyaltoledano/claude-task-master `scripts/modules/task-manager/find-next-task.js`, issue #1392 | 2026-10-31 | next task by priority 3/2/1 among tasks whose dependencies are done; cancelled dependencies once blocked dependents | 28,283 | NOASSERTION (README: MIT with Commons Clause); read only | no |
| https://github.com/gastownhall/beads `docs/core-concepts/dependencies.md` | 2026-10-31 | ready when all blocking dependencies closed; layers; cycles refused at write time | 28,326 | MIT | no |
| https://github.com/FoundationAgents/MetaGPT `metagpt/schema.py` | 2026-10-31 | "FIXME: if LLM generates cyclic tasks, this will result in infinite recursion" | 71,108 | MIT | no |
| https://github.com/BloopAI/vibe-kanban `packages/web-core/src/features/kanban/model/hooks/useKanbanFilters.ts`, issues #1700, #3111 | 2026-10-31 | blocking is a display filter; dependency-triggered start requested; subtasks hard to work with | 28,537 | Apache-2.0 | no |
| https://github.com/getpaseo/paseo `public-docs/orchestration.md`, issue #3217 | 2026-10-31 | "Tool injection is off by default"; one send created six agents (duplicate accept, not fan-out) | 22,608 | NOASSERTION in the API (LICENSE file not opened) | no |
| https://github.com/generalaction/emdash issue #322 | 2026-10-31 | merge orchestration across parallel worktrees requested | 6,128 | Apache-2.0 | no |
| https://github.com/crewAIInc/crewAI issue #4783 | 2026-10-31 | hierarchical delegation by a manager agent fails | 60,349 | MIT | no |
| https://code.claude.com/docs/en/workflows and https://code.claude.com/docs/en/agent-teams; https://github.com/anthropics/claude-code issue #33045 | 2026-10-31 | "Who decides what runs next: The script"; plan approval prompt; no mid-run input; 16 concurrent, 1,000 per run; teams experimental, blocked tasks not self-claimed, "Task status can lag", same-file overwrites; worktree isolation ignored for team agents | 154,070 | none in the API | no |
| https://learn.chatgpt.com/docs/agent-configuration/subagents; https://github.com/openai/codex issue #36973 | 2026-10-31 | subagents on by default, spawned on a direct request or instructions; parallel writes conflict; more tokens; conflicting delegation guidance | 132,460 | Apache-2.0 | no |
| https://kiro.dev/docs/specs/; https://github.com/kirodotdev/Kiro issue #11786 | 2026-10-31 | "Run all tasks" in dependency waves; Quick Spec without approval gates; runaway reported as succeeded | 4,422 (issue repo) | none in the API | no |
| https://www.conductor.build/docs/concepts/workflow | 2026-10-31 | "Create a workspace for each shippable unit of work"; the person breaks down the problem | n/a (closed source) | proprietary | n/a |

Items taken from the researchers' notes and not re-opened (Kiro #10098, Vibe Kanban #2469 and #2720, agent-orchestrator #5598, paperclip #14069, Cursor's first-use spend limit) are not evidence for this decision. Tools whose sources were not re-opened (Cursor, goose, OpenHands, ruflo, Sculptor, Claude Squad, LangGraph, the OpenAI Agents SDK) are left out.

## Windows notes

- No new process kind. The planner and every goal task start through the existing adapters: `cross-spawn`, `windowsHide`, resolved `.cmd` shims, process trees killed with `taskkill /T /F`.
- Git goes through `packages/proc` `run`, with no shell:
  - `merge-tree --write-tree -z --name-only`, where exit 1 means conflict, not an error;
  - `merge --no-ff --no-edit` in the integration worktree.
- One extra worktree per goal with a writing task. It is created through the existing `ensureWorktree`, under the project's worktree root.
- `merge-tree --write-tree` needs Git 2.38.0 or newer; the installed Git 2.56.0.windows.3 has it. The machine check reports an older Git as outdated.
- Path comparison is case-insensitive with `/` separators, as Windows compares files. Planned paths are compared, never opened.
- Tests keep spaces in repository paths ("demo repo with spaces") and Turkish text in goals and plan fields.

## Security notes

- The planner is read-only twice (the runner's engine, our approval layer). It has no user MCP servers and no tool that creates a task, goal or run. Its only output is the checked result.
- Every plan field is cleaned, capped and refused rather than cut. Paths are validated against absolute paths, `..`, drives, UNC, streams and device names, and only ever compared.
- Goal text, reports, issue text and agent output are data: quoted in prompts and shown as plain text. A report from a task that writes nothing reaches a writing task only after you accept it.
- Approval is idempotent per revision (checked inside its transaction). `tasks.approve` refuses goal tasks. Release re-checks each crew. Every release, hold, merge and decision is an audited `goal.*` event.
- Crewyard merges only into its own goal branch, inside its own worktree, and never pushes. Your branches and the remote are touched only through the existing push and PR flows on your click. The goal PR passes the same gate as any task PR, including a review pinned to its head.
- Spend:
  - The goal budget is always set and is split into task budgets that the existing caps enforce.
  - An Unknown estimate needs its own typed budget.
  - The project daily cap is enforced.
  - The planning ceiling is shown before the click.
- The `Orchestra` switch and `Pause all goals` change only on a real boolean; a malformed call is refused and changes nothing.
- The planner's corrective turn starts only after D7 admission, and not while the goal or every goal is paused.
- Known gap: the conflict fix sent to the implementer (`Send to the implementer`, your click) and PR feedback launch through `messages.followUp` without D7 admission. Tracked as later work.

## Rollback

- Turn `Orchestra` off in Settings: no new goals, and the composer opens on Crew; approved goals continue in their order. `Pause all goals` pauses every goal at once, planning runs included.
- Reverting the code leaves six tables and some settings rows that nothing else reads. Unknown events are skipped by the timeline.
- Goal tasks are ordinary tasks. The ones not yet released stay proposals, because their crews were never approved. An older build cannot start them without a click, and their descriptions name what they wait for ("[Goal: waits for 01, 02]").
- The goal branch stays a local branch in its worktree. The existing cleanup removes it after confirmation.
