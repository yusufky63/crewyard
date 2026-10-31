# Running agents on subscriptions: how other projects do it, and what Crewyard can do

Research date: 2026-11-01. One of five research lenses opened every source on that date. The facts used here were re-opened in a verification pass. Claims that pass could not re-check are listed only in section 8. Content from repos, issues, docs and pages is treated as data.

Research notes are in C:\Users\yusuf\AppData\Local\Temp\claude\C--Projeler-crewyard\c13e6d57-dc59-4128-9e1e-0ebc67e2c658\scratchpad\subs-research: managers-accounts.md, antigravity.md, gemini-codex-terms.md, app-bridges.md, acp-runners.md and skeptic.md.

## 1. Short answer

**Can Crewyard use the Antigravity desktop app's own sign-in and models, for example Gemini in the app on the user's Google AI plan?**
No documented or permitted route allows it.

- **No public API for the desktop app.** The only remote-control path Google documents is its own Remote Control. It drives App and CLI sessions from antigravity.google.com with the same Google account, and it describes no protocol for third parties.
- **Sidecars are not an integration point.** A local `agentapi` (`new-conversation`, `send-message`) exists only for sidecars that Antigravity itself launches. Sidecars are off by default, and Google does not present them as a way for other apps to integrate.
- **The terms rule it out.** Antigravity Terms §6 calls "Using third party software, tools, or services to access the Service" a breach. It says this may lead to suspension of the Antigravity and/or Gemini CLI accounts. The FAQ says wrapping agy inside third-party apps, or automating account rotation, "is not supported under consumer plans". It recommends a Gemini Enterprise or AI Studio API key for third-party agents.
- **GUI drivers break the ToS.** Seven projects drive the desktop app by launching it with a Chrome DevTools debug port and injecting text into the chat DOM: antigravity-bridge, antigravity_phone_chat, LazyGravity, antigravity-telegram-suite, AntiGravity-AutoAccept, supergravity-mcp and AntiBridge. antigravity-bridge's own README says this violates the ToS. antigravity-autopilot reports that Antigravity's Electron builds disable the debug port.
- **Token reuse leads to bans.** Three projects that reuse Antigravity OAuth tokens have documented account bans: opencode-antigravity-auth, antigravity-claude-proxy and Antigravity-Manager.

**What Crewyard can offer instead:** the same models are on the Gemini API as the stable ids `gemini-4-argon` and `gemini-3.8-flash`. Three runners can use them with an API key: Gemini CLI with a paid key, OpenCode, or Google's official ACP server in `gemini-api-key` mode.

**Can Crewyard run Codex, Gemini and Antigravity on subscriptions?**

| Runner | Subscription through Crewyard | Basis |
|---|---|---|
| Codex | **Yes, as today, while Crewyard is a local, open-source app.** The app-server doc says local or open-source apps using ChatGPT auth "can continue using it" and recommends moving to Sign in with ChatGPT. It also says app-server auth "has never been permitted for commercial or hosted services". | learn.chatgpt.com/docs/app-server |
| Gemini CLI | **No for personal plans.** Since 2026-06-18 Gemini CLI has not served free, AI Pro or Ultra accounts, and Login with Google no longer works. It still serves Code Assist Standard/Enterprise and paid Gemini or Agent Platform keys. Crewyard's `oauth-personal` sign-in in `packages/adapter-acp/src/agents.ts` (line 111) now helps only enterprise Code Assist users. | Google blog; Code Assist deprecation page |
| Antigravity (agy CLI or the official `agy_acp_server`) | **Technically possible; the terms are unclear and lean against it.** Google's official ACP server runs its own sign-in, and orca, agent-orchestrator, T3 Code and codeg use it. But Terms §6 and the FAQ do not separate token reuse from a third-party app launching Google's own binary. Google has not cleared a non-Google client using a consumer sign-in. The only "agy -p is fine" statement is a forum reply with no staff badge. | antigravity.google/terms; /docs/faq |
| Claude Code | **No change: API keys only.** The Agent SDK note still forbids claude.ai login without approval. Crewyard's Claude adapter is built on `@anthropic-ai/claude-agent-sdk` 0.3.312. | code.claude.com/docs/en/agent-sdk/overview |

## 2. How other projects handle it

| Project | Runners | Subscription handling per runner | Multi-account | Own MCP server | Source |
|---|---|---|---|---|---|
| stablyai/orca (111,710, MIT) | Claude Code, Codex, Antigravity | **Claude:** one `CLAUDE_CONFIG_DIR` per account with auth env vars stripped. Usage comes from `api.anthropic.com/api/oauth/usage`, using the token from the existing Claude Code login (Keychain `Claude Code-credentials-<sha256(dir)[0:8]>`). **Antigravity:** official `agy_acp_server` pinned at 1.4.3 with sha256, macOS and Linux only, auth `oauth-personal`. A `BROWSER` helper catches the sign-in URL, which must be accounts.google.com with a 127.0.0.1 redirect. Sets `AGY_ACP_FORCE_FILE_STORAGE=1` and strips `GEMINI_API_KEY`, `GOOGLE_*` and `AGY_ACP_*`. | Yes. Claude by config dir; Antigravity by rewriting agy's native credential (Keychain, or Windows `CredReadW`), which is token swapping | not checked | `src/main/antigravity/*`, `src/main/claude-accounts/*`; issues #19587, #21583 |
| OrchestratorInc/agent-orchestrator (13,965, Apache-2.0) | Claude, Codex, Antigravity | **Claude:** `CLAUDE_CONFIG_DIR` plus `CLAUDE_SECURESTORAGE_CONFIG_DIR` per account. Neutralises the `ANTHROPIC_*` and `CLAUDE_CODE_OAUTH_TOKEN` variables and shares session dirs so resume works. Login is `claude auth login --claudeai/--console/--sso`, or the user pastes a setup-token. **Codex:** `CODEX_HOME` per account with `codex login --device-auth`. **Antigravity:** ACP driver launches only a user-installed `agy_acp_server` ("never downloads or bundles it"). It calls `oauth-personal` only if `GEMINI_HOME` already records a sign-in, with a 20 s timeout. | Yes (Claude, Codex) | see section 8 | `backend/internal/adapters/agentaccount/*`, `chatdriver/agyacp/driver.go` |
| farion1231/cc-switch (150,633, MIT) | Claude, Codex, Antigravity | **Antigravity:** keeps full agy keychain credentials in `agy_accounts.json` (0600) and writes the chosen one back. It adds accounts with agy's installed-app OAuth client id and secret, hard-coded in its source. **Codex:** a proxy runs ChatGPT Plus/Pro device-code OAuth and relays requests. | Yes | no | `src-tauri/src/services/agy_account/*`, `proxy/providers/codex_oauth_auth.rs` |
| generalaction/emdash (6,135, Apache-2.0) | Claude (ACP + Agent SDK), Codex, Antigravity (terminal) | **Claude:** "Sign in with Claude Code" (`claude auth login` in a terminal) or an API key. **Codex:** device-auth login or `OPENAI_API_KEY`. | No (#1678 closed, PR #3202 open) | not checked | `packages/plugins/src/agents/impl/*` |
| BloopAI/vibe-kanban (28,541, Apache-2.0) | Claude, Codex, Gemini and others | Uses the user's own CLI logins in the default homes. `disable_api_key` removes `ANTHROPIC_API_KEY` so the subscription is used. | No (#2187 closed, PR #1983 unmerged) | yes (section 8) | `crates/executors/src/executors/claude.rs` |
| eneskirca/nodeterm (2,266, BUSL-1.1; API reports NOASSERTION) | Claude, Codex, agy and others | **Claude:** `CLAUDE_CONFIG_DIR` accounts. **Codex:** `CODEX_HOME` plus an app-server daemon per account, "not reachable on Windows yet". **agy:** runs in a PTY with status from global hooks, on the user's own login. | Claude and Codex yes; Antigravity no | not checked | `docs/antigravity-agent.md`, `docs/codex-accounts-acceptance.md` |
| pingdotgg/t3code (35,462, MIT) | Antigravity via ACP | Pins `agy_acp_server` 1.4.1 because 1.4.2 to 1.4.4 write `run-workflow/SKILL.md` into every workspace. Sends `clientInfo {name:"zed"}` to unlock non-Gemini models, which is impersonation. | not checked | not checked | `antigravityRelease.ts`, `AntigravityAcpSupport.ts` |
| spacering-net/codeg (4,245, Apache-2.0) | Antigravity via ACP | Signs in through a throwaway agent process (ACP initialize + authenticate). `oauth-personal` binds 127.0.0.1 and waits 300 s. The URL went to stdout in 1.0.0 and goes to stderr from 1.1.1. The agent keeps the token. | not checked | not checked | `src-tauri/src/acp/antigravity_login.rs` |
| tiezbro/paseo-agy-acp (66, Apache-2.0) | Antigravity | Proxies the official ACP server so Paseo can sign in a second Pro account. Its README says the ACP login is in `~/.gemini/antigravity-acp`, separate from the CLI. | 2 accounts | no | README |
| Conductor (closed source) | Claude, Codex | Claude needs "a Claude Pro or Max subscription connected to Claude Code". The page warns that `ANTHROPIC_API_KEY` overrides it. | Not mentioned | not checked | conductor.build harness page |
| lbjlaq/Antigravity-Manager (32,731; badge CC-BY-NC-SA-4.0, API NOASSERTION) | Antigravity | Rotates keychain credentials. A proxy at localhost:8045 serves Antigravity as OpenAI, Anthropic and Gemini APIs, with silent rotation on 429/401. | Yes (rotation) | no | README; issues #2297, #3681 |
| NoeFabris/opencode-antigravity-auth (10,975, MIT) | OpenCode plugin | Reuses Antigravity OAuth against `daily-cloudcode-pa.sandbox`. README: "Google may restrict accounts using third-party clients." | Yes (rotation) | no | README; issue #526 |
| badrisnarayanan/antigravity-claude-proxy (4,033, MIT) | Claude Code via a proxy | Reuses Antigravity OAuth tokens and also detects the local app session. Its README warns of ToS bans. | Yes | no | README |
| shubzkothekar/antigravity-acp (85, MIT) | Antigravity | Spawns the official agy and handles no credentials. Its README still warns this is the pattern the FAQ forbids and recommends a Vertex or AI Studio key. | No | no | README |
| Zed / JetBrains (ACP clients) | Registry agents | Each agent owns its login, models and billing. JetBrains needs no AI subscription for ACP agents. | n/a | forward their own MCP servers to agents | zed.dev and jetbrains.com docs |
| agentclientprotocol/claude-agent-acp (2,713, Apache-2.0) | Claude | Auth methods `claude-ai-login`, `console-login`, `gateway` and `gateway-bedrock`. `--hide-claude-auth` hides the subscription logins and refuses every turn a subscription would pay for. | n/a | n/a | repo |
| GitHub Copilot CLI | Copilot | `copilot --acp` over stdio, or TCP on 127.0.0.1 with `--port`. Public preview. BYOK through `COPILOT_PROVIDER_*` without a GitHub login. | n/a | n/a | docs.github.com |

Ban and incident threads, all confirmed:
- **orca #21583 (2026-09-19):** a Claude account was suspended citing the Supported Countries Policy and reinstated on appeal. A link to Orca is not confirmed.
- **orca #19587:** a contributor declined an agy token-refresh change. Saving changed the file from 0600 to 0644, a stale refresh could overwrite a newer login, and fields were dropped. He pointed to agy's native `/usage` instead.
- **opencode-antigravity-auth #526 (2026-03-03):** a 403 said the account was "disabled ... for violation of Terms of Service". One user says an appeal restored the account.
- **Antigravity-Manager #2297 and #3681:** dated 2026-03-10 and 2026-10-16. They document Google suspending accounts it says use third-party software.

## 3. Antigravity facts

**Surfaces and sign-in**
- **One shared sign-in.** The App, the agy CLI, the IDE extensions (VS Code, Visual Studio, JetBrains, Zed, Xcode, Eclipse) and the Python SDK share one auth layer. The install page says: "Signing in on one local surface shares your credentials across your local environment."
- **Auth types:** `oauth-personal` (Free, Pro, Ultra), `oauth-business` (Enterprise), `gemini-api-key` and `agent-platform`.
- **Using an API key with agy:**
  - It needs `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` plus `GEMINI_API_KEY`.
  - The env var alone "has no effect". Keys in `GOOGLE_API_KEY` or `.env` are ignored.
  - ADC works with `AGY_ADC_AUTH=true`.
  - No config-dir override is documented.
- **Python SDK:** API key, Vertex or ADC only.

**Desktop app**
- **Remote Control:** drives sessions from antigravity.google.com only. `agy remote-control start|status|stop` runs a headless daemon that uses the CLI's credentials.
- **Sidecars:** configured in `~/.gemini/config/sidecars/<id>/sidecar.json` and enabled in `config.json` with a `projectId`. They get `agentapi new-conversation` and `agentapi send-message`. Off by default.

**agy CLI structured mode**
- **Output:** `-p` with `--output-format text|json|stream-json`. stream-json is NDJSON with the events `init`, `step_update` and `result`.
- **Other flags:** `--input-format stream-json`, `--json-schema`, `--model`, `--effort`, `--conversation`, `-c`, `--agent`, `--print-timeout` (default 5 min) and `--sandbox`.
- **Approvals:** in `-p` mode a tool that needs approval is soft-denied and the run exits 0. Headless runs need a prior interactive sign-in.
- **No ACP flag.** Requests #31, #704 and #195 are open; #195 is labelled as a duplicate of #31.

**Official ACP server**
- **Registry entry:** `antigravity-acp` by Google LLC, license proprietary, v1.4.5. It ships `agy_acp_server.exe` for Windows x64 and arm64 from dl.google.com. Added in PR #542, merged 2026-08-20.
- **Auth options:** `oauth-personal`, `oauth-business`, `gemini-api-key` and `agent-platform`, on any plan. Google's Zed page lists macOS and Linux only.
- **Registry auth rule:** an agent must use Agent Auth or Terminal Auth, so tokens never reach the client.

**Models (antigravity.google/docs/models)**

| Model | Plans | Notes |
|---|---|---|
| Gemini 4 Argon | Pro (paid or eligible trial), Ultra, Enterprise; not Free & Plus | API id `gemini-4-argon` |
| Gemini 3.8 Flash | all plans | API id `gemini-3.8-flash`; the page names no default model |
| Gemini 3.7 Flash, 3.6 Flash, 3.1 Pro | Enterprise only | |
| Claude Sonnet 5.5 and Opus 5.5 (Thinking) | Pro non-trial, Ultra, Enterprise | |
| Claude Sonnet 4.6 and Opus 4.6 (Thinking) | Free & Plus, Pro | removed 2026-11-02 |
| GPT-OSS-120b | all plans except Enterprise | removed 2026-11-02 |

**Plans:**
- **Quota refresh:** Ultra and Pro refresh every 5 hours, up to a weekly limit. Free refreshes weekly.
- **No published numbers.** The page says limits can change.
- **Overages:** Pro and Ultra can pay with AI credits.
- **No bring-your-own-key.** Quota is shown only on the Settings page.

**MCP client support:**
- **Where servers are added:** the App's MCP Store (77 servers), or `/mcp` in the CLI.
- **Config files:** `~/.gemini/config/mcp_config.json` and `.agents/mcp_config.json`, under `mcpServers`.
- **Transports:** stdio and Streamable HTTP; SSE and `httpUrl` are not supported.
- **Timeouts:** 300 s to connect, 180 s per tool call.
- **Unconfigured tools** default to Ask.

**Hooks:**
- **Files and events:** `hooks.json` in `.agents/` or `~/.gemini/config/`. Six events: SessionStart, PreToolUse, PostToolUse, PreInvocation, PostInvocation and Stop.
- **Decisions:** PreToolUse returns allow, auto_approve, deny, ask, force_ask or deny_unless_prior_grant.
- **Payloads:** they include conversationId and transcriptPath. Hooks work in the App, the CLI and the IDE.
- **v2.28.0 (2026-10-27):** hooks now receive the user message.
- **nodeterm's measurements on agy 1.2.3:** an empty stdout lets the tool run, while `{}` denies it.

**Terms:**
- **§6** is the clause quoted in section 1. It also bars use "in connection with products not provided by us".
- **No exceptions or dates.** There is no approved-integration list, no ACP exception and no date on the page.
- **FAQ examples:** it names Claude Code, OpenClaw and OpenCode, and never mentions ACP, Zed or JetBrains.

## 4. Provider terms status (all opened 2026-11-01)

| Provider | What the official pages say | Effect on Crewyard | Source |
|---|---|---|---|
| Anthropic Agent SDK | Unless previously approved, third-party products may not offer claude.ai login or rate limits; they must use API keys. The approval path is contacting sales. | Applies to Crewyard, which uses the Agent SDK. Keep PLAN.md §6. | code.claude.com/docs/en/agent-sdk/overview |
| Anthropic legal | No claude.ai login in third-party apps, no routing through subscription credentials, no handling of tokens. New nuance: a product running the **unmodified** Claude Code binary must keep its built-in auth. The page says this does not prevent an end user signing in to that binary with their own subscription. | Covers products that run the plain binary, not SDK products. | code.claude.com/docs/en/legal-and-compliance |
| Anthropic auth | One `CLAUDE_CONFIG_DIR` per account is the documented multi-account method. On Windows the credentials move to `<dir>\.credentials.json`. | Matches Crewyard's per-profile folders. | code.claude.com/docs/en/authentication |
| OpenAI app-server | Login types: `apiKey`, `chatgpt`, `chatgptDeviceCode` and experimental `chatgptAuthTokens`. Local or open-source apps may continue to use ChatGPT auth. It was never permitted for commercial or hosted services. App-server is "experimental and isn't supported for production workloads". Set `clientInfo.name`. `codex mcp-server` has been removed. | Allowed while Crewyard is free, local and open source. Settles the item in PLAN.md §6. | learn.chatgpt.com/docs/app-server; /docs/mcp-server |
| OpenAI SIWC (open source) | PKCE with a 127.0.0.1 redirect and `dynamic_agent_client`, which then issues an `oaiapp_` id. Scope `chatgpt.tokens.use.direct`. Refresh tokens rotate and are stored by the app. The token goes to app-server as `ACCESS_TOKEN`. Listed integrations: OpenClaw, OpenCode, Pi and T3, with a weekly per-app cap. | The long-term route. Crewyard would hold tokens and run a loopback listener, which conflicts with AGENTS.md. | developers.openai.com/siwc/token-sharing-open-source (+ /sign-in, /codex-app-server); learn.chatgpt.com/docs/sign-in-with-chatgpt |
| OpenAI pricing | Codex is included in ChatGPT Free through Enterprise. Plus and Business have 5-hour windows and weekly limits; Pro currently has no 5-hour limit. API-key use has no cloud features. | | learn.chatgpt.com/docs/pricing |
| Google Gemini CLI | Since 2026-06-18 there is no service for free, AI Pro or Ultra users, and Login with Google no longer works. Enterprise accounts and paid keys keep access. The terms forbid third-party access to the services behind the CLI. | PLAN.md §1, §5, §6 and §16 are out of date. | developers.googleblog.com transition post; developers.google.com Code Assist deprecation page; gemini-cli discussion #27274; geminicli.com/docs/resources/tos-privacy |
| Google Antigravity | Terms §6 and the FAQ, as in section 3. The only permissive statement is an unbadged forum reply. | Consumer sign-in through Crewyard is a ban risk Google has not cleared. API key and Agent Platform are the documented route. | antigravity.google/terms; /docs/faq; discuss.ai.google.dev thread 183429 |

## 5. Patterns

**Patterns that work and fit Crewyard's rules**
1. **The user's own CLI login in a per-profile folder.** For example `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, with the CLI running its own login and competing env vars stripped. Crewyard's §6 profiles already do this.
2. **ACP agents keep sign-in inside the agent.** The registry requires Agent Auth or Terminal Auth. Crewyard's adapter-acp already signs in through a throwaway process and never opens the credentials file.
3. **Pin and verify downloaded agent binaries.** orca and T3 Code pin with sha256 and skip bad versions. Alternatively, launch only a user-installed copy, as agent-orchestrator does.
4. **Hide subscription auth where the provider forbids it**, like claude-agent-acp's `--hide-claude-auth`.
5. **Desktop apps as MCP clients of the orchestrator (pull model).** The user drives the app on the app's own sign-in, and the app calls the orchestrator's MCP tools. Antigravity has not said whether this counts as third-party access.
6. **Hooks for observation and approval.** Documented and consent-based.
7. **API keys for the same models.** Google's FAQ points third-party agents here.

**Patterns to avoid**
1. **Token reuse or swapping:** copying or rewriting a CLI's stored credential, or reusing its OAuth client id and secret. These are the projects with documented bans.
2. **Undocumented usage endpoints** called with subscription tokens.
3. **GUI automation** over CDP or UI Automation. It is brittle, leaves an unauthenticated debug port open, skips the app's approvals, and one such project's own README calls it a ToS violation.
4. **Subscription relays and pooling proxies.**
5. **Impersonating another client**, like sending `clientInfo` "zed".
6. **Automated account rotation** on consumer plans.

## 6. Recommendations for Crewyard (ranked)

| # | Recommendation | Tier | Touches |
|---|---|---|---|
| 1 | Fix the Gemini CLI subscription claim. Relabel or hide `oauth-personal` as "Code Assist Standard/Enterprise accounts only", keep paid keys and Vertex, and update PLAN.md and the docs/FAQ. This contradicts PLAN.md as written, so the owner decides first. | Small (copy) to Medium (removing the option) | `packages/adapter-acp/src/agents.ts`, Accounts UI and en/tr locales, PLAN.md, docs |
| 2 | Offer Gemini 4 Argon and Gemini 3.8 Flash by API key in the catalog, for the Gemini CLI and OpenCode runners. No subscription and no terms risk. | Small to Medium | `packages/core` catalog, provider settings, docs |
| 3 | Record the Codex terms answer in PLAN.md §6 and §16: allowed for local open-source use, never for commercial or hosted. Selling or hosting Crewyard would need OpenAI's partner program. Check that app-server gets `clientInfo.name`. | Small | PLAN.md; `packages/adapter-codex` (check only) |
| 4 | Add an Antigravity runner on API key or Agent Platform only, through the official `agy_acp_server` in the generic ACP adapter, with no `oauth-personal`. It needs: a new runner id; a sha256-pinned binary (a managed download needs the owner's consent, or the user installs it); a `GEMINI_HOME` per profile with `AGY_ACP_FORCE_FILE_STORAGE`; URL matching on stdout and stderr; usage marked Unknown; and `clientInfo` "crewyard". Its value over #2 is mainly Antigravity's agent harness. | Large (ADR) | core runner ids, adapter-acp, proc, Settings, conformance |
| 5 | Before any Antigravity consumer sign-in, the owner asks Google on the antigravity-cli tracker or through support and waits for a staff answer. | process | none |
| 6 | Document "use Crewyard from the Antigravity app": a stdio MCP entry in `.agents/mcp_config.json`, plus optional hooks for status. This depends on the Crewyard MCP server ADR (0021, not on this branch) and on the answer to #5. | Medium or Large | MCP/ingress package, docs |
| 7 | List the rejected patterns from section 5, with the ban threads, in PRIOR_ART.md. | Small | PRIOR_ART.md |
| 8 | Keep Claude on API keys. A plain-binary subscription path would need a different adapter and Anthropic's confirmation. | Large if ever pursued | none now |
| 9 | Later: Sign in with ChatGPT through the open-source token-sharing program. It needs DPAPI-stored refresh tokens and a loopback listener, which goes against the current AGENTS.md rules. | Large (ADR) | adapter-codex, secrets, AGENTS.md |

## 7. Sources (opened 2026-11-01; none archived)

| URL | Stars | License |
|---|---|---|
| github.com/stablyai/orca | 111,710 | MIT |
| github.com/farion1231/cc-switch | 150,633 | MIT |
| github.com/OrchestratorInc/agent-orchestrator | 13,965 | Apache-2.0 |
| github.com/generalaction/emdash | 6,135 | Apache-2.0 |
| github.com/BloopAI/vibe-kanban | 28,541 | Apache-2.0 |
| github.com/eneskirca/nodeterm | 2,266 | NOASSERTION (LICENSE file BUSL-1.1) |
| github.com/pingdotgg/t3code | 35,462 | MIT |
| github.com/spacering-net/codeg | 4,245 | Apache-2.0 |
| github.com/tiezbro/paseo-agy-acp | 66 | Apache-2.0 |
| github.com/shubzkothekar/antigravity-acp | 85 | MIT |
| github.com/lbjlaq/Antigravity-Manager | 32,731 | NOASSERTION (badge CC-BY-NC-SA-4.0) |
| github.com/NoeFabris/opencode-antigravity-auth | 10,975 | MIT |
| github.com/badrisnarayanan/antigravity-claude-proxy | 4,033 | MIT |
| github.com/ythx-101/antigravity-bridge | 63 | MIT |
| github.com/presidentrice/supergravity-mcp | 1 | MIT |
| github.com/chillinh/AntiBridge-Antigravity-remote | 44 | MIT |
| github.com/krishnakanthb13/antigravity_phone_chat | 813 | NOASSERTION |
| github.com/tokyoweb3/LazyGravity | 242 | MIT |
| github.com/emreturkmencom/antigravity-telegram-suite | 190 | MIT |
| github.com/yazanbaker94/AntiGravity-AutoAccept | 404 | MIT |
| github.com/timteh/antigravity-autopilot | 7 | MIT |
| github.com/agentclientprotocol/registry | 445 | Apache-2.0 (the antigravity-acp entry is proprietary) |
| github.com/agentclientprotocol/claude-agent-acp | 2,713 | Apache-2.0 |
| github.com/agentclientprotocol/codex-acp | 502 | NOASSERTION (LICENSE file Apache-2.0); the old zed-industries repo is archived |
| github.com/google-gemini/gemini-cli | 108,655 | Apache-2.0 |
| github.com/google-antigravity/antigravity-cli | 2,671 | none reported |
| github.com/google-antigravity/antigravity-sdk-python | 3,898 | Apache-2.0 |
| github.com/openai/codex | 132,488 | Apache-2.0 |
| github.com/eyaltoledano/claude-task-master | 28,283 | NOASSERTION |

Docs opened, by area:
- **Antigravity:** antigravity.google /terms, /docs/faq, /install, /cli/headless, /remote-control, /sidecars, /models, /plans, /mcp, /hooks, /changelog, /ide/extensions and /ide/extensions/zed; the Argon blog post; discuss.ai.google.dev thread 183429.
- **Google Gemini:** ai.google.dev/gemini-api/docs/models; the developers.googleblog.com transition post; the Code Assist deprecation page; gemini-cli discussion #27274; geminicli.com tos-privacy and mcp-server pages.
- **OpenAI:** learn.chatgpt.com app-server, mcp-server, pricing and sign-in-with-chatgpt; developers.openai.com/siwc token-sharing-open-source, /sign-in and /codex-app-server.
- **Anthropic:** code.claude.com agent-sdk/overview, legal-and-compliance and authentication.
- **Other:** conductor.build Claude Code harness page; zed.dev external-agents and acp/agent/antigravity-acp; jetbrains.com ACP; docs.github.com Copilot ACP server; the registry's AUTHENTICATION.md and PR #542.

## 8. Not verified

- orca: Codex hot-swap.
- cc-switch: Claude account mode and its Chinese guide.
- crystal, claude-squad and opcode: whether they really rely on the user's own login.
- Conductor: the Codex page.
- emdash: whether `usage.ts` calls get_usage.
- agent-orchestrator: Codex limits via app-server, and the PR #6600 date.
- claw-orchestrator and Poracode: README content.
- agy-bridge and codex-bridge: content beyond metadata.
- Four CDP driver repos (antigravity_phone_chat, LazyGravity, antigravity-telegram-suite, AntiGravity-AutoAccept): mechanics beyond metadata.
- MCP config details for Codex, Claude Code, Claude Desktop, Cursor, Windsurf/Devin and VS Code; the VS Code LM API rules and copilot-proxy.
- MCP servers: vibe-kanban's shim, `ao mcp`, github-mcp-server, Linear, Atlassian and Backlog.md.
- claude-task-master: provider docs and LICENSE file.
- ACP ecosystem: registry launch commands, the agentclientprotocol.com agent count, the auth RFD date, and codex-acp's auth methods.
- `agy_acp_server` behaviour:
  - the clientInfo model allowlist (#1318, a user report on 1.4.1);
  - a separate credential store (#1354, a static reading of 1.4.3);
  - no usage sent to clients (#1045, measured on 1.1.1);
  - per-profile `GEMINI_HOME` isolation on Windows;
  - the auth methods 1.4.5 advertises;
  - support for request_permission, plans and model switching;
  - any base-URL override.
- paseo-agy-acp: its claim that the ACP path defaults to Gemini models.
- opencode-antigravity-auth #526: the "about 24 h" restore detail.
- nodeterm: the ESC and brain-path details.
- SIWC quickstart: the "limited trial" wording.
- Gemini CLI: whether free AI Studio keys still work.
- Forum threads seen only by title.
- ADR 0021: missing on feat/m0-foundation.
