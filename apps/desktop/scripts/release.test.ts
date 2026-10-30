import { describe, expect, it } from "vitest";
import { releaseOptions } from "./release.cjs";

const ROOT = "D65AF811E3F5ACF4303C5CC1D5E10FCDFC1DD67E";

describe("releaseOptions", () => {
  it("leaves a build without settings unsigned and without a feed, as before", () => {
    const r = releaseOptions({});
    expect(r).toMatchObject({ sign: false, forceCodeSigning: false, publish: null, metadata: { crewyardRelease: { signed: false, testRoot: null } } });
    // A certificate that happens to be in the environment is not used, so signtool never sees its password.
    expect(r.win).toEqual({ signExecutable: false, verifyUpdateCodeSignature: false });
  });

  it("signs through our hook with sha256 and dlls when CREWYARD_SIGN=1", () => {
    const r = releaseOptions({ CREWYARD_SIGN: "1", WIN_CSC_LINK: "C:\\certs\\crewyard.pfx", WIN_CSC_KEY_PASSWORD: "x", CREWYARD_SIGN_PUBLISHER: "CN=Crewyard, O=Crewyard" });
    expect(r.forceCodeSigning).toBe(true);
    expect(r.win).toMatchObject({ signExts: [".dll"], signtoolOptions: { signingHashAlgorithms: ["sha256"], publisherName: ["CN=Crewyard, O=Crewyard"] } });
    expect(typeof (r.win as { signtoolOptions: { sign: unknown } }).signtoolOptions.sign).toBe("function");
    expect(JSON.stringify(r)).not.toContain('"x"');
  });

  it("takes a certificate from the Windows store by thumbprint", () => {
    const r = releaseOptions({ CREWYARD_SIGN: "1", CREWYARD_SIGN_CERT_SHA1: ROOT.toLowerCase() });
    expect(r.win).toMatchObject({ signtoolOptions: { certificateSha1: ROOT } });
  });

  it("refuses to sign without a certificate", () => {
    expect(() => releaseOptions({ CREWYARD_SIGN: "1" })).toThrow(/needs a certificate/);
    expect(() => releaseOptions({ CREWYARD_SIGN: "1", CREWYARD_SIGN_CERT_SHA1: "abc" })).toThrow(/thumbprint/);
  });

  it("writes a generic feed, and only a signed build may use one on the network", () => {
    expect(releaseOptions({ CREWYARD_SIGN: "1", WIN_CSC_LINK: "a.pfx", CREWYARD_UPDATE_URL: "https://updates.example.com/win/" }).publish).toEqual([{ provider: "generic", url: "https://updates.example.com/win" }]);
    expect(() => releaseOptions({ CREWYARD_UPDATE_URL: "https://updates.example.com/win" })).toThrow(/signed build/);
    expect(() => releaseOptions({ CREWYARD_UPDATE_URL: "http://updates.example.com/win" })).toThrow(/https/);
    expect(() => releaseOptions({ CREWYARD_UPDATE_URL: "https://u:p@updates.example.com" })).toThrow(/credentials/);
    // The local update test: unsigned is allowed on loopback.
    expect(releaseOptions({ CREWYARD_UPDATE_URL: "http://127.0.0.1:8123" }).publish).toEqual([{ provider: "generic", url: "http://127.0.0.1:8123" }]);
  });

  it("allows a test root only for a signed build with a loopback feed", () => {
    const local = { CREWYARD_SIGN: "1", WIN_CSC_LINK: "a.pfx", CREWYARD_UPDATE_URL: "http://127.0.0.1:8123", CREWYARD_UPDATE_TEST_ROOT: ROOT };
    expect(releaseOptions(local).metadata).toEqual({ crewyardRelease: { signed: true, testRoot: ROOT } });
    expect(() => releaseOptions({ ...local, CREWYARD_UPDATE_URL: "https://updates.example.com" })).toThrow(/loopback/);
    expect(() => releaseOptions({ ...local, CREWYARD_SIGN: undefined })).toThrow(/signed build/);
    expect(() => releaseOptions({ ...local, CREWYARD_UPDATE_TEST_ROOT: "nope" })).toThrow(/thumbprint/);
  });
});
