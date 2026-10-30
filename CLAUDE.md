@AGENTS.md

## Commands

- `pnpm install`, then once on a new machine: `node node_modules/.pnpm/electron@45.1.0/node_modules/electron/install.js` (pnpm skips Electron's download script).
- `pnpm dev` runs the app with hot reload.
- `pnpm check` is the full gate: tokens, contrast, typecheck, lint (`--max-warnings=0`), tests, build. Run it before saying anything is done.
- `pnpm e2e` builds the app and runs the Playwright-for-Electron flows in `apps/desktop/e2e` (about 10 s; needs a display, so it is not part of `pnpm check` or CI). The runners are scripted fakes (`CREWYARD_E2E`, `packages/daemon/src/e2e`), refused in a packaged build.
- Smoke test (daemon round trip): `cd apps/desktop && CREWYARD_SMOKE=1 <electron.exe> .`
- Screenshots: `CREWYARD_SHOT=<file.png> CREWYARD_SHOT_THEME=dark|light CREWYARD_SHOT_LANG=en|tr CREWYARD_SHOT_SIZE=1440x900 <electron.exe> .` (throwaway profile, never touches your data). `CREWYARD_SHOT_PROJECT=<folder>` with `CREWYARD_SHOT_SCREEN=<id>` opens a project screen; `CREWYARD_SHOT_QUERY="screen=setup&step=2"` sets any other renderer state. Wrap each run in `timeout 60`; several sessions may shoot at once.
