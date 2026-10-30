import type { HostMethod } from "@crewyard/core";

// The main-process half of API key storage on Linux and macOS (docs/adr/0010-linux-macos-groundwork.md):
// Electron's safeStorage, which the daemon cannot reach from its utility process. It encrypts and
// decrypts what the daemon sends and keeps nothing: no cache, no log, no file. Windows never gets
// here; its daemon calls DPAPI itself (ADR 0002).
//
// The async calls are used because the sync ones are deprecated in Electron 45 and go away in 46.

export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string }>;
  /** Linux only in Electron. */
  getSelectedStorageBackend?(): string;
}

/**
 * Backends that do not protect anything: `basic_text` is Chromium's fallback with a hard-coded
 * password, used when no Secret Service or KWallet answered; `unknown` means safeStorage was asked
 * before the app was ready. Keys are refused rather than written with either.
 */
const WEAK_BACKENDS = new Set(["basic_text", "unknown"]);

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function secretHost(safe: SafeStorageLike, platform: NodeJS.Platform): (method: HostMethod, data: string) => Promise<string> {
  return async (method, data) => {
    if (platform === "win32") throw new Error("Windows keeps keys with DPAPI in the daemon");
    if (typeof data !== "string" || !BASE64.test(data)) throw new Error("Malformed secret request");
    if (!(await safe.isAsyncEncryptionAvailable())) throw new Error("No system keychain is available, so API keys cannot be stored");
    if (platform === "linux") {
      const backend = safe.getSelectedStorageBackend?.() ?? "unknown";
      if (WEAK_BACKENDS.has(backend)) throw new Error("No Secret Service or KWallet answered, so API keys cannot be stored");
    }
    if (method === "secret.protect") return Buffer.from(await safe.encryptStringAsync(data)).toString("base64");
    if (method === "secret.unprotect") {
      const { result } = await safe.decryptStringAsync(Buffer.from(data, "base64"));
      if (!BASE64.test(result)) throw new Error("The stored key could not be read");
      return result;
    }
    throw new Error("Unknown secret request");
  };
}
