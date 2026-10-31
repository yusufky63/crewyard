"use client";

import { Download } from "lucide-react";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { formatBytes } from "@/lib/format";
import { detectVisitor, type UaHints, type Visitor } from "@/lib/platform";
import { archLabel, KIND_LABEL, type DownloadFile, type PrimaryFiles } from "@/lib/releases";

// The main Download button. The server renders the version and every file; the browser then picks
// the visitor's own file. Until it has (and without JavaScript) the button opens /download.

type NavigatorWithHints = Navigator & {
  userAgentData?: { platform?: string; getHighEntropyValues?: (hints: string[]) => Promise<UaHints> };
};

let visitor: Visitor | null = null;
let hinting = false;

function snapshot(): Visitor | null {
  if (typeof navigator === "undefined") return null;
  visitor ??= detectVisitor(navigator.userAgent, { platform: (navigator as NavigatorWithHints).userAgentData?.platform }, navigator.maxTouchPoints);
  return visitor;
}

/** Chromium can tell Apple silicon from Intel, but only through an async call; the rest never can. */
function subscribe(onChange: () => void): () => void {
  const nav = navigator as NavigatorWithHints;
  if (!hinting && nav.userAgentData?.getHighEntropyValues) {
    hinting = true;
    nav.userAgentData
      .getHighEntropyValues(["architecture", "bitness", "platform"])
      .then((hints) => {
        const next = detectVisitor(navigator.userAgent, hints, navigator.maxTouchPoints);
        if (next.os !== visitor?.os || next.arch !== visitor?.arch) {
          visitor = next;
          onChange();
        }
      })
      .catch(() => undefined);
  }
  return () => undefined;
}

export interface DownloadCtaProps {
  version: string | null;
  prerelease: boolean;
  files: PrimaryFiles;
}

function fileNote(f: DownloadFile, version: string, prerelease: boolean): string {
  return [`v${version}`, prerelease ? "Pre-release" : null, KIND_LABEL[f.kind], archLabel(f), formatBytes(f.size)].filter(Boolean).join(" · ");
}

function FileButton({ file, label }: { file: DownloadFile; label: string }) {
  return (
    <a className="btn btn-primary btn-lg" href={file.url} rel="noopener noreferrer">
      <Download strokeWidth={1.5} aria-hidden />
      {label}
    </a>
  );
}

function AllButton({ label = "Download" }: { label?: string }) {
  return (
    <Link className="btn btn-primary btn-lg" href="/download">
      <Download strokeWidth={1.5} aria-hidden />
      {label}
    </Link>
  );
}

export function DownloadCta({ version, prerelease, files }: DownloadCtaProps) {
  const v = useSyncExternalStore(subscribe, snapshot, () => null);

  if (!version) {
    return (
      <div className="cta-stack">
        <AllButton />
        <p className="cta-note">No public release is available yet.</p>
      </div>
    );
  }

  let main: { file: DownloadFile; label: string } | null = null;
  let extra: { file: DownloadFile; label: string } | null = null;
  let note: string | null = null;
  if (v?.os === "windows" && files.windows) main = { file: files.windows, label: "Download for Windows" };
  else if (v?.os === "linux" && v.arch !== "arm64" && files.linux) main = { file: files.linux, label: "Download for Linux" };
  else if (v?.os === "macos") {
    if (v.arch === "arm64" && files.macArm64) main = { file: files.macArm64, label: "Download for macOS" };
    else if (v.arch === "x64" && files.macX64) main = { file: files.macX64, label: "Download for macOS" };
    else if (v.arch === "unknown") {
      // Every Mac browser but Chromium hides the chip, so both builds are offered by name.
      const first = files.macArm64 ?? files.macX64;
      if (first) main = { file: first, label: first === files.macArm64 ? "Download for Apple silicon" : "Download for Intel Mac" };
      if (files.macArm64 && files.macX64) extra = { file: files.macX64, label: "Intel Mac" };
    }
  } else if (v?.os === "android" || v?.os === "ios") note = "Crewyard is a desktop app. Open this page on your computer to download it.";

  if (!main && v && v.os !== "unknown" && !note) note = `This release has no build for your system yet. See every file on the download page.`;

  return (
    <div className="cta-stack">
      {main ? <FileButton file={main.file} label={main.label} /> : <AllButton label={`Download v${version}`} />}
      <p className="cta-note">
        {main ? fileNote(main.file, version, prerelease) : (note ?? `v${version}${prerelease ? " · Pre-release" : ""}`)}
        {extra ? (
          <>
            {" · "}
            <a className="link" href={extra.file.url} rel="noopener noreferrer">
              {extra.label}
            </a>
          </>
        ) : null}
      </p>
    </div>
  );
}
