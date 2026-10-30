// Stands in for the `sax` package in the main bundle (electron.vite.config.ts aliases it here).
// builder-util-runtime needs sax for one thing: the XML of GitHub's release feed. Crewyard's feed is
// electron-updater's generic provider, which is YAML, so sax (BlueOak-1.0.0, outside the licences
// AGENTS.md allows) does not ship. Should anything try to parse XML, it fails loudly instead.
// See docs/adr/0011-signing-and-auto-update.md.

export function parser(): never {
  throw new Error("XML update feeds are not supported by this build (docs/adr/0011-signing-and-auto-update.md)");
}
