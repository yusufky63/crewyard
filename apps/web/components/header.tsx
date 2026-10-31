import { Star } from "lucide-react";
import Link from "next/link";
import { getStarCount } from "@/lib/github";
import { formatCount } from "@/lib/format";
import { SITE } from "@/lib/site";
import { BrandMark } from "./brand-mark";
import { MobileNav, NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";

/** The GitHub link, with the star count only when GitHub reported one; never a guessed number. */
export async function GitHubLink({ className = "gh", label = "GitHub" }: { className?: string; label?: string }) {
  const stars = await getStarCount();
  return (
    <a className={className} href={SITE.repoUrl} rel="noopener noreferrer" target="_blank">
      <BrandMark id="github" />
      <span className="gh-label">{label}</span>
      {stars.kind === "known" ? (
        <span className="gh-count" title={`${stars.stars} stars on GitHub`}>
          <Star strokeWidth={1.5} aria-hidden />
          <span className="num">{formatCount(stars.stars)}</span>
          <span className="sr-only"> stars</span>
        </span>
      ) : null}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function Header() {
  return (
    <header className="hdr">
      <div className="wrap hdr-in">
        <Link href="/" className="brandlink" aria-label={`${SITE.name} home`}>
          <span className="mark" aria-hidden />
          {SITE.name}
        </Link>
        <NavLinks />
        <div className="hdr-end">
          <GitHubLink />
          <ThemeToggle />
          <Link href="/download" className="btn btn-primary btn-sm hdr-dl">
            Download
          </Link>
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
