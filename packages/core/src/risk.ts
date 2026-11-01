import { commandStatements } from "./command-shape.ts";
import type { RiskLevel } from "./events.ts";

// Risk classes for approvals (PLAN.md §11). The agent's own description of a command is never
// trusted; we look at the command, the working directory and the paths it touches.

export interface RiskInput {
  command: string | null;
  cwd: string | null;
  paths: string[];
  network: boolean;
  worktreeRoot: string;
  projectRoot: string;
  allowlist: string[];
}

const HIGH_PATTERNS = [
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+checkout\s+--\s/i,
  /\brm\s+-[a-z]*r[a-z]*f?\b/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\b(rd|rmdir)\s+\/s\b/i,
  /\bdel\s+\/[sfq]/i,
  /\bformat\s+[a-z]:/i,
  /\b(npm|pnpm|yarn)\s+(i|install|add)\b/i,
  /\bpip\s+install\b/i,
  /\bwinget\s+install\b/i,
  /\bchoco\s+install\b/i,
  /\breg\s+(add|delete)\b/i,
  /\bSet-ExecutionPolicy\b/i,
];

const SECRET_PATH = /(^|[\\/])(\.env(\..*)?|\.dev\.vars|id_rsa|id_ed25519|\.ssh|\.aws|\.secrets|credentials\.json|\.credentials\.json)([\\/]|$)/i;

/**
 * Anything that could run a second command, write a file or expand into one, in POSIX shells,
 * cmd.exe (`&`, `%VAR%`) and PowerShell. An allowlist entry names one command with plain
 * arguments, so `npm test && curl ...` must never ride on an allowlisted `npm test`.
 */
export const SHELL_SYNTAX = /[;&|<>`$(){}%\r\n]/;

/** True when `command` is one of `allowlist` (or starts with it) and carries no shell syntax. */
export function matchesAllowlist(command: string, allowlist: readonly string[]): boolean {
  // Checked before whitespace is folded: a newline is a command separator, not a space.
  if (SHELL_SYNTAX.test(command)) return false;
  const cmd = command.trim().replace(/\s+/g, " ");
  if (cmd === "") return false;
  return allowlist.some((a) => {
    const want = a.trim().replace(/\s+/g, " ");
    return want !== "" && (cmd === want || cmd.startsWith(`${want} `));
  });
}

const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
const inside = (path: string, root: string) => {
  const p = norm(path);
  const r = norm(root);
  return p === r || p.startsWith(r + "\\");
};

/**
 * Reads and local git a step needs all the time, low risk inside its own worktree without an
 * allowlist entry. Before, Codex's wrapper (`powershell.exe -Command '…'`) and its habit of joining
 * two reads with `;` made every one of these an approval (owner, 2026-11-01: "codex bağladım ama
 * sürekli approve istiyor", Codex keeps asking for approval). Pushing, resetting, cleaning and
 * installing stay high through HIGH_PATTERNS, which see the whole command first.
 */
export const WORKTREE_READ_COMMANDS: readonly string[] = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git rev-parse",
  "git ls-files",
  "git branch --show-current",
  "git add",
  "git commit",
  "Get-Content",
  "Get-ChildItem",
  "Select-String",
  "Get-Location",
  "Test-Path",
  "rg",
  "ls",
  "dir",
  "cat",
  "type",
  "pwd",
];

/**
 * An argument that names a place outside the worktree: an absolute path elsewhere, a `..` step, a
 * home shortcut or a secret file. A built-in read with one of these is not low risk.
 */
function leavesWorktree(statement: string, worktreeRoot: string): boolean {
  const words = statement.split(/\s+/).slice(1).map((w) => w.replace(/^["']|["']$/g, ""));
  return words.some((w) => {
    if (SECRET_PATH.test(w) || /(^|[\\/])\.\.([\\/]|$)/.test(w) || w.startsWith("~")) return true;
    const absolute = /^[a-z]:[\\/]/i.test(w) || /^[\\/]{1,2}[^\\/]/.test(w);
    return absolute && !inside(w, worktreeRoot);
  });
}

/** True when every statement of the command is an allowed one with plain arguments (see commandStatements). */
function allStatementsAllowed(command: string, allowlist: readonly string[], worktreeRoot: string): boolean {
  if (matchesAllowlist(command, allowlist)) return true;
  const statements = commandStatements(command);
  if (!statements || statements.length === 0) return false;
  return statements.every((s) => matchesAllowlist(s, allowlist) || (matchesAllowlist(s, WORKTREE_READ_COMMANDS) && !leavesWorktree(s, worktreeRoot)));
}

export function classifyRisk(input: RiskInput): RiskLevel {
  const cmd = input.command?.trim() ?? "";
  const touched = [...input.paths, ...(input.cwd ? [input.cwd] : [])];

  if (touched.some((p) => SECRET_PATH.test(p))) return "high";
  if (cmd && HIGH_PATTERNS.some((re) => re.test(cmd))) return "high";
  if (touched.some((p) => !inside(p, input.projectRoot) && !inside(p, input.worktreeRoot))) return "high";

  if (input.network) return "medium";
  if (touched.some((p) => !inside(p, input.worktreeRoot))) return "medium";

  const allowed = cmd === "" || allStatementsAllowed(cmd, input.allowlist, input.worktreeRoot);
  return allowed ? "low" : "medium";
}
