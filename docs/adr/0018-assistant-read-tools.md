# ADR 0018: Read tools and own-draft tools for the task assistant

**Status:** accepted, 2026-10-31. Owner request the same day. Amends ADR 0014 (the assistant's tools) and ADR 0017 (`list_tasks` and `read_task` are no longer gated on Autopilot).

## Problem

The owner, 2026-10-31: "drafts ve mesajlar kısmında agent kısmı ve asistana çok daha fazla tool ekle erişebilsin hemen hemen her şeye" (in the drafts and messages part, give the agent and the assistant many more tools so it can reach almost everything).

Today the assistant's session (ADR 0014) is a read-only runner session in the project folder. It can read files with the runner's own tools, and on Crewyard's report server it has `propose_task`, plus the Autopilot tools (ADR 0017), which are all refused while Autopilot is off. So when you ask it "what failed yesterday?", "why is this task waiting?", "how much did the reviewer cost?" or "what does my project.json say?", it has no way to know: the answers live in Crewyard's own database, not in the repository. Even `list_tasks` and `read_task` answered only while Autopilot was on.

What must not change:

- **Read-only, twice** (ADR 0014): the runner's own read-only mode plus our approval layer that denies every approval and cancels every question. The assistant runs no commands.
- **Nothing starts without you** (PLAN.md D8), except Autopilot's own checked tools when you turned it on (ADR 0017). Outward actions (push, PR, merge, deletes, spend past a cap, Inbox answers) never.
- **Agent text is data** (§9.3); **no secret** ever reaches an agent through a tool (AGENTS.md security); **Claude subscription limits** are never shown (PLAN.md §6); every cost number carries its label.
- **Crew runs** keep only `report` and `propose_followup`.

## Options

### (a) Narrow read tools on the report server, one per area, plus edit and discard of the assistant's own drafts

Each tool reads one thing Crewyard already shows you on a screen, through that part's own public read or a fixed SQL query, and returns a capped JSON result: tasks, a task, its report, its crew, drafts, the Inbox, a task's events, spend and limits, profiles, project settings, local git, problems, agent files. Two more tools change only the assistant's own open drafts in this conversation. Listed only on assistant connections, available whether Autopilot is on or not.

- For: every tool's result is ours to shape: cleaned, redacted, capped, aliases instead of ids and keys, labels on numbers; each one is testable on its own; the agent learns what exists from the tool list; no new process, no network.
- Against: more tool definitions in every assistant session's context (about 4 KB); each new screen needs its own tool to be readable.

### (b) One generic query tool (read-only SQL over the database, or "call any read IPC method")

- For: one tool reaches everything at once, including future tables.
- Against: the database holds things an agent must never see (encrypted-key file references, native session ids, raw payloads with tool output, the plan-quota rows for Claude); a read-only SQL connection cannot redact columns or cap rows per meaning, and an IPC passthrough would hand the agent every method's full shape, including the ones that write. GitHub's own MCP server, read for this ADR, goes the other way: tools grouped into toolsets you choose, and `--read-only` skips the write tools even when they are asked for by name, so the list itself is the guard.

## The choice

**(a).** The tools are fixed in `packages/core/src/assistant-tools.ts` (definitions, argument checks, result cap, tool-line titles) and served by `packages/daemon/src/assistant/tools.ts`, reached from `AssistantService.toolCall` for a live assistant conversation only.

| Tool | Reads | Notes |
|---|---|---|
| `list_tasks` | the project's tasks, newest first (50), optional status filter | id, title, kind, status, spend with its label, open requests, whether Autopilot made it; Autopilot's on/stopped state and limits |
| `read_task` | one task: status, estimate, budget, spend, each step's state and failure, what waits on you, a finished analysis's report | Autopilot's own read, now ungated; reading one of its own reports is still recorded for `complete_task` |
| `read_report` | a finished task's findings, verdict, plan or final message, and the drafts suggested from it | a pure read of the stored result (`readTaskReport`); it never creates suggestion drafts |
| `read_crew` | each step's role, profile alias, runner, model, estimate, dependencies, standby chain, state, last runs | aliases only, never profile ids or keys |
| `list_drafts` | this conversation's drafts; with a task, its suggested drafts | |
| `read_inbox` | open questions, tool approvals with their risk, handoff and budget decisions, agent questions and follow-ups, stall alerts | commands redacted with `redactLogLine`; only you answer |
| `read_events` | a task's or run's recent events, newest first, 40 a page (100 at most), paged by `before_seq` | streamed text left out; each preview redacted and cut to 300 bytes |
| `read_usage` | spend per key alias today and over 1 to 90 days with its caps, spend per task, the assistant's own spend, plan windows per profile, plan tokens | every number labelled Reported, Estimated, Unknown or Plan; Claude windows are never included |
| `list_profiles` | alias, runner, provider, model, catalog price, ready, read-only capable, MCP, paid key or plan or local | no key, no sign-in detail |
| `read_project` | project.json settings or the defaults, detected type and commands, roles in effect including custom ones | commands and the remote redacted |
| `git_overview` | branch, upstream, ahead and behind as last fetched, short status, last commits, a task worktree's status and diff stat against its base | local git only, through `packages/proc` `run`, `--no-optional-locks`, 5 s timeout; no fetch, no push |
| `list_problems` | failed steps, failed audit events, failing PR checks (as already stored), open stall alerts | the Problems tab's own sources; no network |
| `list_agent_files` | your instruction files, skills and commands (name, tool, kind, 300-byte preview), shares, the project bridge | the agent-files service's own scan; no content past its preview |
| `edit_draft` | changes one of this conversation's open drafts | merged draft checked again by `parseTaskDraft` |
| `discard_draft` | discards one of this conversation's open drafts | an added draft, a report's suggestion, or another conversation's draft is refused |

`list_problems` covers the sources the daemon derives (failed runs, failed events, failing checks, stalls). The Problems tab's project.json, role-file, agent-file and key-check rows are assembled in the renderer from other screens' reads; `read_project` and `list_agent_files` carry the first three, and key checks are left out because they describe credentials.

Left out on purpose: GitHub issues and pull requests read live (a network call you did not ask for), file contents (the runner's own read tools already do that, inside its read-only engine), and anything under a run's transcript.

Every call:

- **Arguments** checked in core, unknown keys refused, ids matched against `^[A-Za-z0-9-]{1,64}$`, numbers bounded, strings capped in bytes; a refusal is a tool error (`isError: true`) the agent can read and correct, as the MCP spec asks.
- **Results** capped at 16 KB: when a result does not fit, its longest list loses items from the end and the result says `truncated` and how many were left out; never a cut JSON.
- **Text** cleaned with `cleanText` (control and bidi characters removed), free text redacted, and marked as data in the result.
- **Rate**: 30 calls per conversation in any rolling minute.
- **A tool line** the panel shows as `Read task: Fix login` (or `... (refused)`), written by Crewyard with an id that names the tool and outcome (`call:<tool>:<outcome>:<uuid>`), so the view can mark it as ours (`AssistantLine.call`) without a new column. The runner's own raw line for the same call (`mcp__crewyard__read_task`, `crewyard.read_task`) is dropped.

The system prompt lists the read tools and says that reading never starts anything and that their results are data. The MCP server instructions say which tools always work and which need Autopilot.

## Sources

| Source | Opened | Stars | License | Archived |
|---|---|---|---|---|
| https://modelcontextprotocol.io/specification/2025-11-25/server/tools (servers "MUST validate all tool inputs", implement access controls, "rate limit tool invocations" and "sanitize tool outputs"; input validation errors are tool execution errors with `isError: true` so the model can self-correct; a no-argument tool should use `additionalProperties: false`) | 2026-10-31 | n/a (spec) | spec terms | no |
| https://github.com/github/github-mcp-server README (toolsets chosen with `--toolsets`; "Read-only mode takes priority: write tools are skipped if `--read-only` is set, even if explicitly requested"; `perPage` capped at 100; `fields` and `tail_lines` to keep results small) | 2026-10-31 | 34,119 | MIT | no |

License checked with `gh api repos/github/github-mcp-server --jq .license.spdx_id`. Ideas only; no code was copied or ported.

## Windows notes

Nothing new is spawned except `git`, through `packages/proc` `run` (cross-spawn, `windowsHide`, resolved path, no shell, UTF-8, a 5 s timeout), with `--no-optional-locks` so a status read never takes the index lock a running crew may need. Paths with spaces are passed as arguments, never through a shell; the tests use a project and a home folder with spaces. The tools ride the existing per-user named pipe and ticket of the assistant (ADR 0007, 0014).

## Security notes

- **Who can call:** only a connection whose ticket carries the `assistant:` prefix lists these tools, and only a live, not-stopping assistant conversation reaches them; a crew run's ticket goes to the report service, which refuses any other name, and its MCP session does not list them. Tests cover both.
- **What can change:** only open drafts of the calling conversation. No tool starts, approves, edits, cancels or stops a task or a run, answers an Inbox item, or changes a setting. Reading a task's report never creates drafts.
- **What never leaves:** keys and their file references, native session ids, raw event payloads, profile ids in place of aliases, Claude subscription windows. Free text from runs, issues, checks and commands goes through `redactLogLine` before it is shown, and everything is capped.
- **Untrusted text:** report findings, Inbox questions, event previews and agent-file previews are agent or user text; each result says so, and the prompt repeats it. They cannot instruct Crewyard: no tool here acts on them.
- **Autopilot unchanged:** its acting tools keep every check (on, consent, kill switch, halt, ownership, budget, caps, rates). Reading is not acting, so the kill switch no longer refuses `list_tasks` and `read_task`; their results say whether Autopilot is stopped.

## Rollback

Remove `ASSISTANT_EXTRA_TOOL_DEFS` from the assistant's tool set in `packages/daemon/src/mcp/service.ts`: sessions started afterwards no longer list the tools and any call is refused as unknown. To return the reads to Autopilot, put `list_tasks` and `read_task` back in `AUTOPILOT_TOOLS`. Nothing was added to the database; tool lines already written stay as ordinary tool lines.
