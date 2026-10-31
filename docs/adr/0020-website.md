# ADR 0020: The project website and how it learns about releases

**Status:** accepted, 2026-10-31. Owner request the same day.

## Problem

The owner, 2026-10-31: a website that fits the project's design, with download buttons, linked to GitHub, a "how it works" and the other needed pages, where every release is added automatically, for macOS, Linux and Windows. Decisions made the same day: the repository `yusufky63/crewyard` becomes public at release time under MIT, and the site is a Next.js app on Vercel that reads releases from the public GitHub API.

Constraints:

- **No fake data.** Until the repository is public the API answers 404, so every page must say plainly that there is no public release yet and link to the GitHub releases page. Never a made-up version, file or size.
- **No code change per release.** A new GitHub release must reach the download and changelog pages on its own.
- **The design cannot drift from the app.** DESIGN.md applies, and the tokens come from the same source as the app's.
- **Untrusted input.** Release bodies, asset names and URLs come from the GitHub API and are data.

The site is `apps/web`, a new workspace app with its own deploy target. It does not change any decision in PLAN.md §3; it is a Medium-to-Large change, so this record holds the research.

## Options

### Which endpoint

**(a) `GET /repos/{owner}/{repo}/releases/latest`.** One request, one release. GitHub's docs say it returns the most recent release that is neither a draft nor a pre-release. v0.1.0 is a pre-release, so this endpoint would answer 404 for the first release and the site could not tell "private" from "only pre-releases".

**(b) `GET /repos/{owner}/{repo}/releases` (chosen).** Up to 100 per page, followed through the `Link` header (capped at five pages, only to URLs on this repository's API). Drafts are only listed for users with push access, so a server-only token never leaks a draft to the site. The site picks the newest full release, or the newest pre-release while there is none, and the changelog renders the whole list from the same answer.

### How a new release reaches the pages

**(a) Hourly revalidation only.** Every release fetch carries `next: { revalidate: 3600, tags: ["github-releases"] }`. Simple, no secret, at most an hour late.

**(b) Hourly revalidation plus an optional webhook (chosen).** The same, and when `GITHUB_WEBHOOK_SECRET` is set a GitHub "Releases" webhook to `/api/revalidate` calls `revalidateTag("github-releases", { expire: 0 })`, which the Next.js docs give as the form for invalidations that come from outside a Server Action. Without the secret the route answers 404, so the deploy works with nothing configured.

A failure during a background regeneration (network, 5xx, rate limit) throws, so Next keeps serving the last good page instead of replacing real data with a notice. A 401 is not treated that way: it means `GITHUB_TOKEN` is bad, and treating it as transient would freeze the site on its last page for as long as the token stays bad. The site logs one error and asks again without the token.

### Download button

The visitor's system is detected in the browser after load (user agent, plus `userAgentData` architecture where Chromium gives it), so pages stay static and cacheable. Without JavaScript, or for a system with no build, the button opens `/download`, which lists every file with its size and the SHA-256 GitHub reports in the asset's `digest` field.

## Sources

| Source | Opened | Stars | Licence | Archived | What we took |
|---|---|---|---|---|---|
| GitHub REST, Releases: https://docs.github.com/en/rest/releases/releases | 2026-10-31 | n/a | docs | n/a | `/releases/latest` skips drafts and pre-releases; `per_page` up to 100; drafts listed only with push access; asset `digest` |
| GitHub, Validating webhook deliveries: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries | 2026-10-31 | n/a | docs | n/a | `X-Hub-Signature-256`, HMAC-SHA256 with the `sha256=` prefix, constant-time comparison |
| Next.js, revalidateTag: https://nextjs.org/docs/app/api-reference/functions/revalidateTag | 2026-10-31 | n/a | docs | n/a | the two-argument form; `{ expire: 0 }` for webhook-driven invalidation |
| Vercel, Using Monorepos: https://vercel.com/docs/monorepos | 2026-10-31 | n/a | docs | n/a | Root Directory per app, pnpm workspace detection from the root lockfile, filtered installs, skipping unaffected projects |
| getpaseo/paseo `packages/website/src/latest-release.ts`, `platform.ts` | 2026-10-31 | 22,609 | NOASSERTION (GitHub cannot classify it; our feature scan lists it as Apache-2.0) | no | reads the release list rather than `/latest`; matches assets by file-name patterns per platform; user-agent order (Android before Linux, iOS before Mac). Read only, no code taken |
| generalaction/emdash `apps/emdash-desktop/scripts/release/lib/artifacts.ts` and `.github/workflows/release-*.yml` | 2026-10-31 | 6,131 | Apache-2.0 | no | installer kinds a release carries (dmg, zip, exe, AppImage, deb) and that `latest*.yml` and `.blockmap` files are updater metadata, never offered as downloads |
| BloopAI/vibe-kanban, stablyai/orca (repository metadata only) | 2026-10-31 | 28,539 / 111,652 | Apache-2.0 / MIT | no | checked as prior art listed in PRIOR_ART.md; nothing specific taken for the site |

No code was copied or ported from any of these.

## Windows notes

The site itself is platform-neutral. `scripts/shots.mjs` drives the Windows desktop build's `CREWYARD_SHOT` mode one Electron at a time with a 60 s timeout, and kills the process tree through `@crewyard/proc` when a run outlives it. The download page's install notes cover SmartScreen for the unsigned NSIS installer, and the PowerShell `Get-FileHash` check.

## Security notes

- `GITHUB_TOKEN` is server-only (`import "server-only"`, never `NEXT_PUBLIC_`), optional, and needs no scopes for a public repository. A rejected token is logged by status only, never its value.
- The webhook endpoint exists only with a secret, checks the HMAC in constant time, caps the body at 1 MB and only expires a cache tag; it never reads or writes anything else.
- Asset and release URLs are accepted only under `https://github.com/yusufky63/crewyard/releases/`, and pagination only follows links on this repository's API. Anything else is dropped.
- Release notes are rendered from Markdown with raw HTML disabled; links get `rel="noopener noreferrer"`.
- `/api/health` and `/status` report a state and a reason, never a token or a credentialed URL.
- A local stand-in for the API (`CREWYARD_SITE_GITHUB_API`) is read only under `next dev`; a production build ignores it.

## Rollback

The site is a separate Vercel project rooted at `apps/web`; nothing in the desktop app depends on it. Roll back a bad deploy with Vercel's instant rollback, or remove the project. Deleting `apps/web` removes the site from the repository without touching any other workspace package. The webhook, if added, is removed from the repository settings on GitHub.
