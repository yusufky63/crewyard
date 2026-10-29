import { STATUS_FILTER, type CandidateView, type CrewMemberView, type LimitNoticePayload, type LimitWindow, type RequestView, type RunView, type TaskDetail, type TaskStatus, type TaskSummary } from "@crewyard/core";
import type { InspectorTarget } from "../../inspector.ts";

// Pure view logic for the Tasks screen, the Inbox and the inspector. The app has no DOM test
// environment, so everything that decides what a row says lives here and is tested on its own.

export const FILTERS = ["all", "running", "needs_you", "review", "merged", "done"] as const;
export type Filter = (typeof FILTERS)[number];

export function matchesFilter(status: TaskStatus, filter: Filter): boolean {
  return filter === "all" || STATUS_FILTER[status] === filter;
}

export function filterCounts(tasks: Pick<TaskSummary, "status">[]): Record<Filter, number> {
  const out = Object.fromEntries(FILTERS.map((f) => [f, 0])) as Record<Filter, number>;
  for (const t of tasks) for (const f of FILTERS) if (matchesFilter(t.status, f)) out[f] += 1;
  return out;
}

const TITLE_MAX = 120;

/**
 * The composer takes one free text. Its first line is the title; a single long paragraph is cut
 * at the first sentence end (or a word boundary) and kept whole as the description.
 */
export function splitTaskText(text: string): { title: string; description: string } {
  const trimmed = text.trim();
  if (!trimmed) return { title: "", description: "" };
  const [first = "", ...rest] = trimmed.split(/\r?\n/);
  const firstLine = first.trim();
  const body = rest.join("\n").trim();
  if (firstLine.length <= TITLE_MAX) return { title: firstLine, description: body };
  const sentence = firstLine.slice(0, TITLE_MAX).match(/^(.+?[.!?])\s/);
  const cut = sentence?.[1] ?? firstLine.slice(0, firstLine.lastIndexOf(" ", TITLE_MAX) > 40 ? firstLine.lastIndexOf(" ", TITLE_MAX) : TITLE_MAX).trimEnd();
  return { title: cut, description: [firstLine, body].filter(Boolean).join("\n") };
}

const isOpen = (r: RunView) => r.endedAt === null;

/** The run a row talks about: the newest open one, else the newest run at all. */
export function currentRun(detail: Pick<TaskDetail, "runs">): RunView | null {
  const byStart = [...detail.runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return byStart.filter(isOpen).at(-1) ?? byStart.at(-1) ?? null;
}

/** Latest run of each crew step, in crew order. */
export function latestRunOf(detail: Pick<TaskDetail, "runs">, memberId: string): RunView | null {
  return [...detail.runs].filter((r) => r.memberId === memberId).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1) ?? null;
}

/** Wall time from the first run's start until the last run ended, or until now while one is open. */
export function elapsedMs(detail: Pick<TaskDetail, "runs">, now: number): number | null {
  if (detail.runs.length === 0) return null;
  const start = Math.min(...detail.runs.map((r) => Date.parse(r.startedAt)));
  const end = detail.runs.some(isOpen) ? now : Math.max(...detail.runs.map((r) => Date.parse(r.endedAt ?? r.startedAt)));
  return Math.max(0, end - start);
}

/** "45s", "14m 02s", "2h 05m": compact and fixed-width enough for a row. */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function runDuration(run: Pick<RunView, "startedAt" | "endedAt">, now: number): number {
  return Math.max(0, (run.endedAt ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt));
}

/** Diff stat of the task: each step's latest reported diff, summed per file path. */
export function diffTotals(detail: Pick<TaskDetail, "runs">): { files: number; added: number; removed: number } | null {
  const byPath = new Map<string, { added: number; removed: number }>();
  const steps = new Set(detail.runs.map((r) => r.memberId));
  for (const memberId of steps) {
    const diff = [...detail.runs].filter((r) => r.memberId === memberId && r.diff).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1)?.diff;
    for (const f of diff ?? []) byPath.set(f.path, f);
  }
  if (byPath.size === 0) return null;
  let added = 0;
  let removed = 0;
  byPath.forEach((f) => {
    added += f.added;
    removed += f.removed;
  });
  return { files: byPath.size, added, removed };
}

/** Runners that worked on the task (or will, while it is only proposed), in order of appearance. */
export function runnersOf(detail: Pick<TaskDetail, "runs" | "crew">): string[] {
  const out: string[] = [];
  const add = (r: string) => {
    if (!out.includes(r)) out.push(r);
  };
  detail.runs.forEach((r) => add(r.runner));
  if (out.length === 0) detail.crew?.members.forEach((m) => m.chosen && add(m.chosen.runner));
  return out;
}

/** Every profile the crew knows by name: chosen and standby, so ids can be shown as aliases. */
export function profileNames(detail: Pick<TaskDetail, "crew">): Map<string, CandidateView> {
  const out = new Map<string, CandidateView>();
  for (const m of detail.crew?.members ?? []) {
    if (m.chosen) out.set(m.chosen.profileId, m.chosen);
    m.standby.forEach((s) => out.has(s.profileId) || out.set(s.profileId, s));
  }
  return out;
}

export type Tone = "run" | "wait" | "ok" | "bad" | "ink" | "muted";
export type StatusIcon = "crew" | "clock" | "spinner" | "question" | "terminal" | "gauge" | "swap" | "check" | "pr" | "x" | "square";

export interface StatusLine {
  status: TaskStatus;
  /** Key under `status.` in the tasks namespace. */
  key: string;
  tone: Tone;
  icon: StatusIcon;
  /** Raw values; the component translates roles and formats times. */
  params: { role?: string; time?: string; target?: string; reason?: string };
}

/** DESIGN.md §5 "Status labels": one line per canonical state, with the detail that makes it useful. */
export function statusLine(detail: TaskDetail, requests: RequestView[]): StatusLine {
  const run = currentRun(detail);
  const base = { status: detail.status, params: {} };
  switch (detail.status) {
    case "proposed":
      return { ...base, key: "proposed", tone: "ink", icon: "crew" };
    case "queued":
      return { ...base, key: "queued", tone: "wait", icon: "clock" };
    case "running":
      return { ...base, key: run ? "runningStep" : "running", tone: "run", icon: "spinner", params: { role: run?.role } };
    case "needs_input": {
      const pending = requests.find((q) => q.taskId === detail.id && q.answeredAt === null);
      if (pending?.kind === "approval") return { ...base, key: "needsApproval", tone: "wait", icon: "terminal" };
      if (pending?.kind === "handoff") return { ...base, key: "needsDecision", tone: "wait", icon: "gauge" };
      return { ...base, key: "needsAnswer", tone: "wait", icon: "question" };
    }
    case "limited": {
      const limited = detail.runs.find((r) => isOpen(r) && r.limitReached);
      const pending = requests.find((q) => q.runId === limited?.id && q.payload.kind === "handoff");
      const time = limited?.resumeAt ?? (pending?.payload.kind === "handoff" ? pending.payload.resetsAt : null);
      return { ...base, key: time ? "limitedResets" : "limited", tone: "bad", icon: "gauge", params: { time: time ?? undefined } };
    }
    case "handing_off": {
      const open = detail.handoffs.find((h) => h.closedAt === null);
      const target = open?.targetProfileId ? (profileNames(detail).get(open.targetProfileId)?.alias ?? open.targetProfileId) : undefined;
      return { ...base, key: target ? "handingOffTo" : "handingOff", tone: "wait", icon: "swap", params: { target } };
    }
    case "review":
      return { ...base, key: "review", tone: "ok", icon: "check" };
    case "merged":
      return { ...base, key: "merged", tone: "ink", icon: "pr" };
    case "done":
      return { ...base, key: "done", tone: "ok", icon: "check" };
    case "failed": {
      const failed = [...detail.runs].reverse().find((r) => r.endReason === "failed");
      return { ...base, key: failed?.endDetail ? "failedBecause" : "failed", tone: "bad", icon: "x", params: { reason: failed?.endDetail ?? undefined } };
    }
    case "cancelled":
      return { ...base, key: "cancelled", tone: "muted", icon: "square" };
  }
}

export type StepState = "waiting" | "blocked" | "running" | "needs_you" | "paused" | "limited" | "handing_off" | "done" | "failed" | "stopped" | "interrupted";

/** What one crew step is doing, for the expanded row and the inspector. */
export function stepState(member: CrewMemberView, run: RunView | null): StepState {
  if (!run) return member.blockedBy ? "blocked" : "waiting";
  if (run.endedAt) {
    if (run.endReason === "completed") return "done";
    if (run.endReason === "failed") return "failed";
    if (run.endReason === "interrupted") return "interrupted";
    return "stopped";
  }
  switch (run.state) {
    case "waiting_input":
    case "waiting_approval":
      return "needs_you";
    case "rate_limited":
      return "limited";
    case "handing_off":
      return "handing_off";
    case "paused":
      return "paused";
    default:
      return "running";
  }
}

export interface LimitBannerInfo {
  kind: "warn" | "critical" | "ahead_of_pace" | "reached";
  runId: string;
  profileId: string;
  window: LimitWindow | null;
  usedPct: number | null;
  resetsAt: string | null;
  minutesUntilFull: number | null;
  /** First standby of the step that is not the run's own profile; what "Hand off now" moves to. */
  target: CandidateView | null;
}

const NOTICE_RANK = { reached: 3, critical: 2, warn: 1, ahead_of_pace: 0 } as const;

/**
 * The banner a task row and the inspector show (DESIGN.md `LimitBanner`): a run that reached its
 * limit, or the strongest live notice for an open run. A context-window notice is the run's own
 * and never offers a hand off of the account.
 */
export function limitBanner(detail: TaskDetail, notices: LimitNoticePayload[]): LimitBannerInfo | null {
  const open = detail.runs.filter(isOpen);
  const standbyFor = (run: RunView) => {
    const member = detail.crew?.members.find((m) => m.id === run.memberId);
    return [member?.chosen, ...(member?.standby ?? [])].find((c): c is CandidateView => Boolean(c) && c!.profileId !== run.profileId) ?? null;
  };
  const reached = open.find((r) => r.limitReached);
  if (reached) {
    const n = notices.filter((x) => x.runId === reached.id && x.kind === "reached").at(-1);
    return { kind: "reached", runId: reached.id, profileId: reached.profileId, window: n?.window ?? null, usedPct: n?.usedPct ?? 100, resetsAt: reached.resumeAt ?? n?.resetsAt ?? null, minutesUntilFull: null, target: standbyFor(reached) };
  }
  let best: { n: LimitNoticePayload; run: RunView } | null = null;
  for (const n of notices) {
    if (n.kind === "reached") continue;
    const run = open.find((r) => r.id === n.runId || (n.runId === null && r.profileId === n.profileId));
    if (!run) continue;
    if (n.resetsAt && Date.parse(n.resetsAt) <= Date.parse(n.observedAt)) continue;
    if (!best || NOTICE_RANK[n.kind] > NOTICE_RANK[best.n.kind] || (NOTICE_RANK[n.kind] === NOTICE_RANK[best.n.kind] && n.observedAt > best.n.observedAt)) best = { n, run };
  }
  if (!best) return null;
  const { n, run } = best;
  return { kind: n.kind as LimitBannerInfo["kind"], runId: run.id, profileId: run.profileId, window: n.window, usedPct: n.usedPct, resetsAt: n.resetsAt, minutesUntilFull: n.minutesUntilFull, target: n.window === "context" ? null : standbyFor(run) };
}

/** Tasks with a proposal you still have to approve or cancel. */
export const awaitingApproval = (tasks: TaskSummary[]) => tasks.filter((t) => t.status === "proposed");

/** i18n keys cannot contain dots used as nesting, so reason and error codes map `a.b` to `a_b`. */
export const codeKey = (code: string) => code.replace(/\./g, "_");

/** Which run the inspector shows: the one asked for, else the step's latest, else the task's current one. */
export function resolveTarget(detail: Pick<TaskDetail, "runs" | "crew">, target: InspectorTarget): { run: RunView | null; memberId: string | null } {
  if (target.runId) {
    const run = detail.runs.find((r) => r.id === target.runId) ?? null;
    return { run, memberId: run?.memberId ?? target.memberId ?? null };
  }
  if (target.memberId) return { run: latestRunOf(detail, target.memberId), memberId: target.memberId };
  const run = currentRun(detail);
  return { run, memberId: run?.memberId ?? detail.crew?.members[0]?.id ?? null };
}
