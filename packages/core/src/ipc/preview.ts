// IPC methods for the dev-server preview (docs/adr/0013-dev-server-preview.md). Owned by the
// preview work; implemented in packages/daemon/src/handlers/preview.ts. The rules for which of
// these addresses may load live in ../preview.ts.

/** A loopback URL one of the task's runs printed in its tool output. */
export interface PrintedUrl {
  url: string;
  runId: string;
  /** When the output that held it was stored. */
  at: string;
}

export interface PreviewTargets {
  /** The worktree's bootstrap port (CREWYARD_PORT); null when the project gives none. */
  port: number | null;
  /** Newest first, at most PREVIEW_LIMITS.printed, each URL once. */
  printed: PrintedUrl[];
}

export interface PreviewIpc {
  /** Where this task's dev server may be. Reads stored facts only; nothing is fetched or started. */
  "preview.targets": { params: { taskId: string }; result: PreviewTargets };
}
