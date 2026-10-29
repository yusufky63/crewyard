# ADR 0002: Codex runner on `codex app-server`

Date: 2026-10-30. Status: accepted.

## Problem

Crewyard has to start Codex runs, stream their steps, answer approvals and questions from the Inbox, interrupt and resume them, and show the ChatGPT plan's 5-hour and weekly windows as Reported (PLAN.md §5.2, §7.1). Each account must stay in its own `CODEX_HOME` (PLAN.md D4).

## Options

1. **`codex app-server` over stdio.** JSON-RPC (JSONL, no `jsonrpc` field). Approvals and questions arrive as server requests that we answer in the JSON-RPC response. It has `turn/interrupt`, `thread/resume`, `thread/tokenUsage/updated`, and `account/rateLimits/read` / `updated`. It can also generate TypeScript types for its own protocol (`codex app-server generate-ts`).
2. **`codex exec --json`, or the `@openai/codex-sdk` TypeScript SDK that wraps it.** One-shot JSONL events. Approvals cannot be answered mid-run, there are no rate-limit reads, and no account login.

## Decision

Option 1. Option 2 cannot do approvals, questions or reported limits, which are the reason the app exists.

- One app-server process per run, started through `@crewyard/proc` (cross-spawn, `windowsHide`, no shell), with `CODEX_HOME` set to the profile's folder. `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL` and `CODEX_HOME` are removed from the inherited environment so no other account leaks in.
- Protocol types are generated from the installed CLI by `packages/adapter-codex/scripts/gen-protocol.mjs` (`generate-ts --experimental`). We keep only the files our code reaches: 174 files instead of 723.
- `initialize` opts into `experimentalApi`. Without it, `item/tool/requestUserInput` (questions) never reaches us.
- Threads start with `approvalPolicy: "on-request"`. Writer roles get the `workspace-write` sandbox, read-only roles get `read-only`, and the adapter declines their command, patch and write-permission approvals itself.
- A run ends when its turn completes. To follow up, call `resume`: `thread/resume` reopens the same thread in a fresh process.

## Sources

| Source | Opened | Stars | License | Archived |
|---|---|---|---|---|
| https://github.com/openai/codex (repository metadata via `gh api`) | 2026-10-30 | 131,571 | Apache-2.0 | no |
| `codex-rs/app-server/README.md` at tag `rust-v0.166.0` | 2026-10-30 | same repo | Apache-2.0 | no |
| `codex-rs/app-server-protocol/schema/typescript/{ClientRequest,ServerRequest,ServerNotification}.ts` and 17 `v2/*.ts` files at `rust-v0.166.0` | 2026-10-30 | same repo | Apache-2.0 | no |
| `sdk/typescript/README.md` (option 2) | 2026-10-30 | same repo | Apache-2.0 | no |
| `codex app-server generate-ts --experimental` output from the installed codex-cli 0.147.0 | 2026-10-30 | n/a | Apache-2.0 | n/a |

No code was copied. The generated types are output of codex's own generator (Apache-2.0, listed in NOTICE).

## Windows notes

- On Windows, `codex` is an npm `.cmd` shim. `which` resolves it and cross-spawn starts it without a shell.
- `windowsSandbox/readiness` returned `notConfigured` on the development machine. Without that sandbox, codex asks for approval for every command that is not known to be safe, instead of running it sandboxed. `probe()` reports this as a problem. For read-only roles this fails closed: those approvals are declined.
- The stream of `events()` ends only after the app-server process has exited, so a worktree can be removed right after the loop.
- With the `plugins` feature on (the default), codex 0.147 starts a background `git fetch` of `github.com/openai/plugins` into `CODEX_HOME\.tmp`. That git process outlives the app-server, so it can't be killed as part of the tree, and it keeps the folder locked. We start `codex app-server --disable plugins`. Reproduced on 2026-10-30 without a model call: with default settings git is still running after close; with `--disable plugins` nothing is left. `--disable remote_plugin` is not enough.

## Security notes

- We never read `auth.json` or tokens. Sign-in goes through `account/login/start`. The ChatGPT flow makes codex listen on a local port for the OAuth callback. The device-code flow needs no listener.
- Secrets from `StartRequest.env` reach the child only through its environment and are never put into events.
- `mcpServer/elicitation/request` is declined. Server requests we do not know get JSON-RPC `-32601`, so codex never waits on us for an answer that will not come.

## Rollback

The adapter is one package behind `AgentAdapter`. Revert the package to its stub and remove the codex entry from the registry. Nothing else depends on its internals.
