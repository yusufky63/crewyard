import type { UpdateOff } from "../../shared/api.ts";

// What this build may do about updates (docs/adr/0011-signing-and-auto-update.md). Two files decide:
//   - package.json in the asar carries `crewyardRelease` (scripts/release.cjs): whether the build is
//     signed, and a test root for local tests. The asar integrity fuse protects it.
//   - resources\app-update.yml, written by electron-builder when a feed was configured: the feed URL
//     and the publisher a signed build's updates must be signed by.
// They must agree. If they do not, the updater stays off rather than guess.

export interface ReleaseInfo {
  signed: boolean;
  /** SHA-1 of a self-signed test certificate update checks may accept; loopback feeds only. */
  testRoot: string | null;
}

export interface Feed {
  url: string;
  loopback: boolean;
  /** Empty for an unsigned build: its updates are not checked, which only a loopback feed allows. */
  publisherNames: string[];
}

export type FeedDecision = { ok: true; feed: Feed } | { ok: false; off: UpdateOff; detail: string };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The `crewyardRelease` block of the packaged package.json; anything malformed reads as an unsigned build without a test root. */
export function releaseInfo(pkg: unknown): ReleaseInfo {
  const r = (pkg as { crewyardRelease?: { signed?: unknown; testRoot?: unknown } } | null)?.crewyardRelease;
  const root = typeof r?.testRoot === "string" && /^[0-9A-F]{40}$/.test(r.testRoot) ? r.testRoot : null;
  return { signed: r?.signed === true, testRoot: root };
}

/**
 * The flat YAML electron-builder writes into app-update.yml: `key: value` lines and `key:` followed
 * by `  - item` lines. Quoted values are unquoted. Anything nested deeper is ignored.
 */
export function parseUpdateYml(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      (out[listKey] as string[]).push(unquote(item[1] ?? ""));
      continue;
    }
    const kv = raw.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) {
      listKey = null;
      continue;
    }
    const [, key = "", value = ""] = kv;
    if (value === "") {
      out[key] = [];
      listKey = key;
    } else {
      out[key] = unquote(value);
      listKey = null;
    }
  }
  return out;
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return JSON.parse(s) as string;
  return s;
}

/** https anywhere, plain http only to this machine (the local update test), never credentials or a query. */
export function checkFeedUrl(raw: string): { url: string; loopback: boolean } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  return { url: url.href.replace(/\/$/, ""), loopback };
}

export interface Where {
  platform: string;
  packaged: boolean;
  /** NSIS puts its uninstaller next to the exe; an unpacked copy has none and must not replace itself. */
  installed: boolean;
}

export function decideFeed(where: Where, release: ReleaseInfo, yml: string | null): FeedDecision {
  if (!where.packaged) return { ok: false, off: "development", detail: "not packaged" };
  if (where.platform !== "win32") return { ok: false, off: "platform", detail: where.platform };
  if (yml === null) return { ok: false, off: "no_feed", detail: "no app-update.yml" };
  if (!where.installed) return { ok: false, off: "not_installed", detail: "no uninstaller next to the executable" };
  const conf = parseUpdateYml(yml);
  if (conf.provider !== "generic" || typeof conf.url !== "string") return { ok: false, off: "invalid", detail: "the feed is not a generic provider with a url" };
  const url = checkFeedUrl(conf.url);
  if (!url) return { ok: false, off: "invalid", detail: "the feed url is not https (or http on loopback)" };
  const names = typeof conf.publisherName === "string" ? [conf.publisherName] : (conf.publisherName ?? []);
  const publisherNames = names.map((n) => n.trim()).filter(Boolean);
  if (release.signed && publisherNames.length === 0) return { ok: false, off: "invalid", detail: "a signed build without a publisher to check updates against" };
  if (!release.signed && !url.loopback) return { ok: false, off: "invalid", detail: "an unsigned build may only use a loopback feed" };
  if (release.testRoot && !url.loopback) return { ok: false, off: "invalid", detail: "a test root with a feed that is not on loopback" };
  // An unsigned build checks nothing, so it must not carry names that suggest otherwise.
  return { ok: true, feed: { url: url.url, loopback: url.loopback, publisherNames: release.signed ? publisherNames : [] } };
}
