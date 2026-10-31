import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARTIFACT_NAMES, BUILDS, CHECKSUMS, LICENCE, buildById, checkLicence, checkVersions, parseTag, releaseAssets } from "./release-assets.cjs";

const require = createRequire(import.meta.url);
const appDir = join(import.meta.dirname, "..");
// electron-builder's own naming code, so the test follows its rules instead of restating them.
const libDir = dirname(require.resolve("app-builder-lib/package.json", { paths: [dirname(require.resolve("electron-builder/package.json"))] }));
const { expandMacro } = require(join(libDir, "out", "util", "macroExpander.js")) as { expandMacro: (pattern: string, arch: string, appInfo: object, extra: object) => string };
const builderUtil = require(require.resolve("builder-util", { paths: [libDir] })) as { Arch: Record<string, number>; getArtifactArchName: (arch: number, ext: string) => string };
const { validateConfiguration } = require(join(libDir, "out", "util", "config", "config.js")) as { validateConfiguration: (c: object, logger: object) => Promise<void> };
const { DebugLogger } = require(require.resolve("builder-util", { paths: [libDir] })) as { DebugLogger: new (enabled: boolean) => object };

type Config = Record<string, Record<string, unknown>> & { electronDist: (o: { platformName: string; arch: string }) => string | null };
const config = require(join(appDir, "electron-builder.config.cjs")) as Config;

/** The file name electron-builder gives a target: the target's own artifactName, else the platform's. */
function artifactFor(platform: string, target: string, arch: string, version: string): string {
  const ext = { nsis: "exe", dmg: "dmg", zip: "zip", AppImage: "AppImage", deb: "deb" }[target]!;
  const key = { nsis: "nsis", dmg: "dmg", AppImage: "appImage", deb: "deb" }[target];
  const pattern = ((key && config[key]?.artifactName) ?? config[platform]?.artifactName) as string;
  return expandMacro(pattern, builderUtil.getArtifactArchName(builderUtil.Arch[arch]!, ext), { version }, { ext });
}

describe("release tags", () => {
  it("publishes every 0.x version and every pre-release suffix as a pre-release", () => {
    expect(parseTag("v0.2.0")).toEqual({ version: "0.2.0", prerelease: true });
    expect(parseTag("v1.0.0")).toEqual({ version: "1.0.0", prerelease: false });
    expect(parseTag("v1.4.2-beta.1")).toEqual({ version: "1.4.2-beta.1", prerelease: true });
  });

  it("refuses anything that is not v<major>.<minor>.<patch>", () => {
    for (const bad of ["0.2.0", "v0.2", "v01.2.3", "v1.2.3.4", "v1.2.3-", "v1.2.3 ", "v1.2.3;id", "v1.2.3$(id)", "refs/tags/v1.2.3"]) {
      expect(() => parseTag(bad), bad).toThrow(/not a release tag/);
    }
  });

  it("needs the tag to match both package.json versions", () => {
    expect(checkVersions({ tag: "v0.3.0", desktopVersion: "0.3.0", rootVersion: "0.3.0" }).version).toBe("0.3.0");
    expect(() => checkVersions({ tag: "v0.3.0", desktopVersion: "0.2.0", rootVersion: "0.3.0" })).toThrow(/apps\/desktop/);
    expect(() => checkVersions({ tag: "v0.3.0", desktopVersion: "0.3.0", rootVersion: undefined })).toThrow(/root/);
  });

  it("keeps the root and desktop versions together, so a tag can match both", () => {
    const desktop = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version;
    const root = JSON.parse(readFileSync(join(appDir, "..", "..", "package.json"), "utf8")).version;
    expect(root).toBe(desktop);
  });
});

describe("licence", () => {
  const declared = { license: "MIT", copyright: "Copyright 2026 Yusuf" };

  it("refuses a missing, different or mismatched LICENSE", () => {
    expect(() => checkLicence(undefined, declared)).toThrow(/missing/);
    expect(() => checkLicence("Apache License\nVersion 2.0\n", declared)).toThrow(/MIT License/);
    expect(() => checkLicence("MIT License\n\nCopyright 2026 Someone\n", declared)).toThrow(/copyright/);
    expect(() => checkLicence("MIT License\r\n\r\nCopyright 2026 Yusuf\r\n", declared)).not.toThrow();
    expect(() => checkLicence("MIT License\n\nCopyright 2026 Yusuf\n", { license: "Apache-2.0", copyright: "x" })).toThrow(/only MIT/);
  });

  it("matches the repository's LICENSE to what the packages declare", () => {
    const text = readFileSync(join(appDir, "..", "..", "LICENSE"), "utf8");
    expect((config.extraMetadata as { license: string }).license).toBe(LICENCE.license);
    expect(config.copyright as unknown).toBe(LICENCE.copyright);
    expect(() => checkLicence(text)).not.toThrow();
  });
});

describe("release assets", () => {
  it("lists the files the website matches, checksums last", () => {
    expect(releaseAssets("0.2.0")).toEqual([
      "Crewyard-Setup-0.2.0-x64.exe",
      "Crewyard-0.2.0-arm64.dmg",
      "Crewyard-0.2.0-arm64-mac.zip",
      "Crewyard-0.2.0-x64.dmg",
      "Crewyard-0.2.0-x64-mac.zip",
      "Crewyard-0.2.0-x86_64.AppImage",
      "crewyard_0.2.0_amd64.deb",
      CHECKSUMS,
    ]);
  });

  it("is what electron-builder names each build's targets", () => {
    for (const b of BUILDS) {
      expect(b.targets.map((t) => artifactFor(b.platform, t, b.arch, "1.2.3-beta.4")), b.id).toEqual(b.files("1.2.3-beta.4"));
    }
  });

  it("finds a build by its job id", () => {
    expect(buildById("linux-x64").targets).toEqual(["AppImage", "deb"]);
    expect(() => buildById("linux-arm64")).toThrow(/unknown build/);
  });
});

describe("electron-builder config", () => {
  it("passes electron-builder's own schema check", async () => {
    await expect(validateConfiguration(config, new DebugLogger(false))).resolves.toBeUndefined();
  });

  it("takes its artifact names from release-assets", () => {
    expect(config.nsis!.artifactName).toBe(ARTIFACT_NAMES.nsis);
    expect(config.dmg!.artifactName).toBe(ARTIFACT_NAMES.dmg);
    expect(config.mac!.artifactName).toBe(ARTIFACT_NAMES.macZip);
    expect(config.appImage!.artifactName).toBe(ARTIFACT_NAMES.appImage);
    expect(config.deb!.artifactName).toBe(ARTIFACT_NAMES.deb);
  });

  it("ad-hoc signs macOS without hardened runtime and gives deb its maintainer and homepage", () => {
    expect(config.mac).toMatchObject({ identity: "-", hardenedRuntime: false, notarize: false, icon: "build/icon.icns", minimumSystemVersion: "13.0" });
    // electron-builder takes the exe's CompanyName from author.name, so a string author leaves Electron's own.
    expect(config.extraMetadata).toMatchObject({ author: { name: "Yusuf" } });
    expect(config.linux).toMatchObject({ maintainer: "Yusuf <yusufky63@users.noreply.github.com>", category: "Development", icon: "build/icons" });
    expect(config.extraMetadata).toMatchObject({ homepage: "https://github.com/yusufky63/crewyard", desktopName: "crewyard.desktop" });
  });

  it("copies the installed Electron only when it is the one the target needs", () => {
    expect(config.electronDist({ platformName: process.platform, arch: process.arch })).toBe("node_modules/electron/dist");
    const other = process.arch === "arm64" ? "x64" : "arm64";
    expect(config.electronDist({ platformName: process.platform, arch: other })).toBeNull();
    expect(config.electronDist({ platformName: process.platform === "linux" ? "darwin" : "linux", arch: process.arch })).toBeNull();
  });
});
