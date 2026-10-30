import { describe, expect, it } from "vitest";
import { secretHost, type SafeStorageLike } from "./secrets.ts";

// safeStorage as Electron gives it on Linux and macOS, faked: "encryption" prefixes and XORs.

function fakeSafe(over: Partial<SafeStorageLike> & { backend?: string } = {}): SafeStorageLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s) => (calls.push("encrypt"), Buffer.concat([Buffer.from("v11"), Buffer.from(s).map((x) => x ^ 7)])),
    decryptStringAsync: async (b) => (calls.push("decrypt"), { result: Buffer.from(b.subarray(3).map((x) => x ^ 7)).toString() }),
    ...("backend" in over ? { getSelectedStorageBackend: () => over.backend! } : {}),
    ...over,
  };
}

const key = Buffer.from("sk-ant-api03-örnek").toString("base64");

describe("secretHost", () => {
  it("encrypts and decrypts what the daemon sends, on macOS and on Linux with a real keyring", async () => {
    for (const [platform, backend] of [["darwin", undefined], ["linux", "gnome_libsecret"], ["linux", "kwallet6"]] as const) {
      const safe = fakeSafe(backend ? { backend } : {});
      const host = secretHost(safe, platform);
      const blob = await host("secret.protect", key);
      expect(blob).not.toBe(key);
      expect(await host("secret.unprotect", blob)).toBe(key);
      expect(safe.calls).toEqual(["encrypt", "decrypt"]);
    }
  });

  it("refuses Chromium's plaintext fallback and a backend chosen before the app was ready", async () => {
    for (const backend of ["basic_text", "unknown"]) {
      const safe = fakeSafe({ backend });
      await expect(secretHost(safe, "linux")("secret.protect", key)).rejects.toThrow(/No Secret Service or KWallet/);
      expect(safe.calls).toEqual([]);
    }
    // A Linux safeStorage that cannot name its backend counts as unknown.
    await expect(secretHost(fakeSafe(), "linux")("secret.protect", key)).rejects.toThrow(/No Secret Service/);
  });

  it("refuses when no keychain is available, on Windows, and for malformed input", async () => {
    await expect(secretHost(fakeSafe({ isAsyncEncryptionAvailable: async () => false }), "darwin")("secret.protect", key)).rejects.toThrow(/No system keychain/);
    await expect(secretHost(fakeSafe(), "win32")("secret.protect", key)).rejects.toThrow(/DPAPI/);
    await expect(secretHost(fakeSafe(), "darwin")("secret.protect", "not base64!")).rejects.toThrow(/Malformed/);
    await expect(secretHost(fakeSafe(), "darwin")("secret.other" as "secret.protect", key)).rejects.toThrow(/Unknown/);
  });
});
