import type { AgentEvent, Answer, EndReason, LimitSample, LimitWindow } from "@crewyard/core";
import type {
  AgentMessageDeltaNotification,
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  ErrorNotification,
  FileChangeApprovalDecision,
  FileChangeRequestApprovalParams,
  ItemCompletedNotification,
  ItemStartedNotification,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  RateLimitSnapshot,
  RateLimitWindow,
  ReasoningSummaryTextDeltaNotification,
  ThreadItem,
  ThreadTokenUsage,
  ThreadTokenUsageUpdatedNotification,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  Turn,
  TurnCompletedNotification,
  TurnDiffUpdatedNotification,
  TurnPlanUpdatedNotification,
  TurnStartedNotification,
} from "./protocol/index.ts";
import { addUsage, NO_USAGE, type TokenUsageBreakdown } from "./review-usage.ts";

// Pure translation between codex app-server messages and Crewyard's AgentEvent / Answer types.
// The adapter adds the envelope (runId, seq, at, source) and owns process and request state.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventBody = DistributiveOmit<AgentEvent, "runId" | "seq" | "at" | "source">;

const OUTPUT_LIMIT = 8_000;

/** The default bucket. Other ids are model-specific limits that LimitWindow cannot name yet. */
export const CODEX_LIMIT_ID = "codex";

// ---------------------------------------------------------------- limits

/** Window lengths codex reports, in minutes; matched with one minute of tolerance. */
const WINDOW_MINUTES: Array<[number, LimitWindow]> = [
  [300, "5h"],
  [1_440, "daily"],
  [10_080, "weekly"],
];

/**
 * Labels a window by its length only, never by whether codex sent it as primary or secondary:
 * the order is not a contract, and a mislabelled window would raise the wrong 80/95% notice.
 * A window of unknown or missing length is dropped rather than guessed.
 */
export function windowOf(w: RateLimitWindow): LimitWindow | null {
  const mins = w.windowDurationMins;
  if (mins === null) return null;
  return WINDOW_MINUTES.find(([m]) => Math.abs(mins - m) <= 1)?.[1] ?? null;
}

/** codex sends Unix seconds; a value past 1e10 can only be milliseconds, so it is read as such. */
export const isoFromUnix = (t: number | null): string | null => (t === null ? null : new Date(t > 1e10 ? t : t * 1000).toISOString());
const clampPct = (n: number): number => Math.min(100, Math.max(0, n));

/** True for snapshots of the default bucket. Live updates of other buckets are skipped (limit.update has no bucket); account/rateLimits/read reads them all. */
export function isDefaultBucket(s: RateLimitSnapshot): boolean {
  return s.limitId === null || s.limitId === CODEX_LIMIT_ID;
}

function windows(s: RateLimitSnapshot): Array<{ window: LimitWindow; w: RateLimitWindow }> {
  const out: Array<{ window: LimitWindow; w: RateLimitWindow }> = [];
  for (const w of [s.primary, s.secondary]) {
    const window = w ? windowOf(w) : null;
    if (w && window) out.push({ window, w });
  }
  return out;
}

/**
 * `account/rateLimits/updated` is sparse: a missing window means "no news", not "cleared", so we
 * emit only the windows present. When codex says a limit was reached without a 100% window, the
 * fullest window is the one marked reached.
 */
export function limitEvents(s: RateLimitSnapshot): EventBody[] {
  if (!isDefaultBucket(s)) return [];
  const ws = windows(s);
  const fullest = ws.reduce<RateLimitWindow | null>((a, b) => (a === null || b.w.usedPercent > a.usedPercent ? b.w : a), null);
  return ws.map(({ window, w }) => ({
    type: "limit.update",
    window,
    usedPct: clampPct(w.usedPercent),
    resetsAt: isoFromUnix(w.resetsAt),
    provenance: "reported",
    reached: w.usedPercent >= 100 || (s.rateLimitReachedType !== null && s.rateLimitReachedType !== undefined && w === fullest),
  }));
}

/** Samples of one snapshot; a bucket other than the default one carries its id and codex's name for it. */
export function limitSamples(profileId: string, s: RateLimitSnapshot, observedAt: string): LimitSample[] {
  const bucket = isDefaultBucket(s) ? {} : { bucket: s.limitId, bucketLabel: s.limitName };
  return windows(s).map(({ window, w }) => ({ profileId, window, ...bucket, usedPct: clampPct(w.usedPercent), resetsAt: isoFromUnix(w.resetsAt), provenance: "reported", observedAt }));
}

/** Every bucket `account/rateLimits/read` lists, or the single snapshot when it lists none. */
export function snapshotsOf(res: { rateLimits: RateLimitSnapshot; rateLimitsByLimitId: { [key in string]?: RateLimitSnapshot } | null }): RateLimitSnapshot[] {
  const buckets = Object.values(res.rateLimitsByLimitId ?? {}).filter((s): s is RateLimitSnapshot => s !== undefined);
  return buckets.length > 0 ? buckets : [res.rateLimits];
}

/** API-key accounts and failed reads: the windows exist but nobody reported them (PLAN.md §7.1). */
export function unknownSamples(profileId: string, observedAt: string): LimitSample[] {
  return (["5h", "weekly"] as const).map((window) => ({ profileId, window, usedPct: null, resetsAt: null, provenance: "unknown", observedAt }));
}

// ---------------------------------------------------------------- usage, diff, plan

/**
 * OpenAI counts cached tokens inside inputTokens. tokensIn here excludes them so tokensIn,
 * cacheRead and cacheWrite never overlap and a price lookup cannot count a token twice.
 * Context fill is the last request's total, which is what was in the window at that moment.
 * `subagents` is what the thread's review subagents spent (review-usage.ts): codex never reports
 * it, so it is added to the thread's own totals and the run's totals keep growing.
 */
export function usageEvent(u: ThreadTokenUsage | null, subagents: TokenUsageBreakdown = NO_USAGE): EventBody {
  const t = addUsage(u?.total ?? NO_USAGE, subagents);
  return {
    type: "usage.update",
    tokensIn: Math.max(0, t.inputTokens - t.cachedInputTokens),
    tokensOut: t.outputTokens,
    cacheRead: t.cachedInputTokens,
    cacheWrite: t.cacheWriteInputTokens ?? 0,
    reasoning: t.reasoningOutputTokens,
    contextUsed: u ? u.last.totalTokens : null,
    contextSize: u && u.modelContextWindow !== null && u.modelContextWindow > 0 ? u.modelContextWindow : null,
    // Subscription turns have no price; API-key cost is estimated by the daemon from the catalog.
    costUsd: null,
    costProvenance: "unknown",
  };
}

/** Per-file added/removed line counts from the unified diff codex sends in turn/diff/updated. */
export function parseDiffStats(diff: string): Array<{ path: string; added: number; removed: number }> {
  const files: Array<{ path: string; added: number; removed: number }> = [];
  let current: { path: string; added: number; removed: number } | null = null;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2] ?? header[1] ?? "", added: 0, removed: 0 };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      // Renames and deletions: "+++ /dev/null" keeps the old path from the header.
      const plus = /^\+\+\+ b\/(.+)$/.exec(line);
      if (plus?.[1]) current.path = plus[1];
      continue;
    }
    if (line.startsWith("+")) current.added++;
    else if (line.startsWith("-")) current.removed++;
  }
  return files;
}

export function planEvent(p: TurnPlanUpdatedNotification): EventBody {
  return {
    type: "plan.update",
    steps: p.plan.map((s) => ({ title: s.step, status: s.status === "inProgress" ? "in_progress" : s.status })),
  };
}

// ---------------------------------------------------------------- items

function toolKind(item: ThreadItem): "read" | "edit" | "execute" | "search" | "fetch" | "other" {
  switch (item.type) {
    case "commandExecution": {
      const kinds = new Set(item.commandActions.map((a) => a.type));
      if (kinds.size === 1 && kinds.has("search")) return "search";
      if (kinds.size > 0 && [...kinds].every((k) => k === "read" || k === "listFiles")) return "read";
      return "execute";
    }
    case "fileChange":
      return "edit";
    case "webSearch":
      return "search";
    case "imageView":
      return "read";
    default:
      return "other";
  }
}

function toolCall(item: ThreadItem): EventBody | null {
  switch (item.type) {
    case "commandExecution":
      return { type: "tool.call", toolCallId: item.id, title: item.command, kind: toolKind(item), input: { command: item.command, cwd: item.cwd } };
    case "fileChange":
      return { type: "tool.call", toolCallId: item.id, title: item.changes.map((c) => c.path).join(", ") || "edit", kind: "edit", input: { paths: item.changes.map((c) => c.path) } };
    case "mcpToolCall":
      return { type: "tool.call", toolCallId: item.id, title: `${item.server}.${item.tool}`, kind: "other", input: item.arguments };
    case "dynamicToolCall":
      return { type: "tool.call", toolCallId: item.id, title: item.namespace ? `${item.namespace}.${item.tool}` : item.tool, kind: "other", input: item.arguments };
    case "webSearch":
      return { type: "tool.call", toolCallId: item.id, title: item.query, kind: "search", input: { query: item.query } };
    case "imageView":
      return { type: "tool.call", toolCallId: item.id, title: item.path, kind: "read", input: { path: item.path } };
    default:
      return null;
  }
}

const tail = (s: string | null | undefined): string | undefined => (s ? (s.length > OUTPUT_LIMIT ? s.slice(-OUTPUT_LIMIT) : s) : undefined);

function toolResult(item: ThreadItem): EventBody | null {
  const done = (ok: boolean, output?: string): EventBody => ({ type: "tool.update", toolCallId: item.id, status: ok ? "completed" : "failed", ...(output !== undefined ? { output } : {}) });
  switch (item.type) {
    case "commandExecution":
      return done(item.status === "completed" && (item.exitCode === null || item.exitCode === 0), tail(item.aggregatedOutput));
    case "fileChange":
      return done(item.status === "completed");
    case "mcpToolCall":
      return done(item.status === "completed" && item.error === null, item.error ? tail(item.error.message) : undefined);
    case "dynamicToolCall":
      return done(item.success !== false);
    case "webSearch":
    case "imageView":
      return done(true);
    default:
      return null;
  }
}

// ---------------------------------------------------------------- run state

export function endOf(turn: Turn): { reason: EndReason; detail?: string } | null {
  switch (turn.status) {
    case "completed":
      return { reason: "completed" };
    case "interrupted":
      return { reason: "stopped", detail: "interrupted" };
    case "failed": {
      const info = turn.error?.codexErrorInfo;
      const detail = turn.error?.message;
      const reason: EndReason = info === "usageLimitExceeded" ? "limit" : "failed";
      return detail ? { reason, detail } : { reason };
    }
    default:
      return null;
  }
}

/**
 * Stateful notification mapper for one thread. It remembers items so approvals can name the files
 * a patch touches, and which messages already streamed so completed items are not repeated.
 */
export class NotificationMapper {
  readonly items = new Map<string, ThreadItem>();
  private readonly streamed = new Set<string>();
  turnId: string | null = null;
  /** Set when the turn ends; the adapter turns it into run.ended. */
  ended: { reason: EndReason; detail?: string } | null = null;
  /** Full text of the turn's last agent message; with turn/start outputSchema it is the JSON result. */
  lastAgentMessage: string | null = null;
  /** Text of the last native review (`exitedReviewMode.review`), for mapping it to a verdict. */
  reviewText: string | null = null;
  /** A `contextCompaction` item completed (thread/compact/start). */
  compacted = false;
  /** The thread's last token usage notification, as codex sent it. */
  lastUsage: ThreadTokenUsage | null = null;
  /** What the thread's review subagents spent so far; the adapter reads it from their rollouts. */
  subagentUsage: TokenUsageBreakdown = NO_USAGE;

  map(method: string, params: unknown): EventBody[] {
    switch (method) {
      case "turn/started": {
        const p = params as TurnStartedNotification;
        this.turnId = p.turn.id;
        this.ended = null;
        this.lastAgentMessage = null;
        return [
          { type: "turn.started", turnRef: p.turn.id },
          { type: "run.state", state: "running" },
        ];
      }
      case "turn/completed": {
        const p = params as TurnCompletedNotification;
        this.ended = endOf(p.turn);
        if (this.ended) this.turnId = null;
        return [];
      }
      case "item/started": {
        const { item } = params as ItemStartedNotification;
        this.items.set(item.id, item);
        const call = toolCall(item);
        return call ? [call] : [];
      }
      case "item/completed": {
        const { item } = params as ItemCompletedNotification;
        this.items.set(item.id, item);
        if (item.type === "agentMessage") this.lastAgentMessage = item.text;
        if (item.type === "contextCompaction") this.compacted = true;
        // The review is shown as the run's message; the verdict turn after it maps it to our schema.
        if (item.type === "exitedReviewMode") {
          this.reviewText = item.review;
          return item.review ? [{ type: "message.delta", text: item.review }] : [];
        }
        if (item.type === "agentMessage") return this.streamed.has(item.id) || !item.text ? [] : [{ type: "message.delta", text: item.text }];
        if (item.type === "reasoning") {
          const text = item.summary.join("\n\n");
          return this.streamed.has(item.id) || !text ? [] : [{ type: "thought.delta", text }];
        }
        const result = toolResult(item);
        return result ? [result] : [];
      }
      case "item/agentMessage/delta": {
        const p = params as AgentMessageDeltaNotification;
        this.streamed.add(p.itemId);
        return p.delta ? [{ type: "message.delta", text: p.delta }] : [];
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const p = params as ReasoningSummaryTextDeltaNotification;
        this.streamed.add(p.itemId);
        return p.delta ? [{ type: "thought.delta", text: p.delta }] : [];
      }
      case "turn/plan/updated":
        return [planEvent(params as TurnPlanUpdatedNotification)];
      case "turn/diff/updated":
        return [{ type: "diff.update", files: parseDiffStats((params as TurnDiffUpdatedNotification).diff) }];
      case "thread/tokenUsage/updated":
        this.lastUsage = (params as ThreadTokenUsageUpdatedNotification).tokenUsage;
        return [usageEvent(this.lastUsage, this.subagentUsage)];
      case "account/rateLimits/updated":
        return limitEvents((params as { rateLimits: RateLimitSnapshot }).rateLimits);
      case "error": {
        const p = params as ErrorNotification;
        if (!p.willRetry) return [];
        const limited = p.error.codexErrorInfo === "usageLimitExceeded" || p.error.codexErrorInfo === "serverOverloaded";
        return [{ type: "run.state", state: limited ? "rate_limited" : "running", detail: `retrying: ${p.error.message}` }];
      }
      default:
        return [];
    }
  }
}

// ---------------------------------------------------------------- server requests

export function commandApproval(requestId: string, p: CommandExecutionRequestApprovalParams): EventBody {
  const paths = (p.commandActions ?? []).flatMap((a) => (a.type === "read" ? [a.path] : a.type !== "unknown" && a.path ? [a.path] : []));
  return {
    type: "request.approval",
    requestId,
    toolCallId: p.itemId,
    command: p.command ?? null,
    cwd: p.cwd ?? null,
    paths,
    network: Boolean(p.networkApprovalContext),
  };
}

export function fileChangeApproval(requestId: string, p: FileChangeRequestApprovalParams, item: ThreadItem | undefined): EventBody {
  const paths = item?.type === "fileChange" ? item.changes.map((c) => c.path) : [];
  if (p.grantRoot) paths.push(p.grantRoot);
  return { type: "request.approval", requestId, toolCallId: p.itemId, command: null, cwd: null, paths, network: false };
}

export function permissionsApproval(requestId: string, p: PermissionsRequestApprovalParams): EventBody {
  const fs = p.permissions.fileSystem;
  return {
    type: "request.approval",
    requestId,
    toolCallId: p.itemId,
    command: null,
    cwd: p.cwd,
    paths: [...(fs?.write ?? []), ...(fs?.read ?? [])],
    network: p.permissions.network?.enabled === true,
  };
}

/** True when granting this request would let the agent write outside the read-only sandbox. */
export function permissionsWrite(p: PermissionsRequestApprovalParams): boolean {
  return (p.permissions.fileSystem?.write?.length ?? 0) > 0 || (p.permissions.fileSystem?.entries?.length ?? 0) > 0;
}

export function questionRequest(requestId: string, p: ToolRequestUserInputParams): EventBody {
  return {
    type: "request.question",
    requestId,
    questions: p.questions.map((q) => ({
      prompt: q.question,
      options: (q.options ?? []).map((o) => (o.description ? { label: o.label, description: o.description } : { label: o.label })),
      allowFreeText: q.isOther || !q.options || q.options.length === 0,
    })),
  };
}

// ---------------------------------------------------------------- answers

export function commandDecision(a: Answer): CommandExecutionApprovalDecision {
  return fileDecision(a);
}

export function fileDecision(a: Answer): FileChangeApprovalDecision {
  if (a.kind === "cancel") return "cancel";
  if (a.kind !== "approval") throw new Error("expected an approval answer");
  return a.decision === "allow_once" ? "accept" : a.decision === "allow_always" ? "acceptForSession" : "decline";
}

export function permissionsDecision(a: Answer, p: PermissionsRequestApprovalParams): PermissionsRequestApprovalResponse {
  if (a.kind === "approval" && a.decision !== "deny") {
    const granted: PermissionsRequestApprovalResponse["permissions"] = {};
    if (p.permissions.network) granted.network = p.permissions.network;
    if (p.permissions.fileSystem) granted.fileSystem = p.permissions.fileSystem;
    return { permissions: granted, scope: a.decision === "allow_always" ? "session" : "turn" };
  }
  if (a.kind === "question") throw new Error("expected an approval answer");
  return { permissions: {}, scope: "turn" };
}

/** Answers are matched to questions by position, the order request.question listed them in. */
export function userInputResponse(a: Answer, p: ToolRequestUserInputParams): ToolRequestUserInputResponse {
  if (a.kind === "cancel") return { answers: {} };
  if (a.kind !== "question") throw new Error("expected a question answer");
  const answers: ToolRequestUserInputResponse["answers"] = {};
  p.questions.forEach((q, i) => {
    const given = a.answers[i];
    if (!given) return;
    const values = [...given.selected, ...(given.text ? [given.text] : [])];
    answers[q.id] = { answers: values };
  });
  return { answers };
}
