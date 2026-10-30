# ADR 0007: Crew report server over MCP, per-run MCP servers, MCP management

**Status:** accepted, 2026-10-30. Feature scan item A14, plus the MCP management the scan listed under "Later, not now" (emdash, cc-switch). This task brought that item forward. PLAN.md itself does not schedule it, so nothing in the plan changes.

## Problem

Agents had no structured way to tell the orchestrator where they are. A question went through the runner's own question tool, which only some runners have. A blocker or a finished task showed up only in free text. Work an agent noticed outside its task was lost, unless it tried to do that work itself.

PLAN.md §9.1 says "a run cannot create other runs; if an agent asks for more work, the request becomes an Inbox item". Nothing gave an agent a way to make that request.

Users also could not give runs their own MCP servers (a GitHub server, a docs server) without editing each runner's config by hand. A hand-edited config also bypasses the role policy and the DPAPI rule for secrets.

The hard part is the transport. Runners start stdio MCP servers themselves. Crewyard has no TCP listener (AGENTS.md). And the packaged app cannot run as Node, because the `runAsNode` fuse is off (`electron-builder.config.cjs`).

## Options for the transport

1. **A Node script as the stdio server**, started with the system `node` or with `ELECTRON_RUN_AS_NODE`.
   - The packaged exe refuses `ELECTRON_RUN_AS_NODE`: the fuse is off on purpose (agent-orchestrator #6446).
   - A system Node is not guaranteed: Claude Code and OpenCode both ship standalone binaries.
2. **A file spool.** The server writes JSON files into a per-run folder, and the daemon watches it.
   - The server still needs a runtime to run in.
   - Every agent can write to that folder, so a token would be the only check.
   - Watching folders on Windows is slow and unreliable under antivirus.
3. **Localhost HTTP or SSE MCP.**
   - Ruled out by the no-TCP-listener rule: any web page the user opens can reach a localhost port.
   - agent-orchestrator's `ao report` posts to a loopback HTTP API with no token (`backend/internal/cli/report.go`). That is the risk this rule exists for.
4. **A named pipe on the daemon side, with a byte relay in Windows PowerShell 5.1 as the stdio server.**
   - The MCP protocol is spoken by the daemon, in TypeScript and under test.
   - PowerShell 5.1 ships with every Windows 10/11. The DPAPI helper already depends on it (ADR 0002).

**Chosen: 4.** It is the per-user named pipe with a token that PLAN.md §4 and AGENTS.md already name for external ingress. The relay contains no logic worth attacking, and the daemon checks every request.

## Decisions

### Report server

- **Pipe** (`packages/daemon/src/mcp/pipe.ts`).
  - Name: `\\.\pipe\crewyard-mcp-<pid>-<24 random hex>`, new at every daemon start, listening only once a run needs it.
  - libuv creates it with `FILE_FLAG_FIRST_PIPE_INSTANCE` (`src/win/pipe.c`), so a process that took the name first makes our listen fail instead of receiving relays. The random name means nobody can guess it to take it first.
- **Hello and session.**
  - Each connection must send `{"crewyard":1,"ticket":"…"}` within 10 s. Then it speaks MCP JSON-RPC, one message per line (`session.ts`): `initialize` (versions 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05), `ping`, `tools/list`, `tools/call`.
  - Unknown methods, including 2026-07-28's `server/discover`, get -32601, so clients fall back to `initialize`.
- **Tickets** (`tickets.ts`).
  - 32 random bytes per run process. Only the sha256 is kept, in memory.
  - A resume or a continue after a pause issues a new ticket, which revokes the old one. A run that ends revokes its ticket.
  - The ticket is checked at hello and again at every call. So a wrong or old ticket closes the connection, and a revoked one gets a tool error.
  - A daemon restart ends every run process, so tickets never need to survive one.
- **Relay** (`relay.ts`).
  - Command: `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand <script>`. The script holds no secret.
  - The pipe path and ticket arrive in the server's own env (`CREWYARD_REPORT_PIPE`, `CREWYARD_RUN_TICKET`). The names avoid KEY/TOKEN/SECRET so that credential scrubbers leave them alone.
  - It copies bytes both ways (`Stream.CopyToAsync`), so UTF-8 passes through untouched. A test sends Turkish text through it.
- **Tools** (`packages/core/src/mcp.ts`).
  - `report {kind: checkpoint|needs_input|stuck|done, text, artifacts?}` and `propose_followup {title, description?}`, both annotated `readOnlyHint`.
  - Arguments are refused rather than cut past their caps, so the agent learns the limit: text 2,000 bytes, title 120, description 4,000, 10 artifacts of 260 bytes. Each pipe line is capped at 64 KiB, and the connection closes past it.
  - Per run: 100 reports and 10 follow-ups.
  - Control characters and bidirectional overrides are removed.
  - Artifact paths must resolve inside the run's working folder: no `..`, no other drive, no UNC path, no NTFS stream.
- **Where reports land** (`reports.ts`).
  - Every report goes to `crew_reports` and to an `mcp.report` event, which drives the timeline in the inspector.
  - `needs_input`, `stuck` and follow-ups are Inbox items and count in the Inbox badge.
  - A reply goes through `runs.message`: it is queued while a turn runs, and goes to whichever run continues the step.
  - A run's open questions and blockers close when it ends. Follow-ups stay.
- **Follow-ups never start anything.**
  - "Turn into a task" calls `tasks.propose`. That makes a draft: classified, crew proposed, nothing started, and its crew waits for approval on the Tasks screen.
  - The report service has no reference to `approve`, `launch` or an adapter. A test asserts that no run, start or second task appears.
- **Orchestrator hooks**, kept small. `OrchestratorOptions.mcp` / `setMcp()` add a `mcpServers` field to the StartRequest at a run's first start and at its resume, and call `runEnded` from `endRun`. Scheduling is untouched.

### Per-run servers (`inject.ts`, the adapters)

| Runner | Documented way (checked 2026-10-30) | Tool filter | Report tools | A user server's tools |
|---|---|---|---|---|
| Claude Agent SDK 0.3.312 | `mcpServers` (stdio, `alwaysLoad` for ours), `strictMcpConfig: true` so `.mcp.json` and profile servers stay out | `allowedTools` names; PreToolUse hook refuses the rest for read-only roles | `allowedTools: mcp__crewyard` | writers: `canUseTool`, rated like network (medium) |
| Codex 0.147 app-server | `thread/start`/`thread/resume` `config`: `mcp_servers.<name>` with `command`, `args`, `env_vars`, `enabled`, `startup_timeout_sec`, `enabled_tools`, `default_tools_approval_mode`; no `type` (cc-switch `src-tauri/src/mcp/codex.rs`: Codex warns on it) | `enabled_tools` | `approve` | writers: `prompt` → `mcpServer/elicitation/request` with `_meta.codex_approval_kind: "mcp_tool_call"` → Inbox; read-only: declined |
| Gemini CLI over ACP | `session/new` / `session/load` `mcpServers` (name, absolute command, args, env as name/value) | none in ACP, so a read-only role gets only servers it may use whole | allowed by the adapter (`_meta["gemini-cli"].mcp.server_name`) | network-rated approval |
| OpenCode 1.19.5 | `OPENCODE_CONFIG_CONTENT` `mcp.<name> = {type: "local", command: [..], environment, enabled, timeout}`; the 2.x shape `mcp.servers.<name>` with `codemode: false` is built too, for when 2.x passes conformance (Code Mode routes MCP calls through `execute`, so `<server>_*` rules would stop matching) | session permission rules (later rules win): deny `<name>_*`, allow picked tools | `crewyard_*: allow` | writers: `<name>_*: ask`, rated like network |

- **Values stay out of logged config.**
  - Codex: values go in the app-server's own env and are named in `env_vars`, never in the thread config. The thread's `shell_environment_policy.exclude` then drops those names from the agent's commands.
  - OpenCode: the env guard blanks `OPENCODE_CONFIG_CONTENT` in the agent's commands while it carries MCP env.
  - Claude: the env sits in the server entry only.
- **Read-only roles.** A server's `readOnlyAccess` decides:
  - `marked` gives only the tools the server marks `readOnlyHint` (this needs a tools check);
  - `all` means you vouch for the server;
  - `none` leaves it out.

  For a server that marks nothing, Settings says so and asks you to choose. This is "ask the user per server": the choice is made once, in Settings, never by a prompt at run time.
- **Commands.** A server's command is resolved on PATH; an .exe beats a .cmd shim. A shim runs as `cmd.exe /d /c <shim> …`, the form Claude Code's docs give for npx on native Windows:
  - arguments with cmd syntax are refused;
  - `NoDefaultCurrentDirectoryInExePath=1` keeps cmd.exe from running a same-named file in the worktree.
- **Recording.** What each run got, and what it did not get and why, is recorded in `mcp_run_servers` and shown in Settings.

### Management (Settings → MCP servers)

- **Scope.** Servers are global or per project. Both are stored in Crewyard's database, never in `.mission/project.json` (which is committed). A project server replaces a global one of the same name.
- **Secrets.** Secret env values go through `SecretStore` (DPAPI, ADR 0002). Names that look like credentials must be secret. Secret values never return to the window. Removing a variable or a server deletes its blobs.
- **Supply chain.** For `npx`, `pnpm dlx`, `npm exec`, `bunx`, `uvx` and `pipx run`, a floating tag (`@latest`, `@next`) or a missing exact version is flagged, with a pinned example. emdash and cc-switch show no such warning.
- **Check tools.** It runs the server once with its env (initialize, tools/list with paging, at most 60 s), records names and `readOnlyHint`, and kills the tree. It runs only on your click.

## Sources (all opened 2026-10-30)

| Source | Stars | License | Archived | What we took |
|---|---|---|---|---|
| github.com/OrchestratorInc/agent-orchestrator, `backend/internal/skillassets/using-ao/commands/report.md`, `cli/report.go`, `cli/mcp.go` | 13.9k | Apache-2.0 | no | the four report states; caps on report text; that a hand-written stdio MCP server is enough (its `ao mcp`); its loopback HTTP without a token as what not to do |
| github.com/generalaction/emdash, `packages/core/src/primitives/mcp/api/schemas.ts`, `runtimes/agent-config/node/runtime/mcp.ts`, `runtimes/acp/node/runtime/mcp-servers.ts` | 6.1k | Apache-2.0 | no | per-runner config shapes (OpenCode `command` array, ACP env pairs); it writes env in plain text into agent files, which we avoid |
| github.com/farion1231/cc-switch, `src-tauri/src/mcp/codex.rs`, `docs/user-manual/en/3-extensions/3.1-mcp.md` | 150k | MIT | no | no `type` field for Codex; one server list synced per app; env shown masked |
| learn.chatgpt.com/docs/config-file/config-reference (Codex), `codex-rs/core/src/mcp_tool_call.rs` | | Apache-2.0 | no | `mcp_servers` fields, approval modes, `env_vars` |
| opencode.ai/docs/mcp-servers; `anomalyco/opencode` `packages/codemode` | | MIT | no | 1.x and 2.x `mcp` shapes, `<server>_<tool>` names, Code Mode |
| agentclientprotocol.com/protocol/session-setup; gemini-cli `docs/cli/acp-mode.md`, `packages/cli/src/acp/acpSessionManager.ts` | | Apache-2.0 | no | stdio entry shape; Gemini's `_meta["gemini-cli"].mcp` on permission requests |
| modelcontextprotocol.io/specification/2025-11-25 (transports, lifecycle, tools) | | MIT | no | stdio framing, version negotiation, `tools/list` annotations, `isError` |
| Claude Agent SDK `sdk.d.ts` 0.3.312 (`McpStdioServerConfig`, `strictMcpConfig`); code.claude.com/docs/en/env-vars | | | | server config fields; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` reaches stdio MCP servers |
| learn.microsoft.com, "Named Pipe Security and Access Rights" | | | | the default pipe DACL |
| github.com/libuv/libuv `src/win/pipe.c` | 27.3k | MIT | no | the pipe is created with a NULL security descriptor and `FILE_FLAG_FIRST_PIPE_INSTANCE` |

No code was copied. The protocol facts (method names, fields) are used as facts.

## Windows notes

- **Relay process.** One `powershell.exe` per run process, about 40 MB. It ends when the runner closes its stdin or the daemon closes the pipe. Runners stop their MCP servers themselves, and the daemon kills each runner's tree on stop.
- **Paths with spaces.** Tests use them for worktrees, `C:\Program Files\nodejs\npx.cmd`, and arguments.
- **Encoding.** The relay never decodes text, so the console code page plays no part.

## Security notes

- **Pipe access.** The pipe has Windows' default DACL: full control for SYSTEM, administrators and the owner; read for Everyone and anonymous. Node cannot set a security descriptor on a pipe.
  - Another account can open the pipe for reading at most. A connection must write its hello before the daemon sends anything, and each connection is its own pipe instance, so such a reader receives nothing.
  - Remote clients are not rejected at the pipe level (no `PIPE_REJECT_REMOTE_CLIENTS` in libuv). The same reasoning covers them.
  - A native helper that sets the logon SID on the DACL is the follow-up if this ever needs to be stricter.
- **What a stolen ticket allows.** The ticket travels only in the server's env. An agent that reads another process's env could get it, but a ticket allows only reports for its own run: no answers, no approvals, no spend, no runs.
- **Agent text is data.**
  - It is rendered by React as text, never as HTML, in a quoted block under a line Crewyard writes.
  - It is never used as an instruction to Crewyard.
  - A reply sends your words, not the agent's.
- **User servers** are other programs with your rights. Their tool calls are rated like network access (medium), so the policy never approves one on its own. Read-only roles get read tools only.
- **Secret values**
  - are never in a command line, a log, the thread config (Codex), the project folder, or the IPC to the window;
  - check errors are redacted of them.

## Rollback

- `OrchestratorOptions.mcp` absent, or `setMcp` never called (remove `createMcpHandlers` from `server.ts`): runs start without `mcpServers`, and every adapter falls back to what it did before (ACP sends `mcpServers: []`).
- The `mcp` migration only adds tables; leaving them in place is harmless.
- Claude's `strictMcpConfig: true` is the one behaviour change for existing runs: a repository's `.mcp.json` no longer loads in Crewyard runs. Removing that line restores it.
