import { join } from "node:path";
import { clientSnippets, type ExternalClientConfig, type RelayLaunch } from "@crewyard/core";
import { PERL_PATH } from "../mcp/relay.ts";
import { powershellPath } from "../providers/dpapi.ts";

// The stdio end of external access (docs/adr/0021), started by a client you connect (Claude Code,
// Claude Desktop, Codex, Cursor). Like the run relay of docs/adr/0007 it is a byte relay in Windows
// PowerShell 5.1 (the system Perl elsewhere); the daemon speaks MCP. Unlike it, the client's config
// holds no secret: the relay finds the endpoint in <data>/external/endpoint, which the daemon writes
// only while it listens, and decrypts the client's token from <data>/external/<id>.bin with DPAPI
// for the current user, the same call the DPAPI helper makes (ADR 0002). Linux and macOS keep the
// token as a 0600 file in the 0700 folder, since the relay cannot reach the main process's
// safeStorage. The scripts name the variables, never their values.

export const HOME_ENV = "CREWYARD_MCP_HOME";
export const CLIENT_ENV = "CREWYARD_MCP_CLIENT";

/** The folder under the data folder that holds the endpoint file and the client tokens. */
export const EXTERNAL_DIR = "external";
export const ENDPOINT_FILE = "endpoint";

/** Must match ENTROPY in providers/dpapi.ts: the daemon protects the token with that helper. */
const ENTROPY = "crewyard/secret/v1";

const NOT_RUNNING = "Crewyard is not running, or external access is off (Settings > External access).";
const NOT_ANSWERING = "Crewyard did not answer on its endpoint. Is it still running?";
const NO_CLIENT = "This client is not known to Crewyard or was revoked. Copy its config again from Settings > External access.";

const WIN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  `$dir = Join-Path $env:${HOME_ENV} '${EXTERNAL_DIR}'`,
  `$ep = Join-Path $dir '${ENDPOINT_FILE}'`,
  `if (-not (Test-Path -LiteralPath $ep)) { [Console]::Error.WriteLine('${NOT_RUNNING}'); exit 1 }`,
  `$id = $env:${CLIENT_ENV}`,
  `$blob = Join-Path $dir ($id + '.bin')`,
  `if ($id -notmatch '^[0-9a-f-]{36}$' -or -not (Test-Path -LiteralPath $blob)) { [Console]::Error.WriteLine('${NO_CLIENT}'); exit 1 }`,
  "$name = ([IO.File]::ReadAllText($ep)).Trim() -replace '^\\\\\\\\\\.\\\\pipe\\\\', ''",
  "Add-Type -AssemblyName System.Security",
  `$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
  "$token = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($blob), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser))",
  "$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)",
  `try { $pipe.Connect(5000) } catch { [Console]::Error.WriteLine('${NOT_ANSWERING}'); exit 1 }`,
  `$hello = [Text.Encoding]::UTF8.GetBytes('{"crewyard":1,"client":"' + $id + '","token":"' + $token + '"}' + [char]10)`,
  "$token = $null",
  "$pipe.Write($hello, 0, $hello.Length)",
  "$pipe.Flush()",
  "$in = [Console]::OpenStandardInput()",
  "$out = [Console]::OpenStandardOutput()",
  "$up = $in.CopyToAsync($pipe)",
  "$down = $pipe.CopyToAsync($out)",
  "[void][Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]@($up, $down))",
].join("; ");

const POSIX_SCRIPT = [
  "use strict; use warnings; use IO::Socket::UNIX; use IO::Select;",
  "$SIG{PIPE} = 'IGNORE';",
  `my $dir = "$ENV{${HOME_ENV}}/${EXTERNAL_DIR}"; my $id = $ENV{${CLIENT_ENV}} // '';`,
  `open(my $e, '<', "$dir/${ENDPOINT_FILE}") or do { print STDERR "${NOT_RUNNING}\\n"; exit 1 };`,
  "my $path = <$e>; close $e; $path =~ s/\\s+$//;",
  `($id =~ /^[0-9a-f-]{36}$/ && open(my $t, '<', "$dir/$id.token")) or do { print STDERR "${NO_CLIENT}\\n"; exit 1 };`,
  "my $token = <$t>; close $t; $token =~ s/\\s+$//;",
  `my $s = IO::Socket::UNIX->new(Peer => $path) or do { print STDERR "${NOT_ANSWERING}\\n"; exit 1 };`,
  "binmode STDIN; binmode STDOUT; binmode $s;",
  `my $hello = '{"crewyard":1,"client":"' . $id . '","token":"' . $token . '"}' . "\\n"; $token = '';`,
  "defined(syswrite($s, $hello)) or exit 1;",
  "my $sel = IO::Select->new(\\*STDIN, $s);",
  "while (1) { for my $h ($sel->can_read) {",
  "my $n = sysread($h, my $buf, 65536); exit 0 unless $n;",
  "my $to = fileno($h) == fileno($s) ? \\*STDOUT : $s;",
  "for (my $off = 0; $off < $n; ) { my $w = syswrite($to, $buf, $n - $off, $off); exit 0 unless defined $w; $off += $w; }",
  "} }",
].join(" ");

export const externalRelayScript = (platform: NodeJS.Platform = process.platform) => (platform === "win32" ? WIN_SCRIPT : POSIX_SCRIPT);

/** Where the daemon keeps the endpoint file and the tokens for this data folder. */
export const externalDir = (dataDir: string) => join(dataDir, EXTERNAL_DIR);

/** The command a client starts for one client id. Absolute paths: nothing earlier on PATH is used. */
export function relayLaunch(dataDir: string, clientId: string, platform: NodeJS.Platform = process.platform, powershell: string = powershellPath()): RelayLaunch {
  const env = { [HOME_ENV]: dataDir, [CLIENT_ENV]: clientId };
  if (platform !== "win32") return { command: PERL_PATH, args: ["-e", POSIX_SCRIPT], env };
  return { command: powershell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WIN_SCRIPT, "utf16le").toString("base64")], env };
}

export function clientConfig(dataDir: string, clientId: string, platform: NodeJS.Platform = process.platform, powershell?: string): ExternalClientConfig {
  const launch = relayLaunch(dataDir, clientId, platform, powershell);
  return { clientId, ...launch, ...clientSnippets(launch, platform) };
}
