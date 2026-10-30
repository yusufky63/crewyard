import type { CrewReportType } from "../mcp.ts";
import type { Provenance, RunnerId } from "../events.ts";
import type { LoopDecisionKind, Reason } from "./tasks.ts";

// IPC methods for the usage view and the task timeline (PLAN.md M5). Owned by the usage work.
// Implementations live in packages/daemon/src/handlers/usage.ts; the pure rules that shape what
// the screens show live in ../usage.ts and ../timeline.ts.

/**
 * One group of tokens on one local day. Rows from the spend ledger are API-key runs; rows from runs
 * are subscription plans and local models, which have tokens but no dollars.
 */
export interface UsageRecord {
  /** Local calendar day of the daemon's machine, YYYY-MM-DD. */
  day: string;
  providerId: string;
  model: string | null;
  runner: RunnerId | null;
  profileId: string | null;
  credentialId: string | null;
  /** `api_key` for a key, `local` for a local model, null for a plan you signed in to. */
  credentialKind: "api_key" | "local" | null;
  taskId: string | null;
  taskTitle: string | null;
  projectId: string | null;
  tokensIn: number;
  tokensOut: number;
  /** Null when the runner did not split cache reads out for this group. */
  cacheRead: number | null;
  reasoning: number;
  /** Runners report tokens themselves, so this is Reported unless a group had none at all. */
  tokensProvenance: Provenance;
  /** Ledger dollars; null for plans and local models. */
  usd: number | null;
  /** Reported when every row was billed by the provider, Estimated when any was priced by us. */
  usdProvenance: Provenance;
  /** Catalog price tables the estimate used, newest last. */
  catalogVersions: string[];
}

export interface UsageReport {
  days: number;
  /** Inclusive local days. */
  from: string;
  to: string;
  generatedAt: string;
  records: UsageRecord[];
}

/** One stored event of a task, reduced to what the timeline draws. Large text is cut to a preview. */
export type TimelineEvent = {
  seq: number;
  at: string;
  runId: string | null;
} & (
  | { kind: "run.state"; state: string; detail: string | null }
  | { kind: "run.ended"; reason: string; detail: string | null }
  | { kind: "tool.call"; toolCallId: string; title: string; toolKind: string }
  | {
      kind: "tool.update";
      toolCallId: string;
      status: string;
      /** The head of the stored output, at most TIMELINE_PREVIEW bytes. */
      preview: string | null;
      /** Size of the output the runner sent, when the daemon cut it ("truncated, N bytes"). */
      truncatedBytes: number | null;
      /** Where the full text was kept under the data folder, if it was. */
      keptAt: string | null;
      binary: boolean;
    }
  | { kind: "plan.update"; current: string | null; done: number; total: number }
  | { kind: "request"; requestId: string; request: "question" | "approval" }
  /** `requestId` is ours; `nativeId` is the runner's id that its `request` event carried, when it had one. */
  | { kind: "answered"; requestId: string | null; by: string | null; nativeId?: string | null }
  | { kind: "message"; queued: boolean }
  | { kind: "handoff"; phase: "opened" | "completed" | "failed"; handoffId: string | null; trigger: string | null }
  | { kind: "limit"; window: string | null }
  | { kind: "retry"; detail: string | null }
  /** Hibernation: the run's process was stopped while it waited, or it woke (`by`: answer, message, resume). */
  | { kind: "hibernation"; phase: "hibernated" | "woke"; by: string | null }
  /**
   * A run-until-green or review loop decision; `iteration` is the step's fix attempts so far.
   * `memberId` is the step the loop works on (the implementer), also for a reviewer's verdict.
   */
  | { kind: "loop"; decision: LoopDecisionKind; memberId: string | null; iteration: number; max: number; reason: Reason }
  /** A report or follow-up proposal the agent sent through the report server (docs/adr/0007); untrusted text. */
  | { kind: "report"; reportId: string; report: CrewReportType; text: string; title: string | null }
);

/** A timeline event without its envelope, per kind. */
export type TimelineEventBody = TimelineEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "at" | "runId"> : never) : never;

export interface TaskTimelineData {
  taskId: string;
  events: TimelineEvent[];
  /** Older events were left out to keep the answer small; the newest are always kept. */
  omitted: number;
}

/** Bytes of a tool output's head sent to the window; the inspector shows it on demand. */
export const TIMELINE_PREVIEW = 4 * 1024;
/** At most this many events per task are sent, newest first kept. */
export const TIMELINE_MAX_EVENTS = 4000;

export interface UsageIpc {
  /** Tokens and spend over the last `days` local days (1–365), grouped by day, model, provider and task. */
  "usage.report": { params: { days: number }; result: UsageReport };
  /** The task's event log, reduced for the timeline. */
  "usage.timeline": { params: { taskId: string }; result: TaskTimelineData };
}
