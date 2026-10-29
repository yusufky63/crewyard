import type { AgentEvent } from "@crewyard/core";
import type { Message, Part, PermissionRequest, QuestionRequest, SnapshotFileDiff, Todo, ToolPart } from "@opencode-ai/sdk/v2";

// Turns OpenCode bus events into normalized event bodies. Every method is idempotent: after an SSE
// reconnect the adapter replays the whole session (messages, pending requests) through the same
// methods, and only what was not emitted yet comes out. SSE has no replay, so this is how gaps close.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventBody = DistributiveOmit<AgentEvent, "runId" | "seq" | "at" | "source">;

const MAX_OUTPUT = 8_000;

type ToolKind = Extract<AgentEvent, { type: "tool.call" }>["kind"];

export function toolKind(tool: string): ToolKind {
  if (["read", "list", "ls"].includes(tool)) return "read";
  if (["edit", "write", "patch", "multiedit", "apply_patch"].includes(tool)) return "edit";
  if (tool === "bash") return "execute";
  if (["grep", "glob", "codesearch", "lsp"].includes(tool)) return "search";
  if (["webfetch", "websearch"].includes(tool)) return "fetch";
  return "other";
}

const NETWORK_PERMISSIONS = new Set(["webfetch", "websearch"]);

interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export class OpenCodeMapper {
  private readonly sessions = new Set<string>();
  private readonly roles = new Map<string, "user" | "assistant">();
  private readonly partTypes = new Map<string, Part["type"]>();
  private readonly emittedChars = new Map<string, number>();
  private readonly toolStatus = new Map<string, string>();
  private readonly usage = new Map<string, { tokens: Tokens; cost: number; created: number }>();
  private lastUsage = "";
  private lastPlan = "";
  private lastDiff = "";
  /** Requests shown to the user and not answered yet, by OpenCode request id. */
  readonly pending = new Map<string, "permission" | "question">();
  private readonly seenRequests = new Set<string>();
  readonly rootSession: string;
  private readonly cwd: string;

  constructor(rootSession: string, cwd: string) {
    this.rootSession = rootSession;
    this.cwd = cwd;
    this.sessions.add(rootSession);
  }

  /** The root session and the child sessions its subagents (task tool) create. */
  owns(sessionID: string | undefined): boolean {
    return sessionID !== undefined && this.sessions.has(sessionID);
  }

  sessionSeen(info: { id: string; parentID?: string }): void {
    if (info.parentID && this.sessions.has(info.parentID)) this.sessions.add(info.id);
  }

  message(info: Message): EventBody[] {
    if (!this.owns(info.sessionID)) return [];
    this.roles.set(info.id, info.role);
    if (info.role !== "assistant") return [];
    this.usage.set(info.id, { tokens: info.tokens, cost: info.cost, created: info.time.created });
    return this.usageEvent();
  }

  part(part: Part): EventBody[] {
    if (!this.owns(part.sessionID)) return [];
    this.partTypes.set(part.id, part.type);
    if (this.roles.get(part.messageID) === "user") return [];
    if (part.type === "text" || part.type === "reasoning") {
      if (part.type === "text" && (part.synthetic || part.ignored)) return [];
      return this.text(part.id, part.type, part.text, null);
    }
    if (part.type === "tool") return this.tool(part);
    return [];
  }

  delta(p: { sessionID: string; messageID: string; partID: string; field: string; delta: string }): EventBody[] {
    if (!this.owns(p.sessionID) || p.field !== "text" || this.roles.get(p.messageID) === "user") return [];
    const type = this.partTypes.get(p.partID) === "reasoning" ? "reasoning" : "text";
    return this.text(p.partID, type, null, p.delta);
  }

  todos(sessionID: string, todos: Todo[]): EventBody[] {
    if (sessionID !== this.rootSession) return [];
    const steps = todos
      .filter((t) => t.status !== "cancelled")
      .map((t) => ({ title: t.content, status: t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending" }) as const);
    const key = JSON.stringify(steps);
    if (key === this.lastPlan) return [];
    this.lastPlan = key;
    return [{ type: "plan.update", steps }];
  }

  diff(sessionID: string, diff: SnapshotFileDiff[]): EventBody[] {
    if (sessionID !== this.rootSession) return [];
    const files = diff.flatMap((d) => (d.file ? [{ path: d.file, added: d.additions, removed: d.deletions }] : []));
    const key = JSON.stringify(files);
    if (key === this.lastDiff) return [];
    this.lastDiff = key;
    return [{ type: "diff.update", files }];
  }

  permission(req: PermissionRequest): EventBody[] {
    if (!this.owns(req.sessionID) || this.seenRequests.has(req.id)) return [];
    this.seenRequests.add(req.id);
    this.pending.set(req.id, "permission");
    const meta = req.metadata ?? {};
    const command = req.permission === "bash" ? (typeof meta.command === "string" ? meta.command : req.patterns.join(" ")) : null;
    const filepath = typeof meta.filepath === "string" ? [meta.filepath] : [];
    const paths = req.permission === "bash" || NETWORK_PERMISSIONS.has(req.permission) ? [] : filepath.length > 0 ? filepath : req.patterns;
    return [
      {
        type: "request.approval",
        requestId: req.id,
        toolCallId: req.tool?.callID ?? null,
        command: command ?? (paths.length === 0 ? `${req.permission} ${req.patterns.join(" ")}`.trim() : null),
        cwd: this.cwd,
        paths,
        network: NETWORK_PERMISSIONS.has(req.permission),
      },
    ];
  }

  question(req: QuestionRequest): EventBody[] {
    if (!this.owns(req.sessionID) || this.seenRequests.has(req.id)) return [];
    this.seenRequests.add(req.id);
    this.pending.set(req.id, "question");
    return [
      {
        type: "request.question",
        requestId: req.id,
        questions: req.questions.map((q) => ({
          prompt: q.question,
          options: q.options.map((o) => ({ label: o.label, description: o.description })),
          // OpenCode adds a free-text "Other" answer unless the tool turned it off.
          allowFreeText: q.custom !== false,
        })),
      },
    ];
  }

  /** Marks a request as handled (answered here, or replied elsewhere and seen on the bus). */
  settle(requestId: string): void {
    this.pending.delete(requestId);
    this.seenRequests.add(requestId);
  }

  private text(partId: string, type: "text" | "reasoning", full: string | null, delta: string | null): EventBody[] {
    const done = this.emittedChars.get(partId) ?? 0;
    let chunk: string;
    if (delta !== null) chunk = delta;
    else if (full !== null && full.length > done) chunk = full.slice(done);
    else return [];
    if (chunk.length === 0) return [];
    this.emittedChars.set(partId, done + chunk.length);
    return [{ type: type === "text" ? "message.delta" : "thought.delta", text: chunk }];
  }

  private tool(part: ToolPart): EventBody[] {
    const out: EventBody[] = [];
    const id = part.callID;
    const prev = this.toolStatus.get(id);
    const state = part.state;
    if (prev === undefined) {
      const title = "title" in state && state.title ? state.title : part.tool;
      out.push({ type: "tool.call", toolCallId: id, title, kind: toolKind(part.tool), input: state.input });
    }
    if (prev !== state.status) {
      this.toolStatus.set(id, state.status);
      if (state.status === "pending") {
        if (prev !== undefined) out.push({ type: "tool.update", toolCallId: id, status: "pending" });
      } else if (state.status === "running") out.push({ type: "tool.update", toolCallId: id, status: "in_progress" });
      else if (state.status === "completed") out.push({ type: "tool.update", toolCallId: id, status: "completed", output: state.output.slice(0, MAX_OUTPUT) });
      else out.push({ type: "tool.update", toolCallId: id, status: "failed", output: state.error.slice(0, MAX_OUTPUT) });
    }
    return out;
  }

  private usageEvent(): EventBody[] {
    const all = [...this.usage.values()];
    if (all.every((u) => u.cost === 0 && u.tokens.input + u.tokens.output === 0)) return [];
    const sum = (pick: (t: Tokens) => number) => all.reduce((n, u) => n + pick(u.tokens), 0);
    const latest = all.filter((u) => u.tokens.input + u.tokens.output > 0).sort((a, b) => b.created - a.created)[0];
    const contextUsed = latest ? latest.tokens.input + latest.tokens.output + latest.tokens.cache.read + latest.tokens.cache.write : null;
    const body: EventBody = {
      type: "usage.update",
      tokensIn: sum((t) => t.input),
      tokensOut: sum((t) => t.output),
      cacheRead: sum((t) => t.cache.read),
      cacheWrite: sum((t) => t.cache.write),
      reasoning: sum((t) => t.reasoning),
      contextUsed,
      contextSize: null,
      costUsd: all.reduce((n, u) => n + u.cost, 0),
      // OpenCode prices tokens with its models.dev table; the provider's bill can differ.
      costProvenance: "estimated",
    };
    const key = JSON.stringify(body);
    if (key === this.lastUsage) return [];
    this.lastUsage = key;
    return [body];
  }
}
