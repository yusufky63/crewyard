import { describe, expect, it } from "vitest";
import { archLabel, classifyAsset, newerPrerelease, parseRelease, parseReleases, pickLatest, platformsOf, primaryFiles } from "./releases.ts";

const BASE = "https://github.com/yusufky63/crewyard";
const SHA = "ff36079e83e979de3ec2236876ed49ff7da7745bae4773e80a337e168cdc31b6";

const asset = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  size: 123_456_789,
  browser_download_url: `${BASE}/releases/download/v0.1.0/${name}`,
  state: "uploaded",
  digest: `sha256:${SHA}`,
  ...extra,
});

const release = (over: Record<string, unknown> = {}) => ({
  id: 1,
  tag_name: "v0.1.0",
  name: "Crewyard 0.1.0",
  body: "First test build.",
  draft: false,
  prerelease: true,
  html_url: `${BASE}/releases/tag/v0.1.0`,
  created_at: "2026-10-31T10:00:00Z",
  published_at: "2026-10-31T12:00:00Z",
  assets: [asset("Crewyard-Setup-0.1.0-x64.exe"), asset("Crewyard-Setup-0.1.0-x64.exe.blockmap"), asset("latest.yml")],
  ...over,
});

describe("classifyAsset", () => {
  it("matches the file names electron-builder writes for each target", () => {
    expect(classifyAsset("Crewyard-Setup-0.1.0-x64.exe")).toEqual({ platform: "windows", arch: "x64", kind: "exe" });
    expect(classifyAsset("Crewyard-0.1.0-arm64.dmg")).toEqual({ platform: "macos", arch: "arm64", kind: "dmg" });
    expect(classifyAsset("Crewyard-0.1.0-x64.dmg")).toEqual({ platform: "macos", arch: "x64", kind: "dmg" });
    expect(classifyAsset("Crewyard-0.1.0-arm64.zip")).toEqual({ platform: "macos", arch: "arm64", kind: "zip" });
    expect(classifyAsset("Crewyard-0.1.0-x64.zip")).toEqual({ platform: "macos", arch: "x64", kind: "zip" });
    expect(classifyAsset("Crewyard-0.1.0-x86_64.AppImage")).toEqual({ platform: "linux", arch: "x64", kind: "appimage" });
    expect(classifyAsset("Crewyard-0.1.0-amd64.deb")).toEqual({ platform: "linux", arch: "x64", kind: "deb" });
  });

  it("reads other common spellings of the architecture", () => {
    expect(classifyAsset("crewyard-aarch64.AppImage")?.arch).toBe("arm64");
    expect(classifyAsset("crewyard_0.2.0_arm64.deb")?.arch).toBe("arm64");
    expect(classifyAsset("Crewyard-0.2.0-universal.dmg")?.arch).toBe("universal");
    expect(classifyAsset("Crewyard-0.2.0-arm64-mac.zip")).toEqual({ platform: "macos", arch: "arm64", kind: "zip" });
    expect(classifyAsset("Crewyard Setup 0.2.0.exe")).toEqual({ platform: "windows", arch: "x64", kind: "exe" });
    expect(classifyAsset("Crewyard-0.2.0-x86_64.rpm")).toEqual({ platform: "linux", arch: "x64", kind: "rpm" });
  });

  it("leaves out update feeds, delta maps, signatures and checksums", () => {
    for (const name of ["latest.yml", "latest-mac.yml", "latest-linux.yml", "Crewyard-Setup-0.1.0-x64.exe.blockmap", "Crewyard-0.1.0-arm64.dmg.blockmap", "SHA256SUMS.txt", "Crewyard-0.1.0-x64.exe.sig", "checksums.sha256"]) {
      expect(classifyAsset(name), name).toBeNull();
    }
  });

  it("never offers a 32-bit build or a zip for another system as a Mac or x64 download", () => {
    expect(classifyAsset("Crewyard-Setup-0.1.0-ia32.exe")).toBeNull();
    expect(classifyAsset("Crewyard-0.1.0-armv7l.AppImage")).toBeNull();
    expect(classifyAsset("Crewyard-0.1.0-win.zip")).toBeNull();
    expect(classifyAsset("Crewyard-0.1.0-linux-x64.zip")).toBeNull();
    expect(classifyAsset("source.tar.gz")).toBeNull();
  });
});

describe("parseRelease", () => {
  it("keeps installable files with size and sha256, newest kinds first", () => {
    const r = parseRelease(release());
    expect(r).not.toBeNull();
    expect(r!.version).toBe("0.1.0");
    expect(r!.title).toBe("Crewyard 0.1.0");
    expect(r!.files).toEqual([
      { name: "Crewyard-Setup-0.1.0-x64.exe", url: `${BASE}/releases/download/v0.1.0/Crewyard-Setup-0.1.0-x64.exe`, size: 123_456_789, sha256: SHA, platform: "windows", arch: "x64", kind: "exe" },
    ]);
  });

  it("drops drafts, links that leave the repository, and assets still uploading", () => {
    expect(parseRelease(release({ draft: true }))).toBeNull();
    expect(parseRelease(release({ html_url: "https://example.com/releases/tag/v0.1.0" }))).toBeNull();
    const r = parseRelease(release({ assets: [asset("Crewyard-0.1.0-arm64.dmg", { browser_download_url: "https://evil.example/Crewyard-0.1.0-arm64.dmg" }), asset("Crewyard-0.1.0-x64.dmg", { state: "starter" }), asset("Crewyard-0.1.0-x86_64.AppImage")] }));
    expect(r!.files.map((f) => f.name)).toEqual(["Crewyard-0.1.0-x86_64.AppImage"]);
  });

  it("reports a missing or foreign digest as unknown, never a guessed hash", () => {
    const r = parseRelease(release({ assets: [asset("a-x64.exe", { digest: null }), asset("b-x64.msi", { digest: "sha512:abc" }), asset("c-arm64.dmg", { digest: undefined })] }));
    expect(r!.files.map((f) => f.sha256)).toEqual([null, null, null]);
  });

  it("falls back to the tag for a title and to created_at for a release never published", () => {
    const r = parseRelease(release({ name: "  ", published_at: null }));
    expect(r!.title).toBe("v0.1.0");
    expect(r!.publishedAt).toBe("2026-10-31T10:00:00Z");
  });

  it("refuses a payload with the wrong shape instead of guessing", () => {
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease({ id: "x" })).toBeNull();
    expect(parseRelease(release({ assets: "nope" }))).toBeNull();
    expect(parseRelease(release({ published_at: "not a date" }))).toBeNull();
  });
});

describe("parseReleases and pickLatest", () => {
  const stable = release({ id: 2, tag_name: "v0.2.0", prerelease: false, html_url: `${BASE}/releases/tag/v0.2.0`, published_at: "2026-11-10T00:00:00Z" });
  const beta = release({ id: 3, tag_name: "v0.3.0-beta.1", prerelease: true, html_url: `${BASE}/releases/tag/v0.3.0-beta.1`, published_at: "2026-11-20T00:00:00Z" });
  const empty = release({ id: 4, tag_name: "v0.2.1", prerelease: false, html_url: `${BASE}/releases/tag/v0.2.1`, published_at: "2026-11-15T00:00:00Z", assets: [] });

  it("sorts newest first, drops duplicates and bad items, and keeps a non-array out", () => {
    expect(parseReleases([release(), stable, beta, stable, { junk: true }]).map((r) => r.id)).toEqual([3, 2, 1]);
    expect(parseReleases({ message: "Not Found" })).toEqual([]);
  });

  it("uses the newest pre-release while there is no full release", () => {
    expect(pickLatest(parseReleases([release()]))?.tag).toBe("v0.1.0");
  });

  it("prefers the newest full release, like GitHub's latest, and offers a newer pre-release beside it", () => {
    const list = parseReleases([release(), stable, beta]);
    const latest = pickLatest(list);
    expect(latest?.tag).toBe("v0.2.0");
    expect(newerPrerelease(list, latest)?.tag).toBe("v0.3.0-beta.1");
    expect(newerPrerelease(list, pickLatest(parseReleases([release()])))).toBeNull();
  });

  it("skips a release with no installable file", () => {
    expect(pickLatest(parseReleases([stable, empty]))?.tag).toBe("v0.2.0");
    expect(pickLatest(parseReleases([empty]))).toBeNull();
  });
});

describe("primaryFiles", () => {
  const full = parseRelease(
    release({
      assets: ["Crewyard-Setup-0.1.0-x64.exe", "Crewyard-0.1.0-arm64.dmg", "Crewyard-0.1.0-x64.dmg", "Crewyard-0.1.0-arm64.zip", "Crewyard-0.1.0-x64.zip", "Crewyard-0.1.0-x86_64.AppImage", "Crewyard-0.1.0-amd64.deb"].map((n) => asset(n)),
    }),
  )!;

  it("picks the installer per platform: exe, dmg per chip, AppImage", () => {
    const p = primaryFiles(full);
    expect(p.windows?.name).toBe("Crewyard-Setup-0.1.0-x64.exe");
    expect(p.macArm64?.name).toBe("Crewyard-0.1.0-arm64.dmg");
    expect(p.macX64?.name).toBe("Crewyard-0.1.0-x64.dmg");
    expect(p.linux?.name).toBe("Crewyard-0.1.0-x86_64.AppImage");
    expect(platformsOf(full)).toEqual(["windows", "macos", "linux"]);
  });

  it("offers a universal dmg to both chips and nothing for a platform without files", () => {
    const uni = parseRelease(release({ assets: [asset("Crewyard-0.2.0-universal.dmg")] }))!;
    const p = primaryFiles(uni);
    expect(p.macArm64?.name).toBe("Crewyard-0.2.0-universal.dmg");
    expect(p.macX64?.name).toBe("Crewyard-0.2.0-universal.dmg");
    expect(p.windows).toBeNull();
    expect(p.linux).toBeNull();
    expect(primaryFiles(null)).toEqual({ windows: null, macArm64: null, macX64: null, linux: null });
  });

  it("names Mac builds by chip and the rest by architecture", () => {
    expect(archLabel({ platform: "macos", arch: "arm64" })).toBe("Apple silicon");
    expect(archLabel({ platform: "macos", arch: "x64" })).toBe("Intel");
    expect(archLabel({ platform: "linux", arch: "x64" })).toBe("x64");
  });
});
