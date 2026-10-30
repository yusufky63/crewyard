import type { Answer } from "@crewyard/core";
import { toolKind, type EventBody } from "../mapper.ts";
import type { AssistantContent, FormField, FormInfo, FormValue, PermissionRequest, SessionMessage, Tokens, ToolContent } from "./api.ts";

// Turns OpenCode 2.x bus events into normalized event bodies. Like the 1.x mapper every method is
// idempotent: after an SSE reconnect the adapter replays the session history and the open requests
// through it, and only what was not emitted yet comes out.
//
// 2.x streams text by `(assistantMessageID, ordinal)` and keeps the finished content of a step as
// an ordered array in the history. Ordinals count text and reasoning blocks separately (as
// ai-sdk-provider-opencode-sdk reads the 2.x server, opened 2026-10-31), so a block's key holds its
// kind, and a history entry's ordinal is its index among the blocks of its kind. Not confirmed
// against a live 2.x server yet (docs/adr/0012).

const MAX_OUTPUT = 8_000;
const NETWORK_ACTIONS = new Set(["webfetch", "websearch"]);
/** 2.x tool names that differ from 1.x's, for the event kind. */
const TOOL_ALIASES: Record<string, string> = { shell: "bash" };

type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export class OpenCodeV2Mapper {
  private readonly sessions = new Set<string>();
  private readonly emittedChars = new Map<string, number>();
  private readonly toolNames = new Map<string, string>();
  private readonly toolStatus = new Map<string, ToolStatus>();
  private readonly usage = new Map<string, { cost: number; tokens: Tokens }>();
  private lastStep: Tokens | null = null;
  private lastUsage = "";
  /** Requests shown to the user and not answered yet, by OpenCode request id. */
  readonly pending = new Map<string, { kind: "permission" | "form"; sessionID: string; form?: FormInfo }>();
  private readonly seenRequests = new Set<string>();
  private readonly seenTurns = new Set<string>();
  readonly rootSession: string;
  private readonly cwd: string;

  constructor(rootSession: string, cwd: string) {
    this.rootSession = rootSession;
    this.cwd = cwd;
    this.sessions.add(rootSession);
  }

  owns(sessionID: string | undefined): boolean {
    return sessionID !== undefined && this.sessions.has(sessionID);
  }

  sessionSeen(info: { sessionID: string; parentID?: string }): void {
    if (info.parentID && this.sessions.has(info.parentID)) this.sessions.add(info.sessionID);
  }

  /** The user message our prompt became; session revert takes its id. */
  turn(messageID: string): EventBody[] {
    if (this.seenTurns.has(messageID)) return [];
    this.seenTurns.add(messageID);
    return [{ type: "turn.started", turnRef: messageID }];
  }

  delta(sessionID: string, messageID: string, ordinal: number, kind: "text" | "reasoning", delta: string): EventBody[] {
    if (!this.owns(sessionID)) return [];
    return this.text(`${messageID}:${kind}:${ordinal}`, kind, null, delta);
  }

  textEnded(sessionID: string, messageID: string, ordinal: number, kind: "text" | "reasoning", full: string): EventBody[] {
    if (!this.owns(sessionID)) return [];
    return this.text(`${messageID}:${kind}:${ordinal}`, kind, full, null);
  }

  toolStarted(sessionID: string, id: string, name: string): EventBody[] {
    if (!this.owns(sessionID)) return [];
    this.toolNames.set(id, name);
    return [];
  }

  toolCalled(sessionID: string, id: string, input: unknown): EventBody[] {
    if (!this.owns(sessionID)) return [];
    return this.tool(id, this.toolNames.get(id) ?? "tool", input, "in_progress", undefined);
  }

  toolDone(sessionID: string, id: string, ok: boolean, output: string): EventBody[] {
    if (!this.owns(sessionID)) return [];
    return this.tool(id, this.toolNames.get(id) ?? "tool", {}, ok ? "completed" : "failed", output);
  }

  /** A finished step: its tokens are the context size of that call. */
  step(sessionID: string, tokens: Tokens | undefined): void {
    if (this.owns(sessionID) && tokens && tokens.input + tokens.output > 0) this.lastStep = tokens;
  }

  /** `session.usage.updated` carries the session's running totals, so each session's last value counts. */
  sessionUsage(sessionID: string, cost: number, tokens: Tokens): EventBody[] {
    if (!this.owns(sessionID)) return [];
    this.usage.set(sessionID, { cost, tokens });
    return this.usageEvent();
  }

  /** A history entry, read at resume or after a reconnect. */
  message(sessionID: string, m: SessionMessage): EventBody[] {
    if (!this.owns(sessionID)) return [];
    if (m.type === "user") return sessionID === this.rootSession ? this.turn(m.id) : [];
    if (m.type !== "assistant" || !("content" in m)) return [];
    const out: EventBody[] = [];
    const ordinals = { text: 0, reasoning: 0 };
    for (const c of m.content as AssistantContent[]) {
      if (c.type === "text" || c.type === "reasoning") out.push(...this.text(`${m.id}:${c.type}:${ordinals[c.type]++}`, c.type, c.text, null));
      else if (c.type === "tool") {
        this.toolNames.set(c.id, c.name);
        const s = c.state;
        if (s.status === "completed") out.push(...this.tool(c.id, c.name, s.input, "completed", contentText(s.content)));
        else if (s.status === "error") out.push(...this.tool(c.id, c.name, s.input, "failed", s.error.message));
        else if (s.status === "running") out.push(...this.tool(c.id, c.name, s.input, "in_progress", undefined));
      }
    }
    if (m.tokens) this.step(sessionID, m.tokens);
    return out;
  }

  /** Marks a history as already shown (resume: it is in our event log), without emitting it. */
  prime(sessionID: string, history: SessionMessage[]): void {
    for (const m of history) void this.message(sessionID, m);
  }

  permission(req: PermissionRequest): EventBody[] {
    if (!this.owns(req.sessionID) || this.seenRequests.has(req.id)) return [];
    this.seenRequests.add(req.id);
    this.pending.set(req.id, { kind: "permission", sessionID: req.sessionID });
    const meta = req.metadata ?? {};
    const shell = req.action === "shell";
    const network = NETWORK_ACTIONS.has(req.action);
    const command = shell ? (typeof meta.command === "string" ? meta.command : req.resources.join(" ")) : null;
    const filepath = typeof meta.filepath === "string" ? [meta.filepath] : [];
    const paths = shell || network ? [] : filepath.length > 0 ? filepath : req.resources;
    return [
      {
        type: "request.approval",
        requestId: req.id,
        toolCallId: req.source?.id ?? null,
        command: command ?? (paths.length === 0 ? `${req.action} ${req.resources.join(" ")}`.trim() : null),
        cwd: this.cwd,
        paths,
        network,
      },
    ];
  }

  /** A form is 2.x's question: one question per field, the form's title on a single-field form. */
  form(form: FormInfo): EventBody[] {
    if (!this.owns(form.sessionID) || this.seenRequests.has(form.id)) return [];
    this.seenRequests.add(form.id);
    this.pending.set(form.id, { kind: "form", sessionID: form.sessionID, form });
    const single = form.fields.length === 1;
    return [
      {
        type: "request.question",
        requestId: form.id,
        questions: form.fields.map((f) => ({
          prompt: (single ? (f.title ? `${form.title}\n${f.title}` : form.title) : (f.title ?? f.key)).trim() || f.key,
          options: optionsOf(f).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
          allowFreeText: optionsOf(f).length === 0 || f.custom !== false,
        })),
      },
    ];
  }

  settle(requestId: string): void {
    this.pending.delete(requestId);
    this.seenRequests.add(requestId);
  }

  private text(key: string, kind: "text" | "reasoning", full: string | null, delta: string | null): EventBody[] {
    const done = this.emittedChars.get(key) ?? 0;
    let chunk: string;
    if (delta !== null) chunk = delta;
    else if (full !== null && full.length > done) chunk = full.slice(done);
    else return [];
    if (chunk.length === 0) return [];
    this.emittedChars.set(key, done + chunk.length);
    return [{ type: kind === "text" ? "message.delta" : "thought.delta", text: chunk }];
  }

  private tool(id: string, name: string, input: unknown, status: ToolStatus, output: string | undefined): EventBody[] {
    const out: EventBody[] = [];
    const prev = this.toolStatus.get(id);
    if (prev === undefined) out.push({ type: "tool.call", toolCallId: id, title: name, kind: toolKind(TOOL_ALIASES[name] ?? name), input });
    if (prev === status || (prev !== undefined && prev !== "in_progress" && prev !== "pending")) return out;
    this.toolStatus.set(id, status);
    out.push(output === undefined ? { type: "tool.update", toolCallId: id, status } : { type: "tool.update", toolCallId: id, status, output: output.slice(0, MAX_OUTPUT) });
    return out;
  }

  private usageEvent(): EventBody[] {
    const all = [...this.usage.values()];
    if (all.every((u) => u.cost === 0 && u.tokens.input + u.tokens.output === 0)) return [];
    const sum = (pick: (t: Tokens) => number) => all.reduce((n, u) => n + pick(u.tokens), 0);
    const step = this.lastStep;
    const body: EventBody = {
      type: "usage.update",
      tokensIn: sum((t) => t.input),
      tokensOut: sum((t) => t.output),
      cacheRead: sum((t) => t.cache.read),
      cacheWrite: sum((t) => t.cache.write),
      reasoning: sum((t) => t.reasoning),
      contextUsed: step ? step.input + step.output + step.cache.read + step.cache.write : null,
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

function optionsOf(f: FormField): Array<{ value: string; label: string; description?: string }> {
  if (f.type === "boolean") return [{ value: "true", label: "true" }, { value: "false", label: "false" }];
  return f.options ?? [];
}

export function contentText(content: readonly ToolContent[] | undefined): string {
  return (content ?? []).map((c) => (c.type === "text" ? c.text : (c.name ?? c.uri ?? ""))).join("\n");
}

/**
 * Our answer as the form's answer object: an option's label goes back as its value, free text as
 * typed, a boolean as true/false and a number field as a number.
 */
export function formAnswer(form: FormInfo, answer: Extract<Answer, { kind: "question" }>): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  form.fields.forEach((f, i) => {
    const a = answer.answers[i] ?? { selected: [] };
    const options = optionsOf(f);
    const values = a.selected.map((label) => options.find((o) => o.label === label)?.value ?? label);
    const typed = a.text?.trim() ? [a.text.trim()] : [];
    if (f.type === "multiselect") out[f.key] = [...values, ...typed];
    else if (f.type === "boolean") {
      const v = values[0] ?? typed[0];
      if (v !== undefined) out[f.key] = v === "true";
    } else if (f.type === "number" || f.type === "integer") {
      const v = Number(values[0] ?? typed[0]);
      if (Number.isFinite(v)) out[f.key] = v;
    } else {
      const v = values[0] ?? typed[0];
      if (v !== undefined) out[f.key] = v;
    }
  });
  return out;
}
