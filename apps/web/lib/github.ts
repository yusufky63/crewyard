import "server-only";
import { parseReleases, type ReleasesState, type UnavailableReason } from "./releases.ts";
import { SITE } from "./site.ts";

// Every page that shows release data reads it through here, with Next's fetch cache: a new GitHub
// release shows up within REVALIDATE seconds with no code change, or at once when the release
// webhook (app/api/revalidate) marks the tag stale.

/** Seconds a fetched answer is reused; pages that show release data use the same value. */
export const REVALIDATE = 3600;
/** The cache tag the webhook revalidates. */
export const RELEASES_TAG = "github-releases";

/**
 * `next dev` only: CREWYARD_SITE_GITHUB_API points the site at a local stand-in for api.github.com,
 * so the release pages can be checked before any release is public. A production build ignores it,
 * so a deployed site can only ever read GitHub itself.
 */
function apiBase(): string {
  const local = process.env.NODE_ENV === "development" ? process.env.CREWYARD_SITE_GITHUB_API?.trim() : undefined;
  return `${local ? local.replace(/\/+$/, "") : "https://api.github.com"}/repos/${SITE.owner}/${SITE.repo}`;
}
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const TIMEOUT_MS = 8000;

/**
 * GITHUB_TOKEN is optional and server-only (never NEXT_PUBLIC_): without it the API allows 60
 * requests an hour per IP, which shared serverless IPs can use up. A token with no scopes is enough
 * for a public repository.
 */
function token(): string | undefined {
  return process.env.GITHUB_TOKEN?.trim() || undefined;
}

function headers(withToken: boolean): HeadersInit {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "crewyard-site",
  };
  const t = withToken ? token() : undefined;
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

/** Logged once per server process, so a rejected token shows in the logs without flooding them. */
let rejectedTokenLogged = false;

type Fetched = { ok: true; json: unknown; next: string | null } | { ok: false; reason: UnavailableReason };

function request(url: string, withToken: boolean): Promise<Response> {
  return fetch(url, { headers: headers(withToken), next: { revalidate: REVALIDATE, tags: [RELEASES_TAG] }, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function get(url: string): Promise<Fetched> {
  let res: Response;
  try {
    res = await request(url, true);
    // 401 means GITHUB_TOKEN is expired, revoked or mistyped. Treated as a transient error it would
    // freeze the site on its last good page for as long as the token stays bad, so ask again without
    // it: the repository is public, and the token only buys a higher rate limit.
    if (res.status === 401 && token()) {
      if (!rejectedTokenLogged) {
        rejectedTokenLogged = true;
        console.error("GitHub rejected GITHUB_TOKEN (401); reading releases without it. Replace the token in the deploy's environment.");
      }
      res = await request(url, false);
    }
  } catch {
    return { ok: false, reason: "error" };
  }
  // 404: the repository is private or does not exist yet, which is the state before the first
  // public release. It is a fact to show, not an error.
  if (res.status === 404) return { ok: false, reason: "not-public" };
  if (res.status === 403 || res.status === 429) {
    return { ok: false, reason: res.headers.get("x-ratelimit-remaining") === "0" || res.status === 429 ? "rate-limited" : "error" };
  }
  if (!res.ok) return { ok: false, reason: "error" };
  try {
    return { ok: true, json: await res.json(), next: nextLink(res.headers.get("link")) };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** The rel="next" URL of a GitHub Link header, only when it stays on this repository's API. */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (!m) continue;
    // GitHub writes the next page either by name or by the repository's numeric id.
    if (m[1]!.startsWith(`${apiBase()}/releases?`) || /^https:\/\/api\.github\.com\/repositories\/\d+\/releases\?/.test(m[1]!)) return m[1]!;
  }
  return null;
}

export async function getReleases(): Promise<ReleasesState> {
  const items: unknown[] = [];
  let url: string | null = `${apiBase()}/releases?per_page=${PAGE_SIZE}`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const r = await get(url);
    if (!r.ok) {
      // A later page failing still leaves the newest releases, which is what matters most.
      if (page > 0) break;
      return { kind: "unavailable", reason: r.reason };
    }
    if (!Array.isArray(r.json)) return { kind: "unavailable", reason: "error" };
    items.push(...r.json);
    url = r.next;
  }
  const releases = parseReleases(items);
  if (releases.length === 0) return { kind: "unavailable", reason: "no-releases" };
  return { kind: "ok", releases };
}

export type StarCount = { kind: "known"; stars: number } | { kind: "unknown" };

export async function getStarCount(): Promise<StarCount> {
  const r = await get(apiBase());
  if (!r.ok || typeof r.json !== "object" || r.json === null) return { kind: "unknown" };
  const stars = (r.json as { stargazers_count?: unknown }).stargazers_count;
  return typeof stars === "number" && Number.isInteger(stars) && stars >= 0 ? { kind: "known", stars } : { kind: "unknown" };
}

/**
 * A transient failure (rate limit, network, 5xx) during a background regeneration should keep the
 * page that was last built rather than replace good data with an "unavailable" notice: Next serves
 * the previous version when a regeneration throws, and tries again on the next request. During
 * `next build` there is no previous version, so the notice is rendered instead of failing the build,
 * and `next dev` shows the notice too.
 */
export function keepStaleOnTransientError(state: ReleasesState, env: Record<string, string | undefined> = process.env): ReleasesState {
  const transient = state.kind === "unavailable" && (state.reason === "error" || state.reason === "rate-limited");
  if (transient && env.NODE_ENV === "production" && env.NEXT_PHASE !== "phase-production-build") {
    throw new Error(`GitHub releases unavailable (${state.reason}); keeping the last good page`);
  }
  return state;
}

/** The releases a page renders: getReleases, with the stale-page rule above. */
export async function loadReleases(): Promise<ReleasesState> {
  return keepStaleOnTransientError(await getReleases());
}
