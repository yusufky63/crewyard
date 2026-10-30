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

/** The report server for one run, as every adapter receives it. */
export function reportServerSpec(pipe: string, ticket: string): McpServerSpec {
  return {
    name: REPORT_SERVER,
    command: powershellPath(),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded()],
    env: { [PIPE_ENV]: pipe, [TICKET_ENV]: ticket },
    tools: null,
    builtin: true,
  };
}
