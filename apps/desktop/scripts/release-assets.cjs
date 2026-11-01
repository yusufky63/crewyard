// The files a Crewyard release publishes, in one place (docs/release.md):
//   - electron-builder.config.cjs names its artifacts with ARTIFACT_NAMES;
//   - the release workflow (.github/workflows/release.yml, through release-check.mjs) checks every
//     build against BUILDS and publishes exactly releaseAssets(version);
//   - the website finds each download by these names, so a change here is a change to its contract.
//
// electron-builder writes ${arch} per format (builder-util getArtifactArchName): x86_64 for AppImage,
// amd64 for deb, and its own x64 / arm64 everywhere else. BUILDS spells the results out.

const ARTIFACT_NAMES = {
  nsis: "Crewyard-Setup-${version}-${arch}.${ext}",
  dmg: "Crewyard-${version}-${arch}.${ext}",
  // The mac zip takes mac.artifactName; "-mac" keeps it apart from any other platform's zip.
  macZip: "Crewyard-${version}-${arch}-mac.${ext}",
  appImage: "Crewyard-${version}-${arch}.${ext}",
  deb: "crewyard_${version}_${arch}.${ext}",
};

/**
 * One entry per release build job: the electron-builder targets it runs, where electron-builder
 * leaves the unpacked app, and the files it must produce.
 */
const BUILDS = [
  {
    id: "windows-x64",
    platform: "win",
    arch: "x64",
    targets: ["nsis"],
    unpacked: "win-unpacked",
    files: (v) => [`Crewyard-Setup-${v}-x64.exe`],
  },
  {
    id: "macos-arm64",
    platform: "mac",
    arch: "arm64",
    targets: ["dmg", "zip"],
    unpacked: "mac-arm64",
    files: (v) => [`Crewyard-${v}-arm64.dmg`, `Crewyard-${v}-arm64-mac.zip`],
  },
  {
    id: "macos-x64",
    platform: "mac",
    arch: "x64",
    targets: ["dmg", "zip"],
    // x64 is electron-builder's default arch, so its folder has no suffix.
    unpacked: "mac",
    files: (v) => [`Crewyard-${v}-x64.dmg`, `Crewyard-${v}-x64-mac.zip`],
  },
  {
    id: "linux-x64",
    platform: "linux",
    arch: "x64",
    targets: ["AppImage", "deb"],
    unpacked: "linux-unpacked",
    files: (v) => [`Crewyard-${v}-x86_64.AppImage`, `crewyard_${v}_amd64.deb`],
  },
];

const CHECKSUMS = "SHA256SUMS.txt";

// What the packages say about their licence (electron-builder.config.cjs copyright and
// extraMetadata.license, which also reaches the deb control file). Decided 2026-10-31 (PLAN.md §17).
const LICENCE = { license: "MIT", copyright: "Copyright (c) 2026 Yusuf" };

// Semantic version with an optional pre-release part; nothing else may reach a shell or a file name.
const TAG = /^v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)$/;

/**
 * A release tag: v<major>.<minor>.<patch>[-<pre>]. Only a version with a pre-release part is
 * published as a GitHub pre-release; plain versions, 0.x included, are normal releases (the owner
 * asked for v0.2.0 to be the latest release on 2026-11-01).
 * @param {string} tag
 */
function parseTag(tag) {
  const m = TAG.exec(tag);
  if (!m) throw new Error(`not a release tag: ${JSON.stringify(tag)} (expected v<major>.<minor>.<patch>, e.g. v0.2.0)`);
  return { version: m[1], prerelease: m[5] !== undefined };
}

/**
 * The tag must name the version both package.json files carry, so the file names, the app's own
 * version and the release always agree.
 * @param {{ tag: string, desktopVersion: string, rootVersion: string | undefined }} input
 */
function checkVersions({ tag, desktopVersion, rootVersion }) {
  const parsed = parseTag(tag);
  if (desktopVersion !== parsed.version) throw new Error(`${tag} does not match apps/desktop/package.json version ${desktopVersion}`);
  if (rootVersion !== parsed.version) throw new Error(`${tag} does not match the root package.json version ${rootVersion ?? "(none)"}`);
  return parsed;
}

/**
 * The packages declare LICENCE. A tag must not ship that claim while the repository's LICENSE says
 * something else, or before it exists.
 * @param {string | undefined} text the repository's LICENSE file, undefined when it is missing
 * @param {{ license: string, copyright: string }} declared
 */
function checkLicence(text, { license, copyright } = LICENCE) {
  if (license !== "MIT") throw new Error(`the packages declare ${license}; only MIT is checked here`);
  if (text === undefined) throw new Error("LICENSE is missing at the repository root, but the packages declare MIT");
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "MIT License") throw new Error(`LICENSE does not start with "MIT License": ${JSON.stringify(lines[0])}`);
  if (!lines.includes(copyright)) throw new Error(`LICENSE does not carry the packages' copyright line "${copyright}"`);
}

/** @param {string} id */
function buildById(id) {
  const build = BUILDS.find((b) => b.id === id);
  if (!build) throw new Error(`unknown build ${JSON.stringify(id)}; known: ${BUILDS.map((b) => b.id).join(", ")}`);
  return build;
}

/** Every file a published release carries, checksums last. @param {string} version */
function releaseAssets(version) {
  return [...BUILDS.flatMap((b) => b.files(version)), CHECKSUMS];
}

module.exports = { ARTIFACT_NAMES, BUILDS, CHECKSUMS, LICENCE, parseTag, checkVersions, checkLicence, buildById, releaseAssets };
