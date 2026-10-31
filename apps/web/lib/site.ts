// Facts about the site and the project that several pages print. The domain is not hard-coded: on
// Vercel it comes from the production URL Vercel sets, so no page claims a domain nobody bought.

const OWNER = "yusufky63";
const REPO = "crewyard";
const repoUrl = `https://github.com/${OWNER}/${REPO}`;

function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3240";
}

export const SITE = {
  name: "Crewyard",
  /** One sentence, the same everywhere: metadata, the home lead, llms.txt. */
  tagline: "Run and supervise crews of coding agents on your own accounts and API keys.",
  description:
    "Crewyard is a local desktop app that runs and supervises Claude Code, Codex, Gemini CLI and OpenCode across your own accounts and API keys. It proposes a crew for each task, waits for your approval, watches limits and spend, and keeps GitHub under your control.",
  url: siteUrl(),
  owner: OWNER,
  repo: REPO,
  repoUrl,
  releasesUrl: `${repoUrl}/releases`,
  licenseUrl: `${repoUrl}/blob/main/LICENSE`,
  securityUrl: `${repoUrl}/security`,
  issuesUrl: `${repoUrl}/issues`,
  docs: {
    plan: `${repoUrl}/blob/main/PLAN.md`,
    design: `${repoUrl}/blob/main/DESIGN.md`,
    adr: `${repoUrl}/tree/main/docs/adr`,
    notice: `${repoUrl}/blob/main/NOTICE`,
    readme: `${repoUrl}#readme`,
  },
  license: "MIT",
  copyright: "Copyright 2026 Yusuf",
} as const;

/** A link into one ADR on GitHub, by its file name under docs/adr. */
export const adrUrl = (file: string) => `${repoUrl}/blob/main/docs/adr/${file}`;

export const NAV = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/download", label: "Download" },
  { href: "/changelog", label: "Changelog" },
  { href: "/faq", label: "FAQ" },
  { href: "/security", label: "Security" },
] as const;
