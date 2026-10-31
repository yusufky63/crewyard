import { ArrowRight, Check, Clock } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { DownloadCta } from "@/components/download-cta";
import { GitHubLink } from "@/components/header";
import { Shot } from "@/components/shot";
import { CLI_VERSIONS, FEATURES, NEVER_WITHOUT_YOU, OPT_INS, PROVIDERS_NOTE, STEPS } from "@/lib/content";
import { formatDay } from "@/lib/format";
import { loadReleases } from "@/lib/github";
import { pageMeta } from "@/lib/page-meta";
import { PLATFORM_LABEL, pickLatest, platformsOf, primaryFiles } from "@/lib/releases";
import { SITE } from "@/lib/site";

export const revalidate = 3600;

export const metadata = pageMeta({
  title: `${SITE.name}: run crews of coding agents`,
  description: SITE.description,
  path: "/",
});

function Chain({ steps, sep = "→" }: { steps: string[]; sep?: string }) {
  return (
    <div className="chain">
      {steps.map((s, i) => (
        <span key={s} style={{ display: "contents" }}>
          {i > 0 ? <span className="sep">{sep}</span> : null}
          <span className="step">{s}</span>
        </span>
      ))}
    </div>
  );
}

/** A small, literal piece of the app per tile: the same labels and badges the app shows. */
const ART: Record<string, ReactNode> = {
  crews: <Chain steps={["Plan", "Implement", "Test", "Review", "PR"]} />,
  inbox: (
    <>
      <span className="badge badge-ok">Low</span>
      <span className="badge badge-warn">Medium</span>
      <span className="badge badge-bad">High</span>
    </>
  ),
  limits: (
    <>
      <span className="badge badge-reported">Reported</span>
      <span className="badge badge-estimated">Estimated</span>
      <span className="badge badge-unknown">Unknown</span>
    </>
  ),
  fallback: <Chain steps={["Manual", "Ask", "Auto", "Wait for reset"]} sep="·" />,
  github: <Chain steps={["Commit", "Waiting to push", "PR", "Merge"]} />,
  assistant: (
    <>
      <span className="badge">Read-only</span>
      <span className="badge badge-unknown">Autopilot off</span>
    </>
  ),
  setup: (
    <>
      {CLI_VERSIONS.map((c) => (
        <BrandMark key={c.id} id={c.id} />
      ))}
      <code>.crewyard/roles</code>
    </>
  ),
  panel: <Chain steps={["Assistant", "Terminal", "Events", "Logs", "Problems"]} sep="·" />,
  reports: <Chain steps={["Severity", "file:line", "Suggested task"]} sep="·" />,
};

export default async function HomePage() {
  const state = await loadReleases();
  const releases = state.kind === "ok" ? state.releases : [];
  const latest = pickLatest(releases);
  const platforms = latest ? platformsOf(latest) : [];

  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div className="hero-grid">
            <div className="hero-copy">
              <div className="eyebrow bare">Desktop app for coding agents</div>
              <h1 className="h-hero">
                Run crews of coding agents
                <span className="dim">on your own accounts and keys.</span>
              </h1>
              <p className="lead">Claude Code, Codex, Gemini CLI and OpenCode, supervised from one window. Crewyard proposes a crew for each task, watches limits and spend, and starts nothing until you approve.</p>
              <div className="cta-row">
                <DownloadCta version={latest?.version ?? null} prerelease={latest?.prerelease ?? false} files={primaryFiles(latest)} />
                <GitHubLink className="btn btn-lg gh-btn" label="View on GitHub" />
              </div>
              <div className="cta-alt">
                <Link href="/download">Every platform and file</Link>
                <Link href="/changelog">Release notes</Link>
                <Link href="/how-it-works">How it works</Link>
              </div>
            </div>
            <aside className="frame spec-sheet" aria-label="Release facts">
              <dl className="kv">
                <dt>Latest</dt>
                <dd>
                  {latest ? (
                    <span className="inline-badges">
                      <span className="mono">v{latest.version}</span>
                      {latest.prerelease ? <span className="badge badge-warn">Pre-release</span> : null}
                    </span>
                  ) : (
                    "No public release yet"
                  )}
                </dd>
                {latest ? (
                  <>
                    <dt>Released</dt>
                    <dd className="mono">{formatDay(latest.publishedAt)}</dd>
                    <dt>Builds</dt>
                    <dd>{platforms.map((p) => PLATFORM_LABEL[p]).join(" · ")}</dd>
                  </>
                ) : null}
                <dt>Runners</dt>
                <dd>
                  <span className="inline-badges">
                    {CLI_VERSIONS.map((c) => (
                      <BrandMark key={c.id} id={c.id} label={c.name} />
                    ))}
                  </span>
                </dd>
                <dt>Licence</dt>
                <dd>{SITE.license}</dd>
                <dt>Source</dt>
                <dd>
                  <a className="link mono" href={SITE.repoUrl} target="_blank" rel="noopener noreferrer">
                    {`${SITE.owner}/${SITE.repo}`}
                  </a>
                </dd>
              </dl>
            </aside>
          </div>
          <div className="hero-shot">
            <Shot name="crew" title="Crew graph" alt="Crewyard's Crew graph with sample data: a task's plan, implement, test and review steps as connected nodes with their runner, model and status, standbys waiting under each step, and a limit reached on the test step." priority />
          </div>
        </div>
      </section>

      <section className="sec" aria-labelledby="what">
        <div className="wrap">
          <div className="sec-head">
            <div className="eyebrow">
              <span className="n">01</span> What it does
            </div>
            <h2 id="what" className="h-sec">
              One place for the agents you already pay for
            </h2>
          </div>
          <div className="tiles">
            {FEATURES.map((f, i) => (
              <article key={f.id} className="spec">
                <div className="spec-idx">{String(i + 1).padStart(2, "0")}</div>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
                {ART[f.id] ? (
                  <div className="art" aria-hidden>
                    {ART[f.id]}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="sec" aria-labelledby="how">
        <div className="wrap">
          <div className="sec-head">
            <div className="eyebrow">
              <span className="n">02</span> How it works
            </div>
            <h2 id="how" className="h-sec">
              From a task to a merged pull request, with you at each gate
            </h2>
          </div>
          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={s.title} className="spec step-tile">
                <span className="n">{String(i + 1).padStart(2, "0")}</span>
                <h3>{s.title}</h3>
                <p>{s.short}</p>
              </li>
            ))}
          </ol>
          <p className="sec-more">
            <Link className="btn btn-ghost" href="/how-it-works">
              Read how it works <ArrowRight strokeWidth={1.5} aria-hidden />
            </Link>
          </p>
        </div>
      </section>

      <section className="sec" aria-labelledby="inbox">
        <div className="wrap split">
          <div className="sec-head">
            <div className="eyebrow">
              <span className="n">03</span> Inbox
            </div>
            <h2 id="inbox" className="h-sec">
              Questions and approvals wait for you, with the risk spelled out
            </h2>
            <p>When an agent asks something, wants to run a command that is not allowed yet, or reaches a limit or a spend cap, its run pauses and the Inbox shows what it wants: the command, the working directory, the scope, the policy that applies, and who asked.</p>
            <p>Approve once, allow it in this project, or deny with a reason the agent reads. High-risk commands are always approved one at a time, and a request never times out into an approval.</p>
          </div>
          <Shot name="inbox" title="Inbox" alt="Crewyard's Inbox with sample data: a list of questions, approvals and spend-cap notices, and a medium-risk tool approval with its command, working directory, scope and policy, and Approve once, Allow in this project and Deny buttons." />
        </div>
      </section>

      <section className="sec" aria-labelledby="runners">
        <div className="wrap">
          <div className="sec-head">
            <div className="eyebrow">
              <span className="n">04</span> Runners and providers
            </div>
            <h2 id="runners" className="h-sec">
              Four agent CLIs, the models you choose
            </h2>
            <p>{PROVIDERS_NOTE}</p>
          </div>
          <div className="runners">
            {CLI_VERSIONS.map((c) => (
              <div key={c.id} className="frame runner">
                <div className="runner-name">
                  <BrandMark id={c.id} size={18} />
                  {c.name}
                </div>
                <p>{c.note}</p>
                <div className="ver">Checked with {c.version}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="sec" aria-labelledby="never">
        <div className="wrap split">
          <div className="sec-head">
            <div className="eyebrow">
              <span className="n">05</span> Your call
            </div>
            <h2 id="never" className="h-sec">
              What never happens without you
            </h2>
            <p>Agents work in their own worktrees and commit locally. Everything that leaves your machine or spends past a limit waits for an explicit click in the app.</p>
          </div>
          <div className="frame pad">
            <ul className="marks">
              {NEVER_WITHOUT_YOU.map((t) => (
                <li key={t} className="wait">
                  <Clock strokeWidth={1.5} aria-hidden />
                  <span>{t} waits for your click.</span>
                </li>
              ))}
            </ul>
            <div className="optins">
              <div className="lbl">Two opt-ins, both recorded</div>
              <ul className="marks">
                {OPT_INS.map((o) => (
                  <li key={o.title} className="ok">
                    <Check strokeWidth={1.5} aria-hidden />
                    <span>
                      <strong>{o.title}.</strong> {o.body}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="sec" aria-labelledby="get">
        <div className="wrap">
          <div className="frame final">
            <div className="sec-head" style={{ marginBottom: 0 }}>
              <div className="eyebrow bare">
                {latest ? `v${latest.version}${latest.prerelease ? " · Pre-release" : ""} · ${formatDay(latest.publishedAt)}` : "Releases"}
              </div>
              <h2 id="get" className="h-sec">
                {latest ? "Get Crewyard" : "Crewyard is not released publicly yet"}
              </h2>
              <p>{latest ? "Built and tested on Windows 11. Every file, its SHA-256 and the install steps for each system are on the download page." : "Releases will appear here, with every file and its SHA-256, as soon as they are published on GitHub."}</p>
            </div>
            <div className="cta-row">
              <Link className="btn btn-primary btn-lg" href="/download">
                {latest ? "Download" : "Download page"}
              </Link>
              <a className="btn btn-lg" href={SITE.releasesUrl} target="_blank" rel="noopener noreferrer">
                All releases on GitHub
              </a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
