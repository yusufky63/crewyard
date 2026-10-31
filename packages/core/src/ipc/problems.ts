// IPC for the bottom panel's Problems tab (DESIGN.md §4): the failures only the event log and the
// run and pull request tables know. The tab adds what other methods already return (stall alerts,
// project.json notices, role-file problems, agent-file copies, key checks) and words it all.
// Read-only; implemented in packages/daemon/src/handlers/problems.ts.
//
// Details and previews come from runners, tools and GitHub, so they are untrusted text: the window
// shows them as text only.

/** Rows per source; the newest are kept. */
export const PROBLEMS_PER_SOURCE = 50;

/** A step whose newest run failed: no later run of the same step has started since. */
export interface FailedRunSource {
  runId: string;
  taskId: string;
  taskTitle: string;
  memberId: string;
  role: string;
  runner: string;
  endedAt: string;
  /** runs.end_detail as stored: a code, a code with text, or the runner's own error (splitEndDetail). */
  detail: string | null;
}

/** An audit event whose kind ends in `failed` (`transcript.failed`, `git.failed`, `bootstrap.setup_failed`). */
export interface FailedEventSource {
  seq: number;
  at: string;
  kind: string;
  taskId: string | null;
  taskTitle: string | null;
  runId: string | null;
  /** The payload's most readable text, cut to 300 characters. */
  preview: string;
}

/** A failing check run or commit status on the head of a task's open pull request. */
export interface FailingCheckSource {
  feedbackId: string;
  taskId: string;
  taskTitle: string;
  pr: number;
  /** The check's or status context's name. */
  name: string;
  excerpt: string;
  url: string | null;
  observedAt: string;
  /** Head commit the check ran on; a new push brings new rows. */
  headSha: string;
}

export interface ProblemSources {
  failedRuns: FailedRunSource[];
  failedEvents: FailedEventSource[];
  failingChecks: FailingCheckSource[];
}

export interface ProblemsIpc {
  "problems.sources": { params: { projectId: string }; result: ProblemSources };
}
