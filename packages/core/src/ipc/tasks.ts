import type { AttachmentView } from "../attachments.ts";
import type { AgentEvent, EndReason, LimitWindow, Provenance, RiskLevel, RunnerId, RunState } from "../events.ts";
import type { VerdictComment } from "../results.ts";
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
 * How a task's crew is drafted: `crew` is the full plan for its kind (plan, implement, test,
 * review); `solo` is one step of the kind's main role. The run-until-green loop still runs for code.
 */
export type TaskMode = "solo" | "crew";

/**
 * What happens when a run hits a limit (PLAN.md §8.1). `wait_for_reset` resumes on the same
 * profile when its window resets within the task's wait time, otherwise it behaves like `ask`.
 * A budget cap always behaves like `manual`: nothing continues on a paid key without a click.
 */
export type FallbackMode = "manual" | "ask" | "auto" | "wait_for_reset";

export type BuiltinRoleId = "planner" | "implementer" | "reviewer" | "tester" | "researcher" | "docs" | "security";

/**
 * A built-in role, or a custom one from a role file (`.crewyard/roles/<id>.md`, PLAN.md §9.1):
 * lowercase letters, digits and dashes. `string & {}` keeps the built-in ids as suggestions.
 */
export type RoleId = BuiltinRoleId | (string & {});

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
  | "pin.dropped" // { alias, cause }: your pin for this role was not used; cause is "independence", "read_only" or "unavailable"
  | "profile.note" // { note } the profile's own "when to use" note
  | "only_candidate"
  | "no_candidate"
  | "no_independent_candidate"
  | "role.file" // { path }: the role's contract or policy comes from this role file
  // admission control: why a ready step is still queued
  | "admission.project_slots" // { used, slots }
  | "admission.profile_busy" // { used, limit, profileId }
  | "admission.global_slots" // { used, slots }
  | "admission.memory" // { freeMb, neededMb }
  | "admission.worktree_busy" // another run is writing in the task's worktree
  | "admission.no_profile" // the step has no profile; edit the crew
  | "admission.budget_reserved" // { reservedUsd, capUsd, cap }: unfinished runs hold the rest of a spend cap
  | "admission.no_adapter" // { runner } is not wired in this build
  | "admission.group_slots" // { variants, free, scope }: a Best of N group starts all its variants at once; scope is "project", "global" or "profile"
  | "admission.group_memory" // { freeMb, neededMb }: free memory for every variant of a Best of N group
  // crew loops: why the run-until-green or review loop went on or stopped
  | "loop.tests_passed" // { command }
  | "loop.tests_failed" // { command, exitCode }
  | "loop.tests_skipped" // the project has no test command in .crewyard/project.json
  | "loop.review_passed" // { sha }
  | "loop.review_changes" // { comments, sha }
  | "loop.review_invalid" // { error }
  | "loop.iteration_cap" // { max }
  | "loop.no_change" // the worktree is the same as at the last try
  | "loop.spend_cap" // { cap }
  | "loop.no_resume" // { runner }
  // Orchestra goals (docs/adr/0019): why an accepted goal task has not started; `task` is its label ("01")
  | "goal.waits_finish" // { task, taskId }
  | "goal.waits_report" // { task, taskId }: a report you have not accepted yet
  | "goal.waits_join" // { task, taskId }: finished, not merged into the goal branch yet
  | "goal.waits_overlap" // { task, taskId }: both plan to change the same files
  | "goal.prereq_failed" // { task, taskId }
  | "goal.prereq_cancelled" // { task, taskId }
  | "goal.prereq_skipped" // { task, taskId }
  | "goal.paused" // you paused the goal
  | "goal.paused_all" // Pause all goals is on
  | "goal.halted" // the goal's stop rule halted it
  | "goal.parallel_cap" // { running, max }: the goal already runs this many tasks at once
  | "goal.conflict" // { paths }: merging it into the goal branch conflicts
  | "goal.not_approved"; // the plan revision holding it is not approved

export type OrchestratorErrorCode =
  | "project.not_found"
  | "task.not_found"
  | "task.not_proposed" // approve on a task that is already approved or cancelled
  | "task.best_of_kind" // a Best of N task's kind cannot change: its variants were proposed for it
  | "task.cancelled"
  | "task.goal_managed" // the task belongs to an Orchestra goal: it starts with its plan, never through tasks.approve or tasks.edit
  | "task.start_solo_only" // tasks.start was asked for another mode: a crew is proposed for review, never started in one call
  | "crew.member_not_found"
  | "crew.missing_profile" // { role } still has no profile
  | "crew.unknown_profile" // { profileId }
  | "crew.independence" // { role } would use the implementer's model
  | "crew.read_only_profile" // { profileId, role }: the profile is marked read-only and this role writes
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
  | "run.fenced" // the run lost its step to a handoff; its late events and answers are ignored
  | "run.still_limited" // { window, resetsAt }: retry found the limit still in place
  | "handoff.same_profile" // the target is the profile the run already uses
  | "handoff.open" // the run is already being handed off
  | "handoff.target_not_ready" // { profileId }: not signed in, no key, or no adapter
  | "handoff.over_cap" // { profileId, cap }: the target's key is past its daily or per-task cap
  | "handoff.over_budget" // { spentUsd, capUsd }: the task is past its own budget and you have not approved going on
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
  | "adapter.failed" // { detail }
  // Attachments: what an upload was refused for, or why an id cannot be used
  | "attachment.type" // not a supported image, PDF or text file
  | "attachment.too_large" // { kind, max } bytes
  | "attachment.empty"
  | "attachment.too_many" // { max } per task or message
  | "attachment.not_found" // { attachmentId }
  | "attachment.claimed" // { attachmentId }: already belongs to a task or a message
  // Follow-up queue, steer, undo and stall alerts (turn control)
  | "queue.not_found" // { messageId }: no such queued message for this step
  | "queue.delivered" // { messageId }: already handed to the agent; it can no longer change
  | "queue.empty_text" // an edit to blank text; delete the message instead
  | "run.not_steerable" // { reason }: a ControlReason
  | "undo.unavailable" // { reason }: a ControlReason
  | "undo.changed" // the step moved on since the preview (a new turn, run or undo); preview again
  | "undo.partial" // { files }: some files could not be restored (open in another program); the rest were
  | "stall.not_found"
  // Best of N (feature scan A8)
  | "best_of.bad_count" // { min, max }: 2 to 4 variants
  | "best_of.too_few" // { found, needed }: not enough eligible profiles for the implement step
  | "best_of.not_found" // the task has no Best of N group, or no such variant
  | "best_of.kept" // a variant was already kept
  | "best_of.not_finished" // { variantId }: only a variant whose implement run completed can be kept
  | "best_of.not_started" // the group has not started yet
  | "best_of.over_budget" // { estimateUsd, capUsd }: the group's estimate alone passes the task budget
  | "best_of.slots" // { needed, slots }: the project or app has fewer slots than variants
  // Scheduled tasks
  | "schedule.not_found"
  | "schedule.invalid" // { field }: a field failed validation
  | "schedule.busy" // the schedule's previous run is still active, or its precheck is running
  // Hibernation
  | "run.hibernated" // the run's process is stopped while it waits; a message or an answer wakes it
  // Same-provider account switch (docs/adr/0009)
  | "switch.not_found";

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
  /** Set only when the runner cannot take a kind of attachment; it gets those as paths in the text. */
  attachments?: { images: boolean; files: boolean };
}

export interface CrewMemberView {
  id: string;
  /** DAG node id; equals the role id in the built-in plans. */
  step: string;
  role: RoleId;
  /** The title from the role file, for a custom role; built-in roles are translated by id. */
  roleTitle?: string;
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
  /** A step added to an approved crew (a follow-up): it waits for its own approval before it runs. */
  pendingApproval?: boolean;
  /** You skipped the step before it started; the steps after it go on without its result. */
  skippedAt?: string | null;
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
  /**
   * Live state, or "ended" once `endedAt` is set. Derived from facts on read. "hibernated" is its
   * own state: the process is stopped but the run is open and holds its step (never "stopped").
   */
  state: RunState | "ended" | "hibernated";
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
  /** The same messages, oldest first, editable until delivered. */
  queue: QueuedMessageView[];
  controls: RunControls;
  /** Our copy of the runner's transcript under the task folder (taken at handoff and at run end). */
  transcriptPath: string | null;
  tokensIn: number;
  tokensOut: number;
  cost: CostEstimate & { provenance: Provenance };
  /** Latest plan the agent reported. */
  plan: Array<{ title: string; status: "pending" | "in_progress" | "completed" }> | null;
  diff: Array<{ path: string; added: number; removed: number }> | null;
  /**
   * Set while the run's process is stopped to free memory and its admission slot (hibernation).
   * The run is not stopped: it holds its step and wakes by session id on the next message, on an
   * answer to its open request, or when its step continues.
   */
  hibernatedAt?: string | null;
}

/** A follow-up typed for a step while it was busy. Queued is never shown as sent. */
export interface QueuedMessageView {
  id: string;
  text: string;
  createdAt: string;
  editedAt: string | null;
  /** `note`: written by Crewyard after an undo the runner's conversation could not forget. */
  kind: "user" | "note";
  /** Images and files that go with the message; absent or empty when it has none. */
  attachments?: AttachmentView[];
}

/**
 * Why Steer now or Undo is not offered; each is an i18n key under `control.`. The button stays
 * visible and disabled with this text (PLAN.md §5.1).
 */
export type ControlReason =
  | "steer.unsupported" // the runner has no documented way to add to a running turn
  | "steer.no_turn" // no turn is running; the message goes at the next turn start
  | "steer.paused"
  | "undo.unsupported" // the runner has no documented way to rewind a turn
  | "undo.no_worktree" // the step works without a task worktree, so there is nothing of ours to restore
  | "undo.read_only" // a read-only role (planner, reviewer) changed no files
  | "undo.turn_running" // never while a turn runs
  | "undo.no_turn" // no turn with a checkpoint, or the last one was already undone
  | "undo.other_run" // another run is working in the same worktree
  | "undo.superseded" // a later run continues the step; undo that one
  | "undo.cancelled"
  | "attach.image_unsupported" // the runner has no documented image input
  | "attach.file_unsupported"; // the runner has no documented file input; it would get the path as text

export interface ControlState {
  ok: boolean;
  reason: ControlReason | null;
}

export interface RunControls {
  steer: ControlState;
  /** `turnId` is the turn an undo would remove. */
  undo: ControlState & { turnId: string | null };
  /** Attaching each kind to a message for this run's runner. Absent: both allowed. */
  attach?: { image: ControlState; file: ControlState };
}

/** A run nobody can steer or undo; what a view shows before the daemon says otherwise. */
export const NO_RUN_CONTROLS: RunControls = {
  steer: { ok: false, reason: "steer.unsupported" },
  undo: { ok: false, reason: "undo.unsupported", turnId: null },
};

const DETAIL_CODE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;

/**
 * Reads a run's `endDetail` back: a code of ours ("process_gone", "bootstrap.denied"), a code with
 * the redacted error behind it ("adapter.failed: spawn ENOENT"), or a runner's own error text
 * ("API Error: 401 …"), which has no code. The code is translatable; the text is shown as written.
 */
export function splitEndDetail(detail: string | null): { code: string | null; text: string | null } {
  const d = detail?.trim() ?? "";
  if (!d) return { code: null, text: null };
  if (DETAIL_CODE.test(d)) return { code: d, text: null };
  const sep = d.indexOf(": ");
  if (sep > 0 && DETAIL_CODE.test(d.slice(0, sep))) return { code: d.slice(0, sep), text: d.slice(sep + 2).trim() || null };
  return { code: null, text: d };
}

/** What "Undo last turn" would do, shown before you confirm. */
export interface UndoPreview {
  runId: string;
  turnId: string;
  turnStartedAt: string;
  /** From the worktree as it is now to the checkpoint taken before the turn. */
  files: Array<{ path: string; change: "restore" | "delete" | "recreate"; added: number; removed: number }>;
  /** Commits the turn added to the branch; undo moves the branch back past them (they stay reachable). */
  commits: number;
  /** What the runner's own rewind covers; git covers the files in every case. */
  native: { files: boolean; history: boolean };
  /** When the conversation cannot forget the turn, the next message to the agent carries a note. */
  noteQueued: boolean;
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
  /**
   * `native_resume` for the same runner and profile; `fork` when the target got a copy of the
   * source's session (same runner and provider, compacted where the runner can); otherwise a new
   * session fed the package. The package is written in every case.
   */
  kind: "native_resume" | "fork" | "new_session" | null;
  /** How the source was stopped: `interrupt` the turn in flight, or `drain` (let it finish first). */
  stop: HandoffStop;
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

/** How a manual handoff stops its source: interrupt the turn in flight (default), or let it finish. */
export type HandoffStop = "interrupt" | "drain";

/**
 * Crew-level loops (feature scan A9): after Implement the daemon runs the project's test command;
 * a failure goes back to the same implementer, as does a reviewer's "changes" verdict, until the
 * tests pass and the review passes, or a stop rule ends the loop. Every decision is recorded.
 */
export type LoopDecisionKind =
  | "tests_passed"
  | "tests_failed" // the failure went back to the implementer for another try
  | "tests_skipped" // the project has no test command
  | "review_passed"
  | "review_changes" // the comments went back to the implementer, then Test and Review run again
  | "review_invalid" // the reviewer's result failed its schema check; the loop does not guess
  | "stop_iteration_cap" // { max }
  | "stop_no_change" // the worktree did not change between two tries
  | "stop_spend_cap" // { cap }
  | "stop_no_resume"; // the implementer's session cannot be resumed, and it is never replaced on its own

export interface LoopDecisionView {
  id: string;
  memberId: string;
  runId: string | null;
  /** Fix attempts so far for this step, counting this one. */
  iteration: number;
  maxIterations: number;
  kind: LoopDecisionKind;
  /** A translatable reason; params carry the numbers (exit code, failing count, comments). */
  reason: Reason;
  at: string;
}

export interface TestResultView {
  id: string;
  runId: string;
  command: string;
  exitCode: number | null;
  passed: boolean;
  /** Last lines of output, redacted; for the inspector, never sent anywhere else. */
  tail: string;
  durationMs: number;
  /** The commit the result belongs to, when the worktree was committed. */
  headSha: string | null;
  at: string;
}

/** A reviewer's schema-checked verdict, pinned to the commit it read (feature scan F5, A12). */
export interface ReviewVerdictView {
  runId: string;
  memberId: string;
  verdict: "pass" | "changes";
  summary: string;
  comments: VerdictComment[];
  /** The exact commit the reviewer read in its detached checkout; null for a review outside a worktree. */
  headSha: string | null;
  /** Codex's own review/start produced it. */
  native: boolean;
  /**
   * The worktree may have moved on since (a later writer run). The merge and PR gates compare
   * `headSha` with the branch tip and never pass a verdict for another commit.
   */
  stale: boolean;
  at: string;
}

export interface TaskLoopView {
  maxIterations: number;
  decisions: LoopDecisionView[];
  tests: TestResultView[];
  verdicts: ReviewVerdictView[];
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
  /** Set when a schedule created this task (see SchedulesIpc). */
  scheduled?: { scheduleId: string; title: string; autoApproved: boolean } | null;
  /** Variants in a Best of N group, when the task has one; the phase tells the list what to show. */
  bestOf?: { n: number; phase: BestOfPhase } | null;
  /** Set on the hidden task of one Best of N variant: the visible task it belongs to. */
  variantOf?: { taskId: string; position: number; n: number } | null;
  /** Set on a task that belongs to an Orchestra goal (docs/adr/0019); it counts under its goal. */
  goal?: TaskGoalRef | null;
}

/**
 * A goal task as the task list sees it. `waiting`: accepted, not released yet (its derived status
 * reads `proposed`, but it is never offered `Review crew`). `hidden`: planning, integration,
 * discarded and not-yet-approved plan tasks, which show only inside the goal.
 */
export interface TaskGoalRef {
  goalId: string;
  key: string;
  /** 1-based place in the plan, shown as "01". */
  number: number;
  waiting: boolean;
  hold: Reason | null;
  joined: boolean;
  hidden: boolean;
  /** What the task is to the goal: a plan task, the hidden planning task, or the hidden integration task. */
  role?: "task" | "planning" | "integration";
}

// ---------------------------------------------------------------- Best of N (feature scan A8)

/**
 * `proposed`: the crew is not approved. `waiting`: approved, the group has not started (its
 * earlier steps, or admission for all variants at once). `running`: variants are working.
 * `choosing`: none is active and at least one finished; you compare and keep one. `kept`: one
 * continues the crew. `failed`: none is active and none finished.
 */
export type BestOfPhase = "proposed" | "waiting" | "running" | "choosing" | "kept" | "failed";

export interface BestOfVariantView {
  id: string;
  /** 1-based, in the order of the proposal. */
  position: number;
  candidate: CandidateView;
  /** The variant's own hidden task, once the group started; null before. */
  taskId: string | null;
  status: TaskStatus | null;
  /** Latest implement run of the variant. */
  run: RunView | null;
  /** Ended runs of the variant you can resume or retry. */
  resumableRunIds: string[];
  spend: CostEstimate;
  /** Files changed against the task's base, from git in the variant's worktree (Reported by git). */
  diffStat: { files: Array<{ path: string; added: number; removed: number }>; added: number; removed: number } | null;
  /** The variant's latest test run in its own worktree. */
  test: TestResultView | null;
  /** Its loop decisions, oldest first; the last one is its verdict (tests passed, stopped, ...). */
  decisions: LoopDecisionView[];
  branch: string | null;
  worktreePath: string | null;
  outcome: "kept" | "discarded" | null;
  /** A discarded variant's worktree was parked (WIP committed, folder removed, branch kept). */
  parkedAt: string | null;
  /** Why parking a discarded variant failed (an error code); it stays on disk until you park it. */
  parkError: string | null;
}

export interface BestOfView {
  id: string;
  /** The crew step that runs as N variants (the implementer). */
  memberId: string;
  n: number;
  phase: BestOfPhase;
  /** Every variant's estimate together; this is what the caps and reservations count. */
  estimate: CostEstimate;
  variants: BestOfVariantView[];
  startedAt: string | null;
  keptVariantId: string | null;
  keptAt: string | null;
}

// ---------------------------------------------------------------- scheduled tasks

export type ScheduleCadence = "daily" | "weekly";

/**
 * A task template that proposes a task on a schedule. The daemon keeps the timer: nothing runs
 * while Crewyard is closed, and no OS scheduler is involved.
 */
export interface ScheduleInput {
  projectId: string;
  title: string;
  description: string;
  kind?: TaskKind;
  size?: TaskSize;
  fallback?: FallbackMode;
  budgetUsd?: number | null;
  /** 2 to 4 runs the implement step as Best of N. */
  bestOf?: number | null;
  cadence: ScheduleCadence;
  /** "HH:MM", 24-hour, in `timeZone`. */
  time: string;
  /** 0 = Sunday ... 6 = Saturday; required for weekly. */
  weekday?: number | null;
  /** IANA name, e.g. "Europe/Istanbul"; the UI sends the system's. */
  timeZone: string;
  /** Run first in the project folder; exit code 0 lets the run go on, anything else skips it for free. */
  precheck?: string | null;
  /** 5 to 600 seconds; a timeout skips the run like a failure. */
  precheckTimeoutSec?: number;
  /** Approve the proposed crew without asking. Caps, approvals in the Inbox and pushes still wait for you. */
  autoApprove?: boolean;
}

export interface ScheduleView extends Required<Omit<ScheduleInput, "budgetUsd" | "bestOf" | "weekday" | "precheck">> {
  id: string;
  budgetUsd: number | null;
  bestOf: number | null;
  weekday: number | null;
  precheck: string | null;
  /** New schedules start disabled; enabling one is your click. */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** The next slot after now while enabled; null when disabled. */
  nextAt: string | null;
  /** Due slots not run yet (missed while asleep or held by a run still going), at most MAX_CATCH_UP. */
  pending: number;
  lastRun: ScheduleRunView | null;
}

/**
 * What one slot did. `skipped_precheck` costs nothing: no agent ran. `skipped_missed` records
 * slots dropped beyond the catch-up limit (`count`). `proposed` waits for your approval;
 * `approved` was auto-approved. `failed` could not create the task (`detail` is a code).
 */
export type ScheduleOutcome = "running_precheck" | "skipped_precheck" | "skipped_missed" | "proposed" | "approved" | "failed";

export interface ScheduleRunView {
  id: string;
  scheduleId: string;
  /** The slot this run belongs to; null for Run now. */
  slotAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: ScheduleOutcome;
  precheckExit: number | null;
  /** Last lines of the precheck's output, redacted. */
  precheckTail: string | null;
  taskId: string | null;
  count: number;
  detail: string | null;
  manual: boolean;
}

/** Missed slots caught up after sleep or a restart, oldest first; older ones are recorded as skipped. */
export const MAX_CATCH_UP = 3;

export interface TaskDetail extends TaskSummary {
  description: string;
  baseBranch: string | null;
  waitResetMinutes: number;
  classification: Reason[];
  crew: CrewView | null;
  runs: RunView[];
  worktree: WorktreeView | null;
  handoffs: HandoffView[];
  /** Run-until-green and review loop state; empty lists for tasks that never ran a writer. */
  loop: TaskLoopView;
  /** Best of N: the implement step as 2 to 4 variants, each in its own worktree; null without a group. */
  bestOfGroup?: BestOfView | null;
  /**
   * Whether this task lets another account of the same provider take over (docs/adr/0009). Only
   * acts while Settings has it on; absent means on.
   */
  accountSwitch?: boolean;
  /** Images and files attached to the description; every step's first prompt carries them. */
  attachments?: AttachmentView[];
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
       * Set for a worktree setup or cleanup step from .crewyard/project.json rather than an agent's
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

// ---------------------------------------------------------------- same-provider account switch (docs/adr/0009)

/** What stopped the source: a reached limit, an empty prepaid credit, or its key's daily or per-task cap. */
export type AccountSwitchTrigger = "limit" | "credit" | "spend_cap";

/** Why an account of the same provider was not taken; the same preflight every handoff target passes, plus two rules of its own. */
export type AccountSwitchRefusal =
  | "not_ready" // signed out, key missing, or no adapter for the runner
  | "claude_subscription" // Claude runs on API keys only (PLAN.md §6)
  | "other_kind" // a plan sign-in and a paid API key never switch into each other on their own
  | "role" // not allowed in the step's role (read-only preset, missing capability)
  | "independence" // the model another role must stay independent of
  | "left_before" // this step already switched away from this account
  | "over_cap" // its key is at its daily or per-task cap
  | "over_budget" // the task budget is spent
  | "headroom_low"; // 20% or less left on a window

/** What stopped the source, with where the number came from. A cap's amounts are Estimated unless billed. */
export interface AccountSwitchSource {
  window: LimitWindow | null;
  usedPct: number | null;
  provenance: Provenance;
  cap?: SpendCap | null;
}

export interface AccountSwitchSkipped {
  profileId: string;
  alias: string;
  reason: AccountSwitchRefusal;
}

/**
 * One automatic switch to another account of the same provider. `outcome` follows the handoff it
 * opened: pending until the target confirmed, then completed or failed (the source then asks in
 * the Inbox as after any failed handoff).
 */
export interface AccountSwitchView {
  id: string;
  taskId: string;
  projectId: string;
  memberId: string;
  fromRunId: string;
  toRunId: string | null;
  handoffId: string | null;
  runner: RunnerId;
  providerId: string;
  from: { profileId: string; alias: string };
  to: { profileId: string; alias: string };
  trigger: AccountSwitchTrigger;
  source: AccountSwitchSource;
  /** The target's headroom and the step's estimate on it, when the switch was decided. */
  headroom: Headroom;
  estimate: CostEstimate;
  /** Accounts of the provider tried before the target, with why each was passed over. */
  skipped: AccountSwitchSkipped[];
  outcome: "pending" | "completed" | "failed";
  at: string;
  dismissedAt: string | null;
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

export type StallRule = "no_events" | "same_failure" | "request_unanswered";

/** Pushed as `stall.notice` when a rule fires, in the shape of a limit notice (feature scan A7). */
export interface StallNoticePayload {
  alertId: string;
  rule: StallRule;
  projectId: string;
  taskId: string;
  runId: string | null;
  requestId: string | null;
  /** no_events and request_unanswered: how long it has been quiet. */
  minutes: number | null;
  /** same_failure: how many runs in a row ended with it. */
  count: number | null;
  /** same_failure: the failure class (FailureKind) and its HTTP status, if any. */
  detail: string | null;
  observedAt: string;
}

/** The Inbox item behind a stall notice. It closes on its own when the run moves again. */
export interface StallAlertView extends StallNoticePayload {
  dismissedAt: string | null;
  /** Set by the daemon when the condition went away (events resumed, request answered, run ended). */
  clearedAt: string | null;
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
      /** 2 to 4: the implement step runs on that many profiles in parallel, each in its own worktree. */
      bestOf?: number;
      /** Ids from attachments.add; they move into the task's folder. */
      attachments?: string[];
      /** `solo` drafts one step of the kind's main role; absent means `crew`. */
      mode?: TaskMode;
    };
    result: TaskDetail;
  };
  /**
   * A dry run of `tasks.propose`: classification, the crew it would draft and its estimate.
   * Writes nothing; the composer calls it while you type to show the price on the button.
   */
  "tasks.preview": { params: TaskPreviewParams; result: TaskPreview };
  /**
   * Solo's `Start`: proposes a one-step task and approves its crew in the same call. When the
   * estimate is Unknown, a cap would hold the step, or the crew has a problem, nothing is approved
   * and the proposal comes back with `held`, so spend nobody can price still needs your click.
   * Only Solo starts this way: any other `mode` is refused with `task.start_solo_only`, and Best of
   * N is not taken, because a crew is proposed so that you review it first.
   */
  "tasks.start": { params: Omit<TaskPreviewParams, "mode"> & { mode?: "solo"; baseBranch?: string; fallback?: FallbackMode; waitResetMinutes?: number; attachments?: string[] }; result: TaskStartResult };
  /**
   * Approves the crew, optionally with edits (remembered as preferences), and lets the scheduler
   * start ready steps under admission control. Fails with `crew.missing_profile` or
   * `crew.independence` instead of starting a crew that breaks the rules.
   */
  "tasks.approve": { params: { taskId: string; edits?: CrewEdit[]; fallback?: FallbackMode; bestOf?: { profileIds: string[] }; accountSwitch?: boolean }; result: TaskDetail };
  /** Lets this task's steps switch to another account of the same provider, or holds them out (docs/adr/0009). */
  "tasks.setAccountSwitch": { params: { taskId: string; enabled: boolean }; result: TaskDetail };
  /**
   * Keeps one finished Best of N variant: its worktree and session continue the crew (test,
   * review, PR). Every other variant is stopped and its worktree parked (WIP committed, folder
   * removed, branch kept). The UI asks you to confirm first.
   */
  "tasks.keepVariant": { params: { taskId: string; variantId: string }; result: TaskDetail };
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
   * `attachments` are ids from attachments.add; with them, `text` may be empty.
   */
  "runs.message": { params: { runId: string; text: string; attachments?: string[] } & SessionSeen; result: RunView };
  /**
   * Stores an image or file (base64 `data`) for a task description or a message, before either
   * exists: a paste, a drop, the file picker, or a screenshot from Crewyard itself. Refused with
   * `attachment.type`, `attachment.too_large` or `attachment.empty`. Unused uploads are removed
   * after a day.
   */
  "attachments.add": { params: { name: string; data: string }; result: AttachmentView };
  /** Removes an upload that no task or message uses yet (you took it out of the composer). */
  "attachments.discard": { params: { id: string }; result: { id: string } };
  /** An image's bytes as a data URL, for its thumbnail; files have none (`attachment.type`). */
  "attachments.preview": { params: { id: string }; result: { dataUrl: string } };
  /**
   * Moves the step to another profile now (the Crew graph's "Change AI"), through the same durable
   * handoff as a limit, with trigger `manual`: stop at a turn boundary, checkpoint, package, start
   * the target. Works on a live, paused, limited, failed or stopped run; the target must pass the
   * role, independence, readiness and spend-cap preflight. Returns the source run.
   */
  "runs.handoff": { params: { runId: string; targetProfileId: string; stop?: HandoffStop }; result: RunView };
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
  /**
   * Edits a queued follow-up of the run's step. Refused with `queue.delivered` once the agent has
   * it; edits never reach the agent in part.
   */
  "queue.edit": { params: { runId: string; messageId: string; text: string }; result: RunView };
  "queue.delete": { params: { runId: string; messageId: string }; result: RunView };
  /** Moves a queued message to `index` (0 = sent first). */
  "queue.move": { params: { runId: string; messageId: string; index: number }; result: RunView };
  /**
   * "Steer now": sends one queued message into the turn in flight, where the runner supports it
   * (Codex `turn/steer`). Refused with `run.not_steerable` and a ControlReason otherwise; the
   * message stays queued.
   */
  "queue.steer": { params: { runId: string; messageId: string } & SessionSeen; result: RunView };
  /** What undo would change; nothing is touched. Fails with `undo.unavailable` and a ControlReason. */
  "runs.undoPreview": { params: { runId: string }; result: UndoPreview };
  /**
   * Undoes the turn the preview named: the runner's own rewind where it has one, then the worktree
   * back to the git checkpoint taken before the turn (the state before undo is kept under
   * refs/crewyard/undo/). Never while a turn runs; `undo.changed` when the step moved on.
   */
  "runs.undo": { params: { runId: string; turnId: string }; result: RunView };
  /** Open stall alerts by default, newest first. */
  "stalls.list": { params: { projectId?: string; taskId?: string; includeClosed?: boolean }; result: StallAlertView[] };
  "stalls.dismiss": { params: { alertId: string }; result: StallAlertView };
  /** Automatic switches to another account of the same provider, newest first; dismissed ones only on request. */
  "switches.list": { params: { projectId?: string; taskId?: string; includeDismissed?: boolean }; result: AccountSwitchView[] };
  /** Takes a switch off the Inbox; the record and its timeline entry stay. */
  "switches.dismiss": { params: { switchId: string }; result: AccountSwitchView };
  /** Every schedule of a project, or of all projects. */
  "schedules.list": { params: { projectId?: string }; result: ScheduleView[] };
  /** Creates a schedule (disabled) or, with `id`, edits one. Fails with `schedule.invalid` and the field. */
  "schedules.save": { params: ScheduleInput & { id?: string }; result: ScheduleView };
  /** Enabling starts counting slots from now; slots before it are never caught up. */
  "schedules.setEnabled": { params: { id: string; enabled: boolean }; result: ScheduleView };
  "schedules.delete": { params: { id: string }; result: { id: string } };
  /** Newest first. */
  "schedules.runs": { params: { id: string; limit?: number }; result: ScheduleRunView[] };
  /**
   * Proposes the task now, without the precheck (you are asking for it). Refused with
   * `schedule.busy` while its previous run is still active. Approval rules are the same.
   */
  "schedules.runNow": { params: { id: string }; result: ScheduleRunView };
}

export interface TaskPreviewParams {
  projectId: string;
  title: string;
  description?: string;
  kind?: TaskKind;
  size?: TaskSize;
  budgetUsd?: number;
  pins?: Partial<Record<RoleId, string>>;
  exclude?: string[];
  mode?: TaskMode;
}

export interface TaskPreview {
  kind: TaskKind;
  size: TaskSize;
  mode: TaskMode;
  classification: Reason[];
  members: CrewMemberView[];
  estimate: CostEstimate;
  /**
   * Set when `tasks.start` would propose instead of starting, so Solo's button reads `Propose`
   * before the click. A hint only: `tasks.start` checks again against the stored proposal.
   */
  hold?: TaskStartHold | null;
}

/** Why `tasks.start` proposed instead of starting: `estimate_unknown`, `over_cap` { cap }, or `crew` { code } (a crew.* refusal). */
export interface TaskStartHold {
  code: "estimate_unknown" | "over_cap" | "crew";
  params?: Record<string, string | number>;
}

export interface TaskStartResult {
  task: TaskDetail;
  started: boolean;
  held: TaskStartHold | null;
}

/** Live topics pushed through ctx.emit; the renderer re-reads with tasks.get when it needs more. */
export interface TasksTopics {
  "tasks.changed": { taskId: string; projectId: string; status: TaskStatus; cause: TaskChangeCause };
  "requests.changed": { requestId: string; taskId: string; projectId: string; open: boolean };
  "runs.event": { taskId: string; runId: string; event: AgentEvent };
  "limits.notice": LimitNoticePayload;
  "stall.notice": StallNoticePayload;
  "stalls.changed": { alertId: string; taskId: string; projectId: string; open: boolean };
  "schedules.changed": { scheduleId: string; projectId: string };
  "switches.changed": { switchId: string; taskId: string; projectId: string };
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
  | "queue"
  | "undone"
  | "admission"
  | "recovered"
  // The GitHub work: the task's pull request was opened, linked, merged or closed.
  | "pull_request"
  // A run-until-green or review loop decision (tests, verdict, stop rule).
  | "loop"
  // A Best of N group started, a variant changed, or one was kept.
  | "best_of"
  // A run's process was stopped while idle, or woke again.
  | "hibernation"
  // The task let in or held out same-provider account switching (docs/adr/0009).
  | "account_switch"
  // The crew was edited in the Crew graph: a proposal edit, a follow-up, a skip or its approval.
  | "crew_edited"
  // The title, description or kind of a task that had not started changed (docs/adr/0017).
  | "edited"
  // Its Orchestra goal released, held, merged or discarded it (docs/adr/0019).
  | "goal";
