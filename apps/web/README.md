# Crewyard website

The public site for Crewyard: what it is, how it works, downloads for Windows, macOS and Linux, the changelog, the FAQ and the security model. Next.js (App Router) on Vercel, deployed from this folder.

Every release on GitHub shows up on the download and changelog pages within an hour, with no code change: the pages read `https://api.github.com/repos/yusufky63/crewyard/releases` with Next's fetch cache (`revalidate: 3600`). While the repository is private, or before the first public release, the API answers 404 and the pages say "No public release yet" with a link to the GitHub releases page. They never show a made-up file, size or version.

## What is where

| Path | What |
|---|---|
| `app/` | Pages (`/`, `/download`, `/how-it-works`, `/changelog`, `/faq`, `/security`, 404), a share card per page (`opengraph-image.tsx`), `sitemap.ts`, `robots.ts`, `manifest.ts`, `llms.txt`, the icons, and `api/revalidate` for the optional release webhook |
| `lib/releases.ts` | Parsing the GitHub payload (zod), matching assets to platforms by file name, picking the release the buttons offer. Pure, tested in `releases.test.ts` |
| `lib/github.ts` | The only module that calls GitHub (server-only): releases with pagination, the star count, the unavailable states |
| `lib/content.ts` | Every product statement on the site, each from README, PLAN, DESIGN, the ADRs or the release notes. Change a sentence here and every page follows |
| `lib/theme.ts` | System, light and dark themes from `design/tokens`, checked against `packages/ui/src/tokens.css` by `theme.test.ts` |
| `lib/og.tsx` | The share-card kit (next/og) |
| `components/` | Header, footer, the OS-aware download button, the release notes renderer, screenshots |
| `scripts/shots.mjs` | Takes the app screenshots in `public/shots` |

The site uses the app's own tokens and primitives (`@crewyard/ui` `tokens.css` and `styles.css`: frames with corner ticks, buttons, badges, banners) and the same Geist fonts, so it cannot drift from the app. DESIGN.md applies here too.

## Which file the Download button offers

| Visitor | Button |
|---|---|
| Windows | the x64 NSIS installer (`.exe`) |
| macOS, Chromium on Apple silicon or Intel | the `.dmg` for that chip |
| macOS, Safari or Firefox | the Apple silicon `.dmg`, with a link to the Intel one (these browsers do not say which chip a Mac has) |
| Linux x64 | the `.AppImage` |
| Phone, unknown system, or no build for it | the download page |

Detection runs in the browser after the page loads, so pages stay static. Without JavaScript the button opens the download page, which lists every file. Asset names are matched by extension and architecture (`x64`, `x86_64`, `amd64`, `arm64`, `aarch64`, `universal`); `latest*.yml`, `.blockmap`, signatures and checksum files are never offered. The release the buttons use is the newest full release (like GitHub's own "latest"), or the newest pre-release while there is no full release. GitHub's `/releases/latest` is not used because it answers 404 for a repository whose only releases are pre-releases, as v0.1.0 is.

## Develop

From the repository root:

```bash
pnpm install
pnpm --filter @crewyard/web dev
```

The dev server runs on http://localhost:3240.

To see the "release available" pages before any release is public, point `next dev` at a local stand-in for the GitHub API that serves the same JSON shape:

```bash
CREWYARD_SITE_GITHUB_API=http://127.0.0.1:3299 pnpm --filter @crewyard/web dev
```

A production build ignores `CREWYARD_SITE_GITHUB_API`, so a deployed site only ever reads GitHub.

| Command | What |
|---|---|
| `pnpm --filter @crewyard/web dev` | dev server on port 3240 |
| `pnpm --filter @crewyard/web build` | production build (also part of the root `pnpm check`) |
| `pnpm --filter @crewyard/web start` | serve the build on port 3240 |
| `pnpm --filter @crewyard/web typecheck` | TypeScript |
| `pnpm test` (root) | every test, the site's included (`lib/*.test.ts`) |
| `pnpm --filter @crewyard/web shots` | retake the app screenshots |

## Screenshots

`pnpm --filter @crewyard/web shots` builds the desktop app, then runs it once per screen and theme in its screenshot mode (`CREWYARD_SHOT`, see the root CLAUDE.md) with its sample data, a throwaway profile and an empty `sample-project` repository, one Electron at a time with a 60 s limit each. Chromium inside Electron scales the captures to 1920 px and encodes them as WebP, which go to `public/shots`; their sizes go to `lib/shots.json`, and the app icon is copied to `app/icon.png` and `app/apple-icon.png`. `--skip-build` reuses `apps/desktop/out`; `SHOTS=crew,inbox` takes only some.

A capture that comes out blank (a renderer error on that screen) is refused and the previous files are kept, and the script exits with 1. Pages only show screenshots listed in `lib/shots.json`, and every one is captioned "Sample data".

At 286412f the Tasks screen's sample data stops its renderer (the report line reads `drafts` from a fixture report that has none), so `tasks` is skipped until that is fixed in the app; the How it works page shows it once the script has taken it.

## Deploy on Vercel

1. Import the GitHub repository as a new Vercel project.
2. Set **Root Directory** to `apps/web`. Vercel finds the pnpm workspace through `pnpm-lock.yaml` at the repository root; `vercel.json` here installs only this app and the workspace packages it uses (`pnpm install --filter @crewyard/web...`), so Electron and the native terminal module are never downloaded.
3. Keep the framework preset Next.js and leave the build and output settings empty (`vercel.json` sets them). Node 24 matches the repository's `engines`.
4. Add the environment variables below, then deploy. Vercel's monorepo skipping is on by default for new projects: a commit that changes only other workspace packages (not this app, `packages/ui` or `packages/core`) skips the build; files outside the workspace, such as `design/tokens`, count as global changes and build.

Nothing in the repository deploys by itself, and no workflow pushes to Vercel.

### Environment variables

| Name | Needed | What |
|---|---|---|
| `GITHUB_TOKEN` | strongly recommended | Server-only. Without it GitHub allows 60 API requests an hour per IP, and Vercel's functions share IPs. A fine-grained token with read access to public repositories only, and no other permission, is enough once the repository is public. Never prefix it with `NEXT_PUBLIC_`. |
| `NEXT_PUBLIC_SITE_URL` | optional | The canonical origin, for example a custom domain (`https://example.com`, no trailing slash). Without it the site uses Vercel's production domain (`VERCEL_PROJECT_PRODUCTION_URL`), and `http://localhost:3240` locally. |
| `GITHUB_WEBHOOK_SECRET` | optional | Turns on `/api/revalidate`. Without it that route answers 404. |

### Releases at once (optional)

Without a webhook a new release appears within the hour. To show it at once, add a repository webhook on GitHub: payload URL `https://<site>/api/revalidate`, content type `application/json`, the same secret as `GITHUB_WEBHOOK_SECRET`, and only the **Releases** event. The route checks the `X-Hub-Signature-256` HMAC and expires the cached release list; the next visit reads GitHub again.

When GitHub is unreachable or rate-limits the site during a background refresh, the last good page stays in place and the refresh is tried again on the next visit; a build made while GitHub is unreachable shows "Release list not available right now" with a link to the releases page.

## Licence

MIT, like the rest of the repository. Geist and Geist Mono are under the SIL Open Font License 1.1 (see NOTICE at the repository root).
