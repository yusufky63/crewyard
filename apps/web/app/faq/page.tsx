import Link from "next/link";
import { FAQ } from "@/lib/content";
import { pageMeta } from "@/lib/page-meta";
import { SITE } from "@/lib/site";

export const metadata = pageMeta({
  title: "FAQ",
  description: "Answers about Crewyard: supported systems, cost, agents and providers, Claude API keys, approvals, limits, unsigned builds, updates, data and requirements.",
  path: "/faq",
});

/** A stable anchor per question, so a link can land on the answer. */
function faqId(q: string): string {
  return `q-${q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56)}`;
}

const JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a.join(" ") } })),
}).replace(/</g, "\\u003c");

export default function FaqPage() {
  return (
    <div className="wrap page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON_LD }} />
      <header className="doc-head page-head">
        <div className="eyebrow bare">FAQ</div>
        <h1 className="h-page">Questions and answers</h1>
        <p className="lead">
          Short answers. The details are in <Link href="/how-it-works">How it works</Link>, the <Link href="/security">security page</Link> and the project&apos;s{" "}
          <a href={SITE.docs.plan} target="_blank" rel="noopener noreferrer">
            plan
          </a>
          .
        </p>
      </header>
      <div className="faq">
        {FAQ.map((f) => (
          <details key={f.q} id={faqId(f.q)}>
            <summary>{f.q}</summary>
            <div className="answer">
              {f.a.map((p) => (
                <p key={p}>{p}</p>
              ))}
            </div>
          </details>
        ))}
      </div>
      <p className="cta-note">
        Something missing?{" "}
        <a className="link" href={SITE.issuesUrl} target="_blank" rel="noopener noreferrer">
          Open an issue on GitHub
        </a>
        .
      </p>
    </div>
  );
}
