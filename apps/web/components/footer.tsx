import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { SITE } from "@/lib/site";

type Item = { href: string; label: string; external?: boolean };

const GROUPS: Array<{ title: string; items: Item[] }> = [
  {
    title: "Product",
    items: [
      { href: "/download", label: "Download" },
      { href: "/changelog", label: "Changelog" },
      { href: "/how-it-works", label: "How it works" },
      { href: "/faq", label: "FAQ" },
      { href: "/security", label: "Security" },
    ],
  },
  {
    title: "Project",
    items: [
      { href: SITE.repoUrl, label: "Source on GitHub", external: true },
      { href: SITE.releasesUrl, label: "All releases", external: true },
      { href: SITE.issuesUrl, label: "Issues", external: true },
      { href: SITE.licenseUrl, label: "MIT licence", external: true },
      { href: SITE.docs.notice, label: "Third-party notices", external: true },
    ],
  },
  {
    title: "Docs",
    items: [
      { href: SITE.docs.readme, label: "README", external: true },
      { href: SITE.docs.plan, label: "Plan and architecture", external: true },
      { href: SITE.docs.design, label: "Design system", external: true },
      { href: SITE.docs.adr, label: "Decision records", external: true },
      { href: "/llms.txt", label: "llms.txt" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="ftr">
      <div className="wrap">
        <div className="ftr-grid">
          <div className="ftr-about">
            <Link href="/" className="brandlink">
              <span className="mark" aria-hidden />
              {SITE.name}
            </Link>
            <p>{SITE.tagline}</p>
          </div>
          {GROUPS.map((g) => (
            <nav key={g.title} aria-label={g.title}>
              <h2>{g.title}</h2>
              <ul>
                {g.items.map((item) => (
                  <li key={item.href}>
                    {item.external ? (
                      <a href={item.href} target="_blank" rel="noopener noreferrer">
                        {item.label}
                        <ArrowUpRight strokeWidth={1.5} aria-hidden />
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <Link href={item.href}>{item.label}</Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="ftr-base">
          <span>
            {SITE.copyright} · {SITE.license} licence
          </span>
          <span>Claude, Codex, Gemini, OpenCode and GitHub are trademarks of their owners.</span>
        </div>
      </div>
    </footer>
  );
}
