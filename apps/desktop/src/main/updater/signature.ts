import { join } from "node:path";
import { run } from "@crewyard/proc";
import type { SignatureProblem } from "../../shared/api.ts";

// Authenticode check of a downloaded installer before electron-updater may keep it
// (docs/adr/0011-signing-and-auto-update.md). It replaces electron-updater 6's own verifier, which
// accepts the update when PowerShell cannot run, starts PowerShell through cmd.exe and PATH, and
// splices the file path into the command text. Here:
//   - PowerShell is started by its absolute System32 path, without a shell or a console window;
//   - the path reaches it as an environment variable, so no file name can become code;
//   - every failure, including a check that could not run, refuses the update.
// Windows reports in its own language, so only the Status enum and chain status names are read.

export interface SignatureReport {
  /** System.Management.Automation.SignatureStatus: Valid, NotSigned, HashMismatch, UnknownError, ... */
  status: string;
  subject: string | null;
  thumbprint: string | null;
  /** The last certificate of the chain Windows built, also when its root is not trusted. */
  rootThumbprint: string | null;
  /** X509ChainStatusFlags names, empty for a trusted chain. */
  chain: string[];
}

export type Verdict = { ok: true; signer: string } | { ok: false; problem: SignatureProblem; detail: string };

export interface Policy {
  /** As written into app-update.yml: full subject DNs, or bare names compared with the CN. */
  publisherNames: string[];
  /** Local tests only (feed.ts allows it with a loopback feed): a self-signed root that may stand in for a trusted one. */
  testRoot: string | null;
}

/** Splits a subject as Windows prints it: `CN=Name, O="Company, Inc.", C=US`. Keys are upper-cased. */
export function parseDn(dn: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < dn.length) {
    while (dn[i] === " " || dn[i] === "," || dn[i] === "+") i++;
    const eq = dn.indexOf("=", i);
    if (eq < 0) break;
    const key = dn.slice(i, eq).trim().toUpperCase();
    i = eq + 1;
    let value = "";
    if (dn[i] === '"') {
      i++;
      while (i < dn.length) {
        if (dn[i] === '"' && dn[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (dn[i] === '"') {
          i++;
          break;
        } else value += dn[i++];
      }
      while (i < dn.length && dn[i] !== "," && dn[i] !== "+") i++;
    } else {
      while (i < dn.length && dn[i] !== "," && dn[i] !== "+") {
        if (dn[i] === "\\" && i + 1 < dn.length) i++;
        value += dn[i++];
      }
      value = value.trim();
    }
    if (key) out.set(key, value);
  }
  return out;
}

/** A configured DN must match every attribute it names; a bare name is compared with the CN alone. */
export function matchesPublisher(subject: string, names: readonly string[]): boolean {
  const have = parseDn(subject);
  return names.some((name) => {
    if (!name.includes("=")) return have.get("CN") === name;
    const want = parseDn(name);
    return want.size > 0 && [...want].every(([k, v]) => have.get(k) === v);
  });
}

export function judgeSignature(report: SignatureReport, policy: Policy): Verdict {
  const subject = report.subject ?? "";
  if (report.status === "NotSigned") return { ok: false, problem: "not_signed", detail: "the installer carries no Authenticode signature" };
  if (report.status === "HashMismatch") return { ok: false, problem: "tampered", detail: "the installer was changed after it was signed" };
  const trusted = report.status === "Valid";
  // The self-signed test root of a local test: the signature is intact, only the root is unknown to Windows.
  const testTrusted =
    report.status === "UnknownError" &&
    policy.testRoot !== null &&
    report.rootThumbprint === policy.testRoot &&
    report.chain.length > 0 &&
    report.chain.every((c) => c === "UntrustedRoot");
  if (!trusted && !testTrusted) return { ok: false, problem: "untrusted", detail: `Windows does not trust the signature (${report.status}${report.chain.length ? `: ${report.chain.join(", ")}` : ""})` };
  if (!subject || !matchesPublisher(subject, policy.publisherNames)) {
    return { ok: false, problem: "wrong_publisher", detail: `signed by ${subject || "an unknown signer"}, expected ${policy.publisherNames.join(" or ")}` };
  }
  return { ok: true, signer: subject };
}

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$s = Get-AuthenticodeSignature -LiteralPath $env:CREWYARD_VERIFY_FILE
$root = $null
$chain = @()
if ($s.SignerCertificate) {
  $c = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  $c.ChainPolicy.RevocationMode = 'NoCheck'
  $c.ChainPolicy.VerificationFlags = 'AllowUnknownCertificateAuthority'
  $null = $c.Build($s.SignerCertificate)
  $root = $c.ChainElements[$c.ChainElements.Count - 1].Certificate.Thumbprint
  $chain = @($c.ChainStatus | ForEach-Object { $_.Status.ToString() } | Where-Object { $_ -ne 'NoError' })
}
[pscustomobject]@{
  status = $s.Status.ToString()
  subject = $s.SignerCertificate.Subject
  thumbprint = $s.SignerCertificate.Thumbprint
  rootThumbprint = $root
  chain = $chain
} | ConvertTo-Json -Compress
`;

const ENCODED = Buffer.from(SCRIPT, "utf16le").toString("base64");

const powershell = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** Parses the script's JSON; throws on anything else, which the caller turns into a refusal. */
export function parseReport(stdout: string): SignatureReport {
  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  const raw = JSON.parse(line) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  // PowerShell 5.1 writes a one-element array as a bare string.
  const chain = Array.isArray(raw.chain) ? raw.chain.filter((c): c is string => typeof c === "string") : typeof raw.chain === "string" ? [raw.chain] : [];
  if (typeof raw.status !== "string") throw new Error("no signature status");
  return { status: raw.status, subject: str(raw.subject), thumbprint: str(raw.thumbprint), rootThumbprint: str(raw.rootThumbprint), chain };
}

export async function readSignature(file: string): Promise<SignatureReport> {
  const res = await run(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED], {
    env: { ...process.env, CREWYARD_VERIFY_FILE: file },
    timeoutMs: 60_000,
  });
  if (res.code !== 0) throw new Error(`the signature check did not run: ${res.stderr.trim().slice(0, 500) || `exit ${res.code}`}`);
  return parseReport(res.stdout);
}

/** What electron-updater calls as `verifyUpdateCodeSignature`: null accepts, a string refuses. */
export async function verifyInstaller(file: string, policy: Policy, read: (file: string) => Promise<SignatureReport> = readSignature): Promise<Verdict> {
  if (policy.publisherNames.length === 0) return { ok: false, problem: "check_failed", detail: "no publisher to check against" };
  try {
    return judgeSignature(await read(file), policy);
  } catch (err) {
    return { ok: false, problem: "check_failed", detail: err instanceof Error ? err.message : String(err) };
  }
}
