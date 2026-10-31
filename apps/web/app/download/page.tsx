import { Download } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { CodeBlock } from "@/components/code-block";
import { ReleaseUnavailable } from "@/components/release-state";
import { CLI_VERSIONS } from "@/lib/content";
import { formatBytes, formatDay } from "@/lib/format";
import { loadReleases } from "@/lib/github";
import { pageMeta } from "@/lib/page-meta";
import { archLabel, filesFor, KIND_LABEL, newerPrerelease, PLATFORM_LABEL, pickLatest, type DownloadFile, type Platform, type Release } from "@/lib/releases";
import { SITE } from "@/lib/site";

export const revalidate = 3600;

export const metadata = pageMeta({
  title: "Download",
  description: "Download Crewyard for Windows, macOS or Linux: every file of the latest release with its size and SHA-256, install steps for each system and what you need installed.",
  path: "/download",
});

function FileRow({ file }: { file: DownloadFile }) {
  return (
    <div className="file">
      <div className="file-name">
        <b>
          {KIND_LABEL[file.kind]} · {archLabel(file)}
        </b>
        <span className="mono">
          {file.name} · {formatBytes(file.size)}
        </span>
      </div>
      <a className="btn btn-sm" href={file.url} rel="noopener noreferrer">
        <Download strokeWidth={1.5} aria-hidden />
        Download
      </a>
      <div className="file-sum">
        <span className="lbl">SHA-256</span>
        {file.sha256 ? <CodeBlock code={file.sha256} wrap /> : <span className="cta-note">GitHub reported no digest for this file. Compare with the release notes if they list one.</span>}
      </div>
    </div>
  );
}

const pick = (files: DownloadFile[], kind: DownloadFile["kind"], fallback: string) => files.find((f) => f.kind === kind)?.name ?? fallback;

function WindowsNotes({ files, version }: { files: DownloadFile[]; version: string }) {
  const exe = pick(files, "exe", `Crewyard-Setup-${version}-x64.exe`);
  return (
    <>
      <h3>Install</h3>
      <ol>
        <li>Run the installer. It installs for your user only, in %LOCALAPPDATA%\Programs\crewyard, without asking for admin rights, and adds Start-menu and desktop shortcuts.</li>
        <li>
          The build is not code-signed yet, so Windows SmartScreen says the publisher is unknown. Choose <strong>More info</strong>, then <strong>Run anyway</strong>.
        </li>
        <li>Uninstall from Windows Settings. Your data in %APPDATA%\Crewyard stays until you delete it.</li>
      </ol>
      <h3>Silent install</h3>
      <CodeBlock code={`.\\${exe} /S`} />
      <h3>Check the file (PowerShell)</h3>
      <CodeBlock code={`Get-FileHash .\\${exe} -Algorithm SHA256`} />
      <p>Built and tested on Windows 11. Windows 10 has not been tried.</p>
    </>
  );
}

function MacNotes({ files, version }: { files: DownloadFile[]; version: string }) {
  const dmg = pick(files, "dmg", `Crewyard-${version}-arm64.dmg`);
  return (
    <>
      <h3>Install</h3>
      <ol>
        <li>Pick the build for your Mac: Apple silicon (M-series chips) or Intel. Apple menu, About This Mac, shows which one you have.</li>
        <li>Open the .dmg and drag Crewyard to Applications, or unzip the .zip and move Crewyard.app there.</li>
        <li>
          The app is not signed or notarized, so Gatekeeper blocks the first start. Control-click (or right-click) Crewyard in Applications, choose <strong>Open</strong>, then <strong>Open</strong> again. Or try to open it once, then go to System Settings, Privacy &amp; Security, and choose <strong>Open Anyway</strong>.
        </li>
        <li>If macOS says the app is damaged and cannot be opened, remove the download quarantine flag:</li>
      </ol>
      <CodeBlock code="xattr -dr com.apple.quarantine /Applications/Crewyard.app" />
      <h3>Check the file (Terminal)</h3>
      <CodeBlock code={`shasum -a 256 ~/Downloads/${dmg}`} />
    </>
  );
}

function LinuxNotes({ files, version }: { files: DownloadFile[]; version: string }) {
  const appimage = pick(files, "appimage", `Crewyard-${version}-x86_64.AppImage`);
  const deb = pick(files, "deb", `Crewyard-${version}-amd64.deb`);
  return (
    <>
      <h3>AppImage</h3>
      <CodeBlock code={`chmod +x ${appimage}\n./${appimage}`} />
      <p>If it does not start, your distribution may need FUSE 2: the libfuse2 package (libfuse2t64 on Ubuntu 24.04).</p>
      <h3>Debian or Ubuntu package</h3>
      <CodeBlock code={`sudo apt install ./${deb}`} />
      <h3>Check the file</h3>
      <CodeBlock code={`sha256sum ${appimage}`} />
      <p>API keys are stored through the Secret Service (GNOME Keyring) or KWallet; without one, Crewyard does not store keys in plain text. Linux has no tray icon, so closing the window asks whether to quit.</p>
    </>
  );
}

const NOTES: Record<Platform, (p: { files: DownloadFile[]; version: string }) => ReactNode> = {
  windows: WindowsNotes,
  macos: MacNotes,
  linux: LinuxNotes,
};

const PLATFORM_LINE: Record<Platform, string> = {
  windows: "Windows 11 · x64",
  macos: "Apple silicon and Intel",
  linux: "x64",
};

function PlatformPanel({ release, platform, index }: { release: Release; platform: Platform; index: number }) {
  const files = filesFor(release, platform);
  const Notes = NOTES[platform];
  return (
    <section className="frame plat" id={platform} aria-labelledby={`${platform}-h`}>
      <div className="plat-head">
        <h2 id={`${platform}-h`}>
          <span className="spec-idx">{String(index + 1).padStart(2, "0")}</span>
          {PLATFORM_LABEL[platform]}
        </h2>
        <span className="facts">{PLATFORM_LINE[platform]}</span>
      </div>
      <div className="plat-body">
        <div className="files">
          {files.length > 0 ? files.map((f) => <FileRow key={f.name} file={f} />) : <p className="empty-files">v{release.version} has no {PLATFORM_LABEL[platform]} build. Earlier or later releases may; see all releases on GitHub.</p>}
        </div>
        <div className="notes">{files.length > 0 ? <Notes files={files} version={release.version} /> : null}</div>
      </div>
    </section>
  );
}

function Requirements() {
  return (
    <section className="doc-sec plain" aria-labelledby="req-h">
      <h2 id="req-h" className="h-sec">
        What you need installed
      </h2>
      <p>Git, the GitHub CLI (gh) for the GitHub features, and the agent CLIs you want to use, at the versions Crewyard was checked with. One agent CLI is enough to start. The Start screen checks each one and shows the command to install or update it.</p>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th scope="col">CLI</th>
              <th scope="col">Checked with</th>
              <th scope="col">Sign-in</th>
            </tr>
          </thead>
          <tbody>
            {CLI_VERSIONS.map((c) => (
              <tr key={c.id}>
                <td>
                  <span className="brand-name">
                    <BrandMark id={c.id} />
                    {c.name}
                  </span>
                </td>
                <td className="mono">{c.version}</td>
                <td>{c.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function DownloadPage() {
  const state = await loadReleases();
  const releases = state.kind === "ok" ? state.releases : [];
  const latest = pickLatest(releases);
  const newer = newerPrerelease(releases, latest);

  return (
    <div className="wrap page">
      <header className="doc-head page-head">
        <div className="eyebrow bare">Download</div>
        <h1 className="h-page">Download Crewyard</h1>
        {latest ? (
          <>
            <div className="facts">
              <span>
                Version <b className="as-typed">v{latest.version}</b>
              </span>
              <span>
                Released <b>{formatDay(latest.publishedAt)}</b>
              </span>
              {latest.prerelease ? <span className="badge badge-warn">Pre-release</span> : null}
              <Link className="link" href={`/changelog#${encodeURIComponent(latest.tag)}`}>
                Release notes
              </Link>
            </div>
            <p className="lead">{latest.prerelease ? "This is a pre-release: unsigned, built without an update feed, and installed by hand." : "Pick the file for your system. Each one lists its size and, when GitHub reports it, its SHA-256."}</p>
            {newer ? (
              <p className="cta-note">
                A newer pre-release, v{newer.version}, is out.{" "}
                <Link className="link" href={`/changelog#${encodeURIComponent(newer.tag)}`}>
                  See its notes and files
                </Link>
                .
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="lead">Crewyard ships for Windows, macOS and Linux through GitHub releases. This page lists the files of the latest release as soon as one is public.</p>
            <ReleaseUnavailable reason={state.kind === "unavailable" ? state.reason : "no-releases"} />
          </>
        )}
      </header>

      {latest ? (
        <div className="plats">
          {(["windows", "macos", "linux"] as const).map((p, i) => (
            <PlatformPanel key={p} release={latest} platform={p} index={i} />
          ))}
        </div>
      ) : null}

      <Requirements />

      <section className="doc-sec plain" aria-labelledby="all-h">
        <h2 id="all-h" className="h-sec">
          Every release
        </h2>
        <p>
          Older versions, their notes and their files are in the <Link href="/changelog">changelog</Link> and on GitHub. Builds are installed by hand: the app does not update itself yet.
        </p>
        <p>
          <a className="btn" href={SITE.releasesUrl} target="_blank" rel="noopener noreferrer">
            All releases on GitHub
          </a>
        </p>
      </section>
    </div>
  );
}
