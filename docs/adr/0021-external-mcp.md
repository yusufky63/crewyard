# ADR 0021: External access over MCP

**Status:** accepted, 2026-11-01. Owner request the same day. Builds the external ingress PLAN.md §4 names ("one per-user local endpoint protected by a token") on the transport of ADR 0007, and reuses the assistant's read tools of ADR 0018. Amends PLAN.md §4 (the endpoint's name and who uses it) and D8 (one more caller that may only propose).

## Problem

The owner, 2026-11-01: "claude ile mcp ile crewyarda erişme veya bir proje import edip orda ayarlamaları yapma" (reach Crewyard from Claude over MCP, or import a project and adjust its settings there).

Today the only way into Crewyard is its own window. An agent you run outside the app (Claude Code in a terminal, Claude Desktop, Codex, Cursor) cannot see your projects, tasks, reports, Inbox or spend, cannot add a folder as a project, and cannot change a project's slots, budget or test command. You copy facts between the two by hand.

What must not change:

- **Nothing outward-facing happens without you** (D8). Starting a crew, a paid run, push, PR, merge, deleting anything, an Inbox answer and spend past a cap stay one click in the app.
- **No TCP listener** (AGENTS.md). Any web page you open can reach a localhost port.
- **API keys and secret values** never leave the daemon: not to a window that did not ask for them, not to a log, a command line, a URL or an agent.
- **Text from a client is data**, never an instruction to Crewyard.

## Options

### Transport

1. **A localhost HTTP or SSE MCP server.** The usual way: vibe-kanban's stdio binary talks to the app's loopback HTTP API and finds its port in a file in `%TEMP%`; agent-orchestrator's daemon is loopback HTTP too. Neither sends a token. Ruled out by the no-TCP rule, and the MCP security guidance itself says a local server SHOULD use stdio to limit access to the client.
2. **The packaged exe with a flag** (`Crewyard.exe --mcp`), relaying stdio to the daemon.
   - It starts Electron's main process for every client session (about 80 MB), before the single-instance lock, and must never open a window.
   - The path differs in development (`electron.exe` plus the app folder) and after an update moves the install.
   - A GUI-subsystem exe's piped stdin on Windows is a known rough edge in Electron's main process; the relay would need its own tests per Electron version.
3. **The byte relay of ADR 0007** (Windows PowerShell 5.1, the system Perl elsewhere) as the stdio server, connecting to a second endpoint of the daemon.
   - Already shipped and tested for every run; ships with Windows 10/11.
   - The MCP protocol is spoken by the daemon, in TypeScript, under test.
   - The client config is long (an `-EncodedCommand` blob), so Settings writes it for you.

### Where the secret lives

1. **A token in the client's config** (`env` of the server entry). It then sits in plain text in `~/.claude.json`, `claude_desktop_config.json` or `~/.codex/config.toml`, and `claude mcp add -e TOKEN=…` puts it on a command line and in your shell history.
2. **A token Crewyard keeps DPAPI-encrypted, which the relay decrypts itself.** The client config names only the data folder and a client id. The relay reads `<data>\external\<client id>.bin`, unprotects it with .NET `ProtectedData` for the current user (the same call the DPAPI helper of ADR 0002 makes), and sends it in its first line.

## The choice

**Transport 3 and secret option 2.**

### Endpoint

- **A second listener of the daemon** (`packages/daemon/src/external/pipe.ts`), separate from the run report pipe, so no run ticket can reach an external tool and the other way round.
- **Name.** Windows: `\\.\pipe\crewyard-ext-<pid>-<24 random hex>`, new each time it starts listening. Linux and macOS: `ext-<pid>-<16 hex>.sock` in the private socket folder of ADR 0010. libuv creates a Windows pipe with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a process that took the name first makes our listen fail rather than receive tokens, and the random name cannot be guessed to take it first.
- **Discovery.** While it listens, the daemon writes the endpoint into `<data>\external\endpoint` (atomic write) and removes it when it stops. The data folder is in your profile, so other accounts cannot read the name. PLAN.md §4's `crewyard-<user-sid>` is replaced by this: a fixed name is one another account could take first.
- **Off means no listener.** External access is off by default. Off: no endpoint, no file, every connection closed.

### Clients and tokens

- **One client per program** you connect, created in Settings → External access with a name you choose ("Claude Code on this PC").
- **Token:** 32 random bytes, base64url. The daemon keeps its sha256 in `external_clients` and the token itself as a DPAPI blob (entropy `crewyard/secret/v1`, current user) in `<data>\external\<id>.bin`. On Linux and macOS the relay cannot reach the main process's `safeStorage`, so the file holds the token as text, mode 0600 in a 0700 folder; those builds are pre-release (ADR 0010) and Settings says so.
- **Hello.** The relay's first line is `{"crewyard":1,"client":"<id>","token":"<token>"}`, within 10 s. A wrong token, a revoked client or external access off closes the connection. The client and the switch are checked again on every call, so revoking or turning off takes effect at once.
- **Revoke** deletes the blob, marks the row revoked and closes its connections. The row stays, so the activity log keeps the name.
- **Never** on a command line, in a log, in a URL, in an event or in the client's config. The config snippet holds no secret, so it can be shown and copied freely.

### Adding it to a client

Settings shows three copyable snippets for each client, built by the daemon (`external/relay.ts`), all the same server:

- **Claude Code:** `claude mcp add crewyard --scope user -e CREWYARD_MCP_HOME=<data> -e CREWYARD_MCP_CLIENT=<id> -- <powershell.exe> -NoLogo -NoProfile -NonInteractive -EncodedCommand <script>`. `--` passes through Windows PowerShell 5.1 to native commands (checked on 5.1.26100). `claude mcp add-json` is not offered: PowerShell 5.1 strips the inner quotes of a JSON argument.
- **Claude Desktop and Cursor:** the `mcpServers.crewyard` JSON entry (`command`, `args`, `env`).
- **Codex:** a `[mcp_servers.crewyard]` table with `command`, `args` and `env`.

If Crewyard is not running or access is off, the relay writes one line to stderr ("Crewyard is not running, or external access is off") and exits 1; the client shows the server as failed.

### Tools

Listed in `packages/core/src/external.ts`. Every read tool but the project list takes `project_id`. Annotations follow the MCP schema; the spec tells clients to distrust them, so the daemon never relies on them.

| Tool | Kind | What it does |
|---|---|---|
| `list_projects` | read | id, name, folder, last opened |
| `get_status` | read | daemon version and start, projects, active and queued runs, open Inbox items, Autopilot stopped or not, this client |
| `list_tasks`, `read_task`, `read_report`, `read_crew`, `read_inbox`, `read_events`, `read_usage`, `list_profiles`, `read_project`, `list_problems` | read | the assistant's read tools of ADR 0018, through the same code: cleaned, redacted, capped at 16 KB, aliases instead of keys, every number labelled Reported, Estimated, Unknown or Plan, Claude windows never included. A read of an Autopilot task's report from here does not count as Autopilot reading it |
| `list_mcp_servers` | read | the servers runs of the project get (project and global), with plain env values; a secret shows only its name and whether it is stored |
| `import_project` | write | adds an existing folder as a project, as Start → Add folder does: no `git init`, no file written; refused for a missing folder, a file, a folder with case twins (PLAN.md §11.1) |
| `update_project_settings` | write | the allowlist below, written to `.crewyard/project.json` as the wizard writes it |
| `propose_task` | write | `tasks.propose`: a draft whose crew waits for your approval on the Tasks screen. Never `tasks.approve` or `tasks.start` |
| `save_mcp_server` | write | adds or changes one of your stdio MCP servers, plain env only |

**Settings allowlist (`update_project_settings`).** The rule is "tighten anything, loosen nothing":

| Field | Allowed |
|---|---|
| `slots` | any value 1 to 16 |
| `test_command`, `build_command` | a command that passes `splitCommand` (no shell syntax, one line), or null |
| `runners` | any known runners |
| `profiles` | ids of existing profiles |
| `max_iterations` | 1 to 10 |
| `daily_usd`, `per_task_usd` | lower only; raising is refused with "raise it in the app" |
| `fallback` | `manual` or `ask`; `auto` is refused |
| `network` | `ask` only |
| `toast_approvals` | `none` only |
| `remove_allow_commands` | removes entries; adding is not offered |

A newer or invalid `project.json` is never written (the same codes as the wizard). Secret-looking keys are refused by `validateProjectConfig`, as for the wizard.

**MCP servers (`save_mcp_server`).** Plain env values only; a name that looks like a credential is refused (`mcp.env_must_be_secret`), and secret values are never accepted or returned: set them in Settings → MCP servers. A changed server keeps its stored secrets. `read_only_access` may be `marked` or `none`; `all` (you vouch for the whole server) stays in the app. Removing a server is a delete and stays in the app.

**Not offered, on purpose** (a test asserts none is listed and each is refused by name): approving a crew or a step, starting a task, a run, a schedule or Best of N, pause, resume, stop, retry, handoff, messages to a run, push, PR, merge, deleting a task, worktree, branch, project, profile, key or server, any Inbox answer, caps on keys, Autopilot's switch and limits, external access itself, key and secret reads or writes.

### Every call

- **Checked in the daemon:** access on, client not revoked, token current; arguments checked in core, unknown keys refused, ids `^[A-Za-z0-9-]{1,64}$`, strings capped in bytes, text cleaned of control and bidirectional characters (`cleanText`).
- **Rate:** 30 calls a minute per client (the assistant's cap), and 20 `propose_task` calls an hour per client, so a looping client cannot fill the Tasks screen.
- **Recorded:** each write is an `external.*` event with the project, the client's name and what changed (`external.settings` carries each field's old and new value). The Activity log shows it as "changed by external agent <name>". Reads write no event; the client row keeps its last call time and count.
- **Seen in the app:** Settings → External access shows on or off, the clients, which are connected now, the program name each one reported in `initialize` (cleaned, 80 bytes), last seen and calls. The status bar shows an item while access is on.

## Sources (all opened 2026-11-01)

| Source | Stars | License | Archived | What we took |
|---|---|---|---|---|
| github.com/BloopAI/vibe-kanban, `crates/mcp/src/bin/vibe_kanban_mcp.rs`, `crates/mcp/src/task_server/{mod.rs,handler.rs,tools/*.rs}`, `crates/utils/src/port_file.rs`, `crates/server/src/middleware/origin.rs`, `docs/integrations/vibe-kanban-mcp-server.mdx` | 28.5k | Apache-2.0 | no | a thin stdio process that forwards to the running app; a tool list that reads first; what to avoid: no token, a port file in `%TEMP%` written non-atomically, `npx …@latest` in the config, external tools that delete branches, change scripts the app runs and start runs |
| github.com/OrchestratorInc/agent-orchestrator, `backend/internal/cli/mcp.go`, `cli/render.go`, `cli/client.go`, `internal/runfile/runfile.go` | 14.0k | Apache-2.0 | no | annotations on every tool; a run file checked for a live pid so a stale file reads "not running"; its loopback HTTP without auth as what not to do. Its `ao mcp` serves its own sessions, not external clients |
| github.com/generalaction/emdash, `agents/integrations/mcp.md` | 6.1k | Apache-2.0 | no | none found for external clients: its MCP code configures servers for its own agents |
| github.com/stablyai/orca (tree listing) | 111.7k | MIT | no | none found for external clients |
| modelcontextprotocol.io/specification/2025-11-25: transports (stdio), security best practices ("Local MCP Server Compromise"), tools and `ToolAnnotations` | | MIT | no | stdio framing and stderr for logs; stdio over local HTTP; annotation defaults and that clients distrust them |
| code.claude.com/docs/en/mcp | | | | `claude mcp add [options] <name> -- <command> [args...]`, `-e/--env`, `--scope user`, the `mcpServers` entry shape |
| modelcontextprotocol.io/quickstart/user | | | | `claude_desktop_config.json` location and shape |
| learn.chatgpt.com Codex MCP docs | | | | `[mcp_servers.<name>]` with `command`, `args`, `env` |

No code was copied. Protocol facts (method names, fields, config shapes) are used as facts.

## Windows notes

- One `powershell.exe` per client session, about 40 MB, as for runs. It ends when the client closes its stdin or the daemon closes the pipe.
- The relay's DPAPI call runs in the same PowerShell process, so no second helper starts.
- The data folder may contain spaces (`C:\Users\Ada Lovelace\AppData\Roaming\Crewyard\data`); the snippets quote it and the tests use such a path.
- `-EncodedCommand` bypasses the execution policy, which blocks `.ps1` files on a default Windows client.

## Security notes

- **Who can connect.** The pipe has Windows' default DACL (ADR 0007): other accounts may at most open it for reading and receive nothing, and cannot read the endpoint file or decrypt the token. Remote clients cannot read the file either.
- **What the token does not do.** Any program running as you can read the client config, run the relay and decrypt the blob, as it could read a token in `~/.claude.json`. That includes agents Crewyard itself runs. The token separates clients, so you can see and revoke each, and keeps other accounts out; it is not a wall against your own processes. That is why the tool list itself is the guard: nothing here can start work, spend, answer, push, merge or delete, and no read returns a secret.
- **Settings writes** go only toward stricter values for anything that spends or loosens a rule. A test command or an MCP server added from here is a program that crews will run; it is written as the wizard and Settings write it, recorded with the client's name, and its tool calls go through the same approvals as any other.
- **Client text** (titles, descriptions, names, commands) is cleaned and capped, stored as text and shown as text. A task an external client proposes quotes nothing as an instruction; its crew still waits for your approval.
- **Reads** return text agents wrote; each result says it is data.

## Rollback

- Turn external access off: no listener, no endpoint file.
- Remove `createExternalHandlers` from `server.ts`: nothing listens, and the Settings section and the status bar item have nothing to show.
- The `external-mcp` migration only adds a table; leaving it is harmless. The `external` folder in the data folder can be deleted.
