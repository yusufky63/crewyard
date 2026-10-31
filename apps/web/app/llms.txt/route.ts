import { CLI_VERSIONS, SUMMARY } from "@/lib/content";
import { SITE } from "@/lib/site";

export const dynamic = "force-static";

export function GET(): Response {
  const lines = [
    `# ${SITE.name}`,
    "",
    `> ${SITE.tagline}`,
    "",
    SUMMARY,
    "",
    `Licence: ${SITE.license}. Source: ${SITE.repoUrl}. Built and tested on Windows 11; macOS and Linux builds are listed on the download page when a release includes them.`,
    "",
    "## Pages",
    "",
    `- [How it works](${SITE.url}/how-it-works): the flow of a task, crews and roles, runners and providers, limits, fallback and handoff, the task assistant and Autopilot`,
    `- [Download](${SITE.url}/download): every file of the latest release with size and SHA-256, install steps per system, requirements`,
    `- [Changelog](${SITE.url}/changelog): every release from GitHub, newest first`,
    `- [FAQ](${SITE.url}/faq): short answers`,
    `- [Security](${SITE.url}/security): keys, sign-in, local connections, approvals, builds and updates`,
    "",
    "## Agent CLIs it drives",
    "",
    ...CLI_VERSIONS.map((c) => `- ${c.name}: checked with ${c.version}. ${c.note}`),
    "",
    "## Source documents",
    "",
    `- [README](${SITE.docs.readme})`,
    `- [Plan and architecture](${SITE.docs.plan})`,
    `- [Design system](${SITE.docs.design})`,
    `- [Decision records](${SITE.docs.adr})`,
    `- [Releases on GitHub](${SITE.releasesUrl})`,
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600, s-maxage=86400" },
  });
}
