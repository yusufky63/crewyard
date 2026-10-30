// Local end-to-end test of code signing and auto-update (docs/adr/0011-signing-and-auto-update.md).
// A test harness only: nothing here is part of the app, and nothing is published or uploaded.
//
//   pnpm --filter @crewyard/desktop build
//   node apps/desktop/e2e/update/update-flow.mjs [--shots <folder>] [--keep]
//
// What it does, all under one temp folder (a path with spaces) that is deleted at the end:
//   1. makes two throwaway self-signed code-signing certificates as PFX files (never in a store);
//   2. builds "Crewyard Update Test" 0.1.0 and 0.1.1 signed with the first, and 0.1.1 unsigned.
//      The test identity (appId, name, install folder, profile) is separate from Crewyard's, so a
//      real install and its data are never touched;
//   3. serves update feeds from a server bound to 127.0.0.1 that runs only during this test;
//   4. installs 0.1.0 into the temp folder and drives its window over the DevTools protocol;
//   5. offers it a tampered, a checksum-mismatched, a foreign-signed and an unsigned 0.1.1, each of
//      which must be refused, then the real 0.1.1, which must be downloaded, verified, installed on
//      "Restart to install" and come back as 0.1.1;
//   6. uninstalls and removes everything it created.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const appDir = resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const shotsArg = args.indexOf("--shots");
const shots = shotsArg >= 0 ? resolve(args[shotsArg + 1]) : null;

const NAME = "crewyard-update-test";
const PRODUCT = "Crewyard Update Test";
const APP_ID = "dev.crewyard.updatetest";
const FEED_PORT = 18000 + Math.floor(Math.random() * 1000);
const CDP_PORT = 19000 + Math.floor(Math.random() * 1000);
const FEED = `http://127.0.0.1:${FEED_PORT}`;
const SETUP = (v) => `Crewyard-Setup-${v}-x64.exe`;

const root = mkdtempSync(join(tmpdir(), "crewyard update test "));
const installDir = join(root, "install here");
const log = (...a) => console.log(`[update-flow ${new Date().toISOString().slice(11, 19)}]`, ...a);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
function ps(script, env = {}) {
  const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${script}`, "utf16le").toString("base64");
  return execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    env: { ...process.env, ...env },
    windowsHide: true,
    encoding: "utf8",
    // Expected failures (polling a file the installer is replacing) would otherwise print PowerShell's CLIXML.
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const MAKE_CERT = String.raw`
$ErrorActionPreference = 'Stop'
$rsa = [System.Security.Cryptography.RSA]::Create(3072)
$req = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest($env:T_SUBJECT, $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$eku = New-Object System.Security.Cryptography.OidCollection
[void]$eku.Add((New-Object System.Security.Cryptography.Oid('1.3.6.1.5.5.7.3.3')))
$req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($eku, $false)))
$req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension($false, $false, 0, $true)))
$cert = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(1))
[System.IO.File]::WriteAllBytes($env:T_PFX, $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $env:T_PASSWORD))
$cert.Thumbprint
`;

function makeCert(file, subject) {
  const password = randomBytes(18).toString("base64url");
  const thumbprint = ps(MAKE_CERT, { T_PFX: file, T_SUBJECT: subject, T_PASSWORD: password });
  return { file, subject, password, thumbprint };
}

const signature = (file) =>
  JSON.parse(ps("$s = Get-AuthenticodeSignature -LiteralPath $env:T_FILE; [pscustomobject]@{ status = $s.Status.ToString(); subject = $s.SignerCertificate.Subject; thumbprint = $s.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress", { T_FILE: file }));

const builderCli = join(resolve(createRequire(join(appDir, "package.json")).resolve("electron-builder/package.json"), ".."), "cli.js");

/** One installer, built by the real config with the test identity laid over it. */
function build({ version, cert, testRoot, out }) {
  const config = join(root, `config ${version}${cert ? "" : " unsigned"}.cjs`);
  writeFileSync(
    config,
    `const base = require(${JSON.stringify(join(appDir, "electron-builder.config.cjs"))});
module.exports = { ...base, appId: ${JSON.stringify(APP_ID)}, productName: ${JSON.stringify(PRODUCT)},
  extraMetadata: { ...base.extraMetadata, name: ${JSON.stringify(NAME)}, productName: ${JSON.stringify(PRODUCT)}, version: ${JSON.stringify(version)} },
  directories: { ...base.directories, output: ${JSON.stringify(out)} },
  nsis: { ...base.nsis, shortcutName: ${JSON.stringify(PRODUCT)}, createDesktopShortcut: false, createStartMenuShortcut: false, runAfterFinish: false } };
`,
  );
  const env = { ...process.env, CREWYARD_UPDATE_URL: FEED, CREWYARD_SIGN_TIMESTAMP_URL: "none" };
  for (const k of ["CREWYARD_SIGN", "WIN_CSC_LINK", "CSC_LINK", "WIN_CSC_KEY_PASSWORD", "CSC_KEY_PASSWORD", "CREWYARD_SIGN_CERT_SHA1", "CREWYARD_UPDATE_TEST_ROOT"]) delete env[k];
  if (cert) Object.assign(env, { CREWYARD_SIGN: "1", WIN_CSC_LINK: cert.file, WIN_CSC_KEY_PASSWORD: cert.password, CREWYARD_SIGN_PUBLISHER: cert.subject, CREWYARD_UPDATE_TEST_ROOT: testRoot });
  log(`building ${version}${cert ? " signed" : " unsigned"}`);
  const res = spawnSync(process.execPath, [builderCli, "--win", "--projectDir", appDir, "--config", config, "--publish", "never"], { env, windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(root, `build ${version}${cert ? "" : " unsigned"}.log`), `${res.stdout}\n${res.stderr}`);
  if (res.status !== 0) throw new Error(`build ${version} failed:\n${res.stdout.slice(-3000)}\n${res.stderr.slice(-3000)}`);
  return out;
}

const sha512 = (buf) => createHash("sha512").update(buf).digest("base64");

/** A feed folder: the installer (possibly altered) and a latest.yml that lists it. */
function feedDir(name, fromDir, version, { alter, rehash = true } = {}) {
  const dir = join(root, "feeds", name);
  mkdirSync(dir, { recursive: true });
  const setup = SETUP(version);
  let bytes = readFileSync(join(fromDir, setup));
  const yml = readFileSync(join(fromDir, "latest.yml"), "utf8");
  if (alter) bytes = alter(Buffer.from(bytes));
  writeFileSync(join(dir, setup), bytes);
  const fixed = rehash ? yml.replace(/sha512: .*/g, `sha512: ${sha512(bytes)}`).replace(/size: \d+/g, `size: ${bytes.length}`) : yml;
  writeFileSync(join(dir, "latest.yml"), fixed);
  return dir;
}

let feed = null;
const requests = [];
const server = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  const file = feed && join(feed, decodeURIComponent(new URL(req.url ?? "/", FEED).pathname).replace(/^\/+/, ""));
  if (!file || !file.startsWith(feed) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, { "content-type": file.endsWith(".yml") ? "text/yaml" : "application/octet-stream", "content-length": body.length });
  res.end(body);
});

function verbatim(exe, commandLine) {
  // NSIS reads /D= as everything after it, so the path goes unquoted and last.
  const r = spawnSync(exe, [commandLine], { windowsVerbatimArguments: true, windowsHide: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${exe} ${commandLine} exited ${r.status}`);
}

const exePath = () => join(installDir, `${PRODUCT}.exe`);
const profileDir = join(process.env.APPDATA ?? "", PRODUCT);
const cacheDir = join(process.env.LOCALAPPDATA ?? "", `${NAME}-updater`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killApp() {
  spawnSync("taskkill", ["/IM", `${PRODUCT}.exe`, "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}

/** Chromium keeps writing its profile while it exits, so folders are removed only once no process is left. */
async function waitForExit() {
  for (let i = 0; i < 30; i++) {
    if (ps("@(Get-Process | Where-Object { $_.ProcessName -eq $env:T_NAME }).Count", { T_NAME: PRODUCT }) === "0") return;
    await sleep(500);
  }
}

async function openApp() {
  const child = spawn(exePath(), [`--remote-debugging-port=${CDP_PORT}`], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(500);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`).catch(() => null);
  }
  if (!browser) throw new Error("the installed app did not open its DevTools port");
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("index.html")) ?? null;
    if (!page) await sleep(250);
  }
  if (!page) throw new Error("no app window");
  // English and dark, so the selectors and screenshots do not depend on this machine's language.
  await page.evaluate(() => localStorage.setItem("crewyard:prefs", JSON.stringify({ state: { language: "en", theme: "dark" }, version: 1 })));
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 860 }).catch(() => undefined);
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.locator("#settings-updates").scrollIntoViewIfNeeded();
  return { browser, page };
}

async function shot(page, name) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.locator("#settings-updates").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

const section = (page) => page.locator("#settings-updates");

async function offer(page, scenario) {
  feed = join(root, "feeds", scenario);
  await section(page).getByRole("button", { name: "Check now" }).click();
  await section(page).getByText("Crewyard 0.1.1 is available.").waitFor({ timeout: 30_000 });
}

async function refusedScenario(page, scenario, expected) {
  await offer(page, scenario);
  await section(page).getByRole("button", { name: "Download", exact: true }).click();
  const alert = section(page).getByRole("alert");
  await alert.waitFor({ timeout: 120_000 });
  const text = await alert.innerText();
  check(`${scenario}: refused and nothing installed`, text.includes(expected), text.split("\n")[0]);
  check(`${scenario}: no Restart to install`, (await section(page).getByRole("button", { name: "Restart to install" }).count()) === 0);
  await shot(page, `refused-${scenario}`);
}

async function main() {
  if (process.platform !== "win32") throw new Error("Windows only");
  if (!existsSync(join(appDir, "out", "third-party", "THIRD-PARTY-LICENSES.txt"))) throw new Error("run `pnpm --filter @crewyard/desktop build` first");
  if (existsSync(installDir) || existsSync(profileDir)) throw new Error(`leftovers of an earlier run: ${profileDir}`);
  log(`working in ${root}`);
  mkdirSync(join(root, "certs"));

  const ours = makeCert(join(root, "certs", "publisher.pfx"), "CN=Crewyard Update Test, O=Crewyard Test Only");
  const other = makeCert(join(root, "certs", "someone else.pfx"), "CN=Someone Else, O=Not Crewyard");
  check("certificates exist only as files", ps("@(Get-ChildItem -Recurse Cert:\\CurrentUser | Where-Object { $_.Thumbprint -in @($env:A, $env:B) }).Count", { A: ours.thumbprint, B: other.thumbprint }) === "0");

  const v010 = build({ version: "0.1.0", cert: ours, testRoot: ours.thumbprint, out: join(root, "dist 0.1.0") });
  const v011 = build({ version: "0.1.1", cert: ours, testRoot: ours.thumbprint, out: join(root, "dist 0.1.1") });
  const v011u = build({ version: "0.1.1", cert: null, testRoot: null, out: join(root, "dist 0.1.1 unsigned") });

  for (const [label, file] of [
    ["0.1.0 installer", join(v010, SETUP("0.1.0"))],
    ["0.1.0 app exe", join(v010, "win-unpacked", `${PRODUCT}.exe`)],
    ["0.1.0 ffmpeg.dll", join(v010, "win-unpacked", "ffmpeg.dll")],
    ["0.1.1 installer", join(v011, SETUP("0.1.1"))],
  ]) {
    const s = signature(file);
    check(`${label} is signed by the test publisher`, s.thumbprint === ours.thumbprint, `${s.status} ${s.subject}`);
  }
  check("unsigned 0.1.1 installer is not signed", signature(join(v011u, SETUP("0.1.1"))).status === "NotSigned");
  const yml = readFileSync(join(v010, "win-unpacked", "resources", "app-update.yml"), "utf8");
  check("0.1.0 app-update.yml names the feed and the publisher", yml.includes(FEED) && yml.includes(ours.subject), yml.replace(/\r?\n/g, " | "));

  feedDir("valid", v011, "0.1.1");
  feedDir("tampered", v011, "0.1.1", { alter: (b) => ((b[b.length >> 1] ^= 0xff), b) });
  feedDir("checksum", v011, "0.1.1", { alter: (b) => ((b[b.length >> 1] ^= 0xff), b), rehash: false });
  const foreign = feedDir("foreign", v011, "0.1.1");
  ps(
    "$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($env:T_PFX, $env:T_PASSWORD, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet); $null = Set-AuthenticodeSignature -LiteralPath $env:T_FILE -Certificate $c -HashAlgorithm SHA256",
    { T_PFX: other.file, T_PASSWORD: other.password, T_FILE: join(foreign, SETUP("0.1.1")) },
  );
  feedDir("foreign", foreign, "0.1.1");
  feedDir("unsigned", v011u, "0.1.1");

  await new Promise((r) => server.listen(FEED_PORT, "127.0.0.1", r));
  log(`feed on ${FEED}`);

  log("installing 0.1.0");
  verbatim(join(v010, SETUP("0.1.0")), `/S /D=${installDir}`);
  check("0.1.0 installed into the test folder", existsSync(exePath()) && existsSync(join(installDir, `Uninstall ${PRODUCT}.exe`)));
  check("licences ship next to the exe", existsSync(join(installDir, "THIRD-PARTY-LICENSES.txt")) && existsSync(join(installDir, "NOTICE.txt")));

  let { browser, page } = await openApp();
  await section(page).getByText("0.1.0", { exact: true }).waitFor();
  await shot(page, "installed-0.1.0");

  await refusedScenario(page, "tampered", "changed after it was signed");
  await refusedScenario(page, "checksum", "does not match the checksum");
  // Neither trusted by Windows nor the pinned test root, so it fails on trust before the publisher is
  // compared; scripts/sign-windows.test.ts compares publishers on real signatures.
  await refusedScenario(page, "foreign", "does not trust the update's signature");
  await refusedScenario(page, "unsigned", "is not signed");

  await offer(page, "valid");
  await shot(page, "available");
  await section(page).getByRole("button", { name: "Download", exact: true }).click();
  await section(page).getByRole("progressbar").waitFor({ timeout: 10_000 }).then(() => shot(page, "downloading")).catch(() => undefined);
  await section(page).getByRole("button", { name: "Restart to install" }).waitFor({ timeout: 120_000 });
  const verified = await section(page).getByRole("status").filter({ hasText: "verified" }).innerText();
  check("valid 0.1.1 downloaded and verified", verified.includes(ours.subject), verified);
  await shot(page, "downloaded");

  log("restart to install");
  await section(page).getByRole("button", { name: "Restart to install" }).click();
  await browser.close().catch(() => undefined);
  let version = "";
  for (let i = 0; i < 120 && version !== "0.1.1"; i++) {
    await sleep(1000);
    try {
      // electron-builder writes FileVersion as the app version and ProductVersion with a fourth part.
      version = existsSync(exePath()) ? ps("(Get-Item -LiteralPath $env:T_FILE).VersionInfo.FileVersion", { T_FILE: exePath() }) : "";
    } catch {
      // the installer is still writing it
    }
  }
  check("the installed app is 0.1.1 after Restart to install", version === "0.1.1", version);
  let relaunched = false;
  for (let i = 0; i < 30 && !relaunched; i++) {
    await sleep(1000);
    relaunched = ps("@(Get-Process | Where-Object { $_.Path -eq $env:T_FILE }).Count", { T_FILE: exePath() }) !== "0";
  }
  check("Crewyard started again after installing", relaunched);
  const installed = signature(exePath());
  check("the installed 0.1.1 exe is signed by the test publisher", installed.thumbprint === ours.thumbprint, installed.status);
  await sleep(3000);
  killApp();
  await waitForExit();

  ({ browser, page } = await openApp());
  await section(page).getByText("0.1.1", { exact: true }).waitFor({ timeout: 15_000 });
  check("Settings shows 0.1.1 after the update", true);
  await shot(page, "after-update-0.1.1");
  await browser.close().catch(() => undefined);

  const logFile = join(profileDir, "logs", "updater.log");
  const updaterLog = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  check("updater.log records each refusal and the passed check", ["refused (tampered)", "refused (untrusted)", "refused (not_signed)", "passed:"].every((s) => updaterLog.includes(s)));
  check("the feed server saw the app's update requests", requests.some((r) => r.includes("latest.yml")), `${requests.length} requests: ${[...new Set(requests)].join(", ")}`);
}

async function cleanup() {
  killApp();
  await waitForExit();
  server.close();
  const uninstaller = join(installDir, `Uninstall ${PRODUCT}.exe`);
  if (existsSync(uninstaller)) {
    try {
      verbatim(uninstaller, "/S /currentuser");
    } catch (err) {
      log(`uninstall: ${err.message}`);
    }
    await sleep(3000);
  }
  const leftover = ps("@(Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -eq $env:T_NAME }).Count", { T_NAME: PRODUCT });
  check("uninstalled: no uninstall entry left", leftover === "0", leftover);
  killApp();
  await waitForExit();
  // A Chromium helper can hold a profile file for a moment after the last window is gone.
  for (let i = 0; i < 10 && (existsSync(profileDir) || existsSync(cacheDir)); i++) {
    for (const dir of [profileDir, cacheDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // still held; try again
      }
    }
    if (existsSync(profileDir) || existsSync(cacheDir)) await sleep(1000);
  }
  check("profile and updater cache removed", !existsSync(profileDir) && !existsSync(cacheDir));
  if (keep) log(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  log(`ERROR ${err.stack ?? err}`);
} finally {
  await cleanup().catch((err) => log(`cleanup: ${err.message}`));
}
const bad = results.filter((r) => !r.ok);
log(`${results.length - bad.length} passed, ${bad.length} failed${failed ? ", stopped by an error" : ""}`);
if (shots) {
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, "results.json"), JSON.stringify(results, null, 2));
}
process.exit(failed || bad.length ? 1 : 0);
