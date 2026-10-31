import { ReleaseNotes } from "@/components/release-notes";
import { ReleaseUnavailable } from "@/components/release-state";
import { formatBytes, formatDay } from "@/lib/format";
import { loadReleases } from "@/lib/github";
import { pageMeta } from "@/lib/page-meta";
import { archLabel, filesFor, KIND_LABEL, PLATFORM_LABEL, pickLatest, type Release } from "@/lib/releases";
import { SITE } from "@/lib/site";

export const revalidate = 3600;

export const metadata = pageMeta({
  title: "Changelog",
  description: "Every Crewyard release, newest first, with its notes and its files for each system, read from GitHub releases.",
  path: "/changelog",
});

function Assets({ release }: { release: Release }) {
  const groups = (["windows", "macos", "linux"] as const).map((p) => [p, filesFor(release, p)] as const).filter(([, files]) => files.length > 0);
  if (groups.length === 0) return null;
  return (
    <div className="rel-assets">
      <span className="lbl">Files</span>
      {groups.map(([p, files]) => (
        <div key={p} className="asset-row">
          <span className="facts">
            <b>{PLATFORM_LABEL[p]}</b>
          </span>
          {files.map((f) => (
            <a key={f.name} href={f.url} rel="noopener noreferrer" title={`${f.name} · ${formatBytes(f.size)}`}>
              {`${KIND_LABEL[f.kind]} · ${archLabel(f)}`}
            </a>
          ))}
        </div>
      ))}
    </div>
  );
}

export default async function ChangelogPage() {
  const state = await loadReleases();
  const releases = state.kind === "ok" ? state.releases : [];
  const latest = pickLatest(releases);

  return (
    <div className="wrap page">
      <header className="doc-head page-head">
        <div className="eyebrow bare">Changelog</div>
        <h1 className="h-page">Every release</h1>
        <p className="lead">Read from GitHub releases, newest first. A new release shows up here within the hour.</p>
        {state.kind === "unavailable" ? <ReleaseUnavailable reason={state.reason} /> : null}
      </header>
      {releases.length > 0 ? (
        <div className="rels">
          {releases.map((r) => (
            <article key={r.id} id={r.tag} className="frame rel" aria-labelledby={`h-${r.id}`}>
              <div className="rel-head">
                <h2 id={`h-${r.id}`}>
                  <span>{r.title}</span>
                  {r.prerelease ? <span className="badge badge-warn">Pre-release</span> : null}
                  {latest && r.id === latest.id ? <span className="badge badge-ok">Latest</span> : null}
                </h2>
                <span className="facts">
                  <span>
                    <b className="as-typed">{r.tag}</b>
                  </span>
                  <span>{formatDay(r.publishedAt)}</span>
                  <a className="link" href={r.url} target="_blank" rel="noopener noreferrer">
                    On GitHub
                  </a>
                </span>
              </div>
              <div className="rel-body">
                <ReleaseNotes body={r.body} />
              </div>
              <Assets release={r} />
            </article>
          ))}
        </div>
      ) : null}
      <p>
        <a className="btn" href={SITE.releasesUrl} target="_blank" rel="noopener noreferrer">
          All releases on GitHub
        </a>
      </p>
    </div>
  );
}
