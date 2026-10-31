import { formatDay } from "@/lib/format";
import { getReleases } from "@/lib/github";
import { GENERIC_CARD, OG, renderCard, withDeadline } from "@/lib/og";

// The changelog card names the newest release, read through the same loader as the page; without
// one (or when GitHub is slow or down) it falls back to the site card.
export const alt = "Crewyard changelog";
export const size = OG.size;
export const contentType = "image/png";
export const revalidate = 3600;

export default async function Image() {
  const state = await withDeadline(getReleases());
  const newest = state?.kind === "ok" ? state.releases[0] : undefined;
  if (!newest) return renderCard(GENERIC_CARD);
  const count = state?.kind === "ok" ? state.releases.length : 0;
  return renderCard({
    eyebrow: "Changelog",
    title: `Latest: ${newest.title}`,
    lead: `Every Crewyard release, newest first, with its notes and its files for each system.`,
    facts: [formatDay(newest.publishedAt), newest.prerelease ? "Pre-release" : "Release", `${count} ${count === 1 ? "release" : "releases"}`],
  });
}
