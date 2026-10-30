import type { AgentEvent, LimitWindow, Provenance, RiskLevel, RunnerId, RunOutput } from "./events.ts";

// What a runner can do. Unsupported operations are shown disabled with a reason, never hidden.
export interface AgentCapabilities {
  launch: boolean;
  stream: boolean;
  answerQuestions: boolean;
  approveTools: boolean;
  interrupt: boolean;
  resume: boolean;
  setModel: boolean;
  usage: boolean;
  /** Subscription limit data straight from the runner, without touching tokens ourselves. */
  reportedLimits: boolean;
  /** Read-only enforcement (needed for reviewer roles): the runner's own engine where it has one, plus our approval layer. */
  readOnlyMode: boolean;
  /**
   * Adds a message to the turn in flight (Codex `turn/steer`). Absent or false: messages wait in
   * the step's queue for the next turn boundary, and "Steer now" is disabled with the reason.
   */
  steer?: boolean;
  /**
   * `rewind()` undoes the last turn with the runner's own mechanism, and what that covers: files
   * (Claude file checkpoints, OpenCode snapshots) and history (Codex thread rollback, OpenCode
   * revert). Absent: no documented way, so Undo is disabled with the reason.
   */
  undo?: { files: boolean; history: boolean };
  /** `transcript()` can point at, or export, the runner's own session record. */
  transcript?: boolean;
}

/** What `rewind()` undid on the runner's side; the worktree's git checkpoint covers the rest. */
export interface RewindResult {
  /** The runner restored the files it tracks (Claude file checkpoints, OpenCode snapshots). */
  files: boolean;
  /** The runner's conversation forgot the turn (Codex thread rollback, OpenCode revert). */
  history: boolean;
  /** Why something was not undone, in one line; never contains secrets. */
  detail: string | null;
}

export interface RewindRequest {
  profile: Profile;
  cwd: string;
  /** Decrypted secrets, as for a start; passed through env only. */
  env: Record<string, string>;
  session: NativeSessionRef;
  /** The turn.started `turnRef` of the turn to undo. */
  turnRef: string | null;
}

export interface TranscriptRequest {
  profile: Profile;
  cwd: string;
  env: Record<string, string>;
  session: NativeSessionRef;
}

/** The runner's own record of a session: a file it keeps, or text it exported for us. */
export type TranscriptSource = { kind: "file"; path: string; ext: string } | { kind: "text"; text: string; ext: string };

/** A runner + provider + credential + model + its own config folder (PLAN.md D9). */
export interface Profile {
  id: string;
  alias: string;
  runner: RunnerId;
  providerId: string;
  credential: { kind: "api_key" | "plan_signin" | "local"; secretRef: string | null };
  defaultModel: string | null;
  /** Folder passed as CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_CLI_HOME / OpenCode data dir. */
  configDir: string;
  /** Anthropic- or OpenAI-compatible base URL when the provider is not the runner's own. */
  baseUrl: string | null;
}

export interface Probe {
  installed: boolean;
  executable: string | null;
  version: string | null;
  signedIn: boolean | null;
  capabilities: AgentCapabilities;
  problems: string[];
}

export interface RolePolicy {
  /**
   * Reviewers and planners are read-only, never by the prompt: each runner's own engine refuses
   * writes (sandbox, permission mode or ruleset) and our tool denial stays as a second layer.
   */
  writes: "none" | "worktree" | "docs";
  allowCommands: string[];
  network: "ask" | "allowed" | "denied";
}

export interface StartRequest {
  profile: Profile;
  cwd: string;
  model: string | null;
  prompt: string;
  policy: RolePolicy;
  /** Decrypted secrets for this run only; adapters pass them through env and never log them. */
  env: Record<string, string>;
  /**
   * The run must end with one JSON value of this shape (a reviewer verdict, a planner plan).
   * Adapters hand it to the runner's own structured output where it has one, check the answer
   * with `check`, ask once more in the same session when it does not fit, and put the outcome
   * on run.ended as `output`.
   */
  outputSchema?: OutputSchema;
  /**
   * Called at each turn boundary, before the adapter would end the run. Returns the next message
   * (the step's queued follow-ups, joined) to start another turn in the same session, or null to
   * let the run finish. Messages typed while a turn runs wait in our persisted queue instead of
   * the runner's, so they stay editable until this hands them over.
   */
  nextTurn?: () => Promise<string | null>;
}

export interface OutputSchema {
  /** Short identifier, e.g. "review_verdict". */
  name: string;
  /**
   * JSON Schema draft-07 for the runner. Strict on purpose, because OpenAI-style providers
   * refuse anything else: every property required, no additional properties, no "$schema".
   */
  jsonSchema: Record<string, unknown>;
  /** Our own check of the runner's answer: the first problem in one line, or null when it fits. */
  check(value: unknown): string | null;
}

/** Prompt text for runners without native structured output (Gemini over ACP). */
export function outputInstruction(schema: OutputSchema): string {
  return [
    "When you have finished, your final message must be only one JSON object, with no other text and no code fence.",
    `It must match this JSON Schema (${schema.name}):`,
    JSON.stringify(schema.jsonSchema),
  ].join("\n");
}

/** The one retry sent in the same session when the answer did not fit. */
export function outputRetryPrompt(schema: OutputSchema, problem: string): string {
  return [
    `Your final answer did not match the required ${schema.name} JSON format: ${problem}`,
    "Do not redo the work. Reply with only the corrected JSON object, nothing else.",
    "JSON Schema:",
    JSON.stringify(schema.jsonSchema),
  ].join("\n");
}

/**
 * Reads a JSON object out of a final message. Models wrap it in a code fence or a sentence more
 * often than not, so the outermost {...} is taken; anything that still fails to parse is reported.
 */
export function parseOutputText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "the final message was empty" };
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) return { ok: false, error: "the final message contained no JSON object" };
  try {
    return { ok: true, value: JSON.parse(trimmed.slice(start, end + 1)) };
  } catch (err) {
    return { ok: false, error: `the final message was not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** Checks a candidate result; `undefined` means the runner gave none at all. */
export function checkOutput(schema: OutputSchema, value: unknown): RunOutput {
  if (value === undefined || value === null) return { ok: false, error: "no JSON result was returned" };
  const problem = schema.check(value);
  return problem ? { ok: false, error: problem } : { ok: true, value };
}

export interface RunHandle {
  runId: string;
  runner: RunnerId;
  pid: number | null;
  nativeSession: NativeSessionRef | null;
}

export interface NativeSessionRef {
  runner: RunnerId;
  sessionId: string;
}

export type UserInput = { kind: "text"; text: string };

export type Answer =
  | { kind: "approval"; decision: "allow_once" | "allow_always" | "deny"; message?: string }
  | { kind: "question"; answers: Array<{ selected: string[]; text?: string }> }
  | { kind: "cancel" };

export interface LimitSample {
  profileId: string;
  window: LimitWindow;
  usedPct: number | null;
  resetsAt: string | null;
  provenance: Provenance;
  observedAt: string;
  /**
   * Which limit of the account this window belongs to, when it has more than one (Codex
   * `rateLimitsByLimitId`, a coding plan's separate MCP quota). Absent or null is the account's
   * main limit, so every runner that knows one limit only can leave it out.
   */
  bucket?: string | null;
  /** The provider's own name for the bucket (Codex `limitName`), shown when we have no label of our own. */
  bucketLabel?: string | null;
}

export interface AgentAdapter {
  readonly id: RunnerId;
  readonly capabilities: AgentCapabilities;
  probe(profile: Profile): Promise<Probe>;
  start(req: StartRequest): Promise<RunHandle>;
  events(run: RunHandle): AsyncIterable<AgentEvent>;
  send(run: RunHandle, input: UserInput): Promise<void>;
  answer(run: RunHandle, requestId: string, answer: Answer): Promise<void>;
  interrupt(run: RunHandle): Promise<void>;
  resume(ref: NativeSessionRef, req: StartRequest): Promise<RunHandle>;
  setModel?(run: RunHandle, model: string): Promise<void>;
  /** Only from the runner's own channel; never by calling usage endpoints with a subscription token. */
  limits?(profile: Profile): Promise<LimitSample[]>;
  /** Ends the run and its whole process tree. */
  stop(run: RunHandle): Promise<void>;
  /** Adds text to the turn in flight; throws when no turn is running. Only with `capabilities.steer`. */
  steer?(run: RunHandle, input: UserInput): Promise<void>;
  /**
   * Undoes the last turn of a session that has no live process, with the runner's own mechanism.
   * Only with `capabilities.undo`. Never starts a model turn.
   */
  rewind?(req: RewindRequest): Promise<RewindResult>;
  /** Where the runner keeps this session's transcript, or its export. Null when it has none. */
  transcript?(req: TranscriptRequest): Promise<TranscriptSource | null>;
}

export type { RiskLevel };
