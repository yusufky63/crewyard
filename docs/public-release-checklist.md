# Public release checklist

On 2026-10-31 the owner decided that `yusufky63/crewyard` becomes a public repository when the first public release ships, under the MIT licence (Copyright (c) 2026 Yusuf), with a website on Vercel that reads releases from the public GitHub API. This page lists what was checked and what is left, in the order to do it. Until the flip, the GitHub API answers 404 for this repository.

## 1. History scan

`scripts/scan-history.mjs` (`pnpm scan:history`) reads every blob reachable from any ref with `git rev-list --objects --all` and `git cat-file --batch`, plus every commit message, annotated tag message and commit author and committer address. It reads blobs, not diffs, so it also sees content that only a merge resolution introduced, content a later commit deleted, and binary files; `git log -G` misses the first and the last. It never prints a value: each match shows its path, line, pattern, a masked preview (the first 4 characters and the length) and a fingerprint (the first 16 hex characters of the value's SHA-256). Matches reviewed as fake test values are listed in `scripts/scan-history.known.json` by path, pattern and fingerprint; any other match, or a committed `.env`-style file with values, makes the exit code 1.

Patterns: Anthropic `sk-ant-`, OpenAI project, service-account and admin keys, OpenRouter, DeepSeek-style `sk-` plus 32 hex, any other long `sk-` key, Google `AIza`, GitHub classic and fine-grained tokens, AWS access key ids and secret assignments, Slack tokens and webhooks, Hugging Face, Groq, xAI, Stripe live keys, Zhipu GLM keys, npm tokens and `_authToken`, private key blocks, JWTs, `Authorization` and `x-api-key` style headers with a value, URLs with a password, DPAPI blobs (base64 and hex), Vercel tokens, and long values assigned to names such as `api_key`, `secret`, `token` or `password`. It also lists `.env`, `.dev.vars`, `.npmrc`, `.netrc` and credential files, email addresses, blobs of 500 KiB or more, and paths that suggest logs, traces, reports, databases, certificates, local settings, worktree leftovers or images.

### Result on 2026-10-31

48 refs in the local repository (every local branch, including the ones merged later such as the release pipeline, the website and the UI branches, plus `origin/main` and the tag `v0.1.0`): 3,275 blobs and 333 commits.

| Check | Result |
|---|---|
| Real credentials | None. 35 distinct matches in 13 test files (`*.test.ts`), all deliberately fake values for redaction, log, environment-filter and remote-parsing tests. Each was looked at: shorter than a real token of its kind, a repeated or counting pattern, a self-describing string, or a public sample (the jwt.io sample JWT, `user:password` in Basic auth, a six-character private-key body). They are the entries of `scan-history.known.json`. One more weak match looks like a placeholder and does not fail the scan. |
| `.env`, `.npmrc`, credential files, databases, certificates, logs, traces, test results | Never committed. |
| DPAPI blobs | None. |
| Email addresses in files | Only sample addresses in tests (`github.com` users in remote URLs, a `.com` host in a preview test) and a package author's public address inside `pnpm-lock.yaml`. |
| Commit metadata | Every commit is authored and committed with a personal Gmail address. See decision 3b. |
| Large binaries | None of 500 KiB or more. The 62 images are PNG screenshots under `design/screens/` and `docs/research/plan-quota-shots/` and the app icons under `apps/desktop/build/`. The screenshots are rendered from fixture or sample data and show no real key, account balance or token. See decision 3e for the project names in them. |
| Tracked local files | None: `.claude/`, editor folders, logs and test output were never tracked. `.gitignore` now also covers Claude Code worktrees and local settings, editor folders, Playwright's default output folders and signing certificates. |

### Before the flip

The 2026-10-31 result covers what existed that day. Scan again on exactly what GitHub holds, after the last merge and push, from a fresh mirror clone (it also brings `refs/pull/*` and every tag):

In PowerShell, from the working repository:

```powershell
git clone --mirror https://github.com/yusufky63/crewyard.git "$env:TEMP\crewyard-mirror.git"; node scripts/scan-history.mjs "$env:TEMP\crewyard-mirror.git"
```

In Git Bash write `"$TEMP/crewyard-mirror.git"` instead. Run `pnpm scan:history` in the working repository too before each push, so nothing new reaches GitHub in the first place.

- Exit code 0 and "Result: clean." means no unknown match and no credential file with values.
- For each `NEW` line, open the file at that line and look at the value. A real one goes to section 2. A fake one gets an entry in `scan-history.known.json` (path, pattern, masked, fingerprint, and why it is fake) in the same commit that explains it.
- Open the images the report counts if any new one shows Settings, the Inbox or an account, and run `git ls-files` to look for anything that is not source, docs or a deliberate asset.

## 2. If a real secret is found

1. Revoke or rotate it at the provider at once. It counts as leaked from the moment it reached GitHub, private or not.
2. Rewrite history with `git filter-repo` (`--replace-text` for a value, `--invert-paths` for a file), then force-push every branch and tag.
3. Re-create the `v0.1.0` tag and release, which point at a rewritten commit.
4. Re-clone every local copy and worktree; an old clone pushes the secret back.
5. Ask GitHub Support to remove cached views and pull request refs and to garbage-collect the orphaned commits. A force-push alone leaves the old commits reachable by their id.
6. Scan again, and only then flip.

## 3. Owner decisions before the flip

a. **Provider terms (a gate, PLAN.md §6 and §17 Open item 2).** PLAN.md says to check, before the app is shared, OpenAI's terms for ChatGPT sign-in through the Codex app-server and Google's terms for Gemini CLI sign-in in a third-party app. A public repository with a downloadable release is sharing. Either confirm both and record it in PLAN.md, or hide the ChatGPT and Google sign-in paths in the public build until they are confirmed. Neither the flip nor the release happens before this is settled.

b. **Commit email.** Every commit shows a personal Gmail address, which becomes readable by anyone and by address scrapers. Either keep it, or rewrite it with `git filter-repo --mailmap` to the GitHub noreply address `56938716+yusufky63@users.noreply.github.com`. A rewrite changes every commit id, so:
   - do it only when no other branch or worktree is open;
   - a force-push to this repository is not enough on its own: the old commits stay reachable by id (`/commit/<id>.patch` shows the address) until GitHub Support garbage-collects them, so ask for that before the flip, or push the rewritten history to a newly created repository instead and delete the old one;
   - `filter-repo` rewrites commit ids inside commit messages but not inside files or release notes: replace old ids in the docs and edit the `v0.1.0` release notes, whose last line names the commit it was checked at;
   - re-create the `v0.1.0` tag and release on the rewritten commit.

   Either way, set the noreply address as `user.email` for new commits (in this repository or globally) and turn on Settings → Emails → "Keep my email addresses private" and "Block command line pushes that expose my email" on GitHub.

c. **The v0.1.0 pre-release.** Its unsigned Windows installer (`Crewyard-Setup-0.1.0-x64.exe`, 117 MiB) becomes downloadable by anyone. Keep it as the first entry of the release list, or delete the release once the new one is out.

d. **Old Actions runs.** The existing workflow runs and their logs become public. The repository has no Actions secrets or variables, so the logs hold no masked values; delete the runs only if you want a clean list.

e. **Your own project names in the design material.** `design/prototype.html` and every screenshot rendered from it (all of `design/screens/*.png`) use the owner's own project names and folders as sample data: in the title-bar project picker, the recent projects, the paths and the GitHub screens. At least one of them is the name of another private repository. If those names should stay unknown, rename the sample projects in the prototype and re-shoot the whole `design/screens/` set, not only some of it. The names stay in history either way.

f. **Copyright line in the installer.** `apps/desktop/electron-builder.config.cjs` says "Copyright 2026 Crewyard contributors", while LICENSE and NOTICE say "Copyright (c) 2026 Yusuf". Pick one wording for both.

g. **Decision record (a gate).** PLAN.md §17 still says the code is kept in a private repository and that v0.1.0 is a pre-release in the private repository, and ADR 0011 relies on the repository being private. Add the 2026-10-31 decision to the decision log (public repository at release, MIT, Copyright (c) 2026 Yusuf, website on Vercel), amend the 2026-10-30 entry, and note in ADR 0011 that the private-repository constraint no longer holds. AGENTS.md asks for this before work that contradicts PLAN.md is shipped.

## 4. Files in the repository

Done:

- [x] `LICENSE` with the MIT text, and `"license": "MIT"` in the root and every workspace `package.json`.
- [x] `NOTICE` names the copyright holder and repeats the MIT text, because the installer ships it as `NOTICE.txt` without `LICENSE`; the third-party list is unchanged.
- [x] README: a licence line under the title and a Licence section that replaces "all rights reserved".
- [x] `SECURITY.md`: report through GitHub private vulnerability reporting, scope for Windows, macOS and Linux, supported versions.
- [x] `CONTRIBUTING.md`: the rules from AGENTS.md in short, and contributions under MIT.
- [x] `.gitignore` additions for local tooling and certificates.
- [x] `scripts/scan-history.mjs` with its test and `scan-history.known.json`, so the scan in section 1 can be repeated on the final history.

Optional:

- [ ] `.github/CODEOWNERS` with `* @yusufky63`. It only matters together with a ruleset that requires a code-owner review.
- [ ] Issue templates: a bug report that asks for the Crewyard version, the operating system and its version, and the runner CLI versions, and says never to paste a key or a log with one.
- [ ] A pull request template that repeats the "Before you open a pull request" list from CONTRIBUTING.md.

## 5. GitHub settings

On GitHub Free, rulesets, private vulnerability reporting and secret scanning are offered for public repositories only, so most of this happens right after the flip.

### General (Settings → General)

- **Description:** already set.
- **Website:** the Vercel site's URL once it is deployed.
- **Topics:** for example `coding-agents`, `claude-code`, `codex`, `gemini-cli`, `opencode`, `agent-orchestration`, `electron`, `desktop-app`, `windows`, `macos`, `linux`, `cross-platform`, `typescript`.
- **Features:** Issues on. Discussions off until someone can answer them (Q&A can be turned on later). Wiki off, because the docs live in the repository. Projects off.
- **Pull requests:** "Automatically delete head branches" on.
- **Social preview:** the website's share image, 1280 by 640.

### Rules (Settings → Rules → Rulesets)

- **Branch ruleset for `main`:** restrict deletions and block force pushes, with Repository admin as a bypass actor for the whole ruleset, so a solo maintainer is never locked out.
- **Required status check:** add `check` from `ci.yml` only once merges go through pull requests (then also require a pull request with zero approvals). Today local merges are pushed straight to `main`, and `check` runs only after such a push; a required check would reject that push (GH006), because its commits have no passing result yet.
- **Tag ruleset for `v*`:** restrict updates and deletions, so a published release tag cannot be moved.

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

1. Gates, all of them:
   - decision 3a (provider terms) is settled, and decision 3g (PLAN.md and ADR 0011) is recorded;
   - everything for the release is merged into `main` and pushed, and `pnpm check` passes;
   - the mirror-clone scan in section 1 exits 0 with "Result: clean.".
2. Settings → General → Danger Zone → Change repository visibility → Make public.
3. Right away: the settings in section 5 that need a public repository (rulesets, private vulnerability reporting, secret scanning and push protection).
4. Check while signed out, in a private window:
   - the README renders and the sidebar shows the MIT licence;
   - the Security tab offers "Report a vulnerability";
   - `https://api.github.com/repos/yusufky63/crewyard/releases` answers 200 with the releases instead of 404, which the website depends on. `/releases/latest` skips drafts and pre-releases, so it stays 404 while every release is a pre-release;
   - the download links of the latest release work for each platform it ships.
5. Publish the release and deploy the website.
