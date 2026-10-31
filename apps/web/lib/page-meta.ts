import type { Metadata } from "next";
import { SITE } from "./site.ts";

/**
 * Metadata for one page. Next replaces nested openGraph and twitter objects instead of merging
 * them, so each page builds its full set here: canonical path, og:url, titles and descriptions.
 * The image comes from the page's own opengraph-image file, which Next adds by itself.
 */
export function pageMeta({ title, description, path, noindex = false }: { title: string; description: string; path: string; noindex?: boolean }): Metadata {
  const fullTitle = path === "/" ? title : `${title} · ${SITE.name}`;
  return {
    title: path === "/" ? { absolute: title } : title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", siteName: SITE.name, locale: "en_US", url: path, title: fullTitle, description },
    twitter: { card: "summary_large_image", title: fullTitle, description },
    ...(noindex ? { robots: { index: false, follow: true } } : {}),
  };
}
