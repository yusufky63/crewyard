import type { AssistantSpendLabel, TaskDraftInput } from "../assistant.ts";
import type { AssistantToolLine } from "../assistant-tools.ts";
import type { AutopilotLimits, AutopilotRefusal, AutopilotSource, AutopilotTool } from "../autopilot.ts";
import type { PresetSuggestion, ProjectFacts, TaskPresetId } from "../presets.ts";
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
  /**
   * Set on a `tool` line Crewyard wrote for one of the assistant's own read or draft tools
   * (docs/adr/0018): which tool, whether it was refused, and its subject, days or status. The panel
   * words the line from this in the person's language (`toolLine.*`); `text` then holds only the
   * raw subject and is never shown on its own.
   */
  call?: AssistantToolLine;
}

/** Where a draft came from: the assistant's propose_task, a preset you picked, or a finished task's finding or follow-up. */
export type AssistantDraftSource = "assistant" | "preset" | "finding" | "followup";

export interface AssistantDraftView extends TaskDraftInput {
  id: string;
  conversationId: string | null;
  source: AssistantDraftSource;
  /** For a finding or follow-up: the finished task it was suggested by. */
  sourceTaskId: string | null;
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
  /** What `Suggest tasks for this project` would cost on this profile, shown before you click it. */
  suggestEstimate: { usd: number | null; label: AssistantSpendLabel };
}

export type ReportSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface TaskReportFinding {
  title: string;
  severity: ReportSeverity;
  file: string | null;
  line: number | null;
  detail: string;
  /** The draft this finding's suggested task became, so the report can jump to its card; absent when it suggested none. */
  draftId?: string | null;
}

/**
 * What a finished research, review or docs task produced (docs/adr/0014): the researcher's checked
 * findings, a reviewer's verdict, a planner's plan, or the last run's final message. Agent text:
 * cleaned, capped, shown as text only.
 */
export interface TaskReport {
  taskId: string;
  source: "findings" | "verdict" | "plan" | "text";
  verdict: "pass" | "changes" | null;
  summary: string;
  findings: TaskReportFinding[];
  /** Something was cut to the caps. */
  truncated: boolean;
  at: string;
  /**
   * Suggested follow-up tasks from the findings and the agent's propose_followup calls: the
   * current result's, plus every draft already added. An older result's open drafts are left out.
   */
  drafts: AssistantDraftView[];
  /** Autopilot read this report and marked the task done (docs/adr/0017); its reason is agent text. */
  completed?: { by: "autopilot"; at: string; reason: string } | null;
}

export interface AssistantPresetsView {
  /** A few presets that fit this project, from local facts only (no model call). */
  suggested: PresetSuggestion[];
  facts: ProjectFacts;
}

export interface AssistantDraftEdit {
  title: string;
  description: string;
  kind: TaskKind;
  acceptance: string[];
  size: TaskSize | null;
}

// ---------------------------------------------------------------- Autopilot (docs/adr/0017)

/** What Autopilot used against its limits; the money is Estimated (crew estimates or spend so far). */
export interface AutopilotUsage {
  createdLastHour: number;
  startedLastHour: number;
  /** Its tasks running, waiting, or with a report it has not marked done. */
  active: number;
  committedTodayUsd: number;
}

/**
 * One line of the Autopilot log: a call (allowed or refused) or a change you made. `action` is the
 * tool name, or `enabled`, `disabled`, `limits`, `killed`, `resumed`, `halted`. `reason` is the
 * agent's text for a call (untrusted, render as text), empty for your own changes.
 */
export interface AutopilotLogEntry {
  seq: number;
  at: string;
  action: AutopilotTool | "enabled" | "disabled" | "limits" | "killed" | "resumed" | "halted";
  outcome: "done" | "refused" | "changed";
  code: AutopilotRefusal | null;
  reason: string;
  taskId: string | null;
  taskTitle: string | null;
  /** A refusal's detail for the agent, or a halt's failure; untrusted, capped. */
  detail: string | null;
}

export interface AutopilotTaskView {
  taskId: string;
  title: string;
  /** The quote of your message it was based on, and where its content came from. */
  basis: string;
  sources: AutopilotSource[];
  createdAt: string;
  approvedAt: string | null;
  completedAt: string | null;
}

export interface AutopilotView {
  projectId: string;
  enabled: boolean;
  /** When you accepted what Autopilot may do in this project; enabling is refused before that. */
  consentAt: string | null;
  limits: AutopilotLimits;
  /** The global kill switch: every call is refused in every project while set. */
  killed: boolean;
  /** Stopped by the stop rule until you turn it on again. */
  halted: { reason: "repeated_failure"; at: string; detail: string | null } | null;
  usage: AutopilotUsage;
  tasks: AutopilotTaskView[];
  log: AutopilotLogEntry[];
}

export interface AutopilotGlobal {
  killed: boolean;
  killedAt: string | null;
  /** Projects where Autopilot is on, with their names. */
  projects: Array<{ projectId: string; name: string; halted: boolean }>;
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
  /** A finished non-code task's report and suggested drafts; null while it is not done or produced nothing. */
  "assistant.report": { params: { taskId: string }; result: TaskReport | null };
  "assistant.presets": { params: { projectId: string }; result: AssistantPresetsView };
  /** Puts a preset into the drafts column as an editable draft. Local, no model call. */
  "assistant.preset": { params: { projectId: string; presetId: TaskPresetId }; result: AssistantView };
  "autopilot.get": { params: { projectId: string }; result: AutopilotView };
  /**
   * Your change to Autopilot in a project: on or off, and its limits. The first `enabled: true`
   * needs `consent: true` (`autopilot.consent` otherwise); turning it on again clears a halt.
   * Only this method changes Autopilot's settings; no assistant tool can.
   */
  "autopilot.set": { params: { projectId: string; enabled?: boolean; consent?: boolean; limits?: Partial<AutopilotLimits> }; result: AutopilotView };
  "autopilot.global": { params: Record<string, never>; result: AutopilotGlobal };
  /** The kill switch. Refuses every Autopilot call at once; never stops running agents. */
  "autopilot.kill": { params: { killed: boolean }; result: AutopilotGlobal };
}

export interface AssistantTopics {
  /** Something in the project's assistant changed; re-read assistant.get. Streaming text is batched. */
  "assistant.changed": { projectId: string };
  /**
   * Autopilot changed in a project (null: the kill switch). `action` is set for a call it made,
   * which the main process batches into toasts; `halted` for a stop by the stop rule.
   */
  "autopilot.changed": { projectId: string | null; action?: { tool: AutopilotTool; outcome: "done" | "refused" }; halted?: boolean };
}
