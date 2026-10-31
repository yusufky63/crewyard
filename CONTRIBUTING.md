# Contributing to Crewyard

Thanks for helping. This page is the short version; [AGENTS.md](AGENTS.md) holds the full rules and applies to people and coding agents alike.

## Before you start

- Read [PLAN.md](PLAN.md), and [DESIGN.md](DESIGN.md) for any UI work. If your change contradicts either, open an issue first instead of working around it.
- For anything bigger than a bug fix or a copy change, open an issue to agree on the approach before writing code.
- Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Set up

Windows 11, Node.js 24 or newer, pnpm 9 (`corepack enable`), Git.

```bash
pnpm install
node node_modules/.pnpm/electron@45.1.0/node_modules/electron/install.js
pnpm dev
```

The second line is needed once per machine, because pnpm skips Electron's download script.

## Before you open a pull request

- `pnpm check` passes: token and contrast checks, typecheck, lint with zero warnings, tests and the build. CI runs the same.
- Tests sit next to the source they cover, and every rule in `packages/core` has one.
- UI changes come with screenshots in dark and light at 1280 and 1920 px, and a keyboard pass (CLAUDE.md lists the screenshot command).
- Every user-visible string goes through i18next, in English and Turkish together; the Turkish reads naturally, not word for word.
- User-visible changes update the README, PLAN.md or DESIGN.md in the same pull request.

## Rules that are not negotiable

- **Your own code.** Read any project to learn how it solves a problem, then write code for this architecture. Never copy or port code, including a line-by-line translation. Medium and large changes cite the sources they opened (AGENTS.md, "Research before building").
- **Dependencies.** Only when unavoidable, MIT, Apache-2.0, ISC or BSD, added with an exact version (`pnpm add -E`), and named in the pull request.
- **Windows first.** Child processes go through `packages/proc` (`cross-spawn`, `windowsHide`, never `shell: true`); UTF-8 IO, atomic writes, no symlinks, paths with spaces in tests.
- **Secrets.** API keys only through DPAPI-encrypted storage and child environment variables: never on a command line, in a log, in a commit or in a URL. Never read or copy subscription tokens; each CLI signs in through its own login. Claude profiles use Anthropic API keys only.
- **No network listener.** The UI uses IPC; outside callers use the per-user named pipe with a token.
- **The user decides outward actions.** Push, pull request, merge, delete and spend past a cap always wait for an approval in the app.
- **UI.** Colours, sizes and radii only from tokens; no gradients, glass, blur, glow, coloured shadows or emoji. Every quota or cost number says Reported, Estimated or Unknown.

## Commits and pull requests

- Commit messages are one short imperative English sentence.
- One pull request per finished change; related changes go together.
- Workflows run on ubuntu for pull requests and pushes to `main`, with `concurrency` and `timeout-minutes`. Windows and macOS builds run only on tags or by hand.

## Licence

By contributing you agree that your contribution is released under the [MIT License](LICENSE) that covers the project.
