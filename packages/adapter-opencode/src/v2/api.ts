// The part of the OpenCode 2.x server API (`/api/...`) this adapter drives. Routes, field names and
// shapes are taken from the generated Promise client in @opencode/client 2.2.4 (MIT, published
// 2026-10-30 from anomalyco/opencode, read 2026-10-31); the client itself is not a dependency (see
// docs/adr/0012). Every response body is `{ data }` except where noted; errors carry `_tag`.

export type PermissionEffect = "allow" | "deny" | "ask";

/** One rule of the ordered `permissions` list; the last matching rule wins. */
export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

export interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface StructuredError {
  type: string;
  message: string;
  status?: number;
}

export interface SessionInfo {
  id: string;
  parentID?: string;
  model?: ModelRef;
  cost: number;
  tokens: Tokens;
  time: { created: number; updated: number };
  title?: string;
  permissions?: PermissionRule[];
}

export type SessionStatus = { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string; next: number };

export type ToolContent = { type: "text"; text: string } | { type: "file"; uri?: string; name?: string };

export type ToolState =
  | { status: "streaming"; input: string }
  | { status: "running"; input: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { status: "completed"; input: Record<string, unknown>; content: ToolContent[] }
  | { status: "error"; input: Record<string, unknown>; error: StructuredError; content?: ToolContent[] };

export type AssistantContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id: string; name: string; state: ToolState };

/** The session history (`GET /api/session/{id}/message`): one entry per user prompt, assistant step, idle marker and more. */
export type SessionMessage =
  | { type: "user"; id: string; time: { created: number }; text: string }
  | { type: "assistant"; id: string; time: { created: number; completed?: number }; content: AssistantContent[]; cost?: number; tokens?: Tokens; error?: StructuredError }
  | { type: "idle"; id: string; time: { created: number }; outcome: "succeeded" | "failed" | "interrupted"; error?: StructuredError }
  | { type: string; id: string; time: { created: number } };

export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: { type: "tool"; messageID: string; id: string };
  message?: string;
}

export interface FormOption {
  value: string;
  label: string;
  description?: string;
}

/** Questions are forms in 2.x: one field per question. */
export interface FormField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external";
  title?: string;
  description?: string;
  required?: boolean;
  options?: FormOption[];
  custom?: boolean;
}

export interface FormInfo {
  id: string;
  sessionID: string;
  title: string;
  fields: FormField[];
}

export type FormValue = string | number | boolean | string[];

export interface PluginInfo {
  id?: string;
  source: { type: string; path?: string; target?: string };
  state: { status: "active" } | { status: "failed"; error: string };
}

/** The bus events the adapter reads (`GET /api/event`); every event is `{ id, type, data }`. */
export type ServerEvent =
  | { type: "server.connected"; data: Record<string, never> }
  | { type: "session.created"; data: { sessionID: string; parentID?: string } }
  | { type: "session.inbox.delivered"; data: { sessionID: string; inboxID: string } }
  | { type: "session.text.delta" | "session.reasoning.delta"; data: { sessionID: string; assistantMessageID: string; ordinal: number; delta: string } }
  | { type: "session.text.ended" | "session.reasoning.ended"; data: { sessionID: string; assistantMessageID: string; ordinal: number; text: string } }
  | { type: "session.tool.input.started"; data: { sessionID: string; assistantMessageID: string; id: string; name: string } }
  | { type: "session.tool.called"; data: { sessionID: string; assistantMessageID: string; id: string; input: Record<string, unknown> } }
  | { type: "session.tool.success"; data: { sessionID: string; assistantMessageID: string; id: string; content: ToolContent[] } }
  | { type: "session.tool.failed"; data: { sessionID: string; assistantMessageID: string; id: string; error: StructuredError } }
  | { type: "session.step.ended"; data: { sessionID: string; assistantMessageID: string; cost: number; tokens: Tokens } }
  | { type: "session.step.failed"; data: { sessionID: string; assistantMessageID: string; error: StructuredError; cost?: number; tokens?: Tokens } }
  | { type: "session.usage.updated"; data: { sessionID: string; cost: number; tokens: Tokens } }
  | { type: "session.status"; data: { sessionID: string; status: SessionStatus } }
  | { type: "session.execution.started" | "session.execution.succeeded"; data: { sessionID: string } }
  | { type: "session.execution.failed"; data: { sessionID: string; error: StructuredError } }
  | { type: "session.execution.interrupted"; data: { sessionID: string; reason: "user" | "shutdown" | "superseded" | "inactivity" } }
  | { type: "permission.asked"; data: PermissionRequest }
  | { type: "permission.replied"; data: { sessionID: string; requestID: string; reply: "once" | "always" | "reject" } }
  | { type: "form.created"; data: { form: FormInfo } }
  | { type: "form.replied" | "form.cancelled"; data: { id: string; sessionID: string } }
  | { type: "other"; data: unknown };

// Plain fields, not parameter properties: the live scripts load this file through Node's type
// stripping, which refuses syntax that emits code.
export class ServerError extends Error {
  readonly tag: string;
  readonly status: number;

  constructor(tag: string, message: string, status: number) {
    super(message);
    this.name = tag;
    this.tag = tag;
    this.status = status;
  }
}

export function isSessionGone(err: unknown): boolean {
  return err instanceof ServerError && (err.tag === "SessionNotFoundError" || err.status === 404);
}

interface Call {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

/** One client per server launch. No retries: the adapter decides what a failed call means. */
export class V2Client {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly directory: string;

  constructor(baseUrl: string, authorization: string, directory: string) {
    this.baseUrl = baseUrl;
    this.authorization = authorization;
    this.directory = directory;
  }

  private url(path: string, query: Record<string, string> = {}): URL {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(query)) url.searchParams.append(k, v);
    return url;
  }

  private async call(c: Call, signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = { authorization: this.authorization };
    if (c.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(this.url(c.path, c.query), { method: c.method, headers, body: c.body === undefined ? undefined : JSON.stringify(c.body), signal });
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const e = (parsed ?? {}) as { _tag?: string; message?: string };
      throw new ServerError(e._tag ?? `HTTP ${res.status}`, e.message ?? `opencode serve answered ${res.status} to ${c.method} ${c.path}`, res.status);
    }
    return parsed;
  }

  private async data<T>(c: Call): Promise<T> {
    const body = (await this.call(c)) as { data?: T } | undefined;
    if (body?.data === undefined) throw new Error(`opencode serve returned an empty response to ${c.method} ${c.path}`);
    return body.data;
  }

  /** The location every per-directory list is scoped to: the run's worktree. */
  private get locationQuery(): Record<string, string> {
    return { "location[directory]": this.directory };
  }

  createSession(body: { title: string; model?: ModelRef; permissions: PermissionRule[] }): Promise<SessionInfo> {
    return this.data({ method: "POST", path: "/api/session", body: { ...body, location: { directory: this.directory } } });
  }

  getSession(sessionID: string): Promise<SessionInfo> {
    return this.data({ method: "GET", path: `/api/session/${encodeURIComponent(sessionID)}` });
  }

  async updatePermissions(sessionID: string, permissions: PermissionRule[]): Promise<void> {
    await this.call({ method: "PATCH", path: `/api/session/${encodeURIComponent(sessionID)}`, body: { permissions } });
  }

  async switchModel(sessionID: string, model: ModelRef): Promise<void> {
    await this.call({ method: "POST", path: `/api/session/${encodeURIComponent(sessionID)}/model`, body: { model } });
  }

  /** Returns the inbox entry; its id is the user message id the prompt becomes. */
  prompt(sessionID: string, text: string): Promise<{ id: string }> {
    // "queue": a prompt sent while a turn runs waits for the next turn instead of steering this one.
    return this.data({ method: "POST", path: `/api/session/${encodeURIComponent(sessionID)}/prompt`, body: { text, delivery: "queue" } });
  }

  async interrupt(sessionID: string): Promise<void> {
    await this.call({ method: "POST", path: `/api/session/${encodeURIComponent(sessionID)}/interrupt` });
  }

  async messages(sessionID: string): Promise<SessionMessage[]> {
    const out: SessionMessage[] = [];
    let cursor: string | null | undefined;
    // Paged; a long session takes several pages. A cursor carries the order of the first page, and
    // 2.2.4 refuses the two together ("Cursor cannot be combined with order", seen live 2026-10-31).
    for (let page = 0; page < 100; page++) {
      const query: Record<string, string> = cursor ? { cursor, limit: "200" } : { order: "asc", limit: "200" };
      const body = (await this.call({ method: "GET", path: `/api/session/${encodeURIComponent(sessionID)}/message`, query })) as { data: SessionMessage[]; cursor?: { next?: string | null } };
      out.push(...body.data);
      cursor = body.cursor?.next;
      if (!cursor) break;
    }
    return out;
  }

  /** Session ids with a turn running; an id missing from the map is idle. */
  active(): Promise<Record<string, { type: "running" }>> {
    return this.data({ method: "GET", path: "/api/session/active" });
  }

  permissions(sessionID: string): Promise<PermissionRequest[]> {
    return this.data({ method: "GET", path: `/api/session/${encodeURIComponent(sessionID)}/permission` });
  }

  async replyPermission(sessionID: string, requestID: string, decision: "once" | "always" | "reject", message?: string): Promise<void> {
    await this.call({ method: "POST", path: `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`, body: { decision, ...(message ? { message } : {}) } });
  }

  forms(sessionID: string): Promise<FormInfo[]> {
    return this.data({ method: "GET", path: `/api/session/${encodeURIComponent(sessionID)}/form` });
  }

  async replyForm(sessionID: string, formID: string, answer: Record<string, FormValue>): Promise<void> {
    await this.call({ method: "POST", path: `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`, body: { answer } });
  }

  async cancelForm(sessionID: string, formID: string): Promise<void> {
    await this.call({ method: "DELETE", path: `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}` });
  }

  /** Stages the revert (files and history back to before the message), then makes it final. */
  async revert(sessionID: string, messageID: string): Promise<void> {
    await this.call({ method: "POST", path: `/api/session/${encodeURIComponent(sessionID)}/revert/stage`, body: { messageID, files: true } });
    await this.call({ method: "POST", path: `/api/session/${encodeURIComponent(sessionID)}/revert/commit` });
  }

  /** Reading the location makes the server load it (config, plugins) if it has not yet. */
  async location(): Promise<void> {
    await this.call({ method: "GET", path: "/api/location", query: this.locationQuery });
  }

  async plugins(): Promise<PluginInfo[]> {
    const body = (await this.call({ method: "GET", path: "/api/plugin", query: this.locationQuery })) as { data: PluginInfo[] };
    return body.data;
  }

  /** `GET /api/event`: a live SSE stream with no replay; it ends when the server closes it or `signal` aborts. */
  async *events(signal: AbortSignal): AsyncGenerator<ServerEvent> {
    const res = await fetch(this.url("/api/event"), { headers: { authorization: this.authorization, accept: "text/event-stream" }, signal });
    if (!res.ok || !res.body) throw new ServerError(`HTTP ${res.status}`, `opencode serve refused the event stream (${res.status})`, res.status);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) yield JSON.parse(data) as ServerEvent;
        end = buffer.indexOf("\n\n");
      }
    }
  }
}
