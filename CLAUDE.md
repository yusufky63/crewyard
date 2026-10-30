@AGENTS.md

## Commands

- `pnpm install`, then once on a new machine: `node node_modules/.pnpm/electron@45.1.0/node_modules/electron/install.js` (pnpm skips Electron's download script).
- `pnpm dev` runs the app with hot reload.
- `pnpm check` is the full gate: tokens, contrast, typecheck, lint (`--max-warnings=0`), tests, build. Run it before saying anything is done.
- `pnpm e2e` builds the app and runs the Playwright-for-Electron flows in `apps/desktop/e2e` (about 10 s; needs a display, so it is not part of `pnpm check` or CI). The runners are scripted fakes (`CREWYARD_E2E`, `packages/daemon/src/e2e`), refused in a packaged build.
- `CREWYARD_CONFORMANCE=1 pnpm conformance` drives every installed runner CLI through its adapter against a scripted local model (`packages/daemon/src/conformance`; free, a few minutes, opt-in, never in check or CI). Run it before accepting a CLI version bump. `CREWYARD_CONFORMANCE_RUNNERS=codex,claude-code,opencode,gemini-cli` picks runners; `report.md`, `report.json` and each runner's request trace go to `CREWYARD_CONFORMANCE_OUT` (default `%TEMP%\crewyard-conformance-out`).
- Live run with real runners and keys (cents, opt-in, never in check or CI): `CREWYARD_LIVE=1 CREWYARD_LIVE_SEED=<git repo> node ~/.claude/skills/env-vault/scripts/vault.mjs run --only DEEPSEEK_API_KEY,OPENAI_API_KEY,GEMINI_API_KEY -- pnpm --filter @crewyard/daemon live` (flags in `packages/daemon/src/live/flows.live.ts`). With `CREWYARD_LIVE_KEEP=1`, `CREWYARD_LIVE_PROFILE="<root>\electron profile" pnpm --filter @crewyard/desktop exec playwright test -c e2e/live/playwright.live.config.ts` screenshots the app over that run's data.
- Smoke test (daemon round trip): `cd apps/desktop && CREWYARD_SMOKE=1 <electron.exe> .`
- Screenshots: `CREWYARD_SHOT=<file.png> CREWYARD_SHOT_THEME=dark|light CREWYARD_SHOT_LANG=en|tr CREWYARD_SHOT_SIZE=1440x900 <electron.exe> .` (throwaway profile, never touches your data). `CREWYARD_SHOT_PROJECT=<folder>` with `CREWYARD_SHOT_SCREEN=<id>` opens a project screen; `CREWYARD_SHOT_QUERY="screen=setup&step=2"` sets any other renderer state (`density=compact`, `fixture`, `keys=open`). `CREWYARD_SHOT_SCALE=2` renders at 200% scaling. Wrap each run in `timeout 60`; several sessions may shoot at once.
