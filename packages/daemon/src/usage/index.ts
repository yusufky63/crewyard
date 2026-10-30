import type { DatabaseSync } from "node:sqlite";
import { TIMELINE_MAX_EVENTS, TIMELINE_PREVIEW, utf8Length, type LoopDecisionKind, type Provenance, type Reason, type RunnerId, type TaskTimelineData, type TimelineEvent, type TimelineEventBody, type UsageRecord, type UsageReport } from "@crewyard/core";
import { startOfLocalDay } from "../providers/ledger.ts";

// Reads behind the usage view and the task timeline (PLAN.md M5). Read-only: the spend ledger and
// runs are written by the orchestrator, the event log by the store.

/** Local calendar day of an instant, YYYY-MM-DD, in the machine's time zone. */
export function localDay(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

const RUNNERS = new Set<string>(["claude-code", "codex", "gemini-cli", "opencode", "acp", "fake"]);
const runnerOf = (v: string | null): RunnerId | null => (v && RUNNERS.has(v) ? (v as RunnerId) : null);

interface SpendRow {
  at: string;
  provider_id: string;
  model: string | null;
  profile_id: string | null;
  credential_id: string | null;
  task_id: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cache: number;
  tokens_reasoning: number;
  cost_usd: number;
  source: string;
  catalog_version: string | null;
  runner: string | null;
  kind: string | null;
  title: string | null;
  project_id: string | null;
}

interface RunRow {
  id: string;
  task_id: string;
  profile_id: string;
  runner: string;
  model: string | null;
  at: string;
  tokens_in: number;
  tokens_out: number;
  native_session_id: string | null;
  provider_id: string | null;
  default_model: string | null;
  credential_id: string | null;
  kind: string | null;
  title: string;
  project_id: string;
  spent: number;
}

/**
 * Tokens and dollars over the last `days` local days. API-key spend comes from the ledger (one row
 * per usage delta, so it splits by day exactly). Plans, local models and keys whose model had no
 * price have no ledger rows: their run totals count on the run's last active day.
 */
export function usageReport(db: DatabaseSync, days: number, now = new Date()): UsageReport {
  const span = Math.max(1, Math.min(365, Math.round(days)));
  const start = new Date(now);
  start.setDate(start.getDate() - (span - 1));
  const from = startOfLocalDay(start);
  const groups = new Map<string, { r: UsageRecord; sources: Set<string>; versions: Set<string> }>();
  const add = (key: string, init: () => UsageRecord, fill: (g: { r: UsageRecord; sources: Set<string>; versions: Set<string> }) => void) => {
    let g = groups.get(key);
    if (!g) {
      g = { r: init(), sources: new Set(), versions: new Set() };
      groups.set(key, g);
    }
    fill(g);
  };

  const spend = db
    .prepare(
      `select s.at, s.provider_id, s.model, s.profile_id, s.credential_id, s.task_id, s.tokens_in, s.tokens_out, s.tokens_cache, s.tokens_reasoning,
              s.cost_usd, s.source, s.catalog_version, p.runner, c.kind, t.title, t.project_id
         from spend s
         left join profiles p on p.id = s.profile_id
         left join credentials c on c.id = s.credential_id
         left join tasks t on t.id = s.task_id
        where s.at >= ? order by s.at`,
    )
    .all(from) as unknown as SpendRow[];
  for (const s of spend) {
    const day = localDay(new Date(s.at));
    add(
      ["s", day, s.provider_id, s.model, s.profile_id, s.credential_id, s.task_id].join("|"),
      () => ({
        day,
        providerId: s.provider_id,
        model: s.model,
        runner: runnerOf(s.runner),
        profileId: s.profile_id,
        credentialId: s.credential_id,
        // The ledger only holds key spend; a key removed since keeps counting as one.
        credentialKind: s.kind === "local" ? "local" : "api_key",
        taskId: s.task_id,
        taskTitle: s.title,
        projectId: s.project_id,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        reasoning: 0,
        tokensProvenance: "reported",
        usd: 0,
        usdProvenance: "estimated",
        catalogVersions: [],
      }),
      (g) => {
        g.r.tokensIn += s.tokens_in;
        g.r.tokensOut += s.tokens_out;
        g.r.cacheRead = (g.r.cacheRead ?? 0) + s.tokens_cache;
        g.r.reasoning += s.tokens_reasoning;
        g.r.usd = (g.r.usd ?? 0) + s.cost_usd;
        g.sources.add(s.source);
        if (s.catalog_version) g.versions.add(s.catalog_version);
      },
    );
  }

  const runs = db
    .prepare(
      `select r.id, r.task_id, r.profile_id, r.runner, r.model, coalesce(r.last_activity_at, r.ended_at, r.started_at) as at, r.tokens_in, r.tokens_out,
              r.native_session_id, p.provider_id, p.default_model, p.credential_id, c.kind, t.title, t.project_id,
              (select count(*) from spend s where s.run_id = r.id) as spent
         from runs r
         join tasks t on t.id = r.task_id
         left join profiles p on p.id = r.profile_id
         left join credentials c on c.id = p.credential_id
        where coalesce(r.last_activity_at, r.ended_at, r.started_at) >= ? and r.tokens_in + r.tokens_out > 0`,
    )
    .all(from) as unknown as RunRow[];
  const sessionRuns = db.prepare("select count(*) as n from runs where runner = ? and native_session_id = ?");
  const cacheOf = db.prepare("select cache_read from native_usage where runner = ? and session_id = ?");
  for (const r of runs) {
    if (r.kind === "api_key" && Number(r.spent) > 0) continue;
    // native_usage is per session; a session shared by a resume has no per-run split.
    const session = r.native_session_id ?? `run:${r.id}`;
    const shared = r.native_session_id !== null && Number((sessionRuns.get(r.runner, r.native_session_id) as { n: number }).n) > 1;
    const cache = shared ? null : ((cacheOf.get(r.runner, session) as { cache_read: number } | undefined)?.cache_read ?? null);
    const day = localDay(new Date(r.at));
    const providerId = r.provider_id ?? r.runner;
    const model = r.model ?? r.default_model;
    const kind: UsageRecord["credentialKind"] = r.kind === "api_key" ? "api_key" : r.kind === "local" ? "local" : null;
    add(
      ["r", day, providerId, model, r.profile_id, r.credential_id, r.task_id].join("|"),
      () => ({
        day,
        providerId,
        model,
        runner: runnerOf(r.runner),
        profileId: r.profile_id,
        credentialId: r.credential_id,
        credentialKind: kind,
        taskId: r.task_id,
        taskTitle: r.title,
        projectId: r.project_id,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        reasoning: 0,
        tokensProvenance: "reported",
        usd: null,
        usdProvenance: "unknown",
        catalogVersions: [],
      }),
      (g) => {
        g.r.tokensIn += r.tokens_in;
        g.r.tokensOut += r.tokens_out;
        g.r.cacheRead = g.r.cacheRead === null || cache === null ? null : g.r.cacheRead + cache;
      },
    );
  }

  const records = [...groups.values()].map(({ r, sources, versions }) => {
    const usdProvenance: Provenance = r.usd === null ? "unknown" : sources.size === 1 && sources.has("billed") ? "reported" : "estimated";
    return { ...r, usd: r.usd === null ? null : Math.round(r.usd * 1_000_000) / 1_000_000, usdProvenance, catalogVersions: [...versions].sort() };
  });
  return { days: span, from: localDay(new Date(from)), to: localDay(now), generatedAt: now.toISOString(), records };
}

// ---- timeline

const KINDS = [
  "run.run.state",
  "run.run.ended",
  "run.tool.call",
  "run.tool.update",
  "run.plan.update",
  "run.request.question",
  "run.request.approval",
  "request.answered",
  "run.message",
  "handoff.opened",
  "handoff.completed",
  "handoff.failed",
  "run.limit",
  "run.retried",
  "run.auto_retry",
  "loop.decision",
  "run.hibernated",
  "run.woke",
];

const TRUNCATED = /\n?\[truncated, (\d+) bytes(?:; full text in (.+))?\]$/;
const BINARY = /^\[binary output, (\d+) bytes\]$/;

/** The head of a text within `max` UTF-8 bytes, cut at a whole character. */
export function headBytes(s: string, max: number): string {
  if (s.length * 3 <= max) return s;
  let end = Math.min(s.length, max);
  while (end > 0 && utf8Length(s.slice(0, end)) > max) end = Math.floor(end * 0.9);
  // Never end on the first half of a surrogate pair.
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

/** What the daemon kept of a tool output: its head, the original size when cut, where the rest went. */
export function readOutput(output: string | undefined): { preview: string | null; truncatedBytes: number | null; keptAt: string | null; binary: boolean } {
  if (output === undefined || output === "") return { preview: null, truncatedBytes: null, keptAt: null, binary: false };
  const bin = BINARY.exec(output);
  if (bin) return { preview: null, truncatedBytes: Number(bin[1]), keptAt: null, binary: true };
  const cut = TRUNCATED.exec(output);
  const head = cut ? output.slice(0, cut.index) : output;
  return { preview: headBytes(head, TIMELINE_PREVIEW), truncatedBytes: cut ? Number(cut[1]) : null, keptAt: cut?.[2] ?? null, binary: false };
}

type Payload = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

const DECISIONS: ReadonlySet<string> = new Set<LoopDecisionKind>([
  "tests_passed",
  "tests_failed",
  "tests_skipped",
  "review_passed",
  "review_changes",
  "review_invalid",
  "stop_iteration_cap",
  "stop_no_change",
  "stop_spend_cap",
  "stop_no_resume",
]);

/** A stored reason, kept only when its shape is right; params keep only strings and numbers. */
function reasonOf(v: unknown): Reason | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Payload;
  if (typeof r.code !== "string") return null;
  const params: Record<string, string | number> = {};
  if (typeof r.params === "object" && r.params !== null) for (const [k, x] of Object.entries(r.params as Payload)) if (typeof x === "string" || typeof x === "number") params[k] = x;
  return { code: r.code as Reason["code"], params };
}

function project(kind: string, p: Payload): TimelineEventBody | null {
  // A payload past the store's ceiling keeps only { truncated, bytes }.
  const whole = p.truncated === true && typeof p.bytes === "number" ? p.bytes : null;
  switch (kind) {
    case "run.run.state":
      return { kind: "run.state", state: str(p.state) ?? "", detail: str(p.detail) };
    case "run.run.ended":
      return { kind: "run.ended", reason: str(p.reason) ?? "", detail: str(p.detail) };
    case "run.tool.call":
      return str(p.toolCallId) ? { kind: "tool.call", toolCallId: str(p.toolCallId)!, title: str(p.title) ?? "", toolKind: str(p.kind) ?? "other" } : null;
    case "run.tool.update": {
      if (!str(p.toolCallId)) return null;
      const out = readOutput(str(p.output) ?? undefined);
      return { kind: "tool.update", toolCallId: str(p.toolCallId)!, status: str(p.status) ?? "", ...out, truncatedBytes: out.truncatedBytes ?? whole };
    }
    case "run.plan.update": {
      const steps = Array.isArray(p.steps) ? (p.steps as Payload[]) : [];
      return { kind: "plan.update", current: str(steps.find((s) => s.status === "in_progress")?.title) ?? null, done: steps.filter((s) => s.status === "completed").length, total: steps.length };
    }
    case "run.request.question":
    case "run.request.approval":
      return str(p.requestId) ? { kind: "request", requestId: str(p.requestId)!, request: kind === "run.request.question" ? "question" : "approval" } : null;
    case "request.answered":
      return { kind: "answered", requestId: str(p.requestId), by: str(p.by), nativeId: str(p.nativeId) };
    case "run.message":
      return { kind: "message", queued: p.queued === true };
    case "handoff.opened":
    case "handoff.completed":
    case "handoff.failed":
      return { kind: "handoff", phase: kind.slice("handoff.".length) as "opened" | "completed" | "failed", handoffId: str(p.handoffId), trigger: str(p.trigger) };
    case "run.limit":
      return { kind: "limit", window: str(p.window) };
    case "run.retried":
    case "run.auto_retry":
      return { kind: "retry", detail: str(p.after) };
    case "run.hibernated":
      return { kind: "hibernation", phase: "hibernated", by: null };
    case "run.woke":
      return { kind: "hibernation", phase: "woke", by: str(p.by) };
    case "loop.decision": {
      // A decision from a newer build with a kind this one does not know is left out, not guessed.
      const decision = str(p.kind);
      const reason = reasonOf(p.reason);
      const iteration = int(p.iteration);
      const max = int(p.max);
      if (!decision || !DECISIONS.has(decision) || !reason || iteration === null || max === null) return null;
      return { kind: "loop", decision: decision as LoopDecisionKind, memberId: str(p.memberId), iteration, max, reason };
    }
    default:
      return null;
  }
}

/** The task's events for the timeline, newest TIMELINE_MAX_EVENTS kept, oldest first. */
export function taskTimeline(db: DatabaseSync, taskId: string, max = TIMELINE_MAX_EVENTS): TaskTimelineData {
  const marks = KINDS.map(() => "?").join(", ");
  const total = Number((db.prepare(`select count(*) as n from events where task_id = ? and kind in (${marks})`).get(taskId, ...KINDS) as { n: number }).n);
  const rows = db.prepare(`select seq, at, run_id, kind, payload from events where task_id = ? and kind in (${marks}) order by seq desc limit ?`).all(taskId, ...KINDS, max) as Array<{
    seq: number;
    at: string;
    run_id: string | null;
    kind: string;
    payload: string;
  }>;
  const events: TimelineEvent[] = [];
  for (const r of rows.reverse()) {
    let payload: Payload;
    try {
      payload = JSON.parse(r.payload) as Payload;
    } catch {
      continue;
    }
    if (typeof payload !== "object" || payload === null) continue;
    const e = project(r.kind, payload);
    if (e) events.push({ seq: Number(r.seq), at: r.at, runId: r.run_id, ...e } as TimelineEvent);
  }
  return { taskId, events, omitted: Math.max(0, total - rows.length) };
}
