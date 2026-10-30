// Release options for electron-builder, read from the environment at build time
// (docs/adr/0011-signing-and-auto-update.md). This file holds no secret: certificates and passwords
// stay in environment variables, which it only names.
//
//   CREWYARD_SIGN=1               sign the app's exe and dlls, the installer and its uninstaller, or fail the build
//   WIN_CSC_LINK                  the certificate: path to a .pfx (or its base64)
//   WIN_CSC_KEY_PASSWORD          its password; it reaches PowerShell through the environment only (sign-windows.cjs)
//   CREWYARD_SIGN_CERT_SHA1       or a certificate in the Windows store, by thumbprint (EV token, HSM)
//   CREWYARD_SIGN_PUBLISHER       who updates must be signed by, best as the full subject DN; default: the certificate's CN
//   CREWYARD_SIGN_TIMESTAMP_URL   timestamp server, default DigiCert's; "none" leaves the signature without one
//   CREWYARD_UPDATE_URL           update feed (electron-updater's generic provider): https, or http on loopback for a local test
//   CREWYARD_UPDATE_TEST_ROOT     local tests only: SHA-1 thumbprint of a self-signed test certificate that update checks
//                                 may accept although Windows does not trust it; needs a loopback feed

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** https anywhere, or plain http only to this machine (the local update test). */
function feedUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`CREWYARD_UPDATE_URL is not a URL: ${raw}`);
  }
  if (url.username || url.password) throw new Error("CREWYARD_UPDATE_URL must not carry credentials");
  if (url.search || url.hash) throw new Error("CREWYARD_UPDATE_URL must not carry a query or fragment");
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("CREWYARD_UPDATE_URL must be https (plain http is accepted only on 127.0.0.1 or localhost, for a local test)");
  }
  return { url: url.href.replace(/\/$/, ""), loopback };
}

/** @param {Record<string, string | undefined>} env */
function releaseOptions(env) {
  const sign = env.CREWYARD_SIGN === "1";
  const storeSha1 = env.CREWYARD_SIGN_CERT_SHA1?.replace(/\s/g, "").toUpperCase() || null;
  if (storeSha1 && !/^[0-9A-F]{40}$/.test(storeSha1)) throw new Error("CREWYARD_SIGN_CERT_SHA1 must be a 40-digit SHA-1 thumbprint");
  if (sign && !storeSha1 && !env.WIN_CSC_LINK && !env.CSC_LINK) {
    throw new Error("CREWYARD_SIGN=1 needs a certificate: WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD, or CREWYARD_SIGN_CERT_SHA1");
  }

  const feed = env.CREWYARD_UPDATE_URL ? feedUrl(env.CREWYARD_UPDATE_URL) : null;
  // An installed app trusts its feed with what it runs next, so only a signed build may point at a real one.
  if (feed && !feed.loopback && !sign) throw new Error("an update feed on the network needs a signed build: set CREWYARD_SIGN=1");

  const testRoot = env.CREWYARD_UPDATE_TEST_ROOT?.replace(/\s/g, "").toUpperCase() || null;
  if (testRoot) {
    if (!/^[0-9A-F]{40}$/.test(testRoot)) throw new Error("CREWYARD_UPDATE_TEST_ROOT must be a 40-digit SHA-1 thumbprint");
    if (!feed?.loopback) throw new Error("CREWYARD_UPDATE_TEST_ROOT is for local tests and needs a loopback CREWYARD_UPDATE_URL");
    if (!sign) throw new Error("CREWYARD_UPDATE_TEST_ROOT needs a signed build (CREWYARD_SIGN=1)");
  }

  const timestamp = env.CREWYARD_SIGN_TIMESTAMP_URL ?? "http://timestamp.digicert.com";
  const win = sign
    ? {
        signtoolOptions: {
          // electron-builder's own signtool call would put the PFX password on a command line.
          sign: require("./sign-windows.cjs").withOptions({ timestamp: timestamp === "none" ? null : timestamp }),
          signingHashAlgorithms: ["sha256"],
          ...(storeSha1 ? { certificateSha1: storeSha1 } : {}),
          ...(env.CREWYARD_SIGN_PUBLISHER ? { publisherName: [env.CREWYARD_SIGN_PUBLISHER] } : {}),
        },
        // Smart App Control checks every binary that loads, not only the exe (PLAN.md §16).
        signExts: [".dll"],
      }
    : {
        // Unsigned stays unsigned even when a certificate happens to be in the environment, and its
        // app-update.yml names no publisher, so a signed build is never mistaken for this one.
        signExecutable: false,
        verifyUpdateCodeSignature: false,
      };

  return {
    sign,
    forceCodeSigning: sign,
    win,
    publish: feed ? [{ provider: "generic", url: feed.url }] : null,
    // Read by the main process (src/main/updater/feed.ts releaseInfo) for updates and for the remote
    // debugging check (src/main/debug-switches.ts). It lives inside the asar, which the integrity fuse
    // protects, unlike app-update.yml next to it.
    metadata: { crewyardRelease: { signed: sign, testRoot } },
  };
}

module.exports = { releaseOptions, feedUrl };
