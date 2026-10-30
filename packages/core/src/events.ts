import { z } from "zod";

// One normalized event stream for every runner, shaped after ACP's session/update kinds
// plus our own usage, limit and run-state events (PLAN.md §5.3).

export const RunnerId = z.enum(["claude-code", "codex", "gemini-cli", "opencode", "acp", "fake"]);
export type RunnerId = z.infer<typeof RunnerId>;

const envelope = {
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  at: z.string(),
  source: z.object({ adapter: RunnerId, cliVersion: z.string().nullable() }),
};

export const RiskLevel = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

// "monthly" is a coding plan's 30-day window (OpenCode Go, Z.ai MCP calls).
export const LimitWindow = z.enum(["5h", "weekly", "daily", "context", "budget-day", "budget-task", "monthly"]);
export type LimitWindow = z.infer<typeof LimitWindow>;

// Reported: the provider said it. Estimated: we computed it. Unknown: never shown as a percentage.
export const Provenance = z.enum(["reported", "estimated", "unknown"]);
export type Provenance = z.infer<typeof Provenance>;

export const RunState = z.enum(["starting", "running", "waiting_input", "waiting_approval", "rate_limited", "paused", "handing_off"]);
export type RunState = z.infer<typeof RunState>;

export const EndReason = z.enum(["completed", "failed", "stopped", "limit", "interrupted"]);
export type EndReason = z.infer<typeof EndReason>;

/**
 * The schema-checked result a run was asked for (StartRequest.outputSchema), set on run.ended.
 * `ok: false` means the runner's answer still failed our check after one retry in the session.
 */
export const RunOutput = z.union([z.object({ ok: z.literal(true), value: z.unknown() }), z.object({ ok: z.literal(false), error: z.string() })]);
export type RunOutput = z.infer<typeof RunOutput>;

export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("message.delta"), text: z.string() }),
  z.object({ ...envelope, type: z.literal("thought.delta"), text: z.string() }),
  z.object({
    ...envelope,
    type: z.literal("tool.call"),
    toolCallId: z.string(),
    title: z.string(),
    kind: z.enum(["read", "edit", "execute", "search", "fetch", "other"]),
    input: z.unknown(),
  }),
  z.object({
    ...envelope,
    type: z.literal("tool.update"),
    toolCallId: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "failed"]),
    output: z.string().optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal("plan.update"),
    steps: z.array(z.object({ title: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })),
  }),
  z.object({
    ...envelope,
    type: z.literal("diff.update"),
    files: z.array(z.object({ path: z.string(), added: z.number().int(), removed: z.number().int() })),
  }),
  z.object({
    ...envelope,
    type: z.literal("request.question"),
    requestId: z.string(),
    questions: z.array(
      z.object({
        prompt: z.string(),
        options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
        allowFreeText: z.boolean(),
      }),
    ),
  }),
  z.object({
    ...envelope,
    type: z.literal("request.approval"),
    requestId: z.string(),
    toolCallId: z.string().nullable(),
    command: z.string().nullable(),
    cwd: z.string().nullable(),
    paths: z.array(z.string()),
    network: z.boolean(),
    // Filled in by the daemon's risk classifier, never trusted from the agent.
    risk: RiskLevel.optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal("usage.update"),
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative().default(0),
    cacheWrite: z.number().int().nonnegative().default(0),
    reasoning: z.number().int().nonnegative().default(0),
    contextUsed: z.number().int().nonnegative().nullable(),
    contextSize: z.number().int().positive().nullable(),
    costUsd: z.number().nonnegative().nullable(),
    costProvenance: Provenance,
  }),
  z.object({
    ...envelope,
    type: z.literal("limit.update"),
    window: LimitWindow,
    usedPct: z.number().min(0).max(100).nullable(),
    resetsAt: z.string().nullable(),
    provenance: Provenance,
    reached: z.boolean(),
  }),
  z.object({ ...envelope, type: z.literal("run.state"), state: RunState, detail: z.string().optional() }),
  /**
   * A turn began in the runner. `turnRef` is the runner's own handle for rewinding it: the Claude
   * user message uuid (rewindFiles), the OpenCode user message id (session revert), the Codex turn
   * id. Null when the runner gave none.
   */
  z.object({ ...envelope, type: z.literal("turn.started"), turnRef: z.string().nullable() }),
  z.object({ ...envelope, type: z.literal("run.ended"), reason: EndReason, detail: z.string().optional(), output: RunOutput.optional() }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
export type AgentEventType = AgentEvent["type"];
