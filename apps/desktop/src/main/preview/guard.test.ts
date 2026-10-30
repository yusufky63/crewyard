import { describe, expect, it } from "vitest";
import { previewVerdict } from "@crewyard/core";
import { guardPreviewContents, guardPreviewSession, type GuardedContents, type GuardedSession, type PreviewBlock } from "./guard.ts";
import { pickerScript, STOP_PICKER } from "./picker.ts";

type Listener = (...args: unknown[]) => void;

/** Records listeners like an EventEmitter and lets a test fire them with a cancellable event. */
class Fake {
  listeners = new Map<string, Listener[]>();
  openHandler: ((d: { url: string }) => { action: string }) | null = null;
  handlers: Record<string, unknown> = {};
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  setWindowOpenHandler(h: (d: { url: string }) => { action: string }) {
    this.openHandler = h;
  }
  setPermissionRequestHandler(h: unknown) {
    this.handlers.request = h;
  }
  setPermissionCheckHandler(h: unknown) {
    this.handlers.check = h;
  }
  setDevicePermissionHandler(h: unknown) {
    this.handlers.device = h;
  }
  setDisplayMediaRequestHandler(h: unknown) {
    this.handlers.display = h;
  }
  /** Fires `event`; returns whether a listener prevented it. */
  fire(event: string, details: Record<string, unknown>, ...args: unknown[]): boolean {
    let prevented = false;
    const e = { ...details, preventDefault: () => (prevented = true) };
    for (const l of this.listeners.get(event) ?? []) l(e, ...args);
    return prevented;
  }
}

function setup(ports = [5173]) {
  const wc = new Fake();
  const blocked: Array<[string, PreviewBlock]> = [];
  guardPreviewContents(wc as unknown as GuardedContents, { verdict: (u) => previewVerdict(u, ports), onBlocked: (u, r) => blocked.push([u, r]) });
  return { wc, blocked };
}

describe("guardPreviewContents", () => {
  it("lets the main frame move within the task's loopback ports and stops anything else", () => {
    const { wc, blocked } = setup();
    expect(wc.fire("will-navigate", { url: "http://localhost:5173/next" })).toBe(false);
    expect(wc.fire("will-navigate", { url: "http://[::1]:5173/" })).toBe(false);
    expect(wc.fire("will-navigate", { url: "https://example.com/" })).toBe(true);
    expect(wc.fire("will-navigate", { url: "http://localhost:3000/" })).toBe(true);
    expect(wc.fire("will-navigate", { url: "file:///C:/Users/me/secret.txt" })).toBe(true);
    expect(blocked).toEqual([
      ["https://example.com/", "host"],
      ["http://localhost:3000/", "port"],
      ["file:///C:/Users/me/secret.txt", "scheme"],
    ]);
  });

  it("cancels a main-frame redirect off loopback or to another port, and lets subframe redirects stay http(s)", () => {
    const { wc, blocked } = setup();
    expect(wc.fire("will-redirect", { url: "http://127.0.0.1:5173/home", isMainFrame: true })).toBe(false);
    expect(wc.fire("will-redirect", { url: "https://login.example.com/", isMainFrame: true })).toBe(true);
    expect(wc.fire("will-redirect", { url: "http://localhost:9229/json", isMainFrame: true })).toBe(true);
    expect(wc.fire("will-redirect", { url: "https://cdn.example.com/widget", isMainFrame: false })).toBe(false);
    expect(blocked.map(([, r]) => r)).toEqual(["host", "port"]);
  });

  it("reads the deprecated positional arguments when the details object has none", () => {
    const { wc } = setup();
    expect(wc.fire("will-redirect", {}, "https://example.com/", false, true)).toBe(true);
    expect(wc.fire("will-navigate", {}, "http://localhost:5173/")).toBe(false);
  });

  it("checks main-frame navigations from will-frame-navigate and keeps subframes to web schemes", () => {
    const { wc, blocked } = setup();
    expect(wc.fire("will-frame-navigate", { url: "https://example.com/", isMainFrame: true })).toBe(true);
    expect(wc.fire("will-frame-navigate", { url: "https://www.youtube.com/embed/x", isMainFrame: false })).toBe(false);
    expect(wc.fire("will-frame-navigate", { url: "about:blank", isMainFrame: false })).toBe(false);
    expect(wc.fire("will-frame-navigate", { url: "file:///C:/Windows/win.ini", isMainFrame: false })).toBe(true);
    expect(wc.fire("will-frame-navigate", { url: "chrome://settings", isMainFrame: false })).toBe(true);
    expect(blocked.map(([, r]) => r)).toEqual(["host", "frame", "frame"]);
  });

  it("denies every new window and reports it", () => {
    const { wc, blocked } = setup();
    expect(wc.openHandler!({ url: "http://localhost:5173/popup" })).toEqual({ action: "deny" });
    expect(wc.openHandler!({ url: "https://example.com/" })).toEqual({ action: "deny" });
    expect(blocked.map(([, r]) => r)).toEqual(["window", "window"]);
  });

  it("ignores beforeunload prompts", () => {
    const { wc } = setup();
    expect(wc.fire("will-prevent-unload", {})).toBe(true);
  });

  it("trusts a certificate error only on an allowed loopback port", () => {
    const { wc } = setup();
    const answers: boolean[] = [];
    wc.fire("certificate-error", {}, "https://localhost:5173/", "net::ERR_CERT_AUTHORITY_INVALID", {}, (t: boolean) => answers.push(t));
    wc.fire("certificate-error", {}, "https://example.com/", "net::ERR_CERT_AUTHORITY_INVALID", {}, (t: boolean) => answers.push(t));
    wc.fire("certificate-error", {}, "https://localhost:8443/", "net::ERR_CERT_AUTHORITY_INVALID", {}, (t: boolean) => answers.push(t));
    expect(answers).toEqual([true, false, false]);
  });

  it("answers a client-certificate request with none", () => {
    const { wc } = setup();
    const answers: unknown[][] = [];
    expect(wc.fire("select-client-certificate", {}, "https://localhost:5173/", [{ subjectName: "me" }], (...a: unknown[]) => answers.push(a))).toBe(true);
    expect(answers).toEqual([[]]);
  });
});

describe("guardPreviewSession", () => {
  it("refuses permissions, devices, screen capture and downloads", () => {
    const ses = new Fake();
    const blocked: Array<[string, PreviewBlock]> = [];
    guardPreviewSession(ses as unknown as GuardedSession, (u, r) => blocked.push([u, r]));
    const granted: boolean[] = [];
    (ses.handlers.request as (c: unknown, p: string, cb: (g: boolean) => void) => void)(null, "media", (g) => granted.push(g));
    (ses.handlers.request as (c: unknown, p: string, cb: (g: boolean) => void) => void)(null, "notifications", (g) => granted.push(g));
    expect(granted).toEqual([false, false]);
    expect((ses.handlers.check as () => boolean)()).toBe(false);
    expect((ses.handlers.device as () => boolean)()).toBe(false);
    const streams: unknown[] = [];
    (ses.handlers.display as (r: unknown, cb: (s: unknown) => void) => void)({}, (s) => streams.push(s));
    expect(streams).toEqual([null]);

    expect(ses.fire("will-download", {}, { getURL: () => "http://localhost:5173/report.zip" })).toBe(true);
    expect(blocked).toEqual([["http://localhost:5173/report.zip", "download"]]);

    const picks: unknown[] = [];
    expect(ses.fire("select-hid-device", {}, {}, (id: unknown) => picks.push(id))).toBe(true);
    expect(ses.fire("select-serial-port", {}, [], null, (id: unknown) => picks.push(id))).toBe(true);
    expect(ses.fire("select-usb-device", {}, {}, (id?: unknown) => picks.push(id))).toBe(true);
    expect(picks).toEqual([null, "", undefined]);
  });
});

describe("pickerScript", () => {
  it("is one expression that parses, with the colour and caps inlined as data", () => {
    const script = pickerScript("#7AA2FF");
    expect(() => new Function(`return ${script};`)).not.toThrow();
    expect(script).toContain('"color":"#7AA2FF"');
    expect(script).toContain('"max":65536');
    expect(() => new Function(STOP_PICKER)).not.toThrow();
  });
});
