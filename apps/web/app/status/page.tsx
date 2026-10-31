import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import type { ReactNode } from "react";
import { getReleases } from "@/lib/github";
import { health, type HealthStatus, type ReleasesCheck } from "@/lib/health";
import { pageMeta } from "@/lib/page-meta";
import { SITE } from "@/lib/site";

export const metadata = pageMeta({
  title: "Status",
  description: "Whether the Crewyard website can read its release list from GitHub right now.",
  path: "/status",
  noindex: true,
});

// Five minutes: often enough to be a live check, rare enough that crawlers and visitors never add up
// to GitHub's rate limit. The release fetch itself is cached for an hour (lib/github.ts).
export const revalidate = 300;

const LABEL: Record<HealthStatus, { text: string; icon: ReactNode }> = {
  ok: { text: "Operational", icon: <CircleCheck strokeWidth={1.5} aria-hidden /> },
  degraded: { text: "Degraded", icon: <CircleAlert strokeWidth={1.5} aria-hidden /> },
  down: { text: "Down", icon: <CircleX strokeWidth={1.5} aria-hidden /> },
};

function detail(c: ReleasesCheck): string {
  switch (c.reason) {
    case undefined:
      return c.latest ? `Reading releases. The newest is v${c.latest}.` : "Reading releases.";
    case "not-public":
      return "GitHub answered, but the repository has no public releases yet, so the download and changelog pages say so.";
    case "no-releases":
      return "GitHub answered with an empty release list, so the download and changelog pages say so.";
    case "rate-limited":
      return "GitHub's request limit for this site was reached. Pages keep the last release list they read.";
    case "error":
      return "GitHub could not be read. Pages keep the last release list they read and point at the GitHub releases page.";
  }
}

export default async function StatusPage() {
  const h = health(await getReleases());
  const checkedAt = new Date().toISOString().replace("T", " ").slice(0, 16);
  return (
    <div className="wrap page">
      <header className="doc-head page-head">
        <div className="eyebrow bare">Status</div>
        <h1 className="h-page">Site status</h1>
        <p className="lead">
          The site depends on one outside service: GitHub, for the release list behind the download and changelog pages. The same check answers as JSON at <a href="/api/health">/api/health</a>.
        </p>
      </header>
      <section className="doc-sec plain" aria-labelledby="checks-h">
        <h2 id="checks-h" className="h-sec">
          Checks
        </h2>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">State</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {h.checks.map((c) => (
                <tr key={c.name}>
                  <td>
                    <a href={`https://api.github.com/repos/${SITE.owner}/${SITE.repo}/releases`} target="_blank" rel="noopener noreferrer">
                      GitHub releases API
                    </a>
                  </td>
                  <td>
                    <span className={`health-state ${c.status}`}>
                      {LABEL[c.status].icon}
                      {LABEL[c.status].text}
                    </span>
                  </td>
                  <td>{detail(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="facts">
          Checked <b className="as-typed">{checkedAt} UTC</b> · refreshed every 5 minutes
        </p>
      </section>
    </div>
  );
}
