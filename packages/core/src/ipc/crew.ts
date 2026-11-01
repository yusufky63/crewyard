import type { CrewProposalEdit } from "../crew-edit.ts";
import type { CandidateView, RoleId, TaskDetail } from "./tasks.ts";

// IPC methods for the Crew graph screen. Owned by the crew graph work; other work only reads it.
// Implemented in packages/daemon/src/handlers/crew.ts.
//
// The graph layout is presentation only: moving a node never changes who does the work, so the
// layout methods touch nothing but the saved node positions of one task. Changing the crew itself
// goes through the separate, explicit methods of CrewManageIpc below.

export interface NodePosition {
  x: number;
  y: number;
}

export interface CrewLayout {
  taskId: string;
  /** Saved positions by graph node id; nodes missing here use the default layout. */
  positions: Record<string, NodePosition>;
  savedAt: string | null;
}

/** Upper bounds the daemon enforces, so a bad renderer call cannot bloat the settings table. */
export const CREW_LAYOUT_LIMITS = { nodes: 200, idLength: 120, coordinate: 100_000 } as const;

export interface CrewIpc extends CrewManageIpc {
  "crew.layout.get": { params: { taskId: string }; result: CrewLayout };
  /** Replaces the saved positions of the task. Rejects non-finite or out-of-range coordinates. */
  "crew.layout.save": { params: { taskId: string; positions: Record<string, NodePosition> }; result: CrewLayout };
  /** Forgets the saved positions, so the default layout applies again. */
  "crew.layout.reset": { params: { taskId: string }; result: CrewLayout };
}

// ---------------------------------------------------------------- managing the crew (PLAN.md §9 step 6)
//
// Edits change who works and in what order, so each is an explicit call, never a side effect of
// moving a node. Proposal edits are stored on the draft crew and still wait for `Approve and
// start`; a follow-up added to a running crew waits for `crew.approveSteps`. The rules live in
// crew-edit.ts; a refused edit throws `crew.<CrewEditRefusal>` with its params.

/** Result of Pause all / Resume all: the runs it acted on, and how many it left alone. */
export interface CrewBulkResult {
  taskId: string;
  runIds: string[];
  /** Runs that could not take the action now (handing off, already ended, already paused). */
  skipped: number;
}

export interface CrewManageIpc {
  /**
   * Every eligible candidate for a role in this task's project, scored as the proposal scores
   * them, best first. Candidates that would break the independence rule are included; the UI marks
   * them with the reason. No process or network call.
   */
  "crew.candidates": { params: { taskId: string; role: RoleId }; result: CandidateView[] };
  /** Applies one edit to the draft crew, or to a follow-up step still waiting for approval. */
  "crew.edit": { params: { taskId: string; edit: CrewProposalEdit }; result: TaskDetail };
  /**
   * Changes the AI of a step that has not started yet: a proposal step, a follow-up waiting for
   * approval, or a step of the approved crew still waiting for its turn. The profile must be one
   * `crew.candidates` scores for the step's role; the independence rule, the read-only check and
   * the standby shuffle are those of `crew.edit`'s set_candidate. Refused with `crew.started`
   * once the step has a run, and with `crew.skipped` or `crew.best_of` where set_candidate would
   * not apply. Nothing starts: the step keeps its place and waits for the scheduler as before.
   */
  "crew.changeProfile": { params: { taskId: string; memberId: string; profileId: string }; result: TaskDetail };
  /** Approves every follow-up step of a running crew; they start under admission control. */
  "crew.approveSteps": { params: { taskId: string }; result: TaskDetail };
  /** Skips a step that has not started; the steps that wait for it go on without its result. */
  "crew.skip": { params: { taskId: string; memberId: string }; result: TaskDetail };
  /** Pauses every live run of the task at its next turn boundary. */
  "crew.pauseAll": { params: { taskId: string }; result: CrewBulkResult };
  /** Continues every paused run of the task. Never restarts an ended one. */
  "crew.resumeAll": { params: { taskId: string }; result: CrewBulkResult };
}
