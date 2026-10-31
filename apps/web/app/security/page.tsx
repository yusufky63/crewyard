import Link from "next/link";
import { DocLayout, DocSection, type Toc } from "@/components/doc-layout";
import { SECURITY } from "@/lib/content";
import { pageMeta } from "@/lib/page-meta";
import { adrUrl, SITE } from "@/lib/site";

export const metadata = pageMeta({
  title: "Security",
  description: "How Crewyard handles API keys (DPAPI, Keychain, Secret Service), sign-in, local connections, approvals for outward actions, unsigned pre-release builds and updates.",
  path: "/security",
});

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const TOC: Toc = [...SECURITY.map((s) => [slug(s.title), s.title] as const), ["report", "Reporting a problem"]];

export default function SecurityPage() {
  return (
    <DocLayout
      toc={TOC}
      head={
        <>
          <div className="eyebrow bare">Security</div>
          <h1 className="h-page">What Crewyard does with your keys and your code</h1>
          <p className="lead">Crewyard runs on your machine and drives agent CLIs with your own accounts. These are the rules it keeps, and the places where it cannot protect you.</p>
        </>
      }
    >
      {SECURITY.map((s) => (
        <DocSection key={s.title} toc={TOC} id={slug(s.title)}>
          <ul>
            {s.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </DocSection>
      ))}
      <DocSection toc={TOC} id="report">
        <p>
          The design decisions behind these rules are written down: secrets in <a href={adrUrl("0002-dpapi-secrets.md")}>ADR 0002</a>, macOS and Linux in <a href={adrUrl("0010-linux-macos-groundwork.md")}>ADR 0010</a>, signing and updates in <a href={adrUrl("0011-signing-and-auto-update.md")}>ADR 0011</a>, and Autopilot&apos;s limits in <a href={adrUrl("0017-autopilot.md")}>ADR 0017</a>.
        </p>
        <p>
          To report a security problem, use the repository&apos;s <a href={SITE.securityUrl}>Security page on GitHub</a> rather than a public issue. Everything else goes to <a href={SITE.issuesUrl}>issues</a>. See also the <Link href="/faq">FAQ</Link>.
        </p>
      </DocSection>
    </DocLayout>
  );
}
