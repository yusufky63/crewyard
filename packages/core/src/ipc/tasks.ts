import type { AgentEvent, EndReason, LimitWindow, Provenance, RiskLevel, RunnerId, RunState } from "../events.ts";
import type { TaskStatus } from "../state.ts";

// IPC methods for tasks, crews, runs, requests (Inbox), limits and handoffs. Owned by the orchestrator backend; other work only reads it.
// Implemented in packages/daemon/src/handlers/tasks.ts on top of packages/daemon/src/orchestrator.
//
// Everything the user reads is a code plus parameters, never an English sentence, so the renderer
// translates it (reasons, blocked-by, triggers). Errors thrown by these methods carry a code as
// their message, e.g. "task.not_found" or "crew.independence"; see OrchestratorErrorCode.

export type TaskKind = "code" | "research" | "review" | "docs";
export type TaskSize = "S" | "M" | "L";

/**
 * What happens when a run hits a limit (PLAN.md §8.1). `wait_for_reset` resumes on the same
 * profile when its window resets within the task's wait time, otherwise it behaves like `ask`.
 * A budget cap always behaves like `manual`: nothing continues on a paid key without a click.
 */
export type FallbackMode = "manual" | "ask" | "auto" | "wait_for_reset";

export type RoleId = "planner" | "implementer" | "reviewer" | "tester" | "researcher" | "docs" | "security";

/** A translatable explanation: `code` is an i18n key suffix, `params` fill its placeholders. */
export interface Reason {
  code: ReasonCode;
  params?: Record<string, string | number>;
}

export type ReasonCode =
  // task classification
  | "classify.keyword" // { keyword, kind }
  | "classify.explicit" // kind or size given by the user
  | "classify.length" // { chars, size }
  | "classify.default"
  // candidate scoring
  | "fit.reasoning" // model reasons, preferred for this role
  | "fit.context" // { context } tokens, enough for the task size
  | "fit.context_small" // { context, needed }
  | "fit.model_unknown" // the catalog has no entry for the model
  | "headroom" // { pct, provenance, window }
  | "headroom.unknown"
  | "headroom.low" // { pct, window }, under the 20% handoff line
  | "cost.estimate" // { usd }, estimated from catalog price × expected tokens
  | "cost.plan" // runs on a plan or local model, no per-token cost
  | "cost.unknown"
  | "cost.over_budget" // { usd, budget }
  | "history.accepted" // { accepted, total }
  | "history.preferred" // you picked this profile for this role before
  | "independence.provider" // reviewer on a different provider than the implementer
  | "independence.model" // { model } of the implementer, which this candidate does not share
  | "pinned"
  | "only_candidate"
  | "no_candidate"
  | "no_independent_candidate"
  // admission control: why a ready step is still queued
  | "admission.project_slots" // { used, slots }
  | "admission.profile_busy" // { used, limit, profileId }
  | "admission.global_slots" // { used, slots }
  | "admission.memory" // { freeMb, neededMb }
  | "admission.worktree_busy" // another run is writing in the task's worktree
  | "admission.no_profile" // the step has no profile; edit the crew
  | "admission.budget_reserved" // { reservedUsd, capUsd, cap }: unfinished runs hold the rest of a spend cap
  | "admission.no_adapter"; // { runner } is not wired in this build

export type OrchestratorErrorCode =
  | "project.not_found"
  | "task.not_found"
  | "task.not_proposed" // approve on a task that is already approved or cancelled
  | "task.cancelled"
  | "crew.member_not_found"
  | "crew.missing_profile" // { role } still has no profile
  | "crew.unknown_profile" // { profileId }
  | "crew.independence" // { role } would use the implementer's model
  | "run.not_found"
  | "run.not_live" // no process to talk to
  | "run.ended"
  | "run.not_resumable"
  | "run.resume_unsupported" // { runner }
  | "request.not_found"
  | "request.answered"
  | "request.answer_kind" // the answer does not fit the request kind
  | "request.always_high_risk" // "always allow" is never offered for high risk
  | "request.no_target" // a handoff answer without a target
  | "request.no_reset" // wait for reset without a known reset time
  | "request.not_budget" // "continue" answers only a budget, spend-cap or unknown-price pause
  | "run.session_changed" // { runId }: a handoff or a later run took over the step since you looked; re-read and ask again
  | "run.price_unknown" // continuing needs your approval in the Inbox: the model has no known price and the task has a cap
  | "run.superseded" // a later run already continues this step
  | "run.still_limited" // { window, resetsAt }: retry found the limit still in place
  | "handoff.same_profile" // the target is the profile the run already uses
  | "handoff.open" // the run is already being handed off
  | "handoff.target_not_ready" // { profileId }: not signed in, no key, or no adapter
  | "handoff.over_cap" // { profileId, cap }: the target's key is past its daily or task cap
  | "git.failed" // { command, detail }
  | "worktree.branch_elsewhere" // { branch, path }: the task's branch is checked out in another worktree
  | "worktree.locked" // { path }: registered, folder missing, and locked with `git worktree lock`
  | "worktree.path_taken" // { path }: a folder that git does not know is already there; never deleted
  | "worktree.bad_branch" // { branch }: not a name git accepts (git check-ref-format)
  | "worktree.base_missing" // { base }: the base branch or commit does not resolve
  | "worktree.base_dangling" // { base, ref, target }: a symbolic ref (origin/HEAD) points at a deleted branch
  | "bootstrap.setup_failed" // { command }: a setup step failed; its log tail is on the worktree
  | "bootstrap.denied" // a setup or cleanup step was denied in the Inbox
  | "worktree.not_found" // the task has no worktree
  | "worktree.running" // park refused: a run of the task has not ended
  | "worktree.parked" // the worktree is parked already
  | "worktree.not_parked" // unpark on a worktree whose folder is there
  | "worktree.cleanup_needs_approval" // a cleanup step waits in the Inbox; the worktree stays
  | "worktree.cleanup_failed" // { command }: a cleanup step failed; the worktree stays
  | "adapter.failed"; // { detail }

export interface CostEstimate {
  usd: number | null;
  /** Always "estimated" or "unknown": these are forecasts, not bills. */
  provenance: Provenance;
}

export interface Headroom {
  /** 100 - used % on the tightest window; null when Unknown. */
  pct: number | null;
  window: LimitWindow | null;
  provenance: Provenance;
}

export interface CandidateView {
  profileId: string;
  alias: string;
  runner: RunnerId;
  providerId: string;
  model: string | null;
  score: number;
  headroom: Headroom;
  estimate: CostEstimate;
  reasons: Reason[];
}

export interface CrewMemberView {
  id: string;
  /** DAG node id; equals the role id in the built-in plans. */
  step: string;
  role: RoleId;
  dependsOn: string[];
  required: boolean;
  /** Code-writing steps get the task's git worktree; read-only steps run inside it once it exists. */
  writesCode: boolean;
  /** Chosen candidate; null when nothing fits and the user must edit the crew before approving. */
  chosen: CandidateView | null;
  /** Next candidates for handoff, in order (PLAN.md §9 step 5). */
  standby: CandidateView[];
  /** Explains a missing choice (`no_candidate`, `no_independent_candidate`). */
  reasons: Reason[];
  /** True when the user changed the proposal. */
  edited: boolean;
  /** Set while the step is ready but admission control holds it back. */
  blockedBy: Reason | null;
}

export interface CrewView {
  id: string;
  proposedAt: string;
  approvedAt: string | null;
  estimate: CostEstimate;
  members: CrewMemberView[];
}

export interface RunView {
  id: string;
  taskId: string;
  memberId: string;
  role: RoleId;
  profileId: string;
  runner: RunnerId;
  model: string | null;
  /** Live state, or "ended" once `endedAt` is set. Derived from facts on read. */
  state: RunState | "ended";
  cwd: string;
  worktreeId: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: EndReason | null;
  /** Code such as "process_gone", "adapter_error", "user_stop". */
  endDetail: string | null;
  lastActivityAt: string | null;
  pausedAt: string | null;
  /** Wait-for-reset: when this run resumes on its own. */
  resumeAt: string | null;
  limitReached: boolean;
  pendingRequestId: string | null;
  handoffId: string | null;
  resumedFrom: string | null;
  nativeSessionId: string | null;
  /** Messages for this step that wait for a live run (see runs.message). */
  queuedMessages: number;
  tokensIn: number;
  tokensOut: number;
  cost: CostEstimate & { provenance: Provenance };
  /** Latest plan the agent reported. */
  plan: Array<{ title: string; status: "pending" | "in_progress" | "completed" }> | null;
  diff: Array<{ path: string; added: number; removed: number }> | null;
}

export interface WorktreeView {
  id: string;
  path: string;
  branch: string;
  baseSha: string;
  ownerRunId: string | null;
  createdAt: string;
}

/** `manual` is a hand off you asked for (runs.handoff); the others come from the run. */
export type HandoffTrigger = "limit" | "budget" | "crashed" | "manual";
export type HandoffOutcome = "completed" | "failed" | "cancelled" | "interrupted";

/**
 * Durable checkpoints of PLAN.md §8.2, written before each step starts. An interrupted handoff
 * keeps the phase it died in as its `detail`.
 */
export type HandoffPhase = "stopping_source" | "checkpoint" | "starting_target" | "confirming" | "closed";

export interface HandoffView {
  id: string;
  fromRunId: string;
  toRunId: string | null;
  targetProfileId: string | null;
  mode: FallbackMode;
  /** `native_resume` for the same runner and profile, otherwise a new session fed the package. */
  kind: "native_resume" | "new_session" | null;
  trigger: HandoffTrigger;
  phase: HandoffPhase;
  /** Markdown handoff package under the task folder (PLAN.md §8.2 step 5). */
  packagePath: string | null;
  checkpointSha: string | null;
  openedAt: string;
  closedAt: string | null;
  outcome: HandoffOutcome | null;
  detail: string | null;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  title: string;
  kind: TaskKind;
  size: TaskSize;
  status: TaskStatus;
  fallback: FallbackMode;
  budgetUsd: number | null;
  /** Sum of run costs; provenance is the weakest of the parts. */
  spend: CostEstimate;
  createdAt: string;
  cancelledAt: string | null;
  openRequests: number;
  activeRuns: number;
  /**
   * Ended runs that can be resumed (interrupted by a restart, stopped by you, failed). Status
   * alone reads "queued" for these, so the UI uses this list to offer Resume.
   */
  resumableRunIds: string[];
}

export interface TaskDetail extends TaskSummary {
  description: string;
  baseBranch: string | null;
  waitResetMinutes: number;
  classification: Reason[];
  crew: CrewView | null;
  runs: RunView[];
  worktree: WorktreeView | null;
  handoffs: HandoffView[];
}

export type RequestKind = "question" | "approval" | "handoff";

export type RequestPayload =
  | {
      kind: "question";
      questions: Array<{ prompt: string; options: Array<{ label: string; description?: string }>; allowFreeText: boolean }>;
    }
  | {
      kind: "approval";
      toolCallId: string | null;
      command: string | null;
      cwd: string | null;
      paths: string[];
      network: boolean;
      /** Why the policy decided on its own, when it did (e.g. `policy.allowlisted`, `policy.role_read_only`). */
      policy: string | null;
      /**
       * Set for a worktree setup or cleanup step from .mission/project.json rather than an agent's
       * tool call. Allow once approves this exact text (by its sha256) for the project from then on.
       */
      bootstrap?: { phase: "setup" | "cleanup"; hash: string } | null;
    }
  | {
      kind: "handoff";
      /** `unpriced`: the step's model has no known price and the task has a cap (see `unpriced`). */
      trigger: HandoffTrigger | "handoff_failed" | "unpriced";
      window: LimitWindow | null;
      resetsAt: string | null;
      /** Filled in Ask mode; Manual leaves the choice to you. */
      proposedTarget: CandidateView | null;
      /** Standby candidates that passed preflight. */
      candidates: CandidateView[];
      /** Code for why no target was proposed or why a handoff failed. */
      detail: string | null;
      /** Set when spend paused the run (trigger "budget"); answering `continue` approves going past it. */
      cap?: SpendCap | null;
      /** Set for trigger "unpriced"; answering `continue` approves unpriced spend for this run. */
      unpriced?: UnpricedSpend | null;
    };

/**
 * Which spend limit paused a run: the task's own budget, or the credential's daily or per-task cap
 * from the Limits screen. Amounts are Estimated unless the provider billed them.
 */
export interface SpendCap {
  kind: "task_budget" | "daily_cap" | "task_cap";
  spentUsd: number;
  capUsd: number;
  credentialId: string | null;
  /** Held by other unfinished runs for their estimates; set only when some is. */
  reservedUsd?: number;
  /** This step's own estimate, reserved before it starts; set only for a start that did not fit. */
  estimateUsd?: number;
}

/**
 * Set on a request with trigger `unpriced`: the step's model has no catalog price and the runner
 * reported none, so its spend would count against none of these caps until you approve it.
 */
export interface UnpricedSpend {
  model: string | null;
  caps: Array<SpendCap["kind"]>;
}

export type RequestAnswer =
  | { kind: "question"; answers: Array<{ selected: string[]; text?: string }> }
  /** `message` goes with a deny to the agent, so it can change course instead of retrying the same call. */
  | { kind: "approval"; decision: "allow_once" | "allow_always" | "deny"; message?: string }
  /**
   * `continue` is only for a budget or unknown-price pause: it approves spend past that cap (or
   * without a price) for this run until it ends; a resumed or retried run asks again.
   */
  | { kind: "handoff"; decision: "hand_off" | "wait_for_reset" | "stop" | "continue"; targetProfileId?: string }
  | { kind: "cancel" };

export interface RequestView {
  id: string;
  taskId: string;
  projectId: string;
  runId: string | null;
  /** The run's native session as the daemon has it now; send it back with the answer (see SessionSeen). */
  sessionId: string | null;
  kind: RequestKind;
  /** Set for approvals by the daemon's classifier, never by the agent. */
  risk: RiskLevel | null;
  payload: RequestPayload;
  createdAt: string;
  answeredAt: string | null;
  answer: RequestAnswer | null;
  /** `policy` for low-risk allowlisted approvals and role denials, `system` when a run went away. */
  answeredBy: "user" | "policy" | "system" | null;
}

export type LimitNoticeKind = "warn" | "critical" | "ahead_of_pace" | "reached";

export interface LimitNoticePayload {
  kind: LimitNoticeKind;
  profileId: string;
  window: LimitWindow;
  /** The limit bucket the window belongs to; absent or null is the account's main limit. */
  bucket?: string | null;
  usedPct: number | null;
  resetsAt: string | null;
  provenance: Provenance;
  /** Ahead of pace only: minutes until full at the current burn rate. */
  minutesUntilFull: number | null;
  runId: string | null;
  taskId: string | null;
  observedAt: string;
}

export interface CrewEdit {
  memberId: string;
  profileId: string;
  /** Overrides the profile's default model. */
  model?: string;
}

/**
 * What the UI saw when you clicked: the run and its native session. A stop, pause, message or
 * answer that no longer matches (a handoff, resume or retry took over the step in between) is
 * refused with `run.session_changed`, and the UI re-reads and asks again. A null session means
 * the run had none yet and matches whatever it has now.
 */
export interface SessionSeen {
  sessionId: string | null;
}

export interface TasksIpc {
  /** Newest first. Status is derived on read with deriveTaskStatus. */
  "tasks.list": { params: { projectId?: string }; result: TaskSummary[] };
  "tasks.get": { params: { taskId: string }; result: TaskDetail };
  /**
   * Classifies the task and stores a draft crew. No process, worktree or network call happens.
   * `kind` and `size` override the classifier; `pins` force a profile for a role, `exclude` removes
   * profiles from every role.
   */
  "tasks.propose": {
    params: {
      projectId: string;
      title: string;
      description?: string;
      kind?: TaskKind;
      size?: TaskSize;
      baseBranch?: string;
      fallback?: FallbackMode;
      budgetUsd?: number;
      waitResetMinutes?: number;
      pins?: Partial<Record<RoleId, string>>;
      exclude?: string[];
    };
    result: TaskDetail;
  };
  /**
   * Approves the crew, optionally with edits (remembered as preferences), and lets the scheduler
   * start ready steps under admission control. Fails with `crew.missing_profile` or
   * `crew.independence` instead of starting a crew that breaks the rules.
   */
  "tasks.approve": { params: { taskId: string; edits?: CrewEdit[]; fallback?: FallbackMode }; result: TaskDetail };
  /** Stops every run of the task and closes its open requests. Worktrees are kept. */
  "tasks.cancel": { params: { taskId: string }; result: TaskDetail };
  /** Interrupts at a turn boundary; the run stays open and holds no slot. */
  "runs.pause": { params: { runId: string } & SessionSeen; result: RunView };
  /**
   * Continues a paused run, or resumes an ended (interrupted, stopped, failed) run natively as a new
   * run of the same step. Never restarts anything on its own.
   */
  "runs.resume": { params: { runId: string }; result: RunView };
  /** Ends the run and its process tree. Closing a panel never calls this. */
  "runs.stop": { params: { runId: string } & SessionSeen; result: RunView };
  /**
   * Sends a message to a live run. While the step has no live process (paused, limited, handing
   * off, interrupted) the message waits in the step's outbox and goes to whichever run continues
   * the step: a resume, a reset or a handoff target. Fails with `run.ended` for a completed run.
   */
  "runs.message": { params: { runId: string; text: string } & SessionSeen; result: RunView };
  /**
   * Moves the step to another profile now (the Crew graph's "Change AI"), through the same durable
   * handoff as a limit, with trigger `manual`: stop at a turn boundary, checkpoint, package, start
   * the target. Works on a live, paused, limited, failed or stopped run; the target must pass the
   * role, independence, readiness and spend-cap preflight. Returns the source run.
   */
  "runs.handoff": { params: { runId: string; targetProfileId: string }; result: RunView };
  /**
   * "Check again". A failed, stopped or interrupted step starts a fresh run of the same member on
   * the same profile. A run paused on a limit or a spend cap re-checks now and continues when it
   * cleared, or fails with `run.still_limited`. Any other open run re-runs admission for queued
   * steps. Never starts anything for a completed or superseded run.
   */
  "runs.retry": { params: { runId: string }; result: RunView };
  /** Open requests by default, oldest first. */
  "requests.list": { params: { projectId?: string; taskId?: string; includeAnswered?: boolean }; result: RequestView[] };
  /** Resolves a request; the same record backs the Inbox, the inspector and toasts. */
  "requests.answer": { params: { requestId: string; answer: RequestAnswer; runId: string | null } & SessionSeen; result: RequestView };
}

/** Live topics pushed through ctx.emit; the renderer re-reads with tasks.get when it needs more. */
export interface TasksTopics {
  "tasks.changed": { taskId: string; projectId: string; status: TaskStatus; cause: TaskChangeCause };
  "requests.changed": { requestId: string; taskId: string; projectId: string; open: boolean };
  "runs.event": { taskId: string; runId: string; event: AgentEvent };
  "limits.notice": LimitNoticePayload;
}

export type TaskChangeCause =
  | "proposed"
  | "approved"
  | "cancelled"
  | "run_started"
  | "run_ended"
  | "run_paused"
  | "run_resumed"
  | "request"
  | "limit"
  | "handoff_opened"
  | "handoff_completed"
  | "handoff_failed"
  | "retried"
  | "admission"
  | "recovered"
  // The GitHub work: the task's pull request was opened, linked, merged or closed.
  | "pull_request";
