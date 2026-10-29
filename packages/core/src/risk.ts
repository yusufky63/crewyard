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

const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
const inside = (path: string, root: string) => {
  const p = norm(path);
  const r = norm(root);
  return p === r || p.startsWith(r + "\\");
};

export function classifyRisk(input: RiskInput): RiskLevel {
  const cmd = input.command?.trim() ?? "";
  const touched = [...input.paths, ...(input.cwd ? [input.cwd] : [])];

  if (touched.some((p) => SECRET_PATH.test(p))) return "high";
  if (cmd && HIGH_PATTERNS.some((re) => re.test(cmd))) return "high";
  if (touched.some((p) => !inside(p, input.projectRoot) && !inside(p, input.worktreeRoot))) return "high";

  if (input.network) return "medium";
  if (touched.some((p) => !inside(p, input.worktreeRoot))) return "medium";

  const allowed = cmd === "" || input.allowlist.some((a) => cmd === a || cmd.startsWith(a + " "));
  return allowed ? "low" : "medium";
}
