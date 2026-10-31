import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { endpointPath, ensurePrivateDir, restrictSocket, socketDirs, type PrivateDirFs } from "./local-socket.ts";
import { ReportPipe } from "./mcp/pipe.ts";
import { RunTickets } from "./mcp/tickets.ts";

// The Linux and macOS branches run here with the platform passed in. Folder names keep spaces.

const mac = { platform: "darwin" as const, tmp: "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/", uid: 501 };
const linux = { platform: "linux" as const, runtimeDir: "/run/user/1000", tmp: "/tmp", uid: 1000 };

describe("local endpoint path", () => {
  it("keeps the Windows named pipe as it was", () => {
    expect(endpointPath("crewyard-mcp-42-abc", { platform: "win32" })).toBe("\\\\.\\pipe\\crewyard-mcp-42-abc");
  });

  it("uses XDG_RUNTIME_DIR on Linux, then a per-user temp folder", () => {
    expect(socketDirs(linux)).toEqual(["/run/user/1000/crewyard", "/tmp/crewyard-1000"]);
    expect(endpointPath("mcp-42-00ff", linux)).toBe("/run/user/1000/crewyard/mcp-42-00ff.sock");
    // Empty, as when XDG_RUNTIME_DIR is unset: undefined would fall back to this machine's own value.
    expect(socketDirs({ ...linux, runtimeDir: "" })).toEqual(["/tmp/crewyard-1000"]);
    // A relative XDG_RUNTIME_DIR is invalid by the spec and ignored.
    expect(socketDirs({ ...linux, runtimeDir: "run/user/1000" })).toEqual(["/tmp/crewyard-1000"]);
  });

  it("uses the per-user TMPDIR on macOS, never XDG_RUNTIME_DIR", () => {
    expect(socketDirs({ ...mac, runtimeDir: "/run/user/501" })).toEqual(["/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/crewyard-501", "/tmp/crewyard-501"]);
    const path = endpointPath(`mcp-99999-${"0".repeat(16)}`, mac);
    expect(path.startsWith("/var/folders/")).toBe(true);
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(103);
  });

  it("falls back to /tmp when TMPDIR is too long for sun_path, and refuses when nothing fits", () => {
    const deep = { ...mac, tmp: `/Users/someone with a long name/${"x".repeat(70)}/T` };
    expect(endpointPath("mcp-1-ab", deep)).toBe("/tmp/crewyard-501/mcp-1-ab.sock");
    expect(() => endpointPath("x".repeat(120), deep)).toThrow(/limit 103 bytes/);
    // Linux allows 107.
    expect(() => endpointPath("x".repeat(80), linux)).not.toThrow();
  });
});

describe("private socket folder", () => {
  function fakeFs(existing?: { dir?: boolean; link?: boolean; uid?: number; mode?: number }) {
    const calls: string[] = [];
    const fs: PrivateDirFs = {
      mkdir: (p, mode) => {
        calls.push(`mkdir ${p} ${mode.toString(8)}`);
        if (existing) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      },
      lstat: () => ({ isDirectory: () => existing?.dir ?? true, isSymbolicLink: () => existing?.link ?? false, uid: existing?.uid ?? 1000, mode: existing?.mode ?? 0o40700 }),
      chmod: (p, mode) => void calls.push(`chmod ${p} ${mode.toString(8)}`),
    };
    return { fs, calls };
  }
  const sock = "/tmp/crewyard-1000/mcp-1-ab.sock";

  it("creates the folder 0700 and makes the socket 0600", () => {
    const f = fakeFs();
    ensurePrivateDir(sock, linux, f.fs);
    restrictSocket(sock, linux, f.fs);
    expect(f.calls).toEqual(["mkdir /tmp/crewyard-1000 700", `chmod ${sock} 600`]);
  });

  it("tightens our own folder and refuses a symlink, a file or another user's folder", () => {
    const loose = fakeFs({ mode: 0o40755 });
    ensurePrivateDir(sock, linux, loose.fs);
    expect(loose.calls).toContain("chmod /tmp/crewyard-1000 700");
    expect(() => ensurePrivateDir(sock, linux, fakeFs({ link: true }).fs)).toThrow(/not a plain folder/);
    expect(() => ensurePrivateDir(sock, linux, fakeFs({ dir: false }).fs)).toThrow(/not a plain folder/);
    expect(() => ensurePrivateDir(sock, linux, fakeFs({ uid: 0 }).fs)).toThrow(/another user/);
  });

  it("does nothing for a Windows pipe", () => {
    const f = fakeFs();
    ensurePrivateDir("\\\\.\\pipe\\x", { platform: "win32" }, f.fs);
    restrictSocket("\\\\.\\pipe\\x", { platform: "win32" }, f.fs);
    expect(f.calls).toEqual([]);
  });
});

// Real sockets; runs on the Linux CI job and on a Mac.
describe.runIf(process.platform !== "win32")("report socket on this machine", () => {
  const root = mkdtempSync(join(tmpdir(), "cy sock "));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("listens in a 0700 folder with a 0600 socket and removes the file on close", async () => {
    const path = join(root, "private dir", "r.sock");
    const pipe = new ReportPipe({ tickets: new RunTickets(), call: async () => ({ text: "", isError: false }), version: "1" }, path);
    await pipe.listen();
    expect(statSync(join(root, "private dir")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await pipe.close();
    expect(() => statSync(path)).toThrow();
  });
});
