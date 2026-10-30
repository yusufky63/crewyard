import type { AgentEvent, EndReason } from "@crewyard/core";
import type { SDKAssistantMessage, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { sessionProblemDetail } from "./sessions.ts";
import { toolKind, toolTitle } from "./tools.ts";

// Turns SDKMessage frames into normalized events. Pure apart from its own bookkeeping, so the
// replay tests can feed recorded frames straight in.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventBody = DistributiveOmit<AgentEvent, "runId" | "seq" | "at" | "source">;
type PlanStep = Extract<AgentEvent, { type: "plan.update" }>["steps"][number];

const MAX_OUTPUT = 8_000;

/** Tool the CLI adds for outputFormat; documented as an implementation detail to keep out of the UI. */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

export interface TurnOutcome {
  reason: EndReason;
  detail?: string;
}

export class EventMapper {
  cliVersion: string | null = null;
  sessionId: string | null = null;
  apiKeySource: string | null = null;
  /** Assistant message ids whose text already arrived as stream deltas. */
  private readonly streamed = new Set<string>();
  private currentStreamId: string | null = null;
  /** TodoWrite replaces the list; TaskCreate/TaskUpdate edit it by id. Both feed plan.update. */
  private readonly tasks = new Map<string, PlanStep>();
  private readonly pendingTaskCreates = new Map<string, string>();
  private lastContext: number | null = null;
  private lastError: string | null = null;
  /** StructuredOutput calls, kept out of the transcript together with their results. */
  private readonly hidden = new Set<string>();

  map(msg: SDKMessage): EventBody[] {
    switch (msg.type) {
      case "system":
        return this.system(msg);
      case "stream_event":
        return this.stream(msg);
      case "assistant":
        return this.assistant(msg);
      case "user":
        return this.user(msg);
      case "tool_progress":
        return msg.heartbeat ? [] : [{ type: "tool.update", toolCallId: msg.tool_use_id, status: "in_progress" }];
      case "result":
        return [this.usage(msg)];
      // rate_limit_event describes claude.ai subscription windows. Claude runs on API keys
      // here (PLAN.md §6), so those numbers are never surfaced.
      default:
        return [];
    }
  }

  /** How the run ends if this result is the last one. */
  outcome(msg: SDKResultMessage): TurnOutcome {
    if (msg.subtype === "success" && !msg.is_error) return { reason: "completed" };
    if (msg.subtype === "error_max_budget_usd") return { reason: "limit", detail: "Budget for this run was reached." };
    if (msg.terminal_reason === "blocking_limit" || this.lastError === "rate_limit" || this.lastError === "billing_error") {
      return { reason: "limit", detail: this.lastError ?? msg.terminal_reason };
    }
    if (msg.terminal_reason === "aborted_streaming" || msg.terminal_reason === "aborted_tools") return { reason: "interrupted" };
    // The CLI refused the session to resume: the orchestrator tells this from an ordinary failure by the prefix.
    const problem = msg.subtype === "success" ? null : sessionProblemDetail(msg.errors ?? [], msg.startup_failure_reason);
    if (problem) return { reason: "failed", detail: problem };
    const detail = msg.subtype === "success" ? msg.result : (msg.errors?.join("; ") ?? msg.subtype);
    return { reason: "failed", detail: detail || this.lastError || msg.subtype };
  }

  private system(msg: Extract<SDKMessage, { type: "system" }>): EventBody[] {
    switch (msg.subtype) {
      case "init":
        this.cliVersion = msg.claude_code_version;
        this.sessionId = msg.session_id;
        this.apiKeySource = msg.apiKeySource;
        return [{ type: "run.state", state: "running" }];
      case "api_retry":
        if (msg.error === "rate_limit" || msg.error_status === 429) {
          return [{ type: "run.state", state: "rate_limited", detail: `Retrying in ${Math.round(msg.retry_delay_ms / 1000)} s (attempt ${msg.attempt} of ${msg.max_retries}).` }];
        }
        return [];
      case "status":
        return msg.status === "compacting" ? [{ type: "run.state", state: "running", detail: "Compacting the conversation." }] : [];
      default:
        return [];
    }
  }

  private stream(msg: Extract<SDKMessage, { type: "stream_event" }>): EventBody[] {
    // Subagent text stays inside its tool call; only the main thread speaks in the transcript.
    if (msg.parent_tool_use_id !== null) return [];
    const ev = msg.event;
    if (ev.type === "message_start") {
      this.currentStreamId = ev.message.id;
      return [];
    }
    if (ev.type !== "content_block_delta") return [];
    const out: EventBody[] = [];
    if (ev.delta.type === "text_delta" && ev.delta.text) out.push({ type: "message.delta", text: ev.delta.text });
    if (ev.delta.type === "thinking_delta" && ev.delta.thinking) out.push({ type: "thought.delta", text: ev.delta.thinking });
    if (out.length && this.currentStreamId) this.streamed.add(this.currentStreamId);
    return out;
  }

  private assistant(msg: SDKAssistantMessage): EventBody[] {
    if (msg.error) this.lastError = msg.error;
    const out: EventBody[] = [];
    const usage = msg.message.usage;
    if (msg.parent_tool_use_id === null && usage) {
      this.lastContext = msg.context_usage?.total_tokens ?? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + usage.output_tokens;
    }
    const alreadyStreamed = this.streamed.has(msg.message.id);
    for (const block of msg.message.content) {
      if (block.type === "text" && !alreadyStreamed && msg.parent_tool_use_id === null && block.text) out.push({ type: "message.delta", text: block.text });
      else if (block.type === "thinking" && !alreadyStreamed && msg.parent_tool_use_id === null && block.thinking) out.push({ type: "thought.delta", text: block.thinking });
      else if (block.type === "tool_use") {
        // The CLI's own carrier for outputFormat; the result arrives on the result message instead.
        if (block.name === STRUCTURED_OUTPUT_TOOL) {
          this.hidden.add(block.id);
          continue;
        }
        out.push({ type: "tool.call", toolCallId: block.id, title: toolTitle(block.name, block.input), kind: toolKind(block.name), input: block.input });
        const plan = this.planFromToolUse(block.id, block.name, block.input);
        if (plan) out.push(plan);
      }
    }
    if (msg.error === "rate_limit") out.push({ type: "run.state", state: "rate_limited", detail: "The provider rate-limited this request." });
    return out;
  }

  private user(msg: Extract<SDKMessage, { type: "user" }>): EventBody[] {
    const content = (msg as SDKUserMessage).message.content;
    if (typeof content === "string") return [];
    const out: EventBody[] = [];
    for (const block of content) {
      if (block.type !== "tool_result" || this.hidden.has(block.tool_use_id)) continue;
      const text = typeof block.content === "string" ? block.content : (block.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
      out.push({
        type: "tool.update",
        toolCallId: block.tool_use_id,
        status: block.is_error ? "failed" : "completed",
        ...(text ? { output: text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[truncated]` : text } : {}),
      });
      const plan = this.planFromToolResult(block.tool_use_id, msg.tool_use_result);
      if (plan) out.push(plan);
    }
    return out;
  }

  /**
   * modelUsage and total_cost_usd are cumulative for the native session, and the CLI restores them
   * on resume (seen live on 2026-10-30: cost kept growing across three resumed processes). So every
   * usage.update carries session totals; per-run figures are the difference to the previous run.
   * total_cost_usd is the CLI's own price estimate. For a model missing from its price table
   * (costBasis "unknown", e.g. every DeepSeek model) that estimate uses a Claude rate and was ~40x
   * too high, so the cost becomes Unknown and the daemon prices the tokens from the catalog.
   *
   * webSearchRequests counts the WebSearch tool's server-side searches, which DeepSeek bills as
   * Search requests; result.usage.server_tool_use leaves out the tool's own request (seen live on
   * DeepSeek on 2026-10-30: 0 there, 1 in modelUsage). WebFetch downloads the page on this machine
   * and has the model read it, so no fetch request is reported.
   */
  private usage(msg: SDKResultMessage): EventBody {
    const models = Object.values(msg.modelUsage ?? {});
    const sum = (f: (m: (typeof models)[number]) => number) => models.reduce((n, m) => n + (f(m) || 0), 0);
    const fromModels = models.length > 0;
    const unpriced = models.some((m) => m.costBasis === "unknown");
    const contextSize = models.reduce<number | null>((max, m) => (m.contextWindow > 0 && (max === null || m.contextWindow > max) ? m.contextWindow : max), null);
    return {
      type: "usage.update",
      tokensIn: fromModels ? sum((m) => m.inputTokens) : msg.usage.input_tokens,
      tokensOut: fromModels ? sum((m) => m.outputTokens) : msg.usage.output_tokens,
      cacheRead: fromModels ? sum((m) => m.cacheReadInputTokens) : (msg.usage.cache_read_input_tokens ?? 0),
      cacheWrite: fromModels ? sum((m) => m.cacheCreationInputTokens) : (msg.usage.cache_creation_input_tokens ?? 0),
      reasoning: sum((m) => m.thinkingTokens ?? 0),
      contextUsed: this.lastContext,
      contextSize,
      costUsd: !unpriced && Number.isFinite(msg.total_cost_usd) && msg.total_cost_usd >= 0 ? msg.total_cost_usd : null,
      costProvenance: unpriced ? "unknown" : "estimated",
      webSearchRequests: fromModels ? sum((m) => m.webSearchRequests) : (msg.usage.server_tool_use?.web_search_requests ?? 0),
    };
  }

  private planFromToolUse(id: string, name: string, input: unknown): EventBody | null {
    const i = (input ?? {}) as Record<string, unknown>;
    if (name === "TodoWrite" && Array.isArray(i.todos)) {
      this.tasks.clear();
      (i.todos as Array<{ content?: unknown; status?: unknown }>).forEach((t, n) => this.tasks.set(`todo-${n}`, { title: String(t.content ?? ""), status: planStatus(t.status) }));
      return this.planEvent();
    }
    if (name === "TaskCreate" && typeof i.subject === "string") this.pendingTaskCreates.set(id, i.subject);
    if (name === "TaskUpdate" && typeof i.taskId === "string") {
      const prev = this.tasks.get(i.taskId);
      if (i.status === "deleted") this.tasks.delete(i.taskId);
      else if (prev || typeof i.subject === "string") {
        this.tasks.set(i.taskId, { title: typeof i.subject === "string" ? i.subject : (prev?.title ?? ""), status: i.status === undefined && prev ? prev.status : planStatus(i.status) });
      }
      return this.planEvent();
    }
    return null;
  }

  private planFromToolResult(toolUseId: string, result: unknown): EventBody | null {
    const subject = this.pendingTaskCreates.get(toolUseId);
    if (subject === undefined) {
      const tasks = (result as { tasks?: unknown } | null)?.tasks;
      if (!Array.isArray(tasks)) return null;
      // TaskList returns the whole list; take it as the truth.
      this.tasks.clear();
      for (const t of tasks as Array<{ id?: unknown; subject?: unknown; status?: unknown }>) this.tasks.set(String(t.id), { title: String(t.subject ?? ""), status: planStatus(t.status) });
      return this.planEvent();
    }
    this.pendingTaskCreates.delete(toolUseId);
    const task = (result as { task?: { id?: unknown } } | null)?.task;
    if (!task || task.id === undefined) return null;
    this.tasks.set(String(task.id), { title: subject, status: "pending" });
    return this.planEvent();
  }

  private planEvent(): EventBody {
    return { type: "plan.update", steps: [...this.tasks.values()] };
  }
}

function planStatus(s: unknown): PlanStep["status"] {
  return s === "in_progress" || s === "completed" ? s : "pending";
}
