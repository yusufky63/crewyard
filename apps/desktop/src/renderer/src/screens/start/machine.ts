import type { DefenderCheck, MachineEnv, ToolCheck, ToolId } from "@crewyard/core";

// One state per This machine check, shared by the strip at the top of Start and the full panel
// under it, so both always agree. Color is state only (DESIGN.md §2): a missing agent CLI is not a
// problem by itself, because one is enough (the Getting started checklist says when none is found).

export type MachineItemId = ToolId | "longPaths" | "defender";
export type MachineState = "ok" | "warn" | "neutral" | "unknown" | "pending";

/** What the user can do about a problem. The app never runs a fix; it copies a command or shows steps. */
export type MachineFix = { kind: "copy"; command: string; label: "update" | "signIn" } | { kind: "steps"; target: "longPaths" | "defender" } | null;

export interface MachineItem {
  id: MachineItemId;
  state: MachineState;
  /** i18n key in `start` plus params for the one-line status. */
  detail: { key: string; params?: Record<string, string> };
  fix: MachineFix;
}

export const TOOL_ORDER: ToolId[] = ["claude", "codex", "opencode", "gemini", "git", "gh"];
export const AGENT_IDS: ReadonlySet<ToolId> = new Set<ToolId>(["claude", "codex", "opencode", "gemini"]);

/** PowerShell from Microsoft Learn, "Maximum Path Length Limitation"; needs an administrator. */
export const LONG_PATHS_COMMAND = 'New-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force';
export const GH_LOGIN_COMMAND = "gh auth login";

export interface ToolInput {
  data: ToolCheck | undefined;
  pending: boolean;
  error: unknown;
}

export function toolItem(id: ToolId, q: ToolInput, env: MachineEnv | undefined): MachineItem {
  // gh's sign-in comes from the env read, so it is not settled until both answered.
  if (q.pending || (id === "gh" && !env && !q.error)) return { id, state: "pending", detail: { key: "machine.checking" }, fix: null };
  if (q.error || !q.data) return { id, state: "unknown", detail: { key: "machine.unread" }, fix: null };
  const tool = q.data;
  if (!tool.found) return { id, state: AGENT_IDS.has(id) ? "neutral" : "warn", detail: { key: "machine.notFound" }, fix: null };
  const gate = tool.gate;
  if (gate && gate.status !== "ok") {
    return { id, state: "warn", detail: { key: `machine.gateShort.${gate.status}` }, fix: gate.update ? { kind: "copy", command: gate.update, label: "update" } : null };
  }
  if (id === "gh") {
    return env?.ghUser
      ? { id, state: "ok", detail: { key: "machine.ghSignedIn", params: { user: env.ghUser } }, fix: null }
      : { id, state: "warn", detail: { key: "machine.ghSignedOut" }, fix: { kind: "copy", command: GH_LOGIN_COMMAND, label: "signIn" } };
  }
  return { id, state: "ok", detail: tool.version ? { key: "machine.version", params: { version: tool.version } } : { key: "machine.installed" }, fix: null };
}

/** Null when Windows did not say (not Windows, or the read failed): the check is left out. */
export function longPathsItem(env: MachineEnv | undefined): MachineItem | null {
  if (!env) return { id: "longPaths", state: "pending", detail: { key: "machine.checking" }, fix: null };
  if (env.longPathsEnabled === null) return null;
  return env.longPathsEnabled
    ? { id: "longPaths", state: "ok", detail: { key: "machine.longOn" }, fix: null }
    : { id: "longPaths", state: "warn", detail: { key: "machine.longOff" }, fix: { kind: "steps", target: "longPaths" } };
}

const DEFENDER_STATE: Record<DefenderCheck["state"], MachineState> = { excluded: "ok", not_excluded: "warn", unknown: "unknown", realtime_off: "neutral", unavailable: "neutral" };

/** Null when Defender is not the active antivirus: there is nothing to check. */
export function defenderItem(check: DefenderCheck | undefined, pending: boolean, error: unknown): MachineItem | null {
  if (error) return { id: "defender", state: "unknown", detail: { key: "machine.unread" }, fix: null };
  if (pending || !check) return { id: "defender", state: "pending", detail: { key: "machine.checking" }, fix: null };
  if (check.state === "unavailable") return null;
  const open = check.state === "not_excluded" || check.state === "unknown";
  return { id: "defender", state: DEFENDER_STATE[check.state], detail: { key: `machine.defender.state.${check.state}` }, fix: open ? { kind: "steps", target: "defender" } : null };
}

export interface MachineSummary {
  /** Checks that want the user: a warning, or one Crewyard could not read. */
  attention: number;
  pending: number;
  total: number;
}

export function summarize(items: MachineItem[]): MachineSummary {
  return {
    attention: items.filter((i) => i.state === "warn" || i.state === "unknown").length,
    pending: items.filter((i) => i.state === "pending").length,
    total: items.length,
  };
}
