import type { Session, WebContents } from "electron";
import type { PreviewRefusal, PreviewVerdict } from "@crewyard/core";

// The fence around the preview page (docs/adr/0013-dev-server-preview.md, security notes). Every
// way the page could leave its loopback origin, open something, ask for a device or save a file is
// refused here. Written against the few members it needs, so the tests drive it with fakes.

export type PreviewBlock = PreviewRefusal | "window" | "download" | "frame";

interface Prevent {
  preventDefault(): void;
}

/** The members of WebContents the guard uses. */
export type GuardedContents = Pick<WebContents, "on" | "setWindowOpenHandler">;

/** The members of Session the guard uses. */
export type GuardedSession = Pick<Session, "on" | "setPermissionRequestHandler" | "setPermissionCheckHandler" | "setDevicePermissionHandler" | "setDisplayMediaRequestHandler">;

export interface GuardOptions {
  /** previewVerdict with the task's ports as they are now. */
  verdict(url: string): PreviewVerdict;
  onBlocked(url: string, reason: PreviewBlock): void;
}

/** Schemes a subframe may navigate to; its page is still the preview's sandboxed process. */
const FRAME_SCHEMES = new Set(["http:", "https:", "about:", "data:", "blob:"]);

function frameScheme(url: string): boolean {
  try {
    return FRAME_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function guardPreviewContents(wc: GuardedContents, opts: GuardOptions): void {
  const main = (e: Prevent, url: string) => {
    const v = opts.verdict(url);
    if (v.ok) return;
    e.preventDefault();
    opts.onBlocked(url, v.reason);
  };
  const frame = (e: Prevent, url: string) => {
    if (frameScheme(url)) return;
    e.preventDefault();
    opts.onBlocked(url, "frame");
  };
  // Links, scripts and form posts in the main frame. Not emitted for our own loadURL, which main
  // checks before calling it.
  wc.on("will-navigate", (e: Prevent & { url?: string }, url?: string) => main(e, e.url ?? url ?? ""));
  // Server redirects: cancelling one cancels the whole navigation, so a 302 off loopback ends there.
  wc.on("will-redirect", (e: Prevent & { url?: string; isMainFrame?: boolean }, url?: string, _inPlace?: boolean, isMainFrame?: boolean) => {
    const target = e.url ?? url ?? "";
    if (e.isMainFrame ?? isMainFrame ?? true) main(e, target);
    else frame(e, target);
  });
  wc.on("will-frame-navigate", (e: Prevent & { url: string; isMainFrame: boolean }) => (e.isMainFrame ? main(e, e.url) : frame(e, e.url)));
  // A beforeunload prompt would hold Unload and task switches hostage.
  wc.on("will-prevent-unload", (e: Prevent) => e.preventDefault());
  // A dev server with a self-signed certificate on an allowed loopback port is trusted; on
  // loopback nobody sits between the app and the server. Everything else keeps Chromium's refusal.
  wc.on("certificate-error", (e: Prevent, url: string, _error: string, _cert: unknown, callback: (trusted: boolean) => void) => {
    e.preventDefault();
    callback(opts.verdict(url).ok);
  });
  // Without this, Electron would answer a client-certificate request with the first certificate in
  // the Windows store. The app-level event documents the certificate as optional: none means the
  // request goes on without one; this event's typing just does not say so.
  wc.on("select-client-certificate", (e: Prevent, _url: string, _list: unknown, callback: (cert: never) => void) => {
    e.preventDefault();
    (callback as () => void)();
  });
  wc.setWindowOpenHandler(({ url }) => {
    opts.onBlocked(url, "window");
    return { action: "deny" };
  });
}

/** Called once for the preview partition: no permission, device, screen capture or download. */
export function guardPreviewSession(ses: GuardedSession, onBlocked: (url: string, reason: PreviewBlock) => void): void {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback(null));
  ses.on("will-download", (e: Prevent, item: { getURL(): string }) => {
    // The item is gone once the download is cancelled, so its address is read first.
    const url = item.getURL();
    e.preventDefault();
    onBlocked(url, "download");
  });
  ses.on("select-hid-device", (e: Prevent, _details: unknown, callback: (id?: string | null) => void) => {
    e.preventDefault();
    callback(null);
  });
  ses.on("select-serial-port", (e: Prevent, _ports: unknown, _contents: unknown, callback: (id: string) => void) => {
    e.preventDefault();
    callback("");
  });
  ses.on("select-usb-device", (e: Prevent, _details: unknown, callback: (id?: string) => void) => {
    e.preventDefault();
    callback();
  });
}
