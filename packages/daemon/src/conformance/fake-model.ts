import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

// A scripted model server for the conformance suite (PLAN.md §5.4, D6): the real runner CLIs talk
// to it instead of a provider, so a CLI upgrade can be checked for free and the same way each time.
// It speaks the four wire formats our runners use, each only as far as they need it:
//   - OpenAI Responses (`POST /v1/responses`, SSE): Codex through a [model_providers.<id>] block
//   - Anthropic Messages (`POST /v1/messages`, SSE, `/v1/messages/count_tokens`): Claude Code
//     through ANTHROPIC_BASE_URL
//   - OpenAI Chat Completions (`POST /v1/chat/completions`, SSE): OpenCode's openai-compatible
//     provider
//   - Gemini (`POST /v1beta/models/<m>:streamGenerateContent?alt=sse`, `:generateContent`,
//     `:countTokens`): Gemini CLI through GOOGLE_GEMINI_BASE_URL
//
// Every request is reduced to a ModelRequest and answered by the test's `director`, which returns
// text, one tool call, or a stream that never finishes (for interrupt). It listens on 127.0.0.1
// with port 0 inside the test process only and is never part of the app.

export type Wire = "responses" | "messages" | "chat" | "gemini";

export interface ToolResult {
  callId: string;
  name: string | null;
  text: string;
}

/** One model request, whatever the wire format. */
export interface ModelRequest {
  wire: Wire;
  path: string;
  model: string;
  stream: boolean;
  /** Names of the tools the runner offered, in its own spelling. */
  tools: string[];
  /** Every user and assistant text and every tool result, joined: what the model would "remember". */
  transcript: string;
  /** Text of the last user message that is not only tool results. */
  lastUserText: string;
  /** Tool results the runner sent after the model's last tool call, when the request ends with them. */
  toolResults: ToolResult[];
  /** Tool results since the last user message: which step of a multi-call script comes next. */
  toolRounds: number;
  /** Gemini asks for JSON (next-speaker check, routing) with a response schema. */
  wantsJson: boolean;
  raw: unknown;
  at: number;
}

export type Reply =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown>; text?: string }
  /** Starts a text answer and never finishes it, so the runner has a turn in flight to interrupt. */
  | { kind: "hang"; text: string };

export type Director = (req: ModelRequest) => Reply;

/** Token counts every reply reports, so usage.update can be checked against known numbers. */
export const USAGE = { input: 1200, cachedInput: 200, output: 34 } as const;

export interface FakeModel {
  /** `http://127.0.0.1:<port>`; each runner adds its own path prefix. */
  url: string;
  requests: ModelRequest[];
  /** Requests for paths this server does not serve; a new CLI version may add one. */
  unknown: string[];
  director: Director;
  close(): Promise<void>;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Text of a content value in any of the formats: a string, or parts with `text`. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content)
    .map((p) => {
      const part = rec(p);
      if (typeof part.text === "string") return part.text;
      if (part.type === "tool_result") return textOf(part.content);
      return "";
    })
    .join("\n");
}

let nextId = 0;
const id = (prefix: string) => `${prefix}_cf${++nextId}`;

export async function startFakeModel(director: Director = () => ({ kind: "text", text: "ok" })): Promise<FakeModel> {
  const sockets = new Set<Socket>();
  const open = new Set<ServerResponse>();
  const state: FakeModel = { url: "", requests: [], unknown: [], director, close: async () => undefined };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } }));
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const json: unknown = body ? JSON.parse(body) : {};
    const path = url.pathname;

    if (req.method === "GET" && /\/models\/?$/.test(path)) return sendJson(res, { object: "list", data: [], models: [] });
    if (path.endsWith("/messages/count_tokens")) return sendJson(res, { input_tokens: USAGE.input });
    if (path.endsWith(":countTokens")) return sendJson(res, { totalTokens: USAGE.input });

    let wire: Wire | null = null;
    if (path.endsWith("/responses")) wire = "responses";
    else if (path.endsWith("/messages")) wire = "messages";
    else if (path.endsWith("/chat/completions")) wire = "chat";
    else if (/:(stream)?generateContent$/i.test(path)) wire = "gemini";
    if (!wire || req.method !== "POST") {
      state.unknown.push(`${req.method} ${path}`);
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `fake model: no route for ${path}` } }));
      return;
    }

    const parsed = normalize(wire, path, json);
    state.requests.push(parsed);
    const reply = state.director(parsed);
    open.add(res);
    res.on("close", () => open.delete(res));
    if (wire === "responses") return responses(res, parsed, reply);
    if (wire === "messages") return messages(res, parsed, reply);
    if (wire === "chat") return chat(res, parsed, reply);
    return gemini(res, parsed, reply, path.toLowerCase().endsWith(":streamgeneratecontent"));
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}`;
  state.close = async () => {
    for (const r of open) r.destroy();
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

function sendJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
}

function sse(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
}

/** Keeps a hanging stream alive with comment lines until the client goes away. */
function hold(res: ServerResponse, ping: () => void): void {
  const timer = setInterval(ping, 1_000);
  res.on("close", () => clearInterval(timer));
}

// ---------------------------------------------------------------------------------------------
// Request normalization

export function normalize(wire: Wire, path: string, raw: unknown): ModelRequest {
  const body = rec(raw);
  const base = { wire, path, raw, at: Date.now(), wantsJson: false };
  if (wire === "responses") return { ...base, ...fromResponses(body) };
  if (wire === "messages") return { ...base, ...fromMessages(body) };
  if (wire === "chat") return { ...base, ...fromChat(body) };
  const model = decodeURIComponent(/models\/([^:]+):/.exec(path)?.[1] ?? "");
  const config = rec(body.generationConfig);
  return { ...base, ...fromGemini(body), model, stream: /:streamGenerateContent$/i.test(path), wantsJson: config.responseMimeType === "application/json" || config.responseJsonSchema !== undefined || config.responseSchema !== undefined };
}

type Normal = Pick<ModelRequest, "model" | "stream" | "tools" | "transcript" | "lastUserText" | "toolResults" | "toolRounds">;

/** Walks a conversation in order; the same bookkeeping for every wire format. */
class Conversation {
  private readonly lines: string[] = [];
  private readonly names = new Map<string, string>();
  private lastUserText = "";
  private trailing: ToolResult[] = [];
  private rounds = 0;

  user(text: string): void {
    this.lines.push(text);
    this.lastUserText = text;
    this.trailing = [];
    this.rounds = 0;
  }

  assistant(text: string): void {
    if (text) this.lines.push(text);
    this.trailing = [];
  }

  call(callId: string, name: string): void {
    this.names.set(callId, name);
    this.trailing = [];
  }

  result(callId: string, text: string, name?: string): void {
    this.lines.push(text);
    this.trailing.push({ callId, name: name || (this.names.get(callId) ?? null), text });
    this.rounds++;
  }

  /** Text that arrives next to tool results (Claude Code's reminders): remembered, but not a user turn. */
  note(text: string): void {
    if (text) this.lines.push(text);
  }

  done(): Pick<ModelRequest, "transcript" | "lastUserText" | "toolResults" | "toolRounds"> {
    return { transcript: this.lines.join("\n"), lastUserText: this.lastUserText, toolResults: this.trailing, toolRounds: this.rounds };
  }
}

function fromResponses(body: Record<string, unknown>): Normal {
  // Codex nests some tools in namespaces ({ type: "namespace", tools: [...] }).
  const tools = arr(body.tools).flatMap((t) => {
    const tool = rec(t);
    return Array.isArray(tool.tools) ? tool.tools.map((x) => str(rec(x).name)) : [str(tool.name) || str(tool.type)];
  });
  const input = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : arr(body.input);
  const c = new Conversation();
  for (const it of input) {
    const item = rec(it);
    const type = str(item.type) || "message";
    if (type === "message") {
      if (item.role === "user") c.user(textOf(item.content));
      else if (item.role === "assistant") c.assistant(textOf(item.content));
      // developer and system messages are instructions, not conversation.
    } else if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call") {
      c.call(str(item.call_id), str(item.name));
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      const output = item.output;
      c.result(str(item.call_id), typeof output === "string" ? output : textOf(rec(output).content ?? output));
    }
  }
  return { model: str(body.model), stream: body.stream !== false, tools, ...c.done() };
}

function fromMessages(body: Record<string, unknown>): Normal {
  const tools = arr(body.tools).map((t) => str(rec(t).name));
  const c = new Conversation();
  for (const m of arr(body.messages)) {
    const msg = rec(m);
    const parts = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : arr(msg.content).map(rec);
    if (msg.role === "assistant") {
      c.assistant(parts.filter((p) => p.type === "text").map((p) => str(p.text)).join("\n"));
      for (const p of parts) if (p.type === "tool_use") c.call(str(p.id), str(p.name));
      continue;
    }
    const results = parts.filter((p) => p.type === "tool_result");
    const text = parts.filter((p) => p.type === "text").map((p) => str(p.text)).join("\n");
    for (const r of results) c.result(str(r.tool_use_id), textOf(r.content));
    // Claude Code adds reminder text next to tool results; a message is the user's only without results.
    if (results.length === 0) c.user(text);
    else c.note(text);
  }
  return { model: str(body.model), stream: body.stream === true, tools, ...c.done() };
}

function fromChat(body: Record<string, unknown>): Normal {
  const tools = arr(body.tools).map((t) => str(rec(rec(t).function).name));
  const c = new Conversation();
  for (const m of arr(body.messages)) {
    const msg = rec(m);
    const text = textOf(msg.content);
    if (msg.role === "user") c.user(text);
    else if (msg.role === "assistant") {
      c.assistant(text);
      for (const call of arr(msg.tool_calls)) c.call(str(rec(call).id), str(rec(rec(call).function).name));
    } else if (msg.role === "tool") c.result(str(msg.tool_call_id), text);
  }
  return { model: str(body.model), stream: body.stream === true, tools, ...c.done() };
}

function fromGemini(body: Record<string, unknown>): Omit<Normal, "model" | "stream"> {
  const tools = arr(body.tools).flatMap((t) => arr(rec(t).functionDeclarations).map((f) => str(rec(f).name)));
  const c = new Conversation();
  for (const entry of arr(body.contents)) {
    const content = rec(entry);
    const parts = arr(content.parts).map(rec);
    const text = parts
      .map((p) => str(p.text))
      .filter(Boolean)
      .join("\n");
    if (content.role === "model") {
      c.assistant(text);
      for (const p of parts) if (p.functionCall) c.call(str(rec(p.functionCall).id), str(rec(p.functionCall).name));
      continue;
    }
    const results = parts.filter((p) => p.functionResponse);
    for (const r of results) {
      const fr = rec(r.functionResponse);
      c.result(str(fr.id), JSON.stringify(fr.response ?? {}), str(fr.name));
    }
    if (results.length === 0) c.user(text);
    else c.note(text);
  }
  return { tools, ...c.done() };
}

// ---------------------------------------------------------------------------------------------
// Replies

function responses(res: ServerResponse, req: ModelRequest, reply: Reply): void {
  const responseId = id("resp");
  const usage = {
    input_tokens: USAGE.input,
    input_tokens_details: { cached_tokens: USAGE.cachedInput },
    output_tokens: USAGE.output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: USAGE.input + USAGE.output,
  };
  sse(res);
  const event = (type: string, extra: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
  event("response.created", { response: { id: responseId, status: "in_progress", model: req.model } });
  const output: unknown[] = [];
  let index = 0;
  const text = reply.text;
  if (text) {
    const msgId = id("msg");
    const pending = { type: "message", id: msgId, role: "assistant", status: "in_progress", content: [] };
    event("response.output_item.added", { output_index: index, item: pending });
    event("response.content_part.added", { item_id: msgId, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    event("response.output_text.delta", { item_id: msgId, output_index: index, content_index: 0, delta: text });
    if (reply.kind === "hang") {
      hold(res, () => res.write(": keep-alive\n\n"));
      return;
    }
    const done = { type: "message", id: msgId, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    event("response.output_text.done", { item_id: msgId, output_index: index, content_index: 0, text });
    event("response.output_item.done", { output_index: index, item: done });
    output.push(done);
    index++;
  }
  if (reply.kind === "tool") {
    const item = { type: "function_call", id: id("fc"), call_id: id("call"), name: reply.name, arguments: JSON.stringify(reply.args), status: "completed" };
    event("response.output_item.added", { output_index: index, item });
    event("response.output_item.done", { output_index: index, item });
    output.push(item);
  }
  event("response.completed", { response: { id: responseId, status: "completed", model: req.model, output, usage } });
  res.end();
}

function messages(res: ServerResponse, req: ModelRequest, reply: Reply): void {
  const messageId = id("msg");
  const usage = { input_tokens: USAGE.input - USAGE.cachedInput, cache_read_input_tokens: USAGE.cachedInput, cache_creation_input_tokens: 0, output_tokens: USAGE.output };
  const toolId = id("toolu");
  const stop = reply.kind === "tool" ? "tool_use" : "end_turn";
  if (!req.stream) {
    const content: unknown[] = [];
    if (reply.text) content.push({ type: "text", text: reply.text });
    if (reply.kind === "tool") content.push({ type: "tool_use", id: toolId, name: reply.name, input: reply.args });
    return sendJson(res, { id: messageId, type: "message", role: "assistant", model: req.model, content, stop_reason: stop, stop_sequence: null, usage });
  }
  sse(res);
  const event = (type: string, extra: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
  event("message_start", { message: { id: messageId, type: "message", role: "assistant", model: req.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
  let index = 0;
  if (reply.text) {
    event("content_block_start", { index, content_block: { type: "text", text: "" } });
    event("content_block_delta", { index, delta: { type: "text_delta", text: reply.text } });
    if (reply.kind === "hang") {
      hold(res, () => event("ping", {}));
      return;
    }
    event("content_block_stop", { index });
    index++;
  }
  if (reply.kind === "tool") {
    event("content_block_start", { index, content_block: { type: "tool_use", id: toolId, name: reply.name, input: {} } });
    event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.args) } });
    event("content_block_stop", { index });
  }
  event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: USAGE.output } });
  event("message_stop", {});
  res.end();
}

function chat(res: ServerResponse, req: ModelRequest, reply: Reply): void {
  const chatId = id("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const usage = { prompt_tokens: USAGE.input, completion_tokens: USAGE.output, total_tokens: USAGE.input + USAGE.output, prompt_tokens_details: { cached_tokens: USAGE.cachedInput } };
  const toolCall = reply.kind === "tool" ? { id: id("call"), type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) } } : null;
  const finish = toolCall ? "tool_calls" : "stop";
  if (!req.stream) {
    const message = { role: "assistant", content: reply.text ?? null, ...(toolCall ? { tool_calls: [toolCall] } : {}) };
    return sendJson(res, { id: chatId, object: "chat.completion", created, model: req.model, choices: [{ index: 0, message, finish_reason: finish }], usage });
  }
  sse(res);
  const chunk = (delta: Record<string, unknown>, finishReason: string | null, extra: Record<string, unknown> = {}) =>
    res.write(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created, model: req.model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })}\n\n`);
  chunk({ role: "assistant", content: "" }, null);
  if (reply.text) chunk({ content: reply.text }, null);
  if (reply.kind === "hang") {
    hold(res, () => res.write(": keep-alive\n\n"));
    return;
  }
  if (toolCall) chunk({ tool_calls: [{ index: 0, ...toolCall }] }, null);
  chunk({}, finish);
  res.write(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created, model: req.model, choices: [], usage })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function gemini(res: ServerResponse, req: ModelRequest, reply: Reply, stream: boolean): void {
  const usageMetadata = { promptTokenCount: USAGE.input, cachedContentTokenCount: USAGE.cachedInput, candidatesTokenCount: USAGE.output, totalTokenCount: USAGE.input + USAGE.output };
  const parts: unknown[] = [];
  // JSON side requests (next-speaker check, model routing) get an answer that ends the turn.
  if (req.wantsJson) parts.push({ text: JSON.stringify({ reasoning: "The answer is complete.", next_speaker: "user", model_choice: "flash" }) });
  else {
    if (reply.text) parts.push({ text: reply.text });
    if (reply.kind === "tool") parts.push({ functionCall: { id: id("call"), name: reply.name, args: reply.args } });
  }
  const candidate = (p: unknown[], finishReason?: string) => ({ candidates: [{ index: 0, content: { role: "model", parts: p }, ...(finishReason ? { finishReason } : {}) }], modelVersion: req.model });
  if (!stream) return sendJson(res, { ...candidate(parts, "STOP"), usageMetadata });
  sse(res);
  const data = (v: unknown) => res.write(`data: ${JSON.stringify(v)}\n\n`);
  if (reply.kind === "hang" && !req.wantsJson) {
    data(candidate(parts));
    hold(res, () => res.write(": keep-alive\n\n"));
    return;
  }
  data({ ...candidate(parts, "STOP"), usageMetadata });
  res.end();
}
