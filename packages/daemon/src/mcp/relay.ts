import { existsSync } from "node:fs";
import { REPORT_SERVER, type McpServerSpec } from "@crewyard/core";
import { powershellPath } from "../providers/dpapi.ts";

// The stdio end of the report server (docs/adr/0007). Runners start stdio MCP servers themselves,
// and the packaged app cannot run as Node (the runAsNode fuse is off, electron-builder.config.cjs),
// so the server is a byte relay in Windows PowerShell 5.1, which ships with every Windows 10/11
// and already carries the DPAPI helper. It copies stdin to the daemon's pipe and the pipe to
// stdout; the MCP protocol itself is spoken by the daemon (session.ts).
//
// The script is passed with -EncodedCommand and holds no secret; the pipe path and the run's
// ticket arrive in the server's env, which every runner sets only for that server process. The
// variable names avoid KEY/TOKEN/SECRET so runners that scrub credential-looking variables from
// MCP servers (Claude Code's CLAUDE_CODE_SUBPROCESS_ENV_SCRUB) leave them alone.

export const PIPE_ENV = "CREWYARD_REPORT_PIPE";
export const TICKET_ENV = "CREWYARD_RUN_TICKET";

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  `$name = $env:${PIPE_ENV} -replace '^\\\\\\\\\\.\\\\pipe\\\\', ''`,
  "$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)",
  "$pipe.Connect(10000)",
  `$hello = [Text.Encoding]::UTF8.GetBytes('{"crewyard":1,"ticket":"' + $env:${TICKET_ENV} + '"}' + [char]10)`,
  "$pipe.Write($hello, 0, $hello.Length)",
  "$pipe.Flush()",
  "$in = [Console]::OpenStandardInput()",
  "$out = [Console]::OpenStandardOutput()",
  "$up = $in.CopyToAsync($pipe)",
  "$down = $pipe.CopyToAsync($out)",
  // Either side closing ends the relay: the runner stopped the server, or the daemon went away.
  "[void][Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]@($up, $down))",
].join("; ");

export const relayScript = () => SCRIPT;

const encoded = () => Buffer.from(SCRIPT, "utf16le").toString("base64");

// Linux and macOS (docs/adr/0010-linux-macos-groundwork.md): the same byte relay over the
// daemon's Unix socket, in the system Perl with core modules only. /usr/bin/perl ships with macOS
// and with every Linux distribution that packages git, whose own scripts need it. The script holds
// no secret either; it ends when either side closes, like the PowerShell one.
const POSIX_SCRIPT = [
  "use strict; use warnings; use IO::Socket::UNIX; use IO::Select;",
  "$SIG{PIPE} = 'IGNORE';",
  `my $s = IO::Socket::UNIX->new(Peer => $ENV{${PIPE_ENV}}) or exit 1;`,
  "binmode STDIN; binmode STDOUT; binmode $s;",
  `my $hello = '{"crewyard":1,"ticket":"' . $ENV{${TICKET_ENV}} . '"}' . "\\n";`,
  "defined(syswrite($s, $hello)) or exit 1;",
  "my $sel = IO::Select->new(\\*STDIN, $s);",
  "while (1) { for my $h ($sel->can_read) {",
  "my $n = sysread($h, my $buf, 65536); exit 0 unless $n;",
  "my $to = fileno($h) == fileno($s) ? \\*STDOUT : $s;",
  "for (my $off = 0; $off < $n; ) { my $w = syswrite($to, $buf, $n - $off, $off); exit 0 unless defined $w; $off += $w; }",
  "} }",
].join(" ");

export const posixRelayScript = () => POSIX_SCRIPT;

/** Absolute, like powershellPath(): a perl earlier on PATH or in the worktree is never used. */
export const PERL_PATH = "/usr/bin/perl";

/** The report server for one run, as every adapter receives it. Throws where no relay can run. */
export function reportServerSpec(pipe: string, ticket: string, platform: NodeJS.Platform = process.platform, perl: (path: string) => boolean = existsSync): McpServerSpec {
  const env = { [PIPE_ENV]: pipe, [TICKET_ENV]: ticket };
  if (platform !== "win32") {
    if (!perl(PERL_PATH)) throw new Error(`The report relay needs ${PERL_PATH}`);
    return { name: REPORT_SERVER, command: PERL_PATH, args: ["-e", POSIX_SCRIPT], env, tools: null, builtin: true };
  }
  return {
    name: REPORT_SERVER,
    command: powershellPath(),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded()],
    env,
    tools: null,
    builtin: true,
  };
}
