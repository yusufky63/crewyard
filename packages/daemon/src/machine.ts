import { basename, dirname, join } from "node:path";
import { GEMINI_ISOLATION_MIN, versionAtLeast } from "@crewyard/adapter-acp";
import { SDK_CLI_VERSION } from "@crewyard/adapter-claude";
import { MIN_CODEX_VERSION } from "@crewyard/adapter-codex";
import { TESTED_VERSION } from "@crewyard/adapter-opencode";
import type { DefenderCheck, MachineEnv, MachineReport, ToolCheck, ToolId, VersionGate, VersionGateStatus } from "@crewyard/core";
import { parseVersion, run, which } from "@crewyard/proc";

// The "This machine" check on the Start screen. Read-only: it never installs or changes anything.

export const TOOL_BINS: Record<ToolId, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
  git: "git",
  gh: "gh",
};

interface GateRule {
  verified: string;
  rule: VersionGate["rule"];
  /** What a version that misses the rule means for this CLI. */
  miss: Exclude<VersionGateStatus, "ok" | "unknown">;
  /** From each CLI's own install docs (opened 2026-10-30). */
  update: string;
}

/** The versions each adapter was verified with; the adapters refuse or warn on the same rules. */
export const VERSION_GATES: Partial<Record<ToolId, GateRule>> = {
  claude: { verified: SDK_CLI_VERSION, rule: "min", miss: "outdated", update: "claude update" },
  codex: { verified: MIN_CODEX_VERSION, rule: "min", miss: "outdated", update: "npm install -g @openai/codex" },
  // OpenCode is pinned: only the version that passed the conformance suite counts, newer or older.
  opencode: { verified: TESTED_VERSION, rule: "exact", miss: "untested", update: `opencode upgrade v${TESTED_VERSION}` },
  // Older Gemini CLIs ignore GEMINI_CLI_HOME and would run every profile in the user's own ~/.gemini.
  gemini: { verified: GEMINI_ISOLATION_MIN, rule: "min", miss: "isolation", update: "npm install -g @google/gemini-cli@latest" },
};

export function versionGate(id: ToolId, version: string | null): VersionGate | null {
  const g = VERSION_GATES[id];
  if (!g) return null;
  const base = { verified: g.verified, rule: g.rule };
  if (!version) return { ...base, status: "unknown", update: g.update };
  const ok = g.rule === "exact" ? version === g.verified : versionAtLeast(version, g.verified);
  return ok ? { ...base, status: "ok", update: null } : { ...base, status: g.miss, update: g.update };
}

export async function checkTool(id: ToolId): Promise<ToolCheck> {
  const path = await which(TOOL_BINS[id]);
  if (!path) return { id, found: false, path: null, version: null, detail: null, gate: null };
  const res = await run(path, ["--version"], { timeoutMs: 15_000 });
  const version = parseVersion(res.stdout || res.stderr);
  return { id, found: true, path, version, detail: res.code === 0 ? null : "version check failed", gate: versionGate(id, version) };
}

/** `gh api user --jq .login` prints the login when signed in; anything else means not signed in. */
async function ghLogin(): Promise<string | null> {
  const gh = await which("gh");
  if (!gh) return null;
  const res = await run(gh, ["api", "user", "--jq", ".login"], { timeoutMs: 15_000 });
  const login = res.stdout.trim();
  return res.code === 0 && /^[\w-]+$/.test(login) ? login : null;
}

/** Parses `reg query ... /v LongPathsEnabled` output; null when the value is missing. */
export function parseLongPaths(regOutput: string): boolean | null {
  const m = regOutput.match(/LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  return m?.[1] ? parseInt(m[1], 16) === 1 : null;
}

async function longPaths(): Promise<boolean | null> {
  if (process.platform !== "win32") return null;
  const res = await run("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled"]);
  return res.code === 0 ? parseLongPaths(res.stdout) : null;
}

export async function checkEnv(): Promise<MachineEnv> {
  const [ghUser, longPathsEnabled] = await Promise.all([ghLogin(), longPaths()]);
  return { checkedAt: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, ghUser, longPathsEnabled };
}

export async function checkMachine(): Promise<MachineReport> {
  const [tools, env] = await Promise.all([Promise.all((Object.keys(TOOL_BINS) as ToolId[]).map(checkTool)), checkEnv()]);
  return { ...env, tools };
}

// Defender exclusion check (PLAN.md §11.1). Read-only by design: it never calls Add-MpPreference;
// it reports, and the Start screen shows the steps for the user to take themselves.

const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

/**
 * Where agents write: each project's worktree root. Roots in the default layout
 * (<projects>\.mc\worktrees\<repo>) collapse into their shared `.mc\worktrees` folder, so one
 * exclusion covers every project in that projects folder, including ones added later.
 */
export function defenderFolders(worktreeRoots: string[]): string[] {
  const out = new Map<string, string>();
  for (const root of worktreeRoots) {
    const parent = dirname(root);
    const shared = basename(parent).toLowerCase() === "worktrees" && basename(dirname(parent)).toLowerCase() === ".mc";
    const folder = shared ? parent : root;
    out.set(norm(folder), folder);
  }
  return [...out.values()];
}

/**
 * True when an exclusion is the folder or one of its parents (folder exclusions cover subfolders).
 * Entries with wildcards or environment variables are not evaluated here, so when one exists and no
 * plain entry matched, the answer is null: we cannot tell.
 */
export function isExcluded(folder: string, exclusions: string[]): boolean | null {
  const f = norm(folder);
  let unsure = false;
  for (const raw of exclusions) {
    if (/[*?%]/.test(raw)) {
      unsure = true;
      continue;
    }
    const e = norm(raw.trim());
    if (e && (f === e || f.startsWith(`${e}\\`))) return true;
  }
  return unsure ? null : false;
}

export interface DefenderRaw {
  /** Defender is the active antivirus (AMRunningMode "Normal"); false in passive mode or when missing. */
  active: boolean;
  realtime: boolean | null;
  /** null when Windows hides the list from this (non-admin) user. */
  exclusions: string[] | null;
}

const NO_DEFENDER: DefenderRaw = { active: false, realtime: null, exclusions: null };

/** Parses the JSON printed by DEFENDER_SCRIPT. */
export function parseDefender(json: string): DefenderRaw {
  let o: { mode?: unknown; rt?: unknown; ex?: unknown };
  try {
    o = JSON.parse(json.trim() || "{}") as typeof o;
  } catch {
    return NO_DEFENDER;
  }
  const active = typeof o.mode === "string" && /^normal$/i.test(o.mode);
  const realtime = typeof o.rt === "boolean" ? o.rt : null;
  const items: unknown[] = Array.isArray(o.ex) ? o.ex : o.ex == null ? [] : [o.ex];
  const list = items.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  // Non-admin users get one placeholder entry instead of the list: "N/A: Must be an administrator to view exclusions".
  const hidden = o.ex === undefined || list.some((x) => x.startsWith("N/A"));
  return { active, realtime, exclusions: hidden ? null : list };
}

export function defenderReport(raw: DefenderRaw, folders: string[], checkedAt = new Date().toISOString()): DefenderCheck {
  const rows = folders.map((path) => ({ path, excluded: raw.exclusions ? isExcluded(path, raw.exclusions) : null }));
  const base = { checkedAt, realtime: raw.realtime, canReadExclusions: raw.exclusions !== null, folders: rows };
  if (!raw.active) return { ...base, state: "unavailable" };
  if (raw.realtime === false) return { ...base, state: "realtime_off" };
  if (rows.length > 0 && rows.every((r) => r.excluded === true)) return { ...base, state: "excluded" };
  if (rows.some((r) => r.excluded === false)) return { ...base, state: "not_excluded" };
  return { ...base, state: "unknown" };
}

// Only Get-* cmdlets: reading Defender's state never changes it. Output is forced to UTF-8 so
// folder names outside the console code page survive.
const DEFENDER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$o = @{}",
  "try { $s = Get-MpComputerStatus; $o.mode = [string]$s.AMRunningMode; $o.rt = [bool]$s.RealTimeProtectionEnabled } catch { }",
  "try { $o.ex = @((Get-MpPreference).ExclusionPath) } catch { }",
  "$o | ConvertTo-Json -Compress",
].join("; ");

/** `scanRoot` stands in for the projects folder until a project is added. */
export async function checkDefender(worktreeRoots: string[], scanRoot: string): Promise<DefenderCheck> {
  const folders = worktreeRoots.length > 0 ? defenderFolders(worktreeRoots) : [join(scanRoot, ".mc", "worktrees")];
  if (process.platform !== "win32") return defenderReport(NO_DEFENDER, folders);
  const ps = (await which("powershell")) ?? "powershell.exe";
  const res = await run(ps, ["-NoProfile", "-NonInteractive", "-Command", DEFENDER_SCRIPT], { timeoutMs: 30_000 });
  return defenderReport(res.code === 0 ? parseDefender(res.stdout) : NO_DEFENDER, folders);
}
