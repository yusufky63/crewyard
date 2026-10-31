import type { AssistantSpendLabel, TaskDraftInput } from "../assistant.ts";
import type { RunnerId } from "../events.ts";
import type { TaskKind, TaskSize } from "./tasks.ts";

// IPC methods for the task assistant (docs/adr/0014). Owned by the assistant work; implemented in
// packages/daemon/src/handlers/assistant.ts. The rules for drafts live in ../assistant.ts.

/**
 * - `idle`: no process; the next message starts or resumes one.
 * - `starting`: the runner is being started.
 * - `working`: a turn is running.
 * - `waiting`: the runner waits for your next message.
 */
export type AssistantState = "idle" | "starting" | "working" | "waiting";

/** Why the last session ended or could not start; an i18n code under `assistant.ended.*`. */
export type AssistantEnd =
  | "closed"
  /** The runner ended the session on its own. */
  | "ended"
  | "idle"
  | "cleared"
  | "daily_cap"
  | "failed"
  | "no_profile"
  | "not_eligible"
  | "admission"
  | "shutdown";

export interface AssistantLine {
  id: string;
  /** `tool`: the runner's title for a read or search; `notice`: Crewyard's own line (stopped, resumed). */
  role: "user" | "assistant" | "tool" | "notice";
  /** Untrusted for `assistant` and `tool`: cleaned, capped, render as text only. For `notice`, an i18n code. */
  text: string;
  at: string;
  /** A message you sent while a turn was running; it goes at the next turn boundary. */
  queued?: boolean;
  /** The reply was longer than the cap and was cut. */
  truncated?: boolean;
}

export interface AssistantDraftView extends TaskDraftInput {
  id: string;
  conversationId: string;
  status: "open" | "added" | "discarded";
  /** The task this draft became; it still waits for its crew approval. */
  taskId: string | null;
  createdAt: string;
}

export interface AssistantSpend {
  /** USD for this conversation; null when any part had no price (Unknown) or for a plan. */
  usd: number | null;
  label: AssistantSpendLabel;
  tokensIn: number;
  tokensOut: number;
}

export interface AssistantView {
  projectId: string;
  conversationId: string | null;
  profileId: string | null;
  profileAlias: string | null;
  runner: RunnerId | null;
  model: string | null;
  state: AssistantState;
  /** Why the last session ended; null while one runs or before the first. */
  ended: AssistantEnd | null;
  /** A provider or runner failure, redacted and capped; untrusted text. */
  detail: string | null;
  lines: AssistantLine[];
  drafts: AssistantDraftView[];
  spend: AssistantSpend;
  /** Idle minutes before the process is stopped (the hibernation setting). */
  idleMinutes: number;
}

export interface AssistantProfileOption {
  profileId: string;
  alias: string;
  runner: RunnerId;
  providerId: string;
  model: string | null;
  /** Null when it can run the assistant; otherwise why not (`not_ready`, `no_read_only`, `no_mcp`, `no_adapter`). */
  unavailable: "not_ready" | "no_read_only" | "no_mcp" | "no_adapter" | null;
  /** The key's spend counts in USD; false for plan sign-ins and local models. */
  paid: boolean;
}

export interface AssistantDraftEdit {
  title: string;
  description: string;
  kind: TaskKind;
  acceptance: string[];
  size: TaskSize | null;
}

export interface AssistantIpc {
  /** Eligible profiles first, default first among them. */
  "assistant.profiles": { params: { projectId: string }; result: AssistantProfileOption[] };
  "assistant.get": { params: { projectId: string }; result: AssistantView };
  /**
   * Sends a message, starting or resuming the session on `profileId` when none runs. A different
   * profile while one runs is refused (`assistant.profile_in_use`): stop first.
   */
  "assistant.send": { params: { projectId: string; profileId: string; text: string }; result: AssistantView };
  /** Stops the process (the panel closed). The conversation and drafts stay. */
  "assistant.stop": { params: { projectId: string }; result: AssistantView };
  /** Stops it and starts a new, empty conversation; added drafts stay as tasks, open ones go. */
  "assistant.clear": { params: { projectId: string }; result: AssistantView };
  /** Turns a draft (with your edits) into a task with a proposed crew. Nothing starts. */
  "assistant.addDraft": { params: { draftId: string; edit?: AssistantDraftEdit }; result: { draft: AssistantDraftView; taskId: string } };
  "assistant.discardDraft": { params: { draftId: string }; result: AssistantDraftView };
}

export interface AssistantTopics {
  /** Something in the project's assistant changed; re-read assistant.get. Streaming text is batched. */
  "assistant.changed": { projectId: string };
}
