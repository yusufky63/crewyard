import type { AgentEvent, LimitWindow, Provenance, RiskLevel, RunnerId } from "./events.ts";

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
  /** Read-only enforcement through our approval layer (needed for reviewer roles). */
  readOnlyMode: boolean;
}

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
  /** Reviewers and planners are read-only; enforced by denying write tools, not by the prompt. */
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
}

export type { RiskLevel };
