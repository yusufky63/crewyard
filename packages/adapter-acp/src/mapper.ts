import { isAbsolute, relative } from "node:path";
import type { AgentEvent, Answer, RolePolicy } from "@crewyard/core";
import type { PermissionOption, RequestPermissionOutcome, SessionUpdate, ToolCallContent, ToolCallUpdate, ToolKind as AcpToolKind } from "@agentclientprotocol/sdk";

// ACP session/update kinds map almost one to one onto our event model (PLAN.md §5.3 is shaped
// after them); the work here is status dedupe, diff line counts and permission option choice.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventBody = DistributiveOmit<AgentEvent, "runId" | "seq" | "at" | "source">;
type ToolKind = Extract<AgentEvent, { type: "tool.call" }>["kind"];

const MAX_OUTPUT = 8_000;

export function toolKind(kind: AcpToolKind | null | undefined): ToolKind {
  switch (kind) {
    case "read":
    case "search":
    case "execute":
    case "fetch":
      return kind;
    case "edit":
    case "delete":
    case "move":
      return "edit";
    default:
      return "other";
  }
}

const WRITE_KINDS = new Set<AcpToolKind>(["edit", "delete", "move"]);

function lineCount(text: string | null | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  if (!text) return counts;
  for (const line of text.split(/\r?\n/)) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** Lines only in one side, counted as a multiset; close enough for the diff badge without a diff library. */
export function diffStat(oldText: string | null | undefined, newText: string): { added: number; removed: number } {
  const before = lineCount(oldText);
  const after = lineCount(newText);
  let added = 0;
  let removed = 0;
  for (const [line, n] of after) added += Math.max(0, n - (before.get(line) ?? 0));
  for (const [line, n] of before) removed += Math.max(0, n - (after.get(line) ?? 0));
  return { added, removed };
}

function contentText(content: ToolCallContent[] | null | undefined): string | undefined {
  const parts = (content ?? []).flatMap((c) => (c.type === "content" && c.content.type === "text" ? [c.content.text] : []));
  return parts.length > 0 ? parts.join("\n").slice(0, MAX_OUTPUT) : undefined;
}

function rawCommand(raw: unknown): string | null {
  if (raw && typeof raw === "object" && "command" in raw && typeof raw.command === "string") return raw.command;
  return null;
}

export class AcpMapper {
  private readonly status = new Map<string, string>();
  private readonly kinds = new Map<string, AcpToolKind>();

  update(u: SessionUpdate): EventBody[] {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        return u.content.type === "text" && u.content.text ? [{ type: "message.delta", text: u.content.text }] : [];
      case "agent_thought_chunk":
        return u.content.type === "text" && u.content.text ? [{ type: "thought.delta", text: u.content.text }] : [];
      case "tool_call": {
        if (u.kind) this.kinds.set(u.toolCallId, u.kind);
        const out: EventBody[] = [];
        if (!this.status.has(u.toolCallId)) out.push({ type: "tool.call", toolCallId: u.toolCallId, title: u.title, kind: toolKind(u.kind), input: u.rawInput ?? null });
        return [...out, ...this.toolUpdate(u)];
      }
      case "tool_call_update":
        if (u.kind) this.kinds.set(u.toolCallId, u.kind);
        return this.toolUpdate(u);
      case "plan":
        return [{ type: "plan.update", steps: u.entries.map((e) => ({ title: e.content, status: e.status })) }];
      case "usage_update": {
        const usd = u.cost && u.cost.currency.toUpperCase() === "USD" ? u.cost.amount : null;
        return [
          {
            type: "usage.update",
            // ACP reports the context window, not per-turn token counts.
            tokensIn: 0,
            tokensOut: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            contextUsed: Math.max(0, Math.round(u.used)),
            contextSize: u.size > 0 ? Math.round(u.size) : null,
            costUsd: usd,
            costProvenance: usd === null ? "unknown" : "reported",
          },
        ];
      }
      default:
        return [];
    }
  }

  kindOf(toolCallId: string): AcpToolKind | undefined {
    return this.kinds.get(toolCallId);
  }

  approval(requestId: string, toolCall: ToolCallUpdate, cwd: string): EventBody {
    const kind = toolCall.kind ?? this.kinds.get(toolCall.toolCallId);
    const paths = (toolCall.locations ?? []).map((l) => l.path);
    const command = kind === "execute" ? (rawCommand(toolCall.rawInput) ?? toolCall.title ?? null) : paths.length === 0 ? (toolCall.title ?? null) : null;
    return { type: "request.approval", requestId, toolCallId: toolCall.toolCallId, command, cwd, paths, network: kind === "fetch" };
  }

  private toolUpdate(u: ToolCallUpdate): EventBody[] {
    const out: EventBody[] = [];
    const diffs = (u.content ?? []).flatMap((c) => (c.type === "diff" ? [{ path: c.path, ...diffStat(c.oldText, c.newText) }] : []));
    if (diffs.length > 0) out.push({ type: "diff.update", files: diffs });
    const status = u.status ?? undefined;
    const prev = this.status.get(u.toolCallId);
    if (status === "pending" && prev === undefined) {
      // A new tool.call already means pending.
      this.status.set(u.toolCallId, status);
    } else if (status && prev !== status) {
      this.status.set(u.toolCallId, status);
      const output = contentText(u.content);
      out.push(output === undefined ? { type: "tool.update", toolCallId: u.toolCallId, status } : { type: "tool.update", toolCallId: u.toolCallId, status, output });
    } else if (!this.status.has(u.toolCallId)) {
      this.status.set(u.toolCallId, "pending");
    }
    return out;
  }
}

/** Picks the agent's option for our decision, falling back to the nearest one it offers. */
export function chooseOutcome(options: PermissionOption[], answer: Answer): RequestPermissionOutcome {
  if (answer.kind === "cancel") return { outcome: "cancelled" };
  if (answer.kind !== "approval") throw new Error("This request is an approval, not a question");
  const order = answer.decision === "allow_once" ? ["allow_once", "allow_always"] : answer.decision === "allow_always" ? ["allow_always", "allow_once"] : ["reject_once", "reject_always"];
  for (const kind of order) {
    const option = options.find((o) => o.kind === kind);
    if (option) return { outcome: "selected", optionId: option.optionId };
  }
  // An agent that offers no matching option still has to be told no; cancelling is never an approval.
  return { outcome: "cancelled" };
}

/** ACP locations are absolute; only paths inside the worktree can count as docs. */
export function isDocsPath(path: string, cwd: string): boolean {
  const rel = (isAbsolute(path) ? relative(cwd, path) : path).replace(/\\/g, "/").replace(/^\.\//, "");
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return false;
  return /\.(md|mdx|txt)$/i.test(rel) || rel.startsWith("docs/");
}

/** Requests a role may never grant are refused before they reach the user (readOnlyMode). */
export function mustReject(policy: RolePolicy, kind: AcpToolKind | undefined, paths: string[], cwd: string): boolean {
  if (kind && WRITE_KINDS.has(kind)) {
    if (policy.writes === "none") return true;
    if (policy.writes === "docs") return paths.length === 0 || !paths.every((p) => isDocsPath(p, cwd));
  }
  if (kind === "fetch" && policy.network === "denied") return true;
  return false;
}
