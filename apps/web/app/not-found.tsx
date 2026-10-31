import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <div className="wrap">
      <div className="nf">
        <div className="eyebrow bare">404</div>
        <h1 className="h-page">This page does not exist</h1>
        <p className="lead">The link may be old, or the page may have moved. These are the pages the site has:</p>
        <div className="cta-row">
          <Link className="btn btn-primary" href="/">
            Home
          </Link>
          <Link className="btn" href="/download">
            Download
          </Link>
          <Link className="btn" href="/how-it-works">
            How it works
          </Link>
          <Link className="btn btn-ghost" href="/changelog">
            Changelog
          </Link>
        </div>
      </div>
    </div>
  );
}
