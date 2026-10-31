import { formatDay } from "@/lib/format";
import { getReleases } from "@/lib/github";
import { GENERIC_CARD, OG, renderCard, withDeadline } from "@/lib/og";
import { PLATFORM_LABEL, pickLatest, platformsOf } from "@/lib/releases";

// The download card says which version the page offers, read through the same loader as the page.
// No release, an API error or a slow answer all fall back to the site card.
export const alt = "Download Crewyard";
export const size = OG.size;
export const contentType = "image/png";
export const revalidate = 3600;

export default async function Image() {
  const state = await withDeadline(getReleases());
  const latest = state?.kind === "ok" ? pickLatest(state.releases) : null;
  if (!latest) return renderCard(GENERIC_CARD);
  const platforms = platformsOf(latest).map((p) => PLATFORM_LABEL[p]);
  return renderCard({
    eyebrow: `Download${latest.prerelease ? " · Pre-release" : ""}`,
    title: `Crewyard v${latest.version}`,
    lead: `Files for ${platforms.join(", ")}, each with its size and SHA-256, and install steps for each system.`,
    facts: [formatDay(latest.publishedAt), ...platforms],
  });
}
