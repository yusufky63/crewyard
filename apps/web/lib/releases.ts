// Release data as the site shows it: parsing the GitHub REST payload, matching assets to platforms
// by file name, and choosing which release the download buttons point at. Pure functions only; the
// fetching lives in github.ts (server-only), so this file runs under Vitest as it is.
import { z } from "zod";
import { SITE } from "./site.ts";

export type Platform = "windows" | "macos" | "linux";
export type Arch = "x64" | "arm64" | "universal";
export type AssetKind = "exe" | "msi" | "dmg" | "zip" | "appimage" | "deb" | "rpm";

export interface DownloadFile {
  name: string;
  url: string;
  size: number;
  /** Lowercase hex, only when GitHub reported a sha256 digest for the asset. */
  sha256: string | null;
  platform: Platform;
  arch: Arch;
  kind: AssetKind;
}

export interface Release {
  id: number;
  tag: string;
  /** The tag without a leading v: "0.1.0". */
  version: string;
  title: string;
  body: string;
  prerelease: boolean;
  /** ISO date-time; GitHub's published_at, or created_at for a release that never had one. */
  publishedAt: string;
  url: string;
  files: DownloadFile[];
}

export type UnavailableReason = "not-public" | "no-releases" | "rate-limited" | "error";

export type ReleasesState =
  | { kind: "ok"; releases: Release[] }
  | { kind: "unavailable"; reason: UnavailableReason };

// Only the fields the site reads. Anything else in the payload is ignored, and an item that does
// not match is dropped on its own instead of failing the whole list.
const AssetSchema = z.object({
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  browser_download_url: z.string(),
  state: z.string().optional(),
  digest: z.string().nullable().optional(),
});

const ReleaseSchema = z.object({
  id: z.number().int(),
  tag_name: z.string().min(1),
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  html_url: z.string(),
  created_at: z.string(),
  published_at: z.string().nullable().optional(),
  assets: z.array(z.unknown()),
});

/**
 * Links on the site only ever point at this repository's own release pages and downloads, whatever
 * a response says, so a tampered or misrouted payload cannot turn a Download button into a link to
 * somewhere else.
 */
const DOWNLOAD_PREFIX = `${SITE.repoUrl}/releases/download/`;
const TAG_PREFIX = `${SITE.repoUrl}/releases/tag/`;

const SHA256 = /^sha256:([0-9a-f]{64})$/i;

/** Platform, architecture and package kind from an asset's file name, or null when it is not a download. */
export function classifyAsset(name: string): Pick<DownloadFile, "platform" | "arch" | "kind"> | null {
  const lower = name.toLowerCase();
  // Update feeds, delta maps, signatures and checksum lists sit next to the installers but are not
  // something to install (electron-builder writes latest*.yml and *.blockmap).
  if (/\.(blockmap|ya?ml|sig|asc|sha256|sha512|txt|json)$/.test(lower)) return null;

  const arm = /(^|[^a-z0-9])(arm64|aarch64)([^a-z0-9]|$)/.test(lower);
  const universal = /(^|[^a-z0-9])universal([^a-z0-9]|$)/.test(lower);
  // 32-bit and other architectures are not built; a file that names one is not offered as x64.
  if (/(^|[^a-z0-9])(ia32|i386|i686|armv7l|armhf|x86)(?![_-]?64)([^a-z0-9]|$)/.test(lower)) return null;
  const arch: Arch = arm ? "arm64" : universal ? "universal" : "x64";

  if (lower.endsWith(".exe")) return { platform: "windows", arch: arm ? "arm64" : "x64", kind: "exe" };
  if (lower.endsWith(".msi")) return { platform: "windows", arch: arm ? "arm64" : "x64", kind: "msi" };
  if (lower.endsWith(".dmg")) return { platform: "macos", arch, kind: "dmg" };
  if (lower.endsWith(".appimage")) return { platform: "linux", arch: arm ? "arm64" : "x64", kind: "appimage" };
  if (lower.endsWith(".deb")) return { platform: "linux", arch: arm ? "arm64" : "x64", kind: "deb" };
  if (lower.endsWith(".rpm")) return { platform: "linux", arch: arm ? "arm64" : "x64", kind: "rpm" };
  if (lower.endsWith(".zip")) {
    // electron-builder's macOS zip carries only the version and arch (Crewyard-0.1.0-arm64.zip);
    // a zip that names another platform is not offered as a Mac download.
    if (/(^|[^a-z])(win|windows|win32|win64|linux)([^a-z]|$)/.test(lower)) return null;
    return { platform: "macos", arch, kind: "zip" };
  }
  return null;
}

const KIND_ORDER: AssetKind[] = ["exe", "msi", "dmg", "zip", "appimage", "deb", "rpm"];
const ARCH_ORDER: Arch[] = ["arm64", "x64", "universal"];

function parseFile(raw: unknown): DownloadFile | null {
  const parsed = AssetSchema.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  // An asset still uploading (or a failed upload) is not offered.
  if (a.state !== undefined && a.state !== "uploaded") return null;
  if (!a.browser_download_url.startsWith(DOWNLOAD_PREFIX)) return null;
  const kind = classifyAsset(a.name);
  if (!kind) return null;
  const digest = a.digest ? SHA256.exec(a.digest) : null;
  return { name: a.name, url: a.browser_download_url, size: a.size, sha256: digest ? digest[1]!.toLowerCase() : null, ...kind };
}

export function compareFiles(a: DownloadFile, b: DownloadFile): number {
  return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || ARCH_ORDER.indexOf(a.arch) - ARCH_ORDER.indexOf(b.arch) || a.name.localeCompare(b.name);
}

/** One release from the API, or null for a draft or an item that does not parse. */
export function parseRelease(raw: unknown): Release | null {
  const parsed = ReleaseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  // Drafts reach the API only for a token with push access; they are never public.
  if (r.draft) return null;
  if (!r.html_url.startsWith(TAG_PREFIX)) return null;
  const publishedAt = r.published_at ?? r.created_at;
  if (Number.isNaN(Date.parse(publishedAt))) return null;
  const files = r.assets.map(parseFile).filter((f): f is DownloadFile => f !== null);
  files.sort(compareFiles);
  const version = r.tag_name.replace(/^v(?=\d)/, "");
  return {
    id: r.id,
    tag: r.tag_name,
    version,
    title: r.name?.trim() || r.tag_name,
    body: r.body ?? "",
    prerelease: r.prerelease,
    publishedAt,
    url: r.html_url,
    files,
  };
}

/** Every release in a list payload, newest first. Anything but an array yields none. */
export function parseReleases(raw: unknown): Release[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: Release[] = [];
  for (const item of raw) {
    const r = parseRelease(item);
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/**
 * The release the download buttons point at: the newest full release, like GitHub's own "latest",
 * or the newest pre-release while there is no full release yet (v0.1.0 is a pre-release, and
 * GitHub's /releases/latest answers 404 for a repository that only has pre-releases).
 * A release with no installable file is skipped, so a tag without assets never empties the page.
 */
export function pickLatest(releases: Release[]): Release | null {
  const installable = releases.filter((r) => r.files.length > 0);
  return installable.find((r) => !r.prerelease) ?? installable[0] ?? null;
}

/** A pre-release newer than the release the buttons use, offered beside it; null when there is none. */
export function newerPrerelease(releases: Release[], latest: Release | null): Release | null {
  if (!latest || latest.prerelease) return null;
  const newer = releases.find((r) => r.prerelease && r.files.length > 0 && Date.parse(r.publishedAt) > Date.parse(latest.publishedAt));
  return newer ?? null;
}

export function filesFor(release: Release, platform: Platform): DownloadFile[] {
  return release.files.filter((f) => f.platform === platform);
}

/** The one file a platform's main button downloads. */
export interface PrimaryFiles {
  windows: DownloadFile | null;
  macArm64: DownloadFile | null;
  macX64: DownloadFile | null;
  linux: DownloadFile | null;
}

export function primaryFiles(release: Release | null): PrimaryFiles {
  if (!release) return { windows: null, macArm64: null, macX64: null, linux: null };
  const find = (pred: (f: DownloadFile) => boolean) => release.files.find(pred) ?? null;
  const mac = (arch: Arch) => find((f) => f.platform === "macos" && f.kind === "dmg" && f.arch === arch) ?? find((f) => f.platform === "macos" && f.kind === "dmg" && f.arch === "universal");
  return {
    windows: find((f) => f.platform === "windows" && f.kind === "exe" && f.arch === "x64") ?? find((f) => f.platform === "windows" && f.arch === "x64"),
    macArm64: mac("arm64"),
    macX64: mac("x64"),
    linux: find((f) => f.platform === "linux" && f.kind === "appimage" && f.arch === "x64") ?? find((f) => f.platform === "linux" && f.arch === "x64"),
  };
}

export const PLATFORM_LABEL: Record<Platform, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

export const KIND_LABEL: Record<AssetKind, string> = {
  exe: "Installer (.exe)",
  msi: "Installer (.msi)",
  dmg: "Disk image (.dmg)",
  zip: "App archive (.zip)",
  appimage: "AppImage",
  deb: "Debian package (.deb)",
  rpm: "RPM package (.rpm)",
};

export const ARCH_LABEL: Record<Arch, string> = { x64: "x64", arm64: "arm64", universal: "Universal" };

/** "Apple silicon" and "Intel" are what Mac owners recognise; elsewhere the arch name is clearer. */
export function archLabel(file: Pick<DownloadFile, "platform" | "arch">): string {
  if (file.platform === "macos") return file.arch === "arm64" ? "Apple silicon" : file.arch === "x64" ? "Intel" : "Universal";
  return ARCH_LABEL[file.arch];
}

/** Platforms a release has at least one file for, in a fixed order. */
export function platformsOf(release: Release): Platform[] {
  return (["windows", "macos", "linux"] as const).filter((p) => release.files.some((f) => f.platform === p));
}
