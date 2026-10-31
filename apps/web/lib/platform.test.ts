import { describe, expect, it } from "vitest";
import { detectVisitor } from "./platform.ts";

const UA = {
  win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  linuxArmFirefox: "Mozilla/5.0 (X11; Linux aarch64; rv:140.0) Gecko/20100101 Firefox/140.0",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
  cros: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

describe("detectVisitor", () => {
  it("takes Windows for x64 unless the hints say ARM", () => {
    expect(detectVisitor(UA.win)).toEqual({ os: "windows", arch: "x64" });
    expect(detectVisitor(UA.win, { platform: "Windows", architecture: "arm", bitness: "64" })).toEqual({ os: "windows", arch: "arm64" });
  });

  it("does not guess a Mac's chip from the user agent, which always says Intel", () => {
    expect(detectVisitor(UA.macSafari)).toEqual({ os: "macos", arch: "unknown" });
    expect(detectVisitor(UA.macChrome, { platform: "macOS", architecture: "arm", bitness: "64" })).toEqual({ os: "macos", arch: "arm64" });
    expect(detectVisitor(UA.macChrome, { platform: "macOS", architecture: "x86", bitness: "64" })).toEqual({ os: "macos", arch: "x64" });
  });

  it("reads Linux architecture from the user agent or the hints", () => {
    expect(detectVisitor(UA.linux)).toEqual({ os: "linux", arch: "x64" });
    expect(detectVisitor(UA.linuxArmFirefox)).toEqual({ os: "linux", arch: "arm64" });
    expect(detectVisitor(UA.cros, { platform: "Chrome OS" }).os).toBe("linux");
  });

  it("tells phones and an iPad posing as a Mac apart from desktops", () => {
    expect(detectVisitor(UA.android).os).toBe("android");
    expect(detectVisitor(UA.iphone).os).toBe("ios");
    expect(detectVisitor(UA.macSafari, undefined, 5).os).toBe("ios");
  });

  it("gives up on an unknown agent instead of guessing", () => {
    expect(detectVisitor("curl/8.9")).toEqual({ os: "unknown", arch: "unknown" });
    expect(detectVisitor("")).toEqual({ os: "unknown", arch: "unknown" });
  });
});
