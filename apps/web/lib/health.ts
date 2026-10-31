import type { ReleasesState } from "./releases.ts";

// The site has one live dependency: GitHub's releases API. /api/health and /status both describe it
// from the same answer the pages use, and say only the state and the reason, never a token or a
// request URL with credentials.

export type HealthStatus = "ok" | "degraded" | "down";

export type ReleasesCheck = {
  name: "github-releases";
  status: HealthStatus;
  /** Why the check is not ok, in GitHub's terms; absent when it is ok. */
  reason?: "not-public" | "no-releases" | "rate-limited" | "error";
  /** The newest release the site would show, when there is one. */
  latest?: string;
};

export type Health = { status: HealthStatus; checks: ReleasesCheck[] };

/**
 * A private repository or an empty release list is degraded, not down: GitHub answered and the
 * site renders its plain "no public release yet" notice. A rate limit is degraded too, because the
 * pages keep their last good copy. Only a failure to read GitHub at all is down.
 */
export function releasesCheck(state: ReleasesState): ReleasesCheck {
  if (state.kind === "ok") return { name: "github-releases", status: "ok", latest: state.releases[0]?.version };
  const status: HealthStatus = state.reason === "error" ? "down" : "degraded";
  return { name: "github-releases", status, reason: state.reason };
}

export function health(state: ReleasesState): Health {
  const checks = [releasesCheck(state)];
  const status: HealthStatus = checks.some((c) => c.status === "down") ? "down" : checks.some((c) => c.status === "degraded") ? "degraded" : "ok";
  return { status, checks };
}
