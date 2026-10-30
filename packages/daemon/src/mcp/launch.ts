import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { CMD_SYNTAX } from "@crewyard/core";
import { which } from "@crewyard/proc";

// How a user server's command reaches a runner. Runners start MCP servers themselves, and ACP
// wants an absolute path (McpServerStdio.command), so the command is resolved on PATH first, the
// same way every agent CLI is (an .exe beats a .cmd shim).
//
// A .cmd/.bat shim (npx, pnpm) cannot start without cmd.exe, so it runs as `cmd.exe /d /c <shim>
// ...`, the form Claude Code's docs give for npx on native Windows. cmd.exe re-parses that line:
// - arguments with cmd syntax (quotes, %, &, |, <, >, ^, !) are refused instead;
// - the shim goes by its resolved path, or by its bare name when that path has a space (a quoted
//   first word would change how cmd.exe strips quotes); then NoDefaultCurrentDirectoryInExePath
//   keeps cmd.exe from picking up a same-named file in the worktree.

export type Launch = { ok: true; command: string; args: string[]; env: Record<string, string> } | { ok: false; reason: "not_found" | "shell_syntax" };

const isWin = process.platform === "win32";
const cmdExe = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");

export async function resolveLaunch(command: string, args: readonly string[], find: (name: string) => Promise<string | null> = (n) => which(n)): Promise<Launch> {
  const resolved = isAbsolute(command) ? (existsSync(command) ? command : null) : await find(command);
  if (!resolved) return { ok: false, reason: "not_found" };
  if (isWin && /\.(cmd|bat)$/i.test(resolved)) {
    if (args.some((a) => CMD_SYNTAX.test(a))) return { ok: false, reason: "shell_syntax" };
    const first = /\s/.test(resolved) ? basename(resolved) : resolved;
    if (CMD_SYNTAX.test(first)) return { ok: false, reason: "shell_syntax" };
    return { ok: true, command: cmdExe(), args: ["/d", "/c", first, ...args], env: { NoDefaultCurrentDirectoryInExePath: "1" } };
  }
  return { ok: true, command: resolved, args: [...args], env: {} };
}
