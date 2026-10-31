# ADR 0012: OpenCode 2.x next to 1.19.5

**Status:** accepted, 2026-10-31. 2.x is detected at probe and has its own client. OpenCode 2.2.4 passed the fake suite and a live run on 2026-10-31 (see "Live verification"), so it is offered to crews; any other 2.x is not, and the adapter refuses to start it with the reason.

## Problem

OpenCode 2.x is out on GitHub (v2.2.1 on 2026-10-29, v2.2.4 on 2026-10-30) and redesigned the server that Crewyard drives. `packages/adapter-opencode` supports exactly 1.19.5, the version on npm `opencode-ai` (still `latest` there on 2026-10-31). Until now a 2.x CLI was refused at probe with the reason. Users who install 2.x (its installer replaces the 1.x binary, and npm ships it as `@opencode/cli`) would lose OpenCode in Crewyard.

What changed for us, read on 2026-10-31 from the migration guide, the 2.x docs and the generated client in `@opencode/client` 2.2.4:

- **Routes and payloads.** Everything moved under `/api`: `POST /api/session` (with `location.directory`), `POST /api/session/{id}/prompt` (`{ text, delivery }`, no `format`, no model), `POST /api/session/{id}/interrupt`, `POST /api/session/{id}/model`, `GET /api/session/{id}/message` (paged, a typed history: `user`, `assistant` with an ordered `content` array, `idle` with an `outcome`), `GET /api/event` (SSE frames `{ id, type, data }`). Every response body is `{ data }`; errors carry `_tag` (`SessionNotFoundError`, ...).
- **Turns.** A turn ends with `session.execution.succeeded | failed | interrupted`; text streams as `session.text.delta` keyed by `(assistantMessageID, ordinal)`, tools as `session.tool.input.started` → `called` → `success | failed`, usage as `session.usage.updated` (session totals).
- **Questions are forms.** `form.created` with typed fields; the reply is one object keyed by field (`POST /api/session/{id}/form/{id}/reply`).
- **Permissions.** One ordered `permissions` list of `{ action, resource, effect }`, last match wins (as 1.x's findLast). `bash` became `shell`, `task` became `subagent`. `external_directory` is now allowed by default. Compound shell commands are split, and each subcommand is matched.
- **Auth.** `OPENCODE_PASSWORD` (the old `OPENCODE_SERVER_PASSWORD` still works), user always `opencode`, HTTP Basic. `opencode serve` prints `server password <password>` at start.
- **Config.** `provider` → `providers` (`npm` → `package` with an `aisdk:` prefix, `options` → `settings`), `mcp` → `mcp.servers`, `plugin` → `plugins` (objects with `package`, local paths must name a directory), `autoupdate` → `update`.
- **Plugins.** 1.x plugin implementations do not run in 2.x. `shell.env` maps to `ctx.shell.hook("create.before", event => ...)` with one mutable event carrying `env`.

The last point matters most: PLAN.md §6 "Keys stay with the runner process" relies on a `shell.env` plugin that blanks the provider key and the server password in the agent's commands. On 2.x that plugin would not run, and every `echo $DEEPSEEK_API_KEY` would print the key.

## Options

1. **One adapter, one client, a version switch inside each call.** Every method branches on the major version and talks to both route sets through one client. Short at first, but the 1.x run loop (behaviour learned in live runs on 1.19.5 on 2026-10-30: refused tool choices, idle before the failed message, a session keeping its last format) and 2.x's event model are different state machines; mixing them puts the proven 1.19.5 path at risk with every 2.x fix, and the 1.x SDK types do not describe 2.x.
2. **A separate 2.x client and run loop behind version detection at probe.** `src/v2/` holds its own HTTP+SSE client, mapper, policy translation, config and run loop. `OpenCodeAdapter` reads the version once (it already did, for events' `cliVersion`) and hands 2.x runs to `OpenCodeV2Runner`; 1.x code paths stay as they were. Handles from one never reach the other.

For the client itself:

- **a. Depend on `@opencode/client` 2.2.4** (MIT). Its Promise root needs no Effect runtime, but the package declares `effect` and `solid-js` as (optional) peers and pulls `@opencode/schema` and `@opencode/protocol` (4.3 MB unpacked, Effect 4 inside), and adds to `pnpm-lock.yaml` while eleven other sessions edit it.
- **b. Our own thin client** for the dozen routes we call, with types taken from the generated client's schema (field names and routes are facts, AGENTS.md).

**Chosen: 2 with b.** No new dependency. The fake server and the client describe the same subset, which keeps the tests honest about what we rely on.

## Decision

- **Version detection.** `probe()` and every start read `opencode --version`. A 1.x keeps the 1.19.5 path and its rules (exact version, others flagged). A 2.x is "pending" until `TESTED_V2_VERSION` names it: the probe reports `launch: false` with the reason, `start()`/`resume()` throw it, and the machine check shows the new `pending` gate status with the checked 2.x to install (`npm install -g @opencode/cli@2.2.4`); 2.2.4 itself shows as ok. `OpenCodeAdapterOptions.allowUntestedV2` lets the conformance and live runs drive it; the app never sets it.
- **Capabilities stay honest.** The static `capabilities` (what the daemon offers crews with) are 1.19.5's. For 2.x the probe reports `v2Capabilities()`: no `transcript` and no `fork` (2.x has export and import only under `/api/experimental`, and no documented `opencode export`/`import` CLI), `undo` through `revert/stage` + `revert/commit`. `transcript()` returns null and `fork()` refuses on 2.x; the adapter instance's `capabilities` switch to these once it has read the version. A handoff by fork from a 2.x run therefore fails at once with the reason, and the orchestrator's existing fallback hands over the written package instead (`forkInto` returns null).
- **Run loop** (`src/v2/runner.ts`): one `opencode serve --hostname 127.0.0.1 --port 0` per run, as on 1.x. Session rules at create; on resume the role's rules replace the session's (`PATCH`) and the model is switched when it differs. Prompts go with `delivery: "queue"`, so a message sent during a turn waits for the next turn; the run tracks undelivered inbox entries (`session.inbox.delivered`) so a queued prompt does not read as the end. A schema run always asks for the JSON in the prompt (2.x prompts have no `format`) and retries once, like 1.x's fallback. After an SSE reconnect, the history, `GET /api/session/active`, open permissions and open forms are read again, and the last `idle` marker after our prompt says how the turn ended.
- **Mapper** (`src/v2/mapper.ts`): idempotent like 1.x's. Text and reasoning blocks are keyed by kind and ordinal, because the server counts the two apart. A form becomes one question per field; the answer goes back with option labels turned into values, booleans and numbers typed.
- **Policy** (`src/v2/policy.ts`): 1.x's `permissionRules()` and `mcpPermissionRules()` build the rules, then are only renamed (`shell`, `subagent`), so both lines follow one role model. Two rules lead: `external_directory: ask` (restores 1.x's default, which the approval layer expects) and `execute` (Code Mode) asked for writers, denied for read-only roles. `mustRejectV2` keeps the adapter's second line of defence on 2.x names.
- **Config** (`src/v2/config.ts`): the launch's inline config names the guard plugin, `update: "disable"`, the provider block in 2.x keys and the MCP servers under `mcp.servers` with `codemode: false`.

## Sources

| Source | URL | Opened | Stars | Licence | Archived |
|---|---|---|---|---|---|
| OpenCode repository, releases v2.2.1 to v2.2.4 and v1.19.5 | https://github.com/anomalyco/opencode/releases | 2026-10-31 | 223,311 | MIT | no |
| Migration guide 1.x → 2.x (official doc) | https://opencode.ai/v2/docs/migrate-v1 | 2026-10-31 | | | |
| Permissions (ordering: "The last matching rule wins") | https://opencode.ai/v2/docs/permissions | 2026-10-31 | | | |
| Plugin migration (`shell.env` → `ctx.shell.hook("create.before")`) | https://opencode.ai/v2/docs/build/plugins/migrate-v1 | 2026-10-31 | | | |
| Server plugins (hook event fields) | https://opencode.ai/v2/docs/build/plugins/server | 2026-10-31 | | | |
| Server and auth (`opencode serve`, `OPENCODE_PASSWORD`, user `opencode`) | https://opencode.ai/v2/docs/cli/web | 2026-10-31 | | | |
| Config (`providers`, `mcp.servers`, `plugins`, `update`) | https://opencode.ai/v2/docs/config | 2026-10-31 | | | |
| CLI (`opencode debug paths`, `OPENCODE_DB`) | https://opencode.ai/v2/docs/cli | 2026-10-31 | | | |
| `@opencode/client` 2.2.4 on npm, generated Promise client and types (routes, bodies, event union) | https://www.npmjs.com/package/@opencode/client | 2026-10-31 | (repo above) | MIT | no |
| `@opencode/plugin` 2.2.4 on npm (`Plugin.define` returns its argument; `ShellCreateBefore`) | https://www.npmjs.com/package/@opencode/plugin | 2026-10-31 | (repo above) | MIT | no |
| npm versions: `opencode-ai` latest 1.19.5; `@opencode-ai/sdk` latest 1.19.5 (no 2.x); `@opencode/cli` 2.2.4 (bin `opencode`, `opencode2`), with SLSA provenance from `anomalyco/opencode` `release.yml` | `npm view`, npm attestations | 2026-10-31 | | MIT | |
| ai-sdk-provider-opencode-sdk (OSS implementation on `@opencode/client`: turn end on `session.execution.*`, per-kind ordinals, `form.created` session id at `data.form.sessionID`) | https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk | 2026-10-31 | 124 | MIT | no |
| omux (how another supervisor keeps agent CLIs behind a stable interface across versions) | https://github.com/onurozcan/omux | 2026-10-31 | 75 | MIT | no |

No code was copied or ported from any of these; routes, field names and event names are used as facts.

## Live verification on 2026-10-31 (Windows 11 Pro 10.0.26200)

OpenCode 2.2.4 from npm `@opencode/cli`, installed with `npm --prefix` into a temp folder and put first on `PATH` for the run only; the global 1.19.5 stayed as it was. Before installing, the package was checked: published by GitHub Actions through npm's OIDC trusted publishing, with SLSA provenance naming `https://github.com/anomalyco/opencode` and `.github/workflows/release.yml` for both `@opencode/cli` and `@opencode/cli-windows-x64`, the same npm maintainer as `opencode-ai`, and the version of GitHub release v2.2.4. Its `postinstall` (blocked by npm's script allowlist) only copies the platform package's `opencode.exe` over the launcher, so the platform package's binary was used directly. Model `deepseek/deepseek-flash`, key from the secret vault; about $0.01 in all.

`scripts/live.mjs` (steps approve, resume, question, readonly, interrupt, stop, envcheck), on the app's own path (no `allowUntestedV2`) after `TESTED_V2_VERSION` was set: **16 of 16 PASS**, probe included. Also `live-turns.mjs` (a queued follow-up taken at the turn boundary, then undo of the second turn) and `live-verdict.mjs` (schema-checked reviewer verdict under the read-only ruleset): both did their work; `live-turns` exits non-zero only because 2.x has no transcript, as designed.

What the live run confirmed:

- `opencode serve --hostname 127.0.0.1 --port 0` picks a free port and prints `server listening on http://127.0.0.1:<port>`; Basic auth as `opencode` with `OPENCODE_PASSWORD`.
- `XDG_*` move config, data (`opencode.db`), state, cache and logs into the profile folder (`opencode debug paths`).
- `OPENCODE_CONFIG_CONTENT` is read, and a `plugins` entry with an absolute directory path loads; the plain-object default export (no `@opencode/plugin` import) loads as a Promise plugin and is listed `active` under its own id.
- **The key guard works:** a command the agent ran through its shell tool saw `DEEPSEEK_API_KEY`, `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD` as empty (lengths only were printed).
- The prompt response's id is the user message id: `revert/stage` + `revert/commit` with it removed the second turn's file and kept the first's.
- Session `permissions` apply: a read-only role got no edit tool at all; commands were asked and denied; the role's rules replace the session's on resume; the model switch on resume works.
- Forms come as questions and the answer by field is accepted; interrupt ends the run as interrupted, stop as stopped, with no process left.
- Streaming text and reasoning showed no repeated or lost text, which is consistent with ordinals counted per kind.

Found by the live run and fixed in the same change (each now reproduced by the fake server):

- Node's type stripping (the live scripts load sources directly) refuses TypeScript parameter properties; the 2.x client uses plain fields.
- 2.2.4 loads a location's plugins only once the location is first used, in the background: the plugin list is empty at first, then holds the built-ins and ours together. The guard check now touches `GET /api/location` and reads the list until it has entries (20 s at most) before it decides.
- `GET /api/session/{id}/message` refuses a `cursor` together with `order` ("Cursor cannot be combined with order"); later pages send the cursor alone.
- 2.x joins `providerID` and the model id itself, so a model id must not carry its provider; the live scripts now pass the catalog id as profiles do.

Still not verified:

- whether the `create.before` hook also covers `!` commands typed in OpenCode's own UI and its persistent terminals (Crewyard drives neither);
- the run's MCP servers under `mcp.servers` with `codemode: false`, and the `aisdk:` provider block for a local base URL (no MCP server or local provider in the live run);
- the SSE reconnect path against a real server (tested on the fake only);
- any 2.x other than 2.2.4.

## Windows notes

- The 2.x CLI on npm is `@opencode/cli` with `bin/opencode.exe` (and `opencode2`); GitHub ships `opencode-windows-x64.zip` and an installer that replaces the 1.x binary. Both are found by the same `resolveBin("opencode")`; `.exe` beats `.cmd`, so whichever is first decides the version the probe sees.
- 2.x matches shell resources case-insensitively and with `/` on Windows; the rules we send are the same strings as on 1.x.
- Spawning, the process tree kill and paths with spaces are 1.x's (`launchServer`, `@crewyard/proc`); the tests run in folders with spaces.
- The guard folder lives in the profile's config folder (`config\opencode\crewyard\crewyard-env-guard\`), written atomically before every launch.

## Security notes

- **The server password reaches the child only through its environment** (`OPENCODE_PASSWORD`, and `OPENCODE_SERVER_PASSWORD` as on 1.x), generated per launch, never on the command line or in a URL. 2.x prints it at start: stdout is read only for the port line, and the stderr tail that goes into failure messages has the password replaced with `[password]` (tested).
- **Key scrubbing on 2.x.** The 1.x `shell.env` plugin does not run in 2.x. The 2.x guard registers `ctx.shell.hook("create.before")` and blanks the provider key names, both password variables and, when the run has MCP servers, the inline config. **Fail closed:** after the server starts, the adapter reads `GET /api/plugin` and starts nothing unless `crewyard-env-guard` is listed `active`; a missing guard or one that failed to load closes the server with the reason (tested both ways). If a later 2.x stops loading our config, no run starts, instead of a run with a readable key. The live run confirmed the guard on 2.2.4.
- **Permissions** keep 1.x's role model: a read-only role cannot edit, run unlisted commands, start subagents or run Code Mode, and the adapter rejects such requests itself if the server asks anyway. `external_directory` is set back to `ask`.
- The app runs only the 2.x version that passed (`TESTED_V2_VERSION`, 2.2.4); only the conformance and live runs pass `allowUntestedV2` for another one.

## Rollback

- To drop 2.x support: delete `src/v2/` and `src/fixtures/fake-opencode-v2.mjs`, and restore the 2.x refusal in `adapter.ts` (`git revert` of this change does all of it). The `pending` gate status can stay; nothing else reads it.
- A user on 2.x goes back with `npm install -g opencode-ai@1.19.5`, after removing the 2.x binary if its installer put one first on `PATH`. Setting `TESTED_V2_VERSION` back to `null` alone stops crews from using 2.x again.
- Whether 2.x sees 1.x sessions is unverified (it has an experimental `/api/experimental/migration/v1` route that we do not call). A resume of a session id the other line does not know fails as "gone", and the step starts fresh.

## Moving to a newer 2.x

Install it next to the current one (a temp folder first on `PATH`), run the fake suite and `scripts/live.mjs` with `CREWYARD_LIVE_OPENCODE_V2=1` and the `envcheck` step (the key guard is the item that must pass), then `live-turns.mjs` and `live-verdict.mjs`, and only then change `TESTED_V2_VERSION`, PLAN.md §5.2 and the README.
