import type { TimelineEvent } from "./ipc/usage.ts";

// A task's timeline (PLAN.md M5): one lane per run with what it was doing over time, and a short
// list of what happened (steps, waits, requests, handoffs) built from the event log. Consecutive
// tool calls fold into one entry, so a run with thousands of calls still reads as a few lines.
// Pure; the inspector only draws what this returns.

export interface TimelineRun {
  id: string;
  memberId: string;
  role: string;
  runner: string;
  profileId: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

/** What a run was doing during a stretch of its lane. */
export type LaneState = "work" | "input" | "approval" | "limited" | "paused" | "handoff";

export interface LaneSegment {
  state: LaneState;
  start: number;
  end: number;
}

export interface Lane {
  run: TimelineRun;
  start: number;
  end: number;
  open: boolean;
  segments: LaneSegment[];
}

export interface ToolStep {
  toolCallId: string;
  title: string;
  toolKind: string;
  start: number;
  end: number | null;
  status: string;
  preview: string | null;
  truncatedBytes: number | null;
  keptAt: string | null;
  binary: boolean;
}

export type TimelineEntry =
  | { kind: "started"; at: number; runId: string }
  | { kind: "tools"; at: number; end: number; runId: string; steps: ToolStep[]; counts: Array<[string, number]> }
  | { kind: "wait"; at: number; end: number; runId: string; state: "limited" | "paused" | "handoff"; open: boolean }
  | { kind: "request"; at: number; runId: string | null; request: "question" | "approval"; answeredAt: number | null }
  | { kind: "handoff"; at: number; runId: string | null; phase: "opened" | "completed" | "failed"; trigger: string | null }
  | { kind: "message"; at: number; runId: string | null; queued: boolean }
  | { kind: "retry"; at: number; runId: string | null }
  | { kind: "ended"; at: number; runId: string; reason: string | null };

export interface Timeline {
  start: number;
  end: number;
  lanes: Lane[];
  entries: TimelineEntry[];
}

const STATE_OF: Record<string, LaneState> = {
  starting: "work",
  running: "work",
  waiting_input: "input",
  waiting_approval: "approval",
  rate_limited: "limited",
  paused: "paused",
  handing_off: "handoff",
};

const ms = (iso: string) => Date.parse(iso);

function lane(run: TimelineRun, events: TimelineEvent[], now: number): Lane {
  const start = ms(run.startedAt);
  const end = run.endedAt ? ms(run.endedAt) : now;
  const segments: LaneSegment[] = [];
  let state: LaneState = "work";
  let since = start;
  const close = (at: number) => {
    const t = Math.min(Math.max(at, since), end);
    if (t > since) segments.push({ state, start: since, end: t });
    since = t;
  };
  for (const e of events) {
    if (e.kind !== "run.state") continue;
    const next = STATE_OF[e.state];
    if (!next || next === state) continue;
    close(ms(e.at));
    state = next;
  }
  close(end);
  // Neighbours in the same state (a repeated state event) become one stretch.
  const merged: LaneSegment[] = [];
  for (const s of segments) {
    const last = merged.at(-1);
    if (last && last.state === s.state && last.end === s.start) last.end = s.end;
    else merged.push({ ...s });
  }
  return { run, start, end, open: !run.endedAt, segments: merged };
}

/** Tool kinds of a folded group with their counts, most frequent first. */
function countKinds(steps: ToolStep[]): Array<[string, number]> {
  const c = new Map<string, number>();
  for (const s of steps) c.set(s.toolKind, (c.get(s.toolKind) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function buildTimeline(runs: TimelineRun[], events: TimelineEvent[], now: number): Timeline {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const byRun = new Map<string, TimelineEvent[]>();
  for (const e of ordered) if (e.runId) byRun.set(e.runId, [...(byRun.get(e.runId) ?? []), e]);
  const sortedRuns = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  const lanes = sortedRuns.map((r) => lane(r, byRun.get(r.id) ?? [], now));

  // A runner's request event carries the runner's own id, which repeats across runs (Codex counts
  // from 0 in each process), so an answer matches by run and native id first, then by our id.
  const answered = new Map<string, number>();
  const answer = (key: string, at: number) => {
    if (!answered.has(key)) answered.set(key, at);
  };
  for (const e of ordered) {
    if (e.kind !== "answered") continue;
    if (e.nativeId) answer(`${e.runId ?? ""}|${e.nativeId}`, ms(e.at));
    if (e.requestId) answer(e.requestId, ms(e.at));
  }
  // Without an answer on record (logs written before answers named the runner's id), the wait is
  // over once the run works again or ends; it never counts on past that.
  const waitOver = (runId: string | null, after: number): number | null => {
    const r = runId ? sortedRuns.find((x) => x.id === runId) : undefined;
    if (!r) return null;
    // Only a wait the run itself reported counts: running again after waiting_* means it got its answer.
    const states = (byRun.get(r.id) ?? []).filter((e): e is Extract<TimelineEvent, { kind: "run.state" }> => e.kind === "run.state" && ms(e.at) >= after);
    const waiting = states.findIndex((e) => e.state === "waiting_approval" || e.state === "waiting_input");
    const back = waiting < 0 ? undefined : states.slice(waiting + 1).find((e) => e.state === "running" || e.state === "starting");
    if (back) return ms(back.at);
    return r.endedAt ? ms(r.endedAt) : null;
  };

  const entries: TimelineEntry[] = [];
  for (const r of sortedRuns) entries.push({ kind: "started", at: ms(r.startedAt), runId: r.id });
  for (const l of lanes)
    for (const s of l.segments)
      if (s.state === "limited" || s.state === "paused" || s.state === "handoff") entries.push({ kind: "wait", at: s.start, end: s.end, runId: l.run.id, state: s.state, open: l.open && s.end === l.end });

  // Tool calls fold per run until something else happens in that run.
  const steps = new Map<string, ToolStep>();
  const open = new Map<string, Extract<TimelineEntry, { kind: "tools" }>>();
  const flush = (runId: string | null) => {
    if (!runId) return;
    const g = open.get(runId);
    if (!g) return;
    g.counts = countKinds(g.steps);
    g.end = Math.max(g.end, ...g.steps.map((s) => s.end ?? s.start));
    entries.push(g);
    open.delete(runId);
  };
  for (const e of ordered) {
    const at = ms(e.at);
    switch (e.kind) {
      case "tool.call": {
        if (!e.runId) break;
        const step: ToolStep = { toolCallId: e.toolCallId, title: e.title, toolKind: e.toolKind, start: at, end: null, status: "pending", preview: null, truncatedBytes: null, keptAt: null, binary: false };
        steps.set(`${e.runId}|${e.toolCallId}`, step);
        let g = open.get(e.runId);
        if (!g) {
          g = { kind: "tools", at, end: at, runId: e.runId, steps: [], counts: [] };
          open.set(e.runId, g);
        }
        g.steps.push(step);
        break;
      }
      case "tool.update": {
        const step = e.runId ? steps.get(`${e.runId}|${e.toolCallId}`) : undefined;
        if (!step) break;
        step.status = e.status;
        if (e.status === "completed" || e.status === "failed") step.end = at;
        if (e.preview !== null) step.preview = e.preview;
        if (e.truncatedBytes !== null) step.truncatedBytes = e.truncatedBytes;
        if (e.keptAt !== null) step.keptAt = e.keptAt;
        step.binary = step.binary || e.binary;
        break;
      }
      case "request":
        flush(e.runId);
        entries.push({ kind: "request", at, runId: e.runId, request: e.request, answeredAt: answered.get(`${e.runId ?? ""}|${e.requestId}`) ?? answered.get(e.requestId) ?? waitOver(e.runId, at) });
        break;
      case "handoff":
        flush(e.runId);
        entries.push({ kind: "handoff", at, runId: e.runId, phase: e.phase, trigger: e.trigger });
        break;
      case "message":
        flush(e.runId);
        entries.push({ kind: "message", at, runId: e.runId, queued: e.queued });
        break;
      case "retry":
        flush(e.runId);
        entries.push({ kind: "retry", at, runId: e.runId });
        break;
      case "run.state":
        if (e.state !== "running" && e.state !== "starting") flush(e.runId);
        break;
      case "run.ended":
        flush(e.runId);
        break;
      default:
        break;
    }
  }
  for (const runId of [...open.keys()]) flush(runId);
  for (const r of sortedRuns) if (r.endedAt) entries.push({ kind: "ended", at: ms(r.endedAt), runId: r.id, reason: r.endReason });

  // Stable order: by time, then so a run starts before its steps and ends after them.
  const RANK: Record<TimelineEntry["kind"], number> = { started: 0, wait: 1, request: 2, handoff: 2, message: 2, retry: 2, tools: 3, ended: 4 };
  entries.sort((a, b) => a.at - b.at || RANK[a.kind] - RANK[b.kind]);

  const start = lanes.length ? Math.min(...lanes.map((l) => l.start)) : now;
  const end = lanes.length ? Math.max(...lanes.map((l) => l.end)) : now;
  return { start, end: Math.max(end, start + 1), lanes, entries };
}

/** Where `t` falls on a lane track, 0–100, for absolute positioning. */
export const trackPct = (t: number, tl: Pick<Timeline, "start" | "end">) => Math.min(100, Math.max(0, (100 * (t - tl.start)) / (tl.end - tl.start)));

/**
 * Segments too short to see still get `minPct` of the track, taken from their longest neighbour
 * rather than stretching the lane past its end.
 */
export function visibleSegments(l: Lane, tl: Pick<Timeline, "start" | "end">, minPct = 1.5): Array<LaneSegment & { left: number; width: number }> {
  return l.segments.map((s) => {
    const left = trackPct(s.start, tl);
    const width = Math.max(minPct, trackPct(s.end, tl) - left);
    return { ...s, left: Math.min(left, 100 - width), width };
  });
}

/** Total time a lane spent in each state, for the lane's text summary. */
export function timeIn(l: Lane): Partial<Record<LaneState, number>> {
  const out: Partial<Record<LaneState, number>> = {};
  for (const s of l.segments) out[s.state] = (out[s.state] ?? 0) + (s.end - s.start);
  return out;
}
