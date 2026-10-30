import type { UUID } from "node:crypto";
import type {
  ModelUsage,
  NonNullableUsage,
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKToolProgressMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

// Recorded-frame builders for the replay tests. Envelopes are typed against the SDK 0.3.312
// definitions; the inner Messages API objects carry the fields the CLI sends and are cast,
// because their full Beta* types include server-tool fields a coding turn never has.

export const SESSION = "6f1c1b7e-3f7a-4a34-9a51-2f1d4a8f0c11";
let n = 0;
const uuid = (): UUID => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` as UUID;

type Block = SDKAssistantMessage["message"]["content"][number];
type StreamEvent = SDKPartialAssistantMessage["event"];

export function init(over: Partial<SDKSystemMessage> = {}): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "ANTHROPIC_API_KEY",
    claude_code_version: "2.1.312",
    cwd: "C:\\Work Trees\\demo repo",
    tools: ["Bash", "Read", "Edit", "Write", "TodoWrite", "AskUserQuestion"],
    mcp_servers: [],
    model: "claude-sonnet-5",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: uuid(),
    session_id: SESSION,
    ...over,
  } as SDKSystemMessage;
}

export function stream(messageId: string, event: StreamEvent | "start", parent: string | null = null): SDKPartialAssistantMessage {
  const ev = event === "start" ? ({ type: "message_start", message: { id: messageId, type: "message", role: "assistant", content: [], model: "claude-sonnet-5" } } as unknown as StreamEvent) : event;
  return { type: "stream_event", event: ev, parent_tool_use_id: parent, uuid: uuid(), session_id: SESSION };
}

export const textDelta = (text: string): StreamEvent => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
export const thinkingDelta = (thinking: string): StreamEvent => ({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } }) as StreamEvent;

export function assistant(messageId: string, content: Array<Record<string, unknown>>, over: Partial<SDKAssistantMessage> = {}): SDKAssistantMessage {
  return {
    type: "assistant",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: content as unknown as Block[],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 3000, cache_creation_input_tokens: 400 },
    } as unknown as SDKAssistantMessage["message"],
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: SESSION,
    ...over,
  };
}

export const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

export function toolResult(toolUseId: string, content: string, opts: { isError?: boolean; result?: unknown } = {}): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: opts.isError ?? false }] },
    parent_tool_use_id: null,
    tool_use_result: opts.result,
    uuid: uuid(),
    session_id: SESSION,
  };
}

export function progress(toolUseId: string, heartbeat = false): SDKToolProgressMessage {
  return { type: "tool_progress", tool_use_id: toolUseId, tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 3, uuid: uuid(), session_id: SESSION, heartbeat };
}

const modelUsage = (over: Partial<ModelUsage> = {}): ModelUsage => ({
  inputTokens: 1500,
  outputTokens: 200,
  thinkingTokens: 40,
  cacheReadInputTokens: 6000,
  cacheCreationInputTokens: 400,
  webSearchRequests: 0,
  costUSD: 0.0123,
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  ...over,
});

export function result(over: Partial<Extract<SDKResultMessage, { subtype: "success" }>> = {}): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 4200,
    duration_api_ms: 3900,
    is_error: false,
    num_turns: 2,
    result: "Done.",
    stop_reason: "end_turn",
    total_cost_usd: 0.0151,
    usage: { input_tokens: 1500, output_tokens: 200, cache_read_input_tokens: 6000, cache_creation_input_tokens: 400 } as unknown as NonNullableUsage,
    modelUsage: { "claude-sonnet-5": modelUsage(), "claude-haiku-4-5": modelUsage({ inputTokens: 300, outputTokens: 20, thinkingTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0028 }) },
    permission_denials: [],
    queued_turn_count: 0,
    uuid: uuid(),
    session_id: SESSION,
    ...over,
  };
}

export function errorResult(subtype: Exclude<SDKResultMessage["subtype"], "success">, over: Record<string, unknown> = {}): SDKResultMessage {
  const base = result();
  return { ...base, subtype, is_error: true, errors: ["Request was aborted."], ...over } as unknown as SDKResultMessage;
}

export function compactBoundary(sessionId: string, preTokens = 14_000, postTokens = 2_500): SDKCompactBoundaryMessage {
  return { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: preTokens, post_tokens: postTokens }, uuid: uuid(), session_id: sessionId };
}
