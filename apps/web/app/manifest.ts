import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";
import { THEME_TOKENS } from "@/lib/theme";

const canvas = THEME_TOKENS.dark.find(([k]) => k === "--bg-canvas")?.[1] ?? "#000000";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE.name,
    short_name: SITE.name,
    description: SITE.tagline,
    start_url: "/",
    display: "browser",
    background_color: canvas,
    theme_color: canvas,
    // The app's own icon (apps/desktop/build/icon.png), copied by scripts/shots.mjs.
    icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" }],
  };
}
