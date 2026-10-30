import { describe, expect, it } from "vitest";
import { judgeSignature, matchesPublisher, parseDn, parseReport, verifyInstaller, type SignatureReport } from "./signature.ts";

const ROOT = "D65AF811E3F5ACF4303C5CC1D5E10FCDFC1DD67E";
const SUBJECT = "CN=Crewyard, O=Crewyard, L=Istanbul, C=TR";
const valid: SignatureReport = { status: "Valid", subject: SUBJECT, thumbprint: "AB".repeat(20), rootThumbprint: "CD".repeat(20), chain: [] };
const policy = { publisherNames: ["CN=Crewyard, O=Crewyard, C=TR"], testRoot: null };

describe("parseDn", () => {
  it("splits a subject as Windows prints it, quotes and escapes included", () => {
    expect([...parseDn('CN=DigiCert SHA256 RSA4096 Timestamp Responder 2026 1, O="DigiCert, Inc.", C=US')]).toEqual([
      ["CN", "DigiCert SHA256 RSA4096 Timestamp Responder 2026 1"],
      ["O", "DigiCert, Inc."],
      ["C", "US"],
    ]);
    expect(parseDn('cn=A ""B"", o=X\\, Y').get("O")).toBe("X, Y");
  });
});

describe("matchesPublisher", () => {
  it("needs every attribute a configured DN names", () => {
    expect(matchesPublisher(SUBJECT, ["CN=Crewyard, O=Crewyard, C=TR"])).toBe(true);
    expect(matchesPublisher(SUBJECT, ["CN=Crewyard, O=Someone Else"])).toBe(false);
    expect(matchesPublisher("CN=Crewyard, O=Mallory", ["CN=Crewyard, O=Crewyard"])).toBe(false);
  });

  it("compares a bare name with the CN only, as electron-builder 26 writes it", () => {
    expect(matchesPublisher(SUBJECT, ["Crewyard"])).toBe(true);
    expect(matchesPublisher("CN=Crewyard Tools, O=X", ["Crewyard"])).toBe(false);
    expect(matchesPublisher(SUBJECT, [])).toBe(false);
  });
});

describe("judgeSignature", () => {
  it("accepts a valid signature from the publisher", () => {
    expect(judgeSignature(valid, policy)).toEqual({ ok: true, signer: SUBJECT });
  });

  it("refuses unsigned, tampered, untrusted and foreign installers", () => {
    expect(judgeSignature({ ...valid, status: "NotSigned", subject: null }, policy)).toMatchObject({ ok: false, problem: "not_signed" });
    expect(judgeSignature({ ...valid, status: "HashMismatch" }, policy)).toMatchObject({ ok: false, problem: "tampered" });
    expect(judgeSignature({ ...valid, status: "UnknownError", chain: ["UntrustedRoot"] }, policy)).toMatchObject({ ok: false, problem: "untrusted" });
    expect(judgeSignature({ ...valid, subject: "CN=Mallory" }, policy)).toMatchObject({ ok: false, problem: "wrong_publisher" });
    expect(judgeSignature({ ...valid, status: "NotTrusted" }, policy)).toMatchObject({ ok: false, problem: "untrusted" });
  });

  it("lets a pinned test root stand in for a trusted one, and nothing else", () => {
    const test = { ...policy, testRoot: ROOT };
    const selfSigned: SignatureReport = { ...valid, status: "UnknownError", rootThumbprint: ROOT, chain: ["UntrustedRoot"] };
    expect(judgeSignature(selfSigned, test)).toMatchObject({ ok: true });
    // Another self-signed certificate, a chain with other problems, or a tampered file stay refused.
    expect(judgeSignature({ ...selfSigned, rootThumbprint: "EF".repeat(20) }, test)).toMatchObject({ ok: false, problem: "untrusted" });
    expect(judgeSignature({ ...selfSigned, chain: ["UntrustedRoot", "NotTimeValid"] }, test)).toMatchObject({ ok: false, problem: "untrusted" });
    expect(judgeSignature({ ...selfSigned, chain: [] }, test)).toMatchObject({ ok: false, problem: "untrusted" });
    expect(judgeSignature({ ...selfSigned, status: "HashMismatch" }, test)).toMatchObject({ ok: false, problem: "tampered" });
  });
});

describe("parseReport", () => {
  it("reads PowerShell 5.1's JSON, where a one-element array is a bare string", () => {
    expect(parseReport('{"status":"UnknownError","subject":"CN=X","thumbprint":"A","rootThumbprint":"A","chain":"UntrustedRoot"}\r\n')).toEqual({
      status: "UnknownError",
      subject: "CN=X",
      thumbprint: "A",
      rootThumbprint: "A",
      chain: ["UntrustedRoot"],
    });
    expect(parseReport('noise\n{"status":"NotSigned","subject":null,"thumbprint":null,"rootThumbprint":null,"chain":[]}').status).toBe("NotSigned");
    expect(() => parseReport("")).toThrow();
  });
});

describe("verifyInstaller", () => {
  it("refuses when the check itself fails, instead of letting the update through", async () => {
    const broken = () => Promise.reject(new Error("PowerShell is blocked by policy"));
    expect(await verifyInstaller("C:\\x.exe", policy, broken)).toEqual({ ok: false, problem: "check_failed", detail: "PowerShell is blocked by policy" });
    expect(await verifyInstaller("C:\\x.exe", { ...policy, publisherNames: [] }, () => Promise.resolve(valid))).toMatchObject({ ok: false, problem: "check_failed" });
    expect(await verifyInstaller("C:\\x.exe", policy, () => Promise.resolve(valid))).toMatchObject({ ok: true });
  });
});
