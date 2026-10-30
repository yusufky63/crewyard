import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostRequest } from "@crewyard/core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { defaultProtector, dpapi, unsupportedProtector, useHostProtector } from "./dpapi.ts";
import { HostClient, hostProtector, SAFE_STORAGE_MARK } from "./host-protector.ts";
import { SecretStore } from "./secrets.ts";

// The Linux and macOS key path: the daemon asks the main process's safeStorage through its parent
// port. Here a fake main answers, which XORs instead of encrypting.

const root = mkdtempSync(join(tmpdir(), "crewyard host secrets "));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => useHostProtector(null));

const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));

/** A main process that answers every request on the next tick, like the parent port does. */
function fakeMain(opts: { fail?: string; silent?: boolean } = {}) {
  const seen: HostRequest[] = [];
  const client: HostClient = new HostClient((msg) => {
    seen.push(msg);
    if (opts.silent) return;
    setImmediate(() => {
      if (opts.fail) return client.settle({ kind: "host.response", id: msg.id, ok: false, error: opts.fail });
      client.settle({ kind: "host.response", id: msg.id, ok: true, data: xor(Buffer.from(msg.data, "base64")).toString("base64") });
    });
  }, 50);
  return { client, seen };
}

describe("host protector", () => {
  it("round-trips a key through the main process, marks the blob and never writes the key in the clear", async () => {
    const main = fakeMain();
    const store = new SecretStore(join(root, "data dir"), hostProtector(main.client));
    await store.set("6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", "sk-live-örnek-1234567890");
    expect(await store.get("6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b")).toBe("sk-live-örnek-1234567890");
    const file = join(root, "data dir", "secrets", readdirSync(join(root, "data dir", "secrets"))[0]!);
    const blob = readFileSync(file);
    expect(blob.subarray(0, 4).equals(SAFE_STORAGE_MARK)).toBe(true);
    expect(blob.toString("latin1")).not.toContain("sk-live");
    expect(main.seen.map((m) => m.method)).toEqual(["secret.protect", "secret.unprotect"]);
  });

  it("refuses a blob another protector wrote, such as a DPAPI file copied from Windows", async () => {
    const main = fakeMain();
    const p = hostProtector(main.client);
    await expect(p.unprotect(Buffer.from([1, 0, 0, 0, 0xd0, 0x8c, 0x9d, 0xdf]))).rejects.toThrow(/not stored with this system's keychain/);
    await expect(p.unprotect(SAFE_STORAGE_MARK)).rejects.toThrow(/not stored/);
    expect(main.seen).toEqual([]);
  });

  it("passes the main process's refusal on, and gives up when main never answers", async () => {
    await expect(hostProtector(fakeMain({ fail: "No system keychain is available, so API keys cannot be stored" }).client).protect(Buffer.from("k"))).rejects.toThrow(/No system keychain/);
    await expect(hostProtector(fakeMain({ silent: true }).client).protect(Buffer.from("k"))).rejects.toThrow(/did not answer in time/);
  });

  it("ignores answers to requests it never sent", () => {
    const main = fakeMain({ silent: true });
    expect(() => main.client.settle({ kind: "host.response", id: 99, ok: true, data: "" })).not.toThrow();
  });
});

describe("defaultProtector per platform", () => {
  it("keeps DPAPI on Windows whatever the host offers", () => {
    useHostProtector(hostProtector(fakeMain().client));
    expect(defaultProtector("win32")).toBe(dpapi);
  });

  it("uses the main process's safeStorage on Linux and macOS, and refuses keys without it", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      useHostProtector(null);
      expect(defaultProtector(platform)).toBe(unsupportedProtector);
      await expect(defaultProtector(platform).protect(Buffer.from("k"))).rejects.toThrow(/system keychain/);
      const host = hostProtector(fakeMain().client);
      useHostProtector(host);
      expect(defaultProtector(platform)).toBe(host);
    }
  });
});
