// Typed contract between the renderer and the daemon. The main process only relays messages;
// it never interprets them. Add a method here first, then implement it in packages/daemon.

export type ToolId = "claude" | "codex" | "gemini" | "opencode" | "git" | "gh";

export interface ToolCheck {
  id: ToolId;
  found: boolean;
  path: string | null;
  version: string | null;
  detail: string | null;
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

export interface IpcMethods {
  "daemon.status": { params: void; result: DaemonStatus };
  "machine.check": { params: void; result: MachineReport };
  /** One tool at a time, so slow CLIs (gemini --version takes ~6 s) don't hold up the others. */
  "machine.tool": { params: { id: ToolId }; result: ToolCheck };
  "machine.env": { params: void; result: MachineEnv };
  "projects.list": { params: void; result: ProjectSummary[] };
  "projects.scan": { params: { root: string }; result: ScanResult };
  "projects.add": { params: { path: string; name?: string }; result: ProjectSummary };
}

export type IpcMethod = keyof IpcMethods;
export type IpcParams<M extends IpcMethod> = IpcMethods[M]["params"];
export type IpcResult<M extends IpcMethod> = IpcMethods[M]["result"];

export type IpcRequest = { kind: "request"; id: number; method: IpcMethod; params: unknown };
export type IpcResponse = { kind: "response"; id: number; ok: true; result: unknown } | { kind: "response"; id: number; ok: false; error: string };
export type IpcEvent = { kind: "event"; topic: string; payload: unknown };
export type IpcMessage = IpcRequest | IpcResponse | IpcEvent;
