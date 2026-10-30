import { describe, expect, it } from "vitest";
import { checkFeedUrl, decideFeed, parseUpdateYml, releaseInfo } from "./feed.ts";

const ROOT = "D65AF811E3F5ACF4303C5CC1D5E10FCDFC1DD67E";
const installed = { platform: "win32", packaged: true, installed: true };
const signed = { signed: true, testRoot: null };

// The shape electron-builder 26 writes for a generic feed of a signed build.
const YML = `provider: generic
url: https://updates.example.com/win
publisherName:
  - CN=Crewyard, O=Crewyard, C=TR
updaterCacheDirName: crewyard-updater
`;

describe("parseUpdateYml", () => {
  it("reads scalars and lists the way electron-builder writes them", () => {
    expect(parseUpdateYml(YML)).toEqual({ provider: "generic", url: "https://updates.example.com/win", publisherName: ["CN=Crewyard, O=Crewyard, C=TR"], updaterCacheDirName: "crewyard-updater" });
  });

  it("unquotes quoted values and a bare publisher name", () => {
    expect(parseUpdateYml("url: 'http://127.0.0.1:8123'\r\npublisherName: \"Crewyard\"\r\n")).toEqual({ url: "http://127.0.0.1:8123", publisherName: "Crewyard" });
    expect(parseUpdateYml("publisherName:\n  - 'CN=\"A, B\", O=X'\n")).toEqual({ publisherName: ['CN="A, B", O=X'] });
  });
});

describe("checkFeedUrl", () => {
  it("accepts https anywhere and http only on loopback", () => {
    expect(checkFeedUrl("https://updates.example.com/win/")).toEqual({ url: "https://updates.example.com/win", loopback: false });
    expect(checkFeedUrl("http://127.0.0.1:8123")).toEqual({ url: "http://127.0.0.1:8123", loopback: true });
    expect(checkFeedUrl("http://localhost:8123/feed")).toEqual({ url: "http://localhost:8123/feed", loopback: true });
    expect(checkFeedUrl("http://updates.example.com")).toBeNull();
    expect(checkFeedUrl("file:///C:/feed")).toBeNull();
  });

  it("refuses credentials, queries and garbage", () => {
    expect(checkFeedUrl("https://user:pw@updates.example.com")).toBeNull();
    expect(checkFeedUrl("https://updates.example.com/?token=x")).toBeNull();
    expect(checkFeedUrl("not a url")).toBeNull();
  });
});

describe("releaseInfo", () => {
  it("reads the block scripts/release.cjs bakes into package.json", () => {
    expect(releaseInfo({ crewyardRelease: { signed: true, testRoot: ROOT } })).toEqual({ signed: true, testRoot: ROOT });
  });

  it("treats anything else as an unsigned build without a test root", () => {
    expect(releaseInfo(null)).toEqual({ signed: false, testRoot: null });
    expect(releaseInfo({ crewyardRelease: { signed: "yes", testRoot: "abc" } })).toEqual({ signed: false, testRoot: null });
  });
});

describe("decideFeed", () => {
  it("turns updates on for an installed, signed build with a publisher", () => {
    expect(decideFeed(installed, signed, YML)).toEqual({ ok: true, feed: { url: "https://updates.example.com/win", loopback: false, publisherNames: ["CN=Crewyard, O=Crewyard, C=TR"] } });
  });

  it("says why it is off", () => {
    expect(decideFeed({ ...installed, packaged: false }, signed, YML)).toMatchObject({ ok: false, off: "development" });
    expect(decideFeed({ ...installed, platform: "linux" }, signed, YML)).toMatchObject({ ok: false, off: "platform" });
    expect(decideFeed(installed, signed, null)).toMatchObject({ ok: false, off: "no_feed" });
    expect(decideFeed({ ...installed, installed: false }, signed, YML)).toMatchObject({ ok: false, off: "not_installed" });
  });

  it("never lets a signed build fetch updates it could not check", () => {
    const noPublisher = YML.replace(/publisherName:\n {2}- .*\n/, "");
    expect(decideFeed(installed, signed, noPublisher)).toMatchObject({ ok: false, off: "invalid" });
  });

  it("keeps unsigned builds and test roots on loopback feeds", () => {
    expect(decideFeed(installed, { signed: false, testRoot: null }, YML)).toMatchObject({ ok: false, off: "invalid" });
    expect(decideFeed(installed, { signed: true, testRoot: ROOT }, YML)).toMatchObject({ ok: false, off: "invalid" });
    const local = "provider: generic\nurl: http://127.0.0.1:8123\n";
    expect(decideFeed(installed, { signed: false, testRoot: null }, local)).toEqual({ ok: true, feed: { url: "http://127.0.0.1:8123", loopback: true, publisherNames: [] } });
  });

  it("refuses feeds that are not https or a generic provider", () => {
    expect(decideFeed(installed, signed, YML.replace("https://", "http://"))).toMatchObject({ ok: false, off: "invalid" });
    expect(decideFeed(installed, signed, YML.replace("provider: generic", "provider: github"))).toMatchObject({ ok: false, off: "invalid" });
  });
});
