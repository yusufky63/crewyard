import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { which } from "@crewyard/proc";
import type { TerminalShell, TerminalShellId } from "../../shared/api.ts";

// The shells a terminal can start (docs/adr/0016-terminal.md, Windows notes). Every one is a
// resolved executable path with fixed arguments; nothing is looked up through a shell and the
// folder is never part of a command line.

/** PowerShell 5.1 and 7 read and write UTF-8 without a BOM, so git, node and the agent CLIs print accents right. */
const PS_UTF8 = "[Console]::InputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false;$OutputEncoding=[Console]::OutputEncoding";

export interface ShellLaunch extends TerminalShell {
  args: string[];
}

/** Git for Windows keeps git.exe in `<Git>\cmd` (or `<Git>\bin`, `<Git>\mingw64\bin`) and bash.exe in `<Git>\bin`. */
export function gitBashFrom(gitExe: string): string {
  const dir = win32.dirname(gitExe);
  const root = /\\mingw64\\bin$/i.test(dir) ? win32.dirname(win32.dirname(dir)) : win32.dirname(dir);
  return win32.join(root, "bin", "bash.exe");
}

/** The Windows shells, in the order the picker offers them; PowerShell 5.1 first, it is always there. */
export function windowsShells(systemRoot: string, found: { pwsh: string | null; gitBash: string | null }): ShellLaunch[] {
  const sys32 = win32.join(systemRoot, "System32");
  const shells: ShellLaunch[] = [{ id: "powershell", path: win32.join(sys32, "WindowsPowerShell", "v1.0", "powershell.exe"), args: ["-NoLogo", "-NoExit", "-Command", PS_UTF8] }];
  if (found.pwsh) shells.push({ id: "pwsh", path: found.pwsh, args: ["-NoLogo", "-NoExit", "-Command", PS_UTF8] });
  if (found.gitBash) shells.push({ id: "gitbash", path: found.gitBash, args: ["--login", "-i"] });
  shells.push({ id: "cmd", path: win32.join(sys32, "cmd.exe"), args: ["/K", "chcp 65001>nul"] });
  return shells;
}

/** Linux and macOS: your login shell, else bash. */
export function posixShells(shell: string | undefined): ShellLaunch[] {
  const path = shell && posix.isAbsolute(shell) ? shell : "/bin/bash";
  return [{ id: "posix", path, args: ["-l"] }];
}

/** The shells on this machine, looked up once per call (the picker asks when the Terminal tab opens). */
export async function findShells(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<ShellLaunch[]> {
  if (platform !== "win32") return posixShells(env.SHELL);
  const [pwsh, git] = await Promise.all([which("pwsh").catch(() => null), which("git").catch(() => null)]);
  const bash = git ? gitBashFrom(git) : null;
  return windowsShells(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", { pwsh, gitBash: bash && existsSync(bash) ? bash : null });
}

export function isShellId(v: unknown): v is TerminalShellId {
  return v === "powershell" || v === "pwsh" || v === "gitbash" || v === "cmd" || v === "posix";
}
