// Which command approvals a read-only role may take without asking (PLAN.md §11). codex sends the
// command as one shell-quoted string of its whole argv (shlex join in codex 0.147's
// app-server), so on Windows it usually wraps the agent's script in PowerShell. We unwrap the
// usual shells, then accept only a plain command that is one of the role's allowed commands,
// optionally followed by arguments: no chaining, redirection, pipes or substitution.

import { matchesAllowlist } from "@crewyard/core";

/** Splits a POSIX shell-quoted string the way shlex quoted it; null when the quoting is broken. */
export function shellSplit(text: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += text.slice(i + 1, end);
      started = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\" && j + 1 < text.length && '"\\$`'.includes(text[j + 1]!)) j++;
        cur += text[j];
      }
      if (j >= text.length) return null;
      started = true;
      i = j;
    } else if (c === "\\" && i + 1 < text.length) {
      cur += text[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

const program = (arg: string) =>
  arg
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, "");

/** The script inside `powershell -Command <s>`, `bash -lc <s>` or `cmd /c <s>`; the command itself when it is not wrapped. */
export function innerCommand(command: string): string | null {
  const argv = shellSplit(command.trim());
  if (!argv || argv.length === 0) return null;
  const shell = program(argv[0]!);
  const last = argv.length - 1;
  if (shell === "powershell" || shell === "pwsh") {
    const at = argv.findIndex((a, i) => i > 0 && /^-(c|command)$/i.test(a));
    // Only switches may come before -Command, and the script must be its last argument.
    if (at < 0 || at !== last - 1 || argv.slice(1, at).some((a) => !a.startsWith("-"))) return null;
    return argv[last]!;
  }
  if (shell === "bash" || shell === "sh" || shell === "zsh") {
    if (argv.length !== 3 || !/^-l?c$/.test(argv[1]!)) return null;
    return argv[2]!;
  }
  if (shell === "cmd") {
    if (argv.length !== 3 || !/^\/c$/i.test(argv[1]!)) return null;
    return argv[2]!;
  }
  return argv.join(" ");
}

/**
 * True when the command is one of `allowed` (the project's test and build commands) with plain
 * arguments. Same matcher as the daemon's risk classes, so a newline or an operator in the
 * unwrapped script never rides on an allowed command.
 */
export function isAllowedCommand(command: string | null | undefined, allowed: readonly string[]): boolean {
  if (!command) return false;
  const inner = innerCommand(command);
  return inner !== null && matchesAllowlist(inner, allowed);
}
