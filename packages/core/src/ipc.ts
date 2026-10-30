import type { CrewIpc } from "./ipc/crew.ts";
import type { GithubIpc } from "./ipc/github.ts";
import type { ProvidersIpc } from "./ipc/providers.ts";
import type { SettingsIpc } from "./ipc/settings.ts";
import type { SetupIpc } from "./ipc/setup.ts";
import type { TasksIpc } from "./ipc/tasks.ts";
import type { WorktreesIpc } from "./ipc/worktrees.ts";
import type { UsageIpc } from "./ipc/usage.ts";
import type { McpIpc } from "./ipc/mcp.ts";

// Typed contract between the renderer and the daemon. The main process only relays messages;
// it never interprets them. Add a method here first, then implement it in packages/daemon.

export type ToolId = "claude" | "codex" | "gemini" | "opencode" | "git" | "gh";

export interface ToolCheck {
  id: ToolId;
  found: boolean;
  path: string | null;
  version: string | null;
  detail: string | null;
  /** Agent CLIs only: the installed version against the one its adapter was verified with. */
  gate: VersionGate | null;
  /**
   * Agent CLIs only: other copies on PATH besides `path`, the one Crewyard starts. Two copies drift
   * apart (`claude update` updates one), and which one runs then depends on PATH order.
   */
  others?: ToolCopy[];
}

export interface ToolCopy {
  path: string;
  version: string | null;
  /** How to remove it when it is a global npm install, e.g. `npm -g uninstall @anthropic-ai/claude-code`. */
  uninstall: string | null;
}

/**
 * - `ok`: at or past the verified version (or exactly it, for an exact rule).
 * - `outdated`: older than the adapter needs.
 * - `untested`: a version the conformance suite has not passed yet (exact rule).
 * - `isolation`: too old to keep profiles apart, so runs would use the user's own config folder.
 * - `unknown`: installed, but no version could be read.
 */
export type VersionGateStatus = "ok" | "outdated" | "untested" | "isolation" | "unknown";

export interface VersionGate {
  status: VersionGateStatus;
  /** The version the adapter was verified with. */
  verified: string;
  /** `min`: this version or newer; `exact`: only this version passed conformance. */
  rule: "min" | "exact";
  /** The command from the CLI's own docs that brings it to a verified version; null when ok. */
  update: string | null;
}

/**
 * Defender's view of the folders agents write in. Read-only: the app shows steps and never adds an
 * exclusion itself. Windows hides the exclusion list from non-admin users, so `excluded` is often
 * null ("could not read") rather than false.
 */
export interface DefenderCheck {
  checkedAt: string;
  /** `unavailable`: not Windows, or Defender is not the active antivirus. */
  state: "excluded" | "not_excluded" | "unknown" | "realtime_off" | "unavailable";
  realtime: boolean | null;
  /** False when Windows answered "Must be an administrator to view exclusions". */
  canReadExclusions: boolean;
  folders: Array<{ path: string; excluded: boolean | null }>;
}

export interface MachineEnv {
  checkedAt: string;
  platform: string;
  ghUser: string | null;
  longPathsEnabled: boolean | null;
}

export interface MachineReport extends MachineEnv {
  tools: ToolCheck[];
}

export interface DaemonStatus {
  state: "running";
  pid: number;
  startedAt: string;
  versions: { node: string; sqlite: string; electron: string | null };
  dbPath: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: string | null;
}

export interface ScanResult {
  root: string;
  repos: Array<{ name: string; path: string; known: boolean }>;
}

/** Base methods live here; each area adds its own in src/ipc/<area>.ts so parallel work never edits this list. */
export interface IpcMethods extends TasksIpc, ProvidersIpc, GithubIpc, SetupIpc, CrewIpc, SettingsIpc, WorktreesIpc, UsageIpc, McpIpc {
  "daemon.status": { params: void; result: DaemonStatus };
  "machine.check": { params: void; result: MachineReport };
  /** One tool at a time, so slow CLIs (gemini --version takes ~6 s) don't hold up the others. */
  "machine.tool": { params: { id: ToolId }; result: ToolCheck };
  "machine.env": { params: void; result: MachineEnv };
  /** Worktree folders of the known projects; `scanRoot` stands in when none is added yet. */
  "machine.defender": { params: { scanRoot: string }; result: DefenderCheck };
  "projects.list": { params: void; result: ProjectSummary[] };
  "projects.scan": { params: { root: string }; result: ScanResult };
  "projects.add": { params: { path: string; name?: string }; result: ProjectSummary };
  /** Marks the project as opened now; the Start screen sorts by this. */
  "projects.open": { params: { projectId: string }; result: ProjectSummary };
}

export type IpcMethod = keyof IpcMethods;
export type IpcParams<M extends IpcMethod> = IpcMethods[M]["params"];
export type IpcResult<M extends IpcMethod> = IpcMethods[M]["result"];

export type IpcRequest = { kind: "request"; id: number; method: IpcMethod; params: unknown };
export type IpcResponse = { kind: "response"; id: number; ok: true; result: unknown } | { kind: "response"; id: number; ok: false; error: string };
export type IpcEvent = { kind: "event"; topic: string; payload: unknown };
export type IpcMessage = IpcRequest | IpcResponse | IpcEvent;
