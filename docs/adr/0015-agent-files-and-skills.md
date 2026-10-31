# ADR 0015: Your own agent files, skills and instruction bridges

**Status:** accepted, 2026-10-31. Owner's request the same day: "kullanıcının kendi agent dosyaları, rules veya diğer AI'larda hazırlamış olduğu skills'ler veya benzeri şeyleri de ekle; diğer örnek aldığımız repoları da incele, varsa ekle, nasıl kullanıyorlarsa" (add the user's own agent files, rules and the skills they prepared in other AI tools, and anything similar; look at the reference repos and add it the way they do).

## Problem

Every Crewyard profile runs its CLI in a config folder of its own (PLAN.md D4: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, OpenCode's `XDG_*` folders under the profile). That keeps accounts apart, and it also hides your personal setup from every run:

- user-level files: `~/.claude/CLAUDE.md`, `~/.claude/rules`, `~/.claude/skills`, `~/.claude/commands`, `~/.claude/agents`; `~/.codex/AGENTS.md`, `~/.codex/skills`, `~/.codex/prompts`; `~/.gemini/GEMINI.md`, `~/.gemini/skills`, `~/.gemini/commands`; OpenCode's `~/.config/opencode` files; the cross-tool `~/.agents/skills`; Windsurf, Cline and other tools' global rules;
- project files are read only by the runner whose format they are: a repo with only `AGENTS.md` gives Claude Code nothing (when it also has a CLAUDE.md), a repo with only `CLAUDE.md` gives Codex, Gemini CLI and OpenCode nothing, and Copilot, Cursor and Windsurf rules reach no runner at all.

The files are instructions written by you or downloaded by you. Some carry more than text: skills ship scripts, commands run shell snippets, front matter pre-approves tools (`allowed-tools`), adds hooks or picks a model, and next to them sit credential stores and settings files with env, hooks and MCP commands. Crewyard must bring the useful part across without letting any of it widen what a run may do (PLAN.md §9.1, AGENTS.md "Security").

## What each runner reads, and what follows the profile folder

Checked against each runner's documentation and, where the docs are silent, its source, on 2026-10-31 (sources below).

| Runner | User level, follows the profile variable | Project level, read from the run's folder regardless | Read from the real home, outside the profile |
|---|---|---|---|
| Claude Code 2.1.x | `CLAUDE.md`, `rules/*.md`, `skills/<name>/SKILL.md`, `commands/*.md` (merged into skills), `agents/*.md`, `output-styles`, settings and credentials | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules`, `.claude/skills`, `.claude/commands`, `.claude/agents`, `.mcp.json`; since 2.1.277 `AGENTS.md` when there is no CLAUDE.md of any kind | managed files only |
| Codex 0.147+ | `$CODEX_HOME/AGENTS.md` (or `AGENTS.override.md`), `$CODEX_HOME/skills` (deprecated, still read), `prompts/*.md` (deprecated), `agents/*.toml`, hooks, auth | the AGENTS.md chain from the git root down (one file per folder: `AGENTS.override.md`, `AGENTS.md`, then `project_doc_fallback_filenames`), 32 KiB in total; `.agents/skills`; `.codex/*` once trusted | **`$HOME/.agents/skills`** (`dirs::home_dir()`), `/etc/codex/skills` |
| Gemini CLI 0.66 | everything under `$GEMINI_CLI_HOME/.gemini/` (`GEMINI.md`, `skills`, `commands/**/*.toml`, `agents`), and `$GEMINI_CLI_HOME/.agents/skills` | the GEMINI.md chain (names from `context.fileName`), `.gemini/skills`, `.agents/skills`, `.gemini/commands`, **project `.env` files** | system settings in `C:\ProgramData\gemini-cli\` |
| OpenCode 1.19 / 2.2 | `$XDG_CONFIG_HOME/opencode/AGENTS.md`, `skill(s)`, `command(s)`, `agent(s)`, config | the AGENTS.md walk, `.opencode/*`, `.claude/skills` and `.agents/skills`, `opencode.json`; `instructions` from config (paths and globs); 1.x also CLAUDE.md as a fallback | **`~/.claude/skills` and `~/.agents/skills`** through `os.homedir()`; Crewyard already sets `OPENCODE_DISABLE_CLAUDE_CODE`, which gates the `.claude` ones |

Settings that name more instruction files: Gemini CLI's `context.fileName` (a string or a list), Codex's `project_doc_fallback_filenames`, OpenCode's `instructions`. Claude Code has none; its documented way is an `@AGENTS.md` import inside CLAUDE.md, which would mean writing into the project.

Other tools, formats only: Cursor `.cursor/rules/*.mdc` (`description`, `globs`, `alwaysApply`; user rules live in Cursor's settings, not a file) and the legacy `.cursorrules`; Windsurf, now Devin Local, `.devin/rules`, `~/.devin/global_rules.md` and the still-imported `.windsurf/rules` and `.windsurfrules`; Copilot `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, `.github/prompts/*.prompt.md`; Cline `.clinerules/`, `.cline/rules`, `Documents\Cline\Rules`, `~/.cline/rules`; AGENTS.md (agents.md) is plain Markdown, nearest file wins.

## How the reference projects do it

| Project | What it does | Source paths read |
|---|---|---|
| cc-switch | A prompt library in SQLite, one enabled prompt per app written over the app's global file (`CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `AGENTS.md`) with an atomic write; the live file is re-read on every list and an outside edit is taken into the enabled prompt; a file it did not write is backed up first. Skills live in one master folder and are synced into each app's skills folder by symlink (Windows `symlink_dir`) with a copy fallback, a SHA-256 over relative paths and contents to detect drift, `SKILL.md` required, archive extraction with byte and entry caps. No subagents, commands or Cursor/Windsurf rules. | `src-tauri/src/prompt_files.rs`, `src-tauri/src/services/prompt.rs`, `src/components/prompts/PromptCopyDialog.tsx`, `src-tauri/src/services/skill.rs`, `src-tauri/src/deeplink/skill.rs`, `src/components/deeplink/SkillConfirmation.tsx` |
| agent-orchestrator | Each account folder gets the user's real folder's entries by symlink: Claude `skills`, `plugins`, `agents`, `commands`, `hooks`, every top-level `*.md`; Codex everything but a private list. No Windows fallback. `settings.json` is merged key by key with a ledger of the value it last wrote. Project rules (`agentRules`, `agentRulesFile`, repo-relative, `..` refused) go into the system prompt (`--append-system-prompt`), through a file on Windows because of the 32,767-character command line. | `backend/internal/adapters/agentaccount/claude.go`, `codex.go`, `share.go`, `backend/internal/domain/projectconfig.go`, `backend/internal/session_manager/prompt.go`, `backend/internal/adapters/chatdriver/acp/system_prompt_file.go`, `backend/internal/skillassets/skillassets.go`, `backend/internal/adapters/agent/opencode/hooks.go` |
| orca | Claude account folders get every entry of the user's Claude folder except runtime and auth state: folders as junctions on Windows, files copied (editors that save by rename break file links), atomic, skipped when unchanged; a non-empty real entry is `user-owned` and never overwritten; each step reports `linked`, `synced`, `unchanged`, `user-owned`, `absent`, `merged` or `failed`. CLAUDE.md becomes a one-line `@~/.claude/CLAUDE.md` import. Codex homes get `skills`, `hooks`, `prompts`, `AGENTS.md` by junction, with a marked copy as fallback. | `src/main/claude-accounts/claude-profile-provisioning.ts`, `claude-profile-sharing.ts`, `claude-profile-setup.ts`, `src/main/codex/codex-home-paths.ts`, `codex-managed-home-resource-copy-marker.ts`, `codex-managed-home-rules.ts` |
| vibe-kanban | Reads `.claude/commands/*.md` and `.claude/skills/*/SKILL.md` (project and `~/.claude`) only to fill its slash-command menu; never copies. Appends profile text to the task prompt. | `crates/executors/src/executors/claude/slash_commands.rs`, `crates/executors/src/executors/codex/slash_commands.rs`, `crates/executors/src/profile.rs`, `crates/executors/src/mcp_config.rs`, `crates/local-deployment/src/copy.rs` |
| emdash | Writes `SKILL.md` alone into `~/.agentskills/<name>/`; no copy into agent folders was found despite its UI text. Skill names `^[a-z0-9][a-z0-9-]{0,62}`. | `packages/core/src/runtimes/agent-config/node/runtime/skills.ts`, `packages/core/src/primitives/skills/api/validation.ts` |
| omux | None found: it reads `~/.claude/projects` and passes an inherited `CODEX_HOME` through; a per-project setup command is the nearest feature. | `Sources/omux/*.swift`, `Store.swift`, `Worktrees.swift`, README, CHANGELOG |

None of the six bridges Cursor, Windsurf or Copilot rules to another runner.

## Options

### Sharing your user-level files with profiles

1. **Link the user's folders into every profile** (agent-orchestrator, orca, cc-switch's default). Always current, no sync step. But everything comes along, hooks included, with no choice per item; links need Developer Mode on Windows (orca and cc-switch fall back to junctions or copies, agent-orchestrator simply fails); and an edit to a source reaches the next run unseen.
2. **Copy what you choose, per item and per runner or profile, into each profile's own folder in that runner's format, and show when a copy is out of date** (cc-switch's skills hashing, orca's `user-owned` rule).

**Chosen: 2.** AGENTS.md forbids symlinks, PLAN.md §9.1 wants nothing to reach a run without you, and hooks must never come along. The cost is a `Sync` button.

### Offering a project file to the other runners

1. **Write into the project:** a `CLAUDE.md` that imports `@AGENTS.md` (Anthropic's documented way), a `.gemini/settings.json`, an `opencode.json`. Simple and visible to the team, but Crewyard would change the repository, and MCP settings already set the rule that Crewyard keeps its own configuration out of the project folder (ADR 0007).
2. **Pass it per run through each runner's own setting**, off by default per project, stored in Crewyard's database.

**Chosen: 2.**

## The choice

### Discovery (read-only)

- `packages/core/src/agentfiles.ts` lists every location as an allowlist entry (`AGENT_FILE_LOCATIONS`): the tool, user or project scope, kind (`instructions`, `skill`, `command`, `agent`), path, and for folders the file extensions taken. User paths follow the tool's own override variable if you set one (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `XDG_CONFIG_HOME`).
- A denylist (`isDeniedName`) is checked on every name, also inside skill folders, before anything is opened: `.credentials.json`, `auth.json`, `oauth_creds.json`, `google_accounts.json`, MCP OAuth stores, `.claude.json`, `settings*.json`, `config.toml`, `opencode.json(c)`, `.mcp.json`, `hooks.json`, `trustedFolders.json`, `.env*`, keys and certificates, databases, and any name with `token`, `secret` or `credential`.
- Caps: 256 KB per file, a skill at most 5 MB, 200 files and 4 folders deep, 200 entries per folder; anything over is listed as skipped with the reason, never read. Links and junctions are listed as skipped and never followed.
- Each item shows its source path, size, description, a text preview (4,000 characters, plain text), the scripts it ships, shell snippets in its body ("!`cmd`", "!{cmd}", a "```!" block), the front matter keys a copy drops, `@` imports a copy does not follow, and what each runner can do with it.
- It runs when Settings → Instructions and skills is shown and on `Look again`. Nothing is written.

### Sharing (copies, never links)

| Kind | Claude Code | Codex | Gemini CLI | OpenCode |
|---|---|---|---|---|
| Instruction files | joined into `<profile>\CLAUDE.md` | joined into `<profile>\AGENTS.md` | joined into `<profile>\.gemini\GEMINI.md` | joined into `<profile>\config\opencode\AGENTS.md` |
| Skills | `<profile>\skills\<name>\` | `<profile>\skills\<name>\` (`$CODEX_HOME/skills`, read for compatibility) | `<profile>\.gemini\skills\<name>\` | `<profile>\config\opencode\skills\<name>\` |
| Commands | `<profile>\commands\<name>.md` | not shared: custom prompts are deprecated and expand only in Codex's own terminal UI | `<profile>\.gemini\commands\<name>.toml`, converted | `<profile>\config\opencode\commands\<name>.md` |
| Subagents | not shared | not shared | not shared | not shared |

- **You choose** an item, a runner and either one profile or every profile of that runner (also ones added later). Project items are never copied; the bridge covers them.
- **Instruction files** of every share that reaches a profile are joined into the runner's one user memory file, in the order shared, each between `<!-- crewyard:begin <id> <source> -->` and `<!-- crewyard:end <id> -->`, under a first line saying Crewyard wrote it. A memory file without that line is someone else's and is never overwritten (`dest_exists`, orca's `user-owned`). The file is removed when the last share goes.
- **Commands** keep only a description and the prompt when converted between Markdown and Gemini CLI's TOML (`$ARGUMENTS` and `{{args}}`).
- **What a copy leaves out:** front matter keys that would grant or change something (`allowed-tools`, `hooks`, `permission(s)`, `tools`, `model`, `subtask`, `agent`, `mcpServers` and the like, `STRIPPED_KEYS`) are removed from SKILL.md and command files, so the role policy, approvals and crew choice still decide. Denied names and links inside a skill were never read, so they are not in the copy.
- **Scripts:** a skill that ships a script (by extension, or a file without one that starts with `#!`) or a command or skill whose body runs a shell snippet is shared only with an explicit tick, recorded on the share.
- **Subagents** are listed and never shared: every runner already runs without them (Claude `Agent` and `Workflow` denied, Codex `agents.enabled = false`, Gemini `experimental.enableAgents = false`), because their work would bypass the crew's plan, approvals and spend caps.
- **Writes** go to a temp name and are renamed into place, retried while antivirus holds the file; a folder that exists and was not written by Crewyard is left alone (`dest_exists`).
- **Change detection:** each copy records the hash of the source it came from and of what it wrote (a SHA-256 over relative paths and contents, like cc-switch). A copy is `current`, `outdated` (the source changed), `modified` (someone changed the copy), `missing` (not copied yet, or deleted) or `source_missing`. Nothing copies again on its own: `Sync` (per share, or `Sync n copies`) does, so a run never picks up an edit you have not seen. A gone source leaves its copies until you stop sharing, except an instruction file, which drops out of the memory file at the next Sync.
- **Stop sharing** removes the copies Crewyard made, unless another share still targets the same file.
- Tables (migration `agent-files`): `agentfile_shares`, `agentfile_copies`, `agentfile_bridges`.

### Bridge (per project, off by default)

- Files offered: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursorrules`, `.windsurfrules`, at the project root. You turn the bridge on in Settings or in the New project wizard's Agents step, and may untick files.
- At every run start and resume, a wrapper around the adapters (`packages/daemon/src/agentfiles/bridge.ts`, registered through `AdapterRegistry.decorate`, so the orchestrator is untouched) finds the run's project from its folder (its task worktree, the project folder, or an earlier run there) and sets `StartRequest.instructionFiles` to the chosen files present there that the runner does not read natively. A failed lookup starts the run as it would without a bridge.
- Each adapter maps it to its runner's own setting:

| Runner | How | Takes |
|---|---|---|
| Claude Code | the files' text in the run's system prompt (the SDK otherwise sends an empty one), framed as the project's instructions with "not permissions", 64 KB per file; AGENTS.md is left out when the folder has no CLAUDE.md, since Claude Code then reads it itself | any path |
| Codex | thread config `project_doc_fallback_filenames`; used only in folders without AGENTS.md | file names only |
| Gemini CLI | `context.fileName` (GEMINI.md kept first) in a system-defaults file named by `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`, the lowest settings layer, so the profile's and the project's own settings win; the file name is the hash of its content, so concurrent runs never share one | file names only |
| OpenCode | `instructions` in the launch's inline config (1.x and 2.x), relative to the project | any path |

- The crew proposal shows, per step, the project files its runner reads, the bridged ones, and what is shared into its profile (with "changed since the copy" where it applies).

## Sources

Opened 2026-10-31 by this work (the runner and repo passes were made by research agents of this session reading through the web and `gh api`; licences, stars and archived state checked again with `gh api` the same day).

| Source | Stars | License | Archived |
|---|---|---|---|
| https://code.claude.com/docs/en/memory, /skills, /sub-agents, /settings, /settings-reference, /claude-directory, /authentication | 153,986 (anthropics/claude-code) | proprietary (no SPDX id) | no |
| Claude Agent SDK 0.3.312 `sdk.d.ts` (`settingSources`, `skills`, `systemPrompt`) and `sdk.mjs` (an omitted `systemPrompt` is sent as `""`), in node_modules | same | same | n/a |
| https://learn.chatgpt.com/docs/agent-configuration/agents-md, /docs/build-skills, /docs/custom-prompts, /docs/agent-configuration/subagents, /docs/config-file/config-reference, /docs/auth; `codex-rs/ext/skills/src/host_roots.rs`, `codex-rs/config/defaults.toml`, `codex-rs/core/src/agents_md.rs` | 132,012 (openai/codex) | Apache-2.0 | no |
| https://geminicli.com/docs/cli/gemini-md/, /docs/reference/configuration/, /docs/reference/memport/, /docs/cli/custom-commands/, /docs/cli/skills/, /docs/core/subagents/; `packages/cli/src/config/settings.ts` and `settingsSchema.ts` at v0.66.0 (`GEMINI_CLI_SYSTEM_DEFAULTS_PATH`, merge order, `context.fileName`), `packages/core/src/utils/paths.ts`, `memoryDiscovery.ts` | 108,638 (google-gemini/gemini-cli) | Apache-2.0 | no |
| https://opencode.ai/docs/rules/, /skills/, /commands/, /agents/, /config/; `packages/core/src/config/discovery.ts`, `config/plugin/{instruction,command,agent,skill,compatibility}.ts`, `packages/util/src/global-roots.ts` at v2.2.5 | 223,346 (anomalyco/opencode) | MIT | no |
| https://agents.md/ | 25,225 (agentsmd/agents.md) | MIT | no |
| https://cursor.com/docs/context/rules; https://docs.devin.ai/desktop/cascade/memories; https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions; https://code.visualstudio.com/docs/copilot/customization/prompt-files; https://docs.cline.bot/features/cline-rules | n/a | n/a | n/a |
| farion1231/cc-switch, files above | 150,410 | MIT | no |
| OrchestratorInc/agent-orchestrator, files above | 13,931 | Apache-2.0 | no |
| stablyai/orca, files above | 111,144 | MIT | no |
| BloopAI/vibe-kanban, files above | 28,523 | Apache-2.0 | no |
| generalaction/emdash, files above | 6,124 | Apache-2.0 | no |
| onurozcan/omux, files above | 75 | MIT | no |

Ideas only; no code was copied or ported. Facts used: file and folder names, setting and variable names, front matter keys and the TOML command format.

## Windows notes

- Copies, never links: links need Developer Mode, and orca notes that editors which save by rename break file links. Writes are temp-and-rename with retries for antivirus locks (`EPERM`, `EBUSY`, `EACCES`).
- Discovery uses `lstat`, so a junction or symlink is reported as `link` and never followed (the tests make a junction).
- Paths with spaces and brackets are tested (`home with spaces`, `my project (1)`, `release notes`); skill and command names may hold spaces but not a trailing dot or space, which Windows drops, nor a reserved device name.
- Paths compare without case when a run's folder is matched to its project.
- `Documents` is taken under the home folder; a OneDrive-redirected Documents folder is not followed (Cline's global rules then are not found).
- OpenCode gets bridged files as project-relative names, because its `instructions` are globs and a Windows path with brackets would be read as a pattern.

## Security notes

- **Instructions, not permissions.** Nothing here changes a role's policy, the approval layer, the project allowlist or the spend caps. Copies lose the front matter that would pre-approve tools, add hooks, pick a model or start subtasks; the bridge's system-prompt text says the files grant nothing, and a file cannot close its own frame.
- **Never read:** credentials, tokens, keys, `.env*` and every runner's settings file (they can carry env, hooks, `apiKeyHelper`, `statusLine`, MCP commands). Hooks and settings with commands are never imported.
- **Nothing copied without your choice,** and nothing copied again without `Sync`. Scripts and shell snippets need a tick of their own.
- **Untrusted text in the UI:** previews and descriptions are cleaned of control and bidi characters, capped, and shown as text, never markup.
- **The originals are never written.** Crewyard writes only inside its own profile folders and its database; the project is never written for the bridge.
- **Found gaps in isolation (not fixed here, listed for follow-up):** Codex reads `$HOME/.agents/skills` from the real home and OpenCode 2.x reads `~/.agents/skills` (no opt-out found), so skills there already reach those runners whatever profile runs them; Gemini CLI loads a project's `.env` into its own environment. The listing marks `.agents/skills` as cross-tool so you can see what those runners pick up.
- **Not verified with a live run:** that Claude Code applies a custom system prompt together with its default tools as before (the SDK already sent an empty one), that Gemini CLI 0.66 reads a context file named only through system defaults, that OpenCode applies inline `instructions` in 2.2.4, and whether a typed `/name` expands a shared command through the SDK, ACP and OpenCode's server. The conformance suite (`pnpm conformance`) does not cover these yet.

## Rollback

- Turn the bridge off per project, or stop sharing an item: its copies go, and the memory file is rewritten or removed.
- Reverting the code leaves the three tables unused (the migration only adds them) and the copies in profile folders, where each runner keeps reading them as its own; a profile's folder is removed with the profile as before.
- The adapter changes are each a few lines that read `StartRequest.instructionFiles`; without the field they do nothing.
