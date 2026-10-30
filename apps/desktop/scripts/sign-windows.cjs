// electron-builder's Windows signing hook (win.signtoolOptions.sign), used when CREWYARD_SIGN=1.
// See docs/adr/0011-signing-and-auto-update.md.
//
// electron-builder's built-in route runs signtool.exe with the PFX password as `/p <password>`,
// where every process on the machine can read it from the command line. This hook signs through
// Windows PowerShell's Set-AuthenticodeSignature instead:
//   - the PFX path and password reach PowerShell only through its environment;
//   - the key is loaded with EphemeralKeySet, so nothing is written to a certificate store or to the
//     user's key folder;
//   - a certificate in the Windows store (EV token, HSM) is used where it is, by thumbprint;
//   - the script itself is fixed text passed as -EncodedCommand, so no value is ever parsed as code.
// After signing, the file is read back: it must carry our certificate's signature. A file that
// already has a valid signature from someone else (Microsoft's d3dcompiler_47.dll) keeps it.

const { spawnSync } = require("node:child_process");
const { basename, join } = require("node:path");

const powershell = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$file = $env:CREWYARD_SIGN_FILE
if ($env:CREWYARD_SIGN_PFX) {
  $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($env:CREWYARD_SIGN_PFX, $env:CREWYARD_SIGN_PFX_PASSWORD, $flags)
} else {
  $cert = Get-Item -LiteralPath $env:CREWYARD_SIGN_STORE_PATH
}
if (-not $cert.HasPrivateKey) { throw 'the certificate has no private key' }
$before = Get-AuthenticodeSignature -LiteralPath $file
if ($before.Status -eq 'Valid' -and $before.SignerCertificate.Thumbprint -ne $cert.Thumbprint) {
  [pscustomobject]@{ kept = $true; signer = $before.SignerCertificate.Subject } | ConvertTo-Json -Compress
  exit 0
}
$params = @{ LiteralPath = $file; Certificate = $cert; HashAlgorithm = 'SHA256' }
if ($env:CREWYARD_SIGN_TIMESTAMP_URL) { $params.TimestampServer = $env:CREWYARD_SIGN_TIMESTAMP_URL }
$null = Set-AuthenticodeSignature @params
$after = Get-AuthenticodeSignature -LiteralPath $file
[pscustomobject]@{
  kept = $false
  status = $after.Status.ToString()
  signer = $after.SignerCertificate.Thumbprint
  expected = $cert.Thumbprint
  selfSigned = ($cert.Subject -eq $cert.Issuer)
  timestamped = [bool]$after.TimeStamperCertificate
} | ConvertTo-Json -Compress
`;

const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");

/** What the read-back says, as an error message, or null when the file is signed as asked. */
function judge(result, { timestamp }) {
  if (result.kept) return null;
  if (result.signer !== result.expected) return `the file is not signed by the configured certificate (${result.status})`;
  if (timestamp && !result.timestamped) return "the signature has no timestamp";
  if (result.status === "Valid") return null;
  // A self-signed test certificate is not trusted by Windows; the signature itself is intact.
  if (result.status === "UnknownError" && result.selfSigned) return null;
  return `Windows does not accept the signature: ${result.status}`;
}

function signOnce(file, cscInfo, timestamp) {
  const env = { ...process.env, CREWYARD_SIGN_FILE: file, CREWYARD_SIGN_TIMESTAMP_URL: timestamp ?? "" };
  if ("file" in cscInfo) {
    env.CREWYARD_SIGN_PFX = cscInfo.file;
    env.CREWYARD_SIGN_PFX_PASSWORD = cscInfo.password ?? "";
  } else {
    env.CREWYARD_SIGN_STORE_PATH = `Cert:\\${cscInfo.isLocalMachineStore ? "LocalMachine" : "CurrentUser"}\\${cscInfo.store}\\${cscInfo.thumbprint}`;
  }
  const res = spawnSync(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    env,
    windowsHide: true,
    encoding: "utf8",
    timeout: 5 * 60_000,
  });
  const line = (res.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  if (res.status !== 0 || !line.startsWith("{")) {
    // PowerShell's error text names the file and the cmdlet, never the password.
    throw new Error(`signing ${basename(file)} failed: ${(res.stderr || res.error?.message || `exit ${res.status}`).trim().slice(0, 2000)}`);
  }
  return JSON.parse(line);
}

function withOptions({ timestamp }) {
  /** @param {{ path: string, cscInfo: null | { file: string, password?: string | null } | { thumbprint: string, store: string, isLocalMachineStore: boolean } }} configuration */
  return async function sign(configuration) {
    if (process.platform !== "win32") throw new Error("sign-windows.cjs signs on Windows only");
    const cscInfo = configuration.cscInfo;
    if (!cscInfo) throw new Error("CREWYARD_SIGN=1 but electron-builder found no certificate (WIN_CSC_LINK or CREWYARD_SIGN_CERT_SHA1)");
    const name = basename(configuration.path);
    let lastError = null;
    // Timestamp servers fail now and then; electron-builder retries signtool the same way.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = signOnce(configuration.path, cscInfo, timestamp);
        const problem = judge(result, { timestamp });
        if (problem) throw new Error(`${name}: ${problem}`);
        if (result.kept) console.log(`  • kept the existing signature  file=${name} signer=${result.signer}`);
        else console.log(`  • signed  file=${name} status=${result.status}${result.timestamped ? " timestamped" : ""}${result.selfSigned ? " self-signed (test certificate, not trusted by Windows)" : ""}`);
        return;
      } catch (err) {
        lastError = err;
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 5000));
      }
    }
    throw lastError;
  };
}

module.exports = { withOptions, judge };
