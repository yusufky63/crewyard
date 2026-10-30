// IPC methods for worktree bootstrap (feature scan A1): what the include list would copy, how much
// disk each task worktree holds, and park / unpark. Owned by the worktree bootstrap work.
// Implementations live in packages/daemon/src/handlers/worktrees.ts.

export type IncludeEntryState =
  /** Gitignored and present: it is copied. */
  | "copy"
  /** Not in the main checkout. */
  | "missing"
  /** Tracked or not ignored: git already puts it in the worktree, so nothing is copied. */
  | "not_ignored"
  /** A symlink or junction, or a folder holding only those: never copied or followed. */
  | "link"
  /** Would push the total past the size cap; skipped. */
  | "over_cap";

export interface IncludeEntry {
  path: string;
  state: IncludeEntryState;
  kind: "file" | "folder" | null;
  bytes: number;
  files: number;
}

/** Only names, sizes and counts. File contents are never read for the preview or logged. */
export interface IncludePreview {
  entries: IncludeEntry[];
  copyBytes: number;
  copyFiles: number;
  capBytes: number;
}

export interface SetupFailure {
  command: string;
  /** Exit code, or null when it timed out or could not start. */
  code: number | null;
  timedOut: boolean;
  /** The last lines of its output, at most 4 KB. */
  tail: string;
  at: string;
}

export type BootstrapState = "pending" | "waiting_approval" | "running" | "ready" | "failed" | "parked";

export interface WorktreeDiskItem {
  taskId: string;
  title: string;
  path: string;
  branch: string;
  /** null while it was not measured yet or the folder is gone (parked). */
  bytes: number | null;
  /** True when the walk stopped at its bound, so `bytes` is a lower bound. */
  truncated: boolean;
  port: number | null;
  state: BootstrapState;
  failure: SetupFailure | null;
  /** A run of the task has not ended, so park is refused. */
  running: boolean;
  parkedAt: string | null;
  /** The work-in-progress commit park made, when it had changes to commit. */
  parkedSha: string | null;
}

export interface WorktreeDisk {
  items: WorktreeDiskItem[];
  totalBytes: number;
  measuredAt: string;
}

export interface WorktreesIpc {
  /** What the include list would copy from this checkout, for the wizard. Reads sizes only. */
  "worktrees.includePreview": { params: { path: string; include: string[]; maxMb: number }; result: IncludePreview };
  "worktrees.disk": { params: { projectId: string }; result: WorktreeDisk };
  /**
   * Commits work in progress, runs the cleanup steps, removes the folder and keeps the branch. The
   * call is the user's confirmation; refused while any run of the task has not ended.
   */
  "worktrees.park": { params: { taskId: string }; result: WorktreeDiskItem };
  /** Recreates the folder on its branch. Setup runs again before the next agent starts. */
  "worktrees.unpark": { params: { taskId: string }; result: WorktreeDiskItem };
}

export interface WorktreesTopics {
  "worktrees.changed": { projectId: string; taskId: string };
}
