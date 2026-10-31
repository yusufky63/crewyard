// Which download to put first for a visitor. Runs in the browser after the page loads, so pages stay
// static and cacheable; without JavaScript the page lists every platform instead.

export type VisitorOs = "windows" | "macos" | "linux" | "android" | "ios" | "unknown";
export type VisitorArch = "x64" | "arm64" | "unknown";

export interface Visitor {
  os: VisitorOs;
  arch: VisitorArch;
}

/** The parts of navigator.userAgentData that matter here (Chromium only; Safari and Firefox lack it). */
export interface UaHints {
  platform?: string;
  architecture?: string;
  bitness?: string;
}

function archFromHints(h: UaHints | undefined): VisitorArch {
  if (!h?.architecture) return "unknown";
  const a = h.architecture.toLowerCase();
  if (a === "arm" && h.bitness !== "32") return "arm64";
  if (a === "x86" && h.bitness !== "32") return "x64";
  return "unknown";
}

/**
 * Order matters: Android user agents also say Linux, and iOS ones say "like Mac OS X". iPadOS Safari
 * sends a desktop Mac user agent, so a Mac with touch points is taken for an iPad.
 *
 * Architecture: every Mac browser says "Intel Mac OS X", Apple silicon included, and Windows
 * browsers say x64 on ARM too. Only Chromium's high-entropy hints tell the truth, so without them
 * a Mac stays "unknown" and the page offers both Mac builds.
 */
export function detectVisitor(userAgent: string, hints?: UaHints, maxTouchPoints = 0): Visitor {
  const ua = userAgent.toLowerCase();
  const platform = hints?.platform?.toLowerCase() ?? "";
  const hinted = archFromHints(hints);

  if (/android/.test(ua) || platform === "android") return { os: "android", arch: "unknown" };
  if (/iphone|ipad|ipod/.test(ua) || platform === "ios") return { os: "ios", arch: "unknown" };
  if (/macintosh|mac os x/.test(ua) && maxTouchPoints > 1) return { os: "ios", arch: "unknown" };
  if (/windows|win32|win64/.test(ua) || platform === "windows") return { os: "windows", arch: hinted === "unknown" ? "x64" : hinted };
  if (/macintosh|mac os x/.test(ua) || platform === "macos") return { os: "macos", arch: hinted };
  if (/cros/.test(ua) || platform === "chrome os" || platform === "chromeos") return { os: "linux", arch: hinted };
  if (/linux|x11/.test(ua) || platform === "linux") {
    if (hinted !== "unknown") return { os: "linux", arch: hinted };
    if (/aarch64|arm64/.test(ua)) return { os: "linux", arch: "arm64" };
    if (/x86_64|amd64|x64/.test(ua)) return { os: "linux", arch: "x64" };
    return { os: "linux", arch: "unknown" };
  }
  return { os: "unknown", arch: "unknown" };
}
