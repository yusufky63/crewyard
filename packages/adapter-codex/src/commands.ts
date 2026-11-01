// Which command approvals a read-only role may take without asking (PLAN.md §11). codex sends the
// command as one shell-quoted string of its whole argv (shlex join in codex 0.147's
// app-server), so on Windows it usually wraps the agent's script in PowerShell. We unwrap the
// usual shells, then accept only a plain command that is one of the role's allowed commands,
// optionally followed by arguments: no chaining, redirection, pipes or substitution.

import { innerCommand, matchesAllowlist } from "@crewyard/core";

// The quoting and unwrapping rules live in core (command-shape.ts), shared with the risk classes.
export { innerCommand, shellSplit } from "@crewyard/core";

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
