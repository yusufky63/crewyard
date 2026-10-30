import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { judgeSignature, readSignature } from "../src/main/updater/signature.ts";
import { judge, withOptions } from "./sign-windows.cjs";

// Signs real files with a throwaway self-signed certificate and reads them back the way the
// updater does. The certificate exists only as a PFX in a temp folder (a path with spaces) and is
// deleted afterwards; nothing goes into a certificate store, which the last test checks.

const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const electronDir = (() => {
  try {
    return dirname(createRequire(join(import.meta.dirname, "..", "package.json"))("electron") as unknown as string);
  } catch {
    return null;
  }
})();
const sample = electronDir ? join(electronDir, "electron_wer.dll") : "";
const microsoftSigned = electronDir ? join(electronDir, "d3dcompiler_47.dll") : "";
const runs = process.platform === "win32" && existsSync(sample);

const MAKE_CERT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$req = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest('CN=Crewyard Sign Test, O=Crewyard Test Only', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$eku = New-Object System.Security.Cryptography.OidCollection
[void]$eku.Add((New-Object System.Security.Cryptography.Oid('1.3.6.1.5.5.7.3.3')))
$req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($eku, $false)))
$cert = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(1))
[System.IO.File]::WriteAllBytes($env:TEST_PFX, $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $env:TEST_PFX_PASSWORD))
$cert.Thumbprint
`;

const ps = (script: string, env: Record<string, string> = {}) =>
  execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, ...env },
    windowsHide: true,
    encoding: "utf8",
  }).trim();

describe("judge (sign-windows.cjs read-back)", () => {
  it("accepts our own signature, valid or self-signed, and nothing else", () => {
    const ours = { kept: false, signer: "A", expected: "A", status: "Valid", selfSigned: false, timestamped: true };
    expect(judge(ours, { timestamp: "http://ts" })).toBeNull();
    expect(judge({ ...ours, status: "UnknownError", selfSigned: true, timestamped: false }, { timestamp: null })).toBeNull();
    expect(judge({ ...ours, status: "UnknownError" }, { timestamp: null })).toMatch(/does not accept/);
    expect(judge({ ...ours, signer: "B" }, { timestamp: null })).toMatch(/not signed by the configured certificate/);
    expect(judge({ ...ours, timestamped: false }, { timestamp: "http://ts" })).toMatch(/no timestamp/);
    expect(judge({ kept: true }, { timestamp: "http://ts" })).toBeNull();
  });
});

describe.runIf(runs)("signing and verifying on Windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "crewyard sign test "));
  const pfx = join(dir, "test cert.pfx");
  const password = randomBytes(18).toString("base64url");
  let thumbprint = "";
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("signs with the PFX through the environment and reads back what the updater accepts and refuses", { timeout: 120_000 }, async () => {
    thumbprint = ps(MAKE_CERT, { TEST_PFX: pfx, TEST_PFX_PASSWORD: password });
    expect(thumbprint).toMatch(/^[0-9A-F]{40}$/);

    const signed = join(dir, "signed copy.dll");
    copyFileSync(sample, signed);
    await withOptions({ timestamp: null })({ path: signed, cscInfo: { file: pfx, password } });

    const subject = "CN=Crewyard Sign Test, O=Crewyard Test Only";
    const policy = { publisherNames: [subject], testRoot: thumbprint };
    const report = await readSignature(signed);
    expect(report).toMatchObject({ status: "UnknownError", thumbprint, rootThumbprint: thumbprint, chain: ["UntrustedRoot"] });
    expect(judgeSignature(report, policy)).toEqual({ ok: true, signer: subject });
    // Without the pinned test root Windows' verdict stands.
    expect(judgeSignature(report, { ...policy, testRoot: null })).toMatchObject({ ok: false, problem: "untrusted" });
    expect(judgeSignature(report, { ...policy, publisherNames: ["CN=Crewyard"] })).toMatchObject({ ok: false, problem: "wrong_publisher" });

    const tampered = join(dir, "tampered copy.dll");
    const bytes = readFileSync(signed);
    bytes[4096] = (bytes[4096] ?? 0) ^ 0xff;
    writeFileSync(tampered, bytes);
    expect(judgeSignature(await readSignature(tampered), policy)).toMatchObject({ ok: false, problem: "tampered" });

    expect(judgeSignature(await readSignature(sample), policy)).toMatchObject({ ok: false, problem: "not_signed" });
  });

  it("keeps a file's own valid signature from another publisher", { timeout: 60_000 }, async () => {
    if (!existsSync(microsoftSigned) || !thumbprint) return;
    const copy = join(dir, "d3dcompiler copy.dll");
    copyFileSync(microsoftSigned, copy);
    const before = await readSignature(copy);
    await withOptions({ timestamp: null })({ path: copy, cscInfo: { file: pfx, password } });
    expect((await readSignature(copy)).thumbprint).toBe(before.thumbprint);
  });

  it("left nothing in the certificate stores", { timeout: 60_000 }, () => {
    if (!thumbprint) return;
    const found = ps("$ProgressPreference = 'SilentlyContinue'; @(Get-ChildItem -Recurse Cert:\\CurrentUser | Where-Object { $_.Thumbprint -eq $env:TEST_THUMB }).Count", { TEST_THUMB: thumbprint });
    expect(found).toBe("0");
  });
});
