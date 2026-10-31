import type { MetadataRoute } from "next";
import { getReleases } from "@/lib/github";
import { SITE } from "@/lib/site";

// The same hour as lib/github.ts REVALIDATE; a route segment option has to be a literal.
export const revalidate = 3600;

const STATIC: Array<{ path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }> = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/download", priority: 0.9, changeFrequency: "weekly" },
  { path: "/how-it-works", priority: 0.8, changeFrequency: "monthly" },
  { path: "/changelog", priority: 0.7, changeFrequency: "weekly" },
  { path: "/faq", priority: 0.6, changeFrequency: "monthly" },
  { path: "/security", priority: 0.6, changeFrequency: "monthly" },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // The newest release date tells crawlers when the download and changelog pages last changed.
  const state = await getReleases();
  const newest = state.kind === "ok" ? state.releases[0]?.publishedAt : undefined;
  return STATIC.map(({ path, priority, changeFrequency }) => ({
    url: `${SITE.url}${path === "/" ? "" : path}`,
    priority,
    changeFrequency,
    ...(newest && (path === "/download" || path === "/changelog" || path === "/") ? { lastModified: newest } : {}),
  }));
}
