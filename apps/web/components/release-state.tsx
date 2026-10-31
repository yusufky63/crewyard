import type { UnavailableReason } from "@/lib/releases";
import { SITE } from "@/lib/site";

/** What a page says when GitHub gave it no release to show. Never a made-up file or version. */
export const UNAVAILABLE_TEXT: Record<UnavailableReason, { title: string; body: string }> = {
  "not-public": {
    title: "No public release yet",
    body: "GitHub has no public release of Crewyard to list yet. When one is published it appears here within the hour, with every file and its SHA-256.",
  },
  "no-releases": {
    title: "No release yet",
    body: "No release of Crewyard has been published on GitHub yet. When one is, it appears here within the hour, with every file and its SHA-256.",
  },
  "rate-limited": {
    title: "Release list not available right now",
    body: "GitHub's request limit for this site was reached, so the release list could not be read. The files are on the GitHub releases page.",
  },
  error: {
    title: "Release list not available right now",
    body: "The release list could not be read from GitHub just now. The files are on the GitHub releases page.",
  },
};

export function ReleaseUnavailable({ reason }: { reason: UnavailableReason }) {
  const t = UNAVAILABLE_TEXT[reason];
  return (
    <div className="banner banner-info unavailable" role="status">
      <div className="unavailable-text">
        <strong>{t.title}.</strong> <span>{t.body}</span>
      </div>
      <a className="btn btn-sm" href={SITE.releasesUrl} target="_blank" rel="noopener noreferrer">
        GitHub releases
      </a>
    </div>
  );
}
