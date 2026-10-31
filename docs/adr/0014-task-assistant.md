# ADR 0014: Task assistant on the Tasks screen

**Status:** accepted, 2026-10-31. Owner request the same day.

## Problem

The owner, 2026-10-31: "tasks kısmında veya crew kısmında vs ai ile chat ile yönetmek olsa yani görevleri veya araştırılacak şeyleri ai ile de yapılandırabilsek terminal ile" (on the Tasks or Crew screen, manage things through a chat with an AI, so tasks and things to research can be structured with AI too, in a terminal-style view).

Today a task starts as one line in the composer, and the classifier (PLAN.md §9 step 1) guesses its kind and size from keywords. Turning a vague goal ("make onboarding faster", "find out why the Windows build is slow") into well-scoped tasks with acceptance criteria is work the user does alone, before Crewyard helps at all.

What a chat must not break:

- **Nothing starts without the user** (PLAN.md D8, DESIGN.md principle 6). The assistant may only produce drafts; each draft still becomes a task through the crew proposal, and nothing runs before that crew is approved.
- **No hidden model calls** (PLAN.md §9): "No hidden model calls happen without a configured key." The user picks the profile the assistant runs on, and its spend counts against that key's caps, labelled.
- **Read-only enforcement** (§9.1) by the runner's engine and our approval layer, never by the prompt.
- **Agent text is untrusted data** (§9.3): capped, shown as text, and a proposal becomes a task only on the user's click, as a draft.
- **D7 admission:** nothing spawns without a free slot and enough memory.

## Options

### (a) An interactive read-only session through the existing runner adapters

The assistant is one more session of a runner the user already set up (Claude Code, Codex, OpenCode, Gemini CLI), started through its `AgentAdapter` in the project folder with a read-only policy. It reads the code with the runner's own read tools to scope the work. It proposes drafts by calling a tool on Crewyard's own report server (ADR 0007), the same pipe, ticket and caps that `propose_followup` uses today.

- For: one path for keys, config folders and env scrubbing (PLAN.md §6); the runner's own read-only engine; it can actually look at the repository, which is what scoping needs; the drafts arrive as structured tool calls, checked by our parser, not scraped from prose; spend arrives as `usage.update` like any run and is priced the same way.
- Against: a runner process per conversation (memory, a start-up delay of a few seconds); only runners with MCP support can propose drafts; the session is not a crew run, so the orchestrator's run machinery (steps, worktrees, Inbox) does not apply and the assistant needs its own small lifecycle.

### (b) A direct model call through a provider key, without a runner

The daemon calls the provider's chat API itself with a stored key and a JSON schema for drafts.

- For: no process, fast, cheapest in memory.
- Against: a second way of talking to every provider (Anthropic Messages, OpenAI Responses and Chat Completions, Gemini), each with its own auth, errors and structured-output dialect, which PLAN.md D3 and §6.1 deliberately left to the runners; it cannot read the code unless we build file tools and their sandbox ourselves; it does not work at all for plan sign-ins (ChatGPT, Google), which only the CLIs may use (D4); and it would be the first place Crewyard sends a key over the network itself, a new path to keep out of logs.

## The choice

**(a).** A read-only runner session per project, proposing drafts through a new report-server tool.

- **One assistant per project at a time.** `packages/daemon/src/assistant/` owns its lifecycle; `packages/core/src/ipc/assistant.ts` is its IPC area and `packages/daemon/src/handlers/assistant.ts` its handlers.
- **Profile:** you pick it in the panel. Offered: ready profiles whose runner claims read-only enforcement and MCP. Others are listed disabled with the reason. The default is a profile with the read-only preset first, then the cheapest model by catalog input price.
- **Read-only policy:** `{ writes: "none", allowCommands: [], network: "denied" }`, the same shape reviewers get, so each adapter puts its runner in its read-only mode (Claude Code's permission rules, Codex's read-only sandbox, OpenCode's ruleset, ACP permission answers). Our layer then answers every approval request with a deny ("The task assistant is read-only") and every question with a cancel (the assistant asks in its reply instead). Reads that need no approval, like Claude Code's Read and Grep inside the working folder, still work. The assistant gets Crewyard's report server and nothing else: the user's own MCP servers are left out, because their read-only marks are the servers' own claims (MCP spec: annotations are untrusted).
- **Drafts:** a new report-server tool, `propose_task` (title, description, kind `code` / `research` / `review` / `docs`, acceptance criteria, suggested size `S` / `M` / `L`), offered only on assistant connections; crew runs keep `report` and `propose_followup` only. Its arguments go through the same checks as follow-ups (core `cleanText`, byte caps refused rather than cut, at most 12 criteria, 20 drafts per conversation). A draft is a card in the panel, editable; `Add as draft` calls the orchestrator's public `propose()`, so the task gets a crew proposal and waits for your approval like any other; `Discard` drops it. A research request becomes a `research` draft and its questions become acceptance criteria. Reusing `propose_followup` itself was considered: it has no kind, criteria or size, and its proposals go to the Inbox, which is the wrong place for a draft you are shaping in a conversation; the server, pipe, tickets and parser are shared instead.
- **Conversation:** the transcript and the drafts are stored (three tables in one migration), so closing the panel or restarting the app keeps them. Each assistant reply is capped at 32 KB, each of your messages at 8 KB; the view shows the newest 200 lines.
- **Turns:** one session stays open between messages: at each turn boundary the adapter's `nextTurn` waits for your next message. A message sent while the assistant works waits and goes at the next boundary.
- **Stop:** `Stop and close` on the panel, `Esc` inside it, `New conversation`, or idle. Idle uses the hibernation setting's minutes (Settings, default 30), whether or not hibernation is on, because the assistant holds nothing worth keeping a process for. A later message resumes the native session where the runner supports resume, otherwise starts a new one with the recent conversation quoted as earlier context.
- **Spend:** usage is priced exactly as runs price it (runner estimate or catalog price, with the provider's peak factor), written to the spend ledger on the profile's key with no task, and shown in the panel's header with its label: Estimated, Reported (only when the provider billed it), Unknown (no price; never a number) or Plan (a plan sign-in, tokens only). The key's daily cap is checked before the session starts, before each message is handed over, and after each usage update; a reached cap stops the assistant with the reason. Per-task caps do not apply: there is no task.
- **Admission:** the assistant needs a free global slot and the minimum free memory (`admit()` from `admission.ts`, the same rule as runs) before it starts. It does not take a project slot, and crew runs do not count it, so a conversation never holds a crew back.
- **Orchestrator:** untouched except two read-only accessors (the profile directory and the adapter for a runner), added last, because the orchestrator is being split by another session.

### "Close is not stop"

DESIGN.md says closing a panel never stops an agent. The owner's request for this panel is the opposite: the assistant stops when the panel closes. Both hold, because the assistant is not a crew agent: it does no work of its own, writes nothing, and its conversation and drafts survive the stop. The panel's close control says what it does (`Stop and close`), so nothing is stopped by a control that looks like a plain close. DESIGN.md records this as the one exception.

## Addendum, same day: reports, findings and presets

The owner, after a first try: "taska kısmında projeyi incele yazdım ve sonuç hiçbir şeyi değiştirmedi, arayüzde sadece done yazdı; bunun yerine task önerisi veya task açma gibi şeyler olmalı, ve hazır olarak projeyi incele ve yorumla, optimizasyon öner, sorunları bul, güvenlik sorunlarını bul gibi hazır tasklar olsa veya projeye göre otomatik oluşturulsa; yeni ekleyeceğimiz şeyde onlar olsun" (I typed "review the project" in Tasks and the result changed nothing, the UI only said done; instead there should be task suggestions or opening tasks, and ready-made tasks like review and comment on the project, suggest optimizations, find problems, find security issues, or ones generated for the project; put them in the new feature).

What had happened: "projeyi incele" was classified as a `review` task, a reviewer on OpenCode ran, and its checked `review.verdict` (pass, a 2,226-character summary) sat in the event log while the row and the inspector said only "Done".

- **Reports are visible.** A finished non-code task (research, review, docs) shows its result: the first line of the summary on the row with the finding and suggestion counts and `Open report`, and the whole report in the inspector's Details. The daemon reads, newest first, the researcher's checked findings, a reviewer's verdict (its comments become findings: blocker critical, major high, minor medium, nit low), a planner's plan, or else the last run's final message rebuilt from its streamed text (`packages/daemon/src/assistant/reports.ts`). Agent text is cleaned, capped (summary 16 KB, 50 findings of 2 KB) and shown as text.
- **Researchers end with checked findings.** `ResearchFindings` joins the reviewer's verdict and the planner's plan in `packages/core/src/results.ts`: a summary and findings, each with a severity (critical to info), file and line (or null), what was seen, and a suggested task or null. It is asked of every researcher run through the runner's structured output (`outputSchemaFor`, in `orchestrator/results.ts`, not the orchestrator itself) and audited as `research.findings`. A researcher that answers in free text still completes; its result is recorded invalid, as for the other roles, and its report falls back to the final message.
- **Findings become drafts.** Each finding's suggested task, and every open `propose_followup` of that task, becomes a draft card under the report, created once per task (`assistant_drafts.source_task_id` and `source_key`, unique). `Add as draft` goes through the same `propose()`, so nothing starts without the crew approval; adding a follow-up there closes its Inbox item as accepted.
- **Presets, no model call.** Six local templates in `packages/core/src/presets.ts`: review the project and comment, suggest optimizations, find bugs and problems, find security issues, audit dependencies and licences, find test coverage gaps. Each is a `research` task (size M) whose description carries a fixed output contract (findings with severity, file and line, a suggested task per finding, change nothing). They are in the composer (`Ready-made`, which fills the text and sets the kind) and in the assistant's drafts column (a click adds an editable draft). So "projeyi incele" now lands as an analysis with findings, not a code-review verdict.
- **Project-based suggestions, no model call.** From local facts only (detected project type, the test command, a dependency manifest, commits in the last 14 days, whether a remote exists) the panel puts up to three presets first under "For this project", each with its reason (`suggestPresets`). Open GitHub issues are left out: reading them is a network request the user did not ask for here.
- **Suggest tasks for this project** is one explicit message to the assistant on the chosen profile. Its cost is shown on the button before the click, Estimated from the catalog price at an assumed 60,000 input and 4,000 output tokens (Unknown without a price, Plan for a sign-in), so no model call is hidden (PLAN.md §9).

Options considered for presets: (a) a model call that writes the task list for each project, or (b) fixed local templates plus local facts to rank them. (b) was chosen: it costs nothing, works offline and before any profile exists, and the model call stays one explicit, priced click.

## Addendum, 2026-10-31: a conversation you can work with

The owner: "mesaj gönderdikten sonra mesajlar kısmında düşünüyor gibi durumları da göster sadece üst kısmında değil ve agent mesajı daha interaktif ve kullanışlı olsun mesela: seçilebilir veya tıklanabilir ve mesaj yazdığım kutucuk çok belirgin değil" (after I send, show states like thinking in the messages too, not only at the top; make the agent's messages more interactive and useful, selectable or clickable; the box I type in is not prominent enough), and "add as draft yapınca open task açılıyor ama open task tepki vermiyor" (after Add as draft, Open task appears but does nothing).

- **Live row.** While a turn runs, the end of the log says what it is doing: starting, thinking, or the runner's title of the latest call, with the time since your message and any message queued for the next turn boundary. It is derived in the renderer from the state and the lines the view already carries (`screens/tasks/assistant/model.ts`, `liveState`), so the daemon and the IPC contract are unchanged. A wait for an agent slot is not a state here: admission refuses at send with the reason, as before.
- **Replies as text-only Markdown.** Replies go through the Files tab's reader (`shell/files/markdown.ts`), which yields plain data turned into React elements: raw HTML stays text, links show their target and are never followed, images are named and never fetched. Each reply offers Copy, Quote and `Make drafts from this`; the last one sends a fixed, visible message (priced like any other) asking for `propose_task` drafts, so it adds no new path to a model. Paths in code marks and tool lines can be copied; nothing in agent text opens anything.
- **Open task.** It used to select the task only, which showed nothing: after `Add as draft` that task was already selected, and from the bottom panel on another screen, or from the inspector, the selection was invisible. It now switches to the project's Tasks screen, selects the task, opens the inspector on Details and moves focus to its row (`screens/tasks/assistant/openTask.ts`); the Autopilot log's task links do the same.

## Sources

| Source | Opened | Stars | License | Archived |
|---|---|---|---|---|
| https://modelcontextprotocol.io/specification/2025-06-18/server/tools (tools/list, tools/call, `isError`; "clients MUST consider tool annotations to be untrusted unless they come from trusted servers"; a human in the loop for tool invocations; servers must validate inputs and rate limit) | 2026-10-31 | 9,570 (modelcontextprotocol/modelcontextprotocol) | NOASSERTION in the API (spec text under its own terms) | no |
| https://code.claude.com/docs/en/permissions (read-only tools such as file reads and Grep need no approval within the working directory; Bash, edits and web fetch do) | 2026-10-31 | n/a (docs) | n/a | n/a |
| https://github.com/eyaltoledano/claude-task-master README and docs/task-structure.md (turns a PRD or a chat request into tasks through MCP tools such as `parse_prd`, `add_task`, `expand_task`; task fields title, description, details, testStrategy, priority, dependencies; runs either on a provider key or through a local Claude Code or Codex CLI) | 2026-10-31 | 28,279 | "MIT with Commons Clause" in its README, NOASSERTION in the API; read only, nothing used | no |

What Task Master does differently, and why we do not: it writes tasks straight into a `tasks.json` in the repository and lets the model set dependencies and status. Here the model only proposes; every task is created by your click, through the crew proposal, in Crewyard's database. Ideas only (structured fields per task, test strategy as acceptance criteria); no code was copied or ported.

## Windows notes

- The runner is started by its adapter exactly as for runs: `cross-spawn`, `windowsHide`, resolved `.cmd` shims, killed as a tree on stop (`packages/proc`).
- The report server is the existing PowerShell 5.1 relay over the per-user named pipe; the assistant only gets its own ticket, revoked when its process ends.
- The project path is the working folder; paths with spaces are covered by the e2e repository (`demo repo with spaces`).

## Security notes

- **Read-only, twice:** the runner's own read-only mode, plus our approval answers (every approval denied, every question cancelled). The policy is a constant in `packages/core/src/assistant.ts` with tests.
- **Cannot start anything:** the assistant's only tool is `propose_task`, which stores a draft. The handler that turns a draft into a task is reachable only through IPC from the renderer, i.e. your click; the tool result tells the agent that nothing starts.
- **Untrusted text:** drafts are checked and capped by core, stored as text and rendered by React as text (no HTML, no links). Assistant replies are capped per message; control and bidirectional-override characters are removed (`cleanText`). Replies are shown through the text-only Markdown reader (see the 2026-10-31 addendum): its output is data, never HTML, and a link's target is shown, never opened.
- **Keys:** only through the profile's env from the DPAPI store, as for runs; never on a command line, in a message, a log or the transcript table.
- **Tickets:** one per assistant process, prefixed so a crew run's ticket can never act as an assistant's and the other way round; revoked on stop.
- **Spend:** recorded and checked against the key's daily cap; a reached cap stops it.

## Rollback

Revert the commits. Researcher runs then stop asking for findings; stored `research.findings` events stay in the log and are ignored. The migration `assistant` adds three tables (`assistant_conversations`, `assistant_messages`, `assistant_drafts`) that nothing else reads; an older build ignores them. Spend rows it wrote stay in the ledger with no task, which the Usage ledger already handles. Tasks created from drafts are ordinary tasks and stay.
