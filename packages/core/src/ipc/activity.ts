// IPC methods for the Activity drawer (DESIGN.md §4): the project's change feed read from the event
// log, and Crewyard's own log lines. Read-only; implemented in packages/daemon/src/handlers/activity.ts.
//
// Event payloads come from agents and tools, so they are untrusted text: the window shows them as
// text only, never as markup or links.

/** Events per page in the drawer. */
export const ACTIVITY_PAGE = 50;
/** Characters of an event's payload sent with the page; the rest is one click away (`activity.event`). */
export const ACTIVITY_PREVIEW = 600;
/** Log lines sent at most per read. */
export const ACTIVITY_LOG_MAX = 2000;

export interface ActivityEventFilter {
  projectId: string;
  taskId?: string | null;
  runId?: string | null;
  /** Exact kind (`run.tool_call`) or a family ending in a dot (`run.`). */
  kind?: string | null;
  /** Include streamed text (message and thought deltas), which otherwise drowns everything else. */
  stream?: boolean;
}

export interface ActivityEvent {
  seq: number;
  at: string;
  kind: string;
  /** Who wrote it: `orchestrator`, `daemon` or a runner id. */
  source: string;
  taskId: string | null;
  runId: string | null;
  /** The most readable text of the payload (its message, command or title), cut to ACTIVITY_PREVIEW. */
  preview: string;
  /** Characters of the whole payload as stored; more than the preview means there is more to read. */
  size: number;
}

export interface ActivityPage {
  events: ActivityEvent[];
  /** Pass as `before` for the next older page; null when this is the oldest. */
  older: number | null;
}

export interface ActivityFacets {
  /** Kinds in this project's log with how many events each, most frequent first. */
  kinds: Array<{ kind: string; count: number }>;
  /** Runs with events, newest first, for the run filter. */
  runs: Array<{ runId: string; taskId: string; role: string; runner: string; startedAt: string }>;
}

export type LogSource = "main" | "daemon" | "updater";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogLine {
  /** Stable within one read, for list keys: source and line number from the end. */
  id: string;
  source: LogSource;
  /** null when the line carried no time (a stack trace line inherits the line above's). */
  at: string | null;
  level: LogLevel;
  /** Redacted before it leaves the daemon. */
  text: string;
}

export interface LogTail {
  /** Newest first. */
  lines: LogLine[];
  /** The tail was cut at `limit`; asking for more returns older lines. */
  more: boolean;
  /** Where the files are, so the user can open the folder. */
  dir: string;
}

export interface ActivityIpc {
  /** One page of the project's event log, newest first, with keyset paging on `seq`. */
  "activity.events": { params: ActivityEventFilter & { before?: number | null; limit?: number }; result: ActivityPage };
  /** The whole stored payload of one event as text, for "Show all". */
  "activity.event": { params: { projectId: string; seq: number }; result: { seq: number; text: string } };
  /** What the filters can offer for this project. */
  "activity.facets": { params: { projectId: string }; result: ActivityFacets };
  /** The newest lines of Crewyard's own logs (main process, daemon, updater), redacted. Never a runner's output. */
  "activity.logs": { params: { sources?: LogSource[]; limit?: number }; result: LogTail };
}
