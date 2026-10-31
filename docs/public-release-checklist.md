# Public release checklist

On 2026-10-31 the owner decided that `yusufky63/crewyard` becomes a public repository when the first public release ships, under the MIT licence (Copyright (c) 2026 Yusuf), with a website on Vercel that reads releases from the public GitHub API. This page lists what was checked and what is left, in the order to do it. Until the flip, the GitHub API answers 404 for this repository.

## 1. History scan

### Done on 2026-10-31

Every blob reachable from any ref was read through `git rev-list --objects --all` and `git cat-file --batch`: 45 local branches, `origin/main` and the tag `v0.1.0`, which is 3,160 blobs and 307 commits, plus every commit and tag message. GitHub itself holds only `main` and `v0.1.0`, and both were included.

Patterns: Anthropic `sk-ant-`, OpenAI `sk-proj-` / `sk-svcacct-` / `sk-admin-`, OpenRouter `sk-or-v1-`, DeepSeek-style `sk-` plus 32 hex, any other long `sk-` key, Google `AIza`, GitHub `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` / `github_pat_`, AWS `AKIA` / `ASIA` and secret assignments, Slack `xox*-` and webhooks, Hugging Face, Groq, xAI, Stripe live keys, Zhipu GLM keys, npm `npm_` and `_authToken`, private key blocks, JWTs, `Authorization` and `x-api-key` headers with a value, URLs with a password, DPAPI blobs (base64 and hex), long values assigned to `api_key` / `secret` / `token` / `password`, `.env` / `.dev.vars` / `.npmrc` / credential files, email addresses, and paths that suggest logs, traces, reports, databases, certificates, local settings or worktree leftovers.

| Check | Result |
|---|---|
| Real credentials | None. 57 matches across 14 test files (`*.test.ts` only), all deliberately fake values that test redaction, logging, environment filtering and remote parsing. Each was checked without printing it: shorter than a real token of its kind, low entropy, or a public sample (the jwt.io sample JWT, `user:password` in Basic auth, a six-character private-key body). |
| `.env`, `.npmrc`, credential files, databases, certificates, logs, traces, test results | Never committed. |
| DPAPI blobs | None. |
| Email addresses in files | Only example domains, `git@github.com` remotes in tests, and a package author's public address inside `pnpm-lock.yaml`. |
| Commit metadata | All 307 commits are authored and committed with a personal Gmail address. See decision 3a. |
| Large binaries | None above 500 KB. The largest blobs are 55 PNG screenshots of at most 377 KiB under `design/screens/` and `docs/research/plan-quota-shots/`. They were looked at: all are rendered from fixture or sample data ("shot project", "SAMPLE DATA") and show no real key, account or balance. |
| Names of other private work | `design/prototype.html` and `design/screens/github-*.png` use `yusufky63/cubeofempires` and `C:\Projeler\cubeofempires` as sample data. Not a secret. See decision 3d. |
| Tracked local files | None: `.claude/`, editor folders, logs and test output were never tracked. `.gitignore` now also covers Claude Code worktrees and local settings, editor folders, Playwright's default output folders and signing certificates. |

### Before the flip

Branches merged after 2026-10-31 were not part of that scan. Run this on the final `main` (PowerShell or Git Bash):

```bash
git fetch origin --tags
git log --all -E -i -G "sk-[a-z0-9_-]{20,}|AIza[0-9a-z_-]{35}|gh[pousr]_[a-z0-9]{30}|github_pat_|AKIA[0-9A-Z]{16}|xox[abposr]-|BEGIN [A-Z ]*PRIVATE KEY|npm_[a-z0-9]{36}|eyJ[a-z0-9_-]{10,}[.]eyJ|AQAAANCMnd8BFdERjHoAwE|(bearer|basic) [a-z0-9._~+/=-]{16,}|://[^ :@/]+:[^ @/]{6,}@" --name-only --format=""
```

It lists every file in which a commit added or removed a matching line. On 2026-10-31 the list was exactly these files, all reviewed:

- `apps/desktop/src/main/logs.test.ts`
- `apps/desktop/src/main/terminal/env.test.ts`
- `apps/desktop/src/renderer/src/shell/activity/problems.test.ts`
- `packages/adapter-claude/src/adapter.test.ts`
- `packages/adapter-claude/src/fork.test.ts`
- `packages/core/src/redact.ts` and `packages/core/src/redact.test.ts`
- `packages/daemon/src/activity/logs.test.ts`
- `packages/daemon/src/assistant/service.test.ts`
- `packages/daemon/src/assistant/tools.test.ts`
- `packages/daemon/src/github/git.test.ts`
- `packages/daemon/src/orchestrator/errors.ts` and `packages/daemon/src/orchestrator/orchestrator.test.ts`
- `packages/daemon/src/settings/data.test.ts`

Open every new file in the output and confirm the value is fake before going on. Also run `git ls-files` and look for anything that is not source, docs or a deliberate asset.

## 2. If a real secret is found

1. Revoke or rotate it at the provider at once. It counts as leaked from the moment it reached GitHub, private or not.
2. Rewrite history with `git filter-repo` (`--replace-text` for a value, `--invert-paths` for a file), then force-push every branch and tag.
3. Re-create the `v0.1.0` tag and release, which point at a rewritten commit.
4. Re-clone every local copy and worktree; an old clone pushes the secret back.
5. Ask GitHub Support to remove cached views and pull request refs that still hold the old commits.
6. Scan again, and only then flip.

## 3. Owner decisions before the flip

a. **Commit email.** Every commit shows a personal Gmail address, which becomes readable by anyone and by address scrapers. Either keep it, or rewrite it before the flip with `git filter-repo --mailmap` to the GitHub noreply address `56938716+yusufky63@users.noreply.github.com`. A rewrite changes every commit id: do it only when no other branch or worktree is open, then force-push `main` and the tag and re-create the `v0.1.0` release. Either way, for new commits set that noreply address as `user.email` (in this repository or globally) and turn on Settings → Emails → "Keep my email addresses private" and "Block command line pushes that expose my email" on GitHub.

b. **The v0.1.0 pre-release.** Its unsigned installer (`Crewyard-Setup-0.1.0-x64.exe`, 117 MiB, from commit `151d7e9`) becomes downloadable by anyone. Keep it as the first entry of the release list, or delete the release once the new one is out.

c. **Old Actions runs.** The seven existing workflow runs and their logs become public. The repository has no Actions secrets or variables, so the logs hold no masked values; delete the runs only if you want a clean list.

d. **Sample data naming another private repository.** Rename `cubeofempires` in `design/prototype.html` and re-shoot `design/screens/github-*.png` if that project's name should stay unknown. It stays in history either way.

e. **Copyright line in the installer.** `apps/desktop/electron-builder.config.cjs` says "Copyright 2026 Crewyard contributors", while LICENSE says "Copyright (c) 2026 Yusuf". Pick one wording for both.

f. **Decision record.** Add the 2026-10-31 decision (public repository, MIT, Vercel website) to the decision log in PLAN.md.

## 4. Files in the repository

Done:

- [x] `LICENSE` with the MIT text, and `"license": "MIT"` in the root and every workspace `package.json`.
- [x] `NOTICE` header names the copyright holder and the licence; the third-party list is unchanged.
- [x] README: a licence line under the title and a Licence section that replaces "all rights reserved".
- [x] `SECURITY.md`: report through GitHub private vulnerability reporting, scope, supported versions.
- [x] `CONTRIBUTING.md`: the rules from AGENTS.md in short, and contributions under MIT.
- [x] `.gitignore` additions for local tooling and certificates.

Optional:

- [ ] `.github/CODEOWNERS` with `* @yusufky63`. It only matters together with a ruleset that requires a code-owner review.
- [ ] Issue templates: a bug report that asks for the Crewyard version, Windows build and runner CLI versions, and says never to paste a key or a log with one.
- [ ] A pull request template that repeats the "Before you open a pull request" list from CONTRIBUTING.md.

## 5. GitHub settings

On GitHub Free, rulesets, private vulnerability reporting and secret scanning are offered for public repositories only, so most of this happens right after the flip.

### General (Settings → General)

- **Description:** already set.
- **Website:** the Vercel site's URL once it is deployed.
- **Topics:** for example `coding-agents`, `claude-code`, `codex`, `gemini-cli`, `opencode`, `agent-orchestration`, `electron`, `desktop-app`, `windows`, `typescript`.
- **Features:** Issues on. Discussions off until someone can answer them (Q&A can be turned on later). Wiki off, because the docs live in the repository. Projects off.
- **Pull requests:** "Automatically delete head branches" on.
- **Social preview:** the website's share image, 1280 by 640.

### Rules (Settings → Rules → Rulesets)

- Branch ruleset for `main`: restrict deletions, block force pushes, require the `check` status check from `ci.yml`. If merges go through pull requests, require a pull request with zero approvals and list Repository admin as a bypass actor so a solo maintainer is never locked out.
- Tag ruleset for `v*`: restrict updates and deletions, so a published release tag cannot be moved.

### Actions (Settings → Actions → General)

- **Actions permissions:** allow actions created by GitHub plus the ones the workflows name (`pnpm/action-setup`, and whatever the release workflow adds), or allow all actions and pin them to commit SHAs.
- **Fork pull request workflows from outside collaborators:** "Require approval for all outside collaborators".
- **Workflow permissions:** "Read repository contents and packages permissions", and "Allow GitHub Actions to create and approve pull requests" off. The release job asks for `contents: write` in its own `permissions` block.
- Standard GitHub-hosted runners are free for public repositories. The CI rules in AGENTS.md (ubuntu, `push` only on `main`, `concurrency`, `timeout-minutes`, Windows and macOS builds only on tags or by hand, no `schedule`) stay as they are.

### Code security (Settings → Code security)

- **Private vulnerability reporting:** on. SECURITY.md sends reporters there.
- **Dependency graph** and **Dependabot alerts:** on. **Dependabot security updates:** on; each pull request it opens runs CI once.
- **Secret scanning** and **push protection:** on. Secret scanning reads the whole history again; resolve any alert before announcing the release.
- **Code scanning (CodeQL default setup):** optional; it adds a workflow run per push and pull request.

## 6. The flip

1. Everything for the release is merged into `main`, `pnpm check` passes, and the scan in section 1 is clean.
2. Settings → General → Danger Zone → Change repository visibility → Make public.
3. Right away: the settings in section 5 that need a public repository (rulesets, private vulnerability reporting, secret scanning and push protection).
4. Check while signed out, in a private window:
   - the README renders and the sidebar shows the MIT licence;
   - the Security tab offers "Report a vulnerability";
   - `https://api.github.com/repos/yusufky63/crewyard/releases` answers 200 with the releases instead of 404, which the website depends on. `/releases/latest` skips drafts and pre-releases, so it stays 404 while every release is a pre-release;
   - the installer download link of the latest release works.
5. Publish the release and deploy the website.
