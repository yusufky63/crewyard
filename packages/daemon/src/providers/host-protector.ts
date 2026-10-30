import type { HostMethod, HostRequest, HostResponse } from "@crewyard/core";
import type { Protector } from "./dpapi.ts";

// API keys on Linux and macOS (docs/adr/0010-linux-macos-groundwork.md). Electron's safeStorage
// keeps its key in the macOS Keychain or the Linux Secret Service / KWallet, but it exists only in
// the main process, so the daemon asks main to encrypt and decrypt over its parent port. Keys still
// leave the daemon only as child environment variables; main never stores, logs or forwards them.
//
// Each blob starts with a 4-byte mark, so a key file written by another protector (a DPAPI blob
// copied over from Windows) is refused with a clear message instead of failing inside Chromium.

export const SAFE_STORAGE_MARK = Buffer.from("CYS1", "ascii");

/** Matches host.response messages to the requests the daemon posted. */
export class HostClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(data: string): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> }>();

  private readonly post: (msg: HostRequest) => void;
  private readonly timeoutMs: number;

  // Plain fields, not parameter properties, like ProbeCache: live scripts strip types only.
  constructor(post: (msg: HostRequest) => void, timeoutMs = 60_000) {
    this.post = post;
    this.timeoutMs = timeoutMs;
  }

  /**
   * The timeout is long: the first use after login can wait on a Keychain or keyring prompt the
   * user has to answer.
   */
  request(method: HostMethod, data: string): Promise<string> {
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The system keychain did not answer in time"));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.post({ kind: "host.request", id, method, data });
    });
  }

  settle(msg: HostResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(msg.error));
  }
}

export function hostProtector(host: Pick<HostClient, "request">): Protector {
  return {
    protect: async (plain) => Buffer.concat([SAFE_STORAGE_MARK, Buffer.from(await host.request("secret.protect", plain.toString("base64")), "base64")]),
    unprotect: async (blob) => {
      if (blob.length <= SAFE_STORAGE_MARK.length || !blob.subarray(0, SAFE_STORAGE_MARK.length).equals(SAFE_STORAGE_MARK)) {
        throw new Error("This key was not stored with this system's keychain; add it again");
      }
      return Buffer.from(await host.request("secret.unprotect", blob.subarray(SAFE_STORAGE_MARK.length).toString("base64")), "base64");
    },
  };
}
