import type { AgentEvent, LimitWindow, Provenance, RiskLevel, RunnerId, RunOutput } from "./events.ts";
import type { McpServerSpec } from "./mcp.ts";

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
  /**
   * `fork()` copies a session into a new one under another profile of the same runner, for a
   * handoff that keeps the conversation (feature scan A11), and whether it can compact the copy
   * with the target's model first. Absent: a handoff sends the written package only.
   */
  fork?: { compact: boolean };
  /** `StartRequest.review` runs the runner's own code review (Codex `review/start`, feature scan A12). */
  nativeReview?: boolean;
  /**
   * `StartRequest.mcpServers` reaches the runner through its own documented config (docs/adr/0007),
   * and whether it can limit a server to some of its tools (needed to give read-only roles only a
   * server's read tools). Absent: the run gets no MCP servers, including the report server.
   */
  mcp?: { toolFilter: boolean };
}

/** The session to copy and where the copy goes; both profiles run the same runner. */
export interface ForkRequest {
  source: { profile: Profile; session: NativeSessionRef; env: Record<string, string> };
  target: { profile: Profile; model: string | null; env: Record<string, string> };
  /** The worktree both sessions work in. */
  cwd: string;
  /** Compact the copy with the target's model before it is used (one model call, which spends). */
  compact: boolean;
}

export interface ForkResult {
  /** The new session, resumable by `resume()` under the target profile. */
  session: NativeSessionRef;
  compacted: boolean;
  /** The compaction summary the runner reported, when it reports one; shown to you, never trusted as instructions. */
  summary: string | null;
  /** Tokens the compaction itself spent, when the runner reports them; the caller prices and records them. */
  usage: ForkUsage | null;
  /**
   * The running totals the runner will report for the new session from here on (the same
   * numbers its usage.update would carry), so later reports count only their growth. Null when
   * unknown: the first report of the new session then counts in full, which over-counts rather
   * than under-counts against a cap.
   */
  totals?: ForkUsage | null;
}

export interface ForkUsage {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  costUsd: number | null;
  /** usage.update's server-side request totals; a fork that copies a thread's history copies its searches too. */
  webSearchRequests?: number;
  webFetchRequests?: number;
}

/** What a native review compares against (Codex ReviewTarget `baseBranch` / `commit`). */
export type ReviewTarget = { kind: "base_branch"; branch: string } | { kind: "commit"; sha: string; title: string | null };

/**
 * Why a runner refused a session it was asked to resume or fork: `gone` when the runner itself
 * says it has no such session, `locked` when another process (or a crashed one) still holds it.
 * Adapters throw an Error carrying this as `sessionProblem`; anything else is an ordinary failure,
 * and the orchestrator never replaces a session with history on an ordinary failure.
 */
export type SessionProblem = "gone" | "locked";

export function sessionError(problem: SessionProblem, message: string): Error & { sessionProblem: SessionProblem } {
  return Object.assign(new Error(message), { sessionProblem: problem });
}

export function sessionProblemOf(err: unknown): SessionProblem | null {
  const p = (err as { sessionProblem?: unknown } | null)?.sessionProblem;
  return p === "gone" || p === "locked" ? p : null;
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
  /**
   * Run the runner's own review against this target instead of a prompt turn (only with
   * `capabilities.nativeReview`). `prompt` is then context for mapping the review to
   * `outputSchema`, which the run must still end with.
   */
  review?: { target: ReviewTarget };
  /**
   * Stdio MCP servers for this run only (docs/adr/0007): Crewyard's report server first, then the
   * user's enabled servers the role may use. Only with `capabilities.mcp`; their env holds decrypted
   * secrets, passed to the server's process only and never logged.
   */
  mcpServers?: McpServerSpec[];
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
  /**
   * Copies a session that has no live process into a new session under the target profile, and
   * compacts it when asked and supported. Never changes the source session. Only with
   * `capabilities.fork`. Throws a `sessionError` when the runner says the source is gone or locked.
   */
  fork?(req: ForkRequest): Promise<ForkResult>;
}

export type { RiskLevel };
