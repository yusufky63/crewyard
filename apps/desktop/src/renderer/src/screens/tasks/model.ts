import { providerErrorLine, providerErrorRaw, splitEndDetail, STATUS_FILTER, type CandidateView, type GoalDecisionView, type GoalDetail, type GoalNeedsReason, type GoalSummary, type GoalTaskView, type HandoffView, type LoopDecisionKind, type CrewMemberView, type LimitNoticePayload, type LimitWindow, type Reason, type RequestKind, type RequestView, type RunView, type TaskDetail, type TaskGoalRef, type TaskStatus, type TaskSummary } from "@crewyard/core";
import type { InspectorTarget } from "../../inspector.ts";

// Pure view logic for the Tasks screen, the Inbox and the inspector. The app has no DOM test
// environment, so everything that decides what a row says lives here and is tested on its own.

export const FILTERS = ["all", "running", "needs_you", "review", "merged", "done"] as const;
export type Filter = (typeof FILTERS)[number];

export function matchesFilter(status: TaskStatus, filter: Filter): boolean {
  return filter === "all" || STATUS_FILTER[status] === filter;
}

/**
 * The count on each filter tab. A task without a goal counts by its status. An Orchestra goal is
 * one group row and counts by its own status (docs/adr/0019, design §3.4); its tasks count under
 * it, never on their own, except a task with an Inbox request, which still counts under Needs you.
 * Hidden goal tasks (planning, the last review, discarded or unapproved ones) never count.
 */
export function filterCounts(tasks: Pick<TaskSummary, "status" | "goal">[], goals: Pick<GoalSummary, "status" | "outcome">[] = []): Record<Filter, number> {
  const out = Object.fromEntries(FILTERS.map((f) => [f, 0])) as Record<Filter, number>;
  for (const t of tasks) for (const f of FILTERS) if (taskMatchesFilter(t, f)) out[f] += 1;
  for (const g of goals) for (const f of FILTERS) if (goalMatchesFilter(g, f)) out[f] += 1;
  return out;
}

// ---------------------------------------------------------------- Orchestra goals (docs/adr/0019)

type Bucket = Exclude<Filter, "all"> | "other";

/** The filter a goal row belongs to (design §3.9): paused, stopped and collapsed goals show only under All. */
export function goalBucket(g: Pick<GoalSummary, "status" | "outcome">): Bucket {
  switch (g.status) {
    case "needs_you":
      return "needs_you";
    case "planning":
    case "running":
      return "running";
    case "ready_for_review":
      return "review";
    case "finished":
      return g.outcome === "merged" ? "merged" : g.outcome === "done" ? "done" : "other";
    case "paused":
    case "stopped":
      return "other";
  }
}

/**
 * Where a task counts on its own: its status filter; `goal` when it counts only under its goal;
 * null when it is hidden. A goal task waiting for its turn derives as `proposed`, which would read
 * Needs you; it never does, so a plan of eight tasks does not flood the tab (design §3.4).
 */
export function taskBucket(t: Pick<TaskSummary, "status" | "goal">): Bucket | "goal" | null {
  if (!t.goal) return STATUS_FILTER[t.status];
  if (t.goal.hidden) return null;
  return t.status === "needs_input" || t.status === "limited" ? "needs_you" : "goal";
}

/** Whether a task row shows under a filter tab; a goal task otherwise shows under its goal's row. */
export function taskMatchesFilter(t: Pick<TaskSummary, "status" | "goal">, filter: Filter): boolean {
  const b = taskBucket(t);
  if (b === null) return false;
  return filter === "all" || b === filter;
}

export function goalMatchesFilter(g: Pick<GoalSummary, "status" | "outcome">, filter: Filter): boolean {
  return filter === "all" || goalBucket(g) === filter;
}

/** "01": a goal task's place in its plan, as the goal view, chips and labels show it. */
export const goalNumber = (n: number) => String(n).padStart(2, "0");

export type GoalIcon = "spinner" | "question" | "pause" | "check" | "pr" | "square";

/** A goal's status label (design §3.9): `key` under `status.` in the goals namespace. */
export interface GoalLine {
  key: "planning" | "needsYou" | "running" | "paused" | "ready" | "merged" | "done" | "collapsed" | "stopped";
  tone: Tone;
  icon: GoalIcon;
  /** For needsYou: what needs you, translated under `needs.`. */
  reason: GoalNeedsReason | null;
  done: number;
  total: number;
}

/** Seven states, each with icon and text in its color; "Ready for review" is never shown as merged. */
export function goalStatusLine(g: Pick<GoalSummary, "status" | "reason" | "outcome" | "done" | "total">): GoalLine {
  const base = { reason: null, done: g.done, total: g.total };
  switch (g.status) {
    case "planning":
      return { ...base, key: "planning", tone: "run", icon: "spinner" };
    case "needs_you":
      return { ...base, key: "needsYou", tone: "wait", icon: "question", reason: g.reason ?? "decision" };
    case "running":
      return { ...base, key: "running", tone: "run", icon: "spinner" };
    case "paused":
      return { ...base, key: "paused", tone: "muted", icon: "pause" };
    case "ready_for_review":
      return { ...base, key: "ready", tone: "ok", icon: "check" };
    case "finished":
      if (g.outcome === "merged") return { ...base, key: "merged", tone: "ink", icon: "pr" };
      if (g.outcome === "collapsed") return { ...base, key: "collapsed", tone: "muted", icon: "check" };
      return { ...base, key: "done", tone: "ok", icon: "check" };
    case "stopped":
      return { ...base, key: "stopped", tone: "muted", icon: "square" };
  }
}

/** Finished and stopped goals fold their tasks in the list (design §3.4). */
export const goalFolded = (g: Pick<GoalSummary, "status">) => g.status === "finished" || g.status === "stopped";

/** A goal task's line in the goal view: `key` under `task.` in the goals namespace. */
export interface GoalTaskLine {
  key: string;
  tone: Tone;
  icon: StatusIcon | "pause";
  /** Why it has not started, translated under `hold.`. */
  hold: Reason | null;
}

/**
 * What one goal task is doing, as the goal view says it (design §3.3): skipped, not approved yet,
 * merged into the goal branch ("In goal branch"), the hold reason while it waits, or its status.
 * A writer whose gates passed waits to be merged; it never reads Ready for review on its own.
 */
export function goalTaskLine(
  t: Pick<GoalTaskView, "accepted" | "released" | "joined" | "hold" | "status" | "writes" | "reportAcceptedAt">,
  opts: { pending?: RequestKind | null; feedsWriter?: boolean; paused?: boolean } = {},
): GoalTaskLine {
  const line = (key: string, tone: Tone, icon: GoalTaskLine["icon"], hold: Reason | null = null): GoalTaskLine => ({ key, tone, icon, hold });
  if (t.accepted === false) return line("skipped", "muted", "square");
  if (t.accepted === null) return line("notApproved", "ink", "crew");
  if (t.joined) return line("inGoalBranch", "ok", "check");
  if (t.status === "cancelled") return line("cancelled", "muted", "square");
  if (t.status === "failed") return line("failed", "bad", "x");
  if (!t.released) {
    if (t.hold) return line("hold", "wait", "clock", t.hold);
    return opts.paused ? line("goalPaused", "muted", "pause") : line("waiting", "wait", "clock");
  }
  switch (t.status) {
    case "needs_input":
      if (opts.pending === "approval") return line("needsApproval", "wait", "terminal");
      if (opts.pending === "handoff") return line("needsDecision", "wait", "gauge");
      return line("needsAnswer", "wait", "question");
    case "limited":
      return line("limited", "bad", "gauge");
    case "running":
      return line("running", "run", "spinner");
    case "handing_off":
      return line("handingOff", "wait", "swap");
    case "review":
    case "done":
    case "merged":
      if (t.writes) return line("awaitingJoin", "wait", "clock");
      if (t.reportAcceptedAt) return line("reportAccepted", "ok", "check");
      return opts.feedsWriter ? line("reportWaits", "wait", "question") : line("done", "ok", "check");
    default:
      return opts.paused ? line("goalPaused", "muted", "pause") : line("queued", "wait", "clock");
  }
}

/**
 * Reports that wait for you: a task that writes nothing, finished, not accepted yet, with a
 * writing task waiting for it. Untrusted text reaches a writing agent only after you read it.
 */
export function reportsToAccept(tasks: readonly Pick<GoalTaskView, "taskId" | "writes" | "status" | "reportAcceptedAt" | "accepted" | "discarded" | "dependsOn">[]): string[] {
  const writersWaitOn = new Set(tasks.filter((t) => t.writes && t.accepted === true && !t.discarded).flatMap((t) => t.dependsOn.map((d) => d.taskId)));
  return tasks.filter((t) => !t.writes && t.accepted === true && !t.discarded && (t.status === "done" || t.status === "review") && !t.reportAcceptedAt && writersWaitOn.has(t.taskId)).map((t) => t.taskId);
}

/** The goal budget meter: spend as a share of the budget; null (Unknown) without a number on either side. */
export function goalSpendPct(g: Pick<GoalSummary, "spend" | "budgetUsd">): number | null {
  if (g.spend.usd === null || !g.budgetUsd || g.budgetUsd <= 0) return null;
  return Math.min(100, Math.max(0, (g.spend.usd / g.budgetUsd) * 100));
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
  /**
   * `reason` is a code to translate; `reasonText` is a runner's own error made readable (status and
   * the provider's message), `reasonRaw` the text as the runner wrote it, for the tooltip.
   */
  params: { role?: string; time?: string; target?: string; reason?: string; reasonText?: string; reasonRaw?: string; count?: number };
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
      if (!run && detail.bestOf?.phase === "running") return { ...base, key: "bestOfRunning", tone: "run", icon: "spinner", params: { count: detail.bestOf.n } };
      return { ...base, key: run ? "runningStep" : "running", tone: "run", icon: "spinner", params: { role: run?.role } };
    case "needs_input": {
      const pending = requests.find((q) => q.taskId === detail.id && q.answeredAt === null);
      // A Best of N group waits on you: a variant asks something, or every variant is done and you pick one.
      if (!pending && detail.bestOf?.phase === "choosing") return { ...base, key: "bestOfChoose", tone: "wait", icon: "crew", params: { count: detail.bestOf.n } };
      if (!pending && detail.bestOf?.phase === "running") return { ...base, key: "bestOfNeedsYou", tone: "wait", icon: "question" };
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
      if (detail.bestOf?.phase === "failed") return { ...base, key: "bestOfFailed", tone: "bad", icon: "x" };
      const failed = [...detail.runs].reverse().find((r) => r.endReason === "failed");
      const why = splitEndDetail(failed?.endDetail ?? null);
      // A code says it in our words; a provider's raw error is cut to its status and message, and
      // the runner's full text stays one hover (or the inspector) away.
      const params = why.code ? { reason: why.code } : why.text ? { reasonText: providerErrorLine(why.text), reasonRaw: providerErrorRaw(why.text) } : {};
      return { ...base, key: why.code || why.text ? "failedBecause" : "failed", tone: "bad", icon: "x", params };
    }
    case "cancelled":
      return { ...base, key: "cancelled", tone: "muted", icon: "square" };
  }
}

export type StepState = "waiting" | "blocked" | "running" | "needs_you" | "paused" | "hibernated" | "limited" | "handing_off" | "done" | "failed" | "stopped" | "interrupted";

/** What one crew step is doing, for the expanded row and the inspector. */
export function stepState(member: CrewMemberView, run: RunView | null): StepState {
  if (!run) return member.blockedBy ? "blocked" : "waiting";
  if (run.endedAt) {
    if (run.endReason === "completed") return "done";
    if (run.endReason === "failed") return "failed";
    if (run.endReason === "interrupted") return "interrupted";
    return "stopped";
  }
  // Its process is stopped while it waits (on you, or idle); it is not stopped and still holds the step.
  if (run.hibernatedAt && run.state !== "paused") return "hibernated";
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
    case "hibernated":
      return "hibernated";
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

/** Tasks with a proposal you still have to approve or cancel; a goal task starts with its plan instead. */
export const awaitingApproval = (tasks: TaskSummary[]) => tasks.filter((t) => t.status === "proposed" && !t.goal);

/**
 * A manual handoff can let the source finish its turn first (drain) only while a turn is under
 * way; a paused, limited or ended run has no turn left to finish, so it is always stopped now.
 */
export const canChooseHandoffStop = (run: Pick<RunView, "state">) => run.state === "running" || run.state === "waiting_input" || run.state === "waiting_approval";

/** Handoffs into or out of a run, newest first, for the inspector's handoff record. */
export const handoffsOf = (handoffs: HandoffView[], runId: string) => handoffs.filter((h) => h.fromRunId === runId || h.toRunId === runId).sort((a, b) => b.openedAt.localeCompare(a.openedAt));

/**
 * The icon and color of a loop decision (DESIGN.md status labels): a pass is green, a skip is
 * neutral, a try sent back or a stop is red, and a stop on a cap uses the limit gauge.
 */
export function loopLook(kind: LoopDecisionKind): { icon: Exclude<StatusIcon, "spinner">; tone: Tone } {
  switch (kind) {
    case "tests_passed":
    case "review_passed":
      return { icon: "check", tone: "ok" };
    case "tests_skipped":
      return { icon: "square", tone: "muted" };
    case "stop_iteration_cap":
    case "stop_spend_cap":
      return { icon: "gauge", tone: "bad" };
    case "stop_no_change":
      return { icon: "square", tone: "bad" };
    case "tests_failed":
    case "review_changes":
    case "review_invalid":
    case "stop_no_resume":
      return { icon: "x", tone: "bad" };
  }
}

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

/**
 * The status a goal task's own row shows when its goal decides it: why it waits (its derived
 * status is `proposed`, but it never reads "Waiting for approval"), or "In goal branch" once merged
 * into it. Null when the task's own status line says it.
 */
export function goalRowStatus(goalRef: TaskGoalRef | null | undefined, status: TaskStatus): GoalTaskLine | null {
  if (!goalRef || goalRef.hidden) return null;
  if (goalRef.joined) return { key: "inGoalBranch", tone: "ok", icon: "check", hold: null };
  if (goalRef.waiting && status === "proposed") return goalRef.hold ? { key: "hold", tone: "wait", icon: "clock", hold: goalRef.hold } : { key: "waiting", tone: "wait", icon: "clock", hold: null };
  return null;
}

/** One line of the goal view's Needs you section (design §3.3), first in the view. */
export type GoalNeed =
  | { kind: "plan"; state: "ready" | "failed"; error: string | null }
  | { kind: "decision"; decision: GoalDecisionView }
  | { kind: "request"; request: RequestView }
  | { kind: "report"; taskId: string }
  | { kind: "failed"; taskId: string }
  | { kind: "halted"; reason: string }
  | { kind: "stuck" }
  | { kind: "empty" };

/**
 * What needs you in a goal, in the order the view lists it: a plan to review or that failed, open
 * goal decisions, Inbox requests of its tasks, reports to accept, failed tasks, then the halt, stuck
 * and empty states when no open decision already says them. A stopped goal needs nothing.
 */
export function goalNeeds(goal: Pick<GoalDetail, "status" | "reason" | "revisions" | "decisions" | "tasks" | "halted" | "integration">, requests: readonly RequestView[]): GoalNeed[] {
  if (goal.status === "stopped") return [];
  const out: GoalNeed[] = [];
  const latest = [...goal.revisions].sort((a, b) => a.revision - b.revision).at(-1);
  if (latest && (latest.state === "ready" || latest.state === "failed")) out.push({ kind: "plan", state: latest.state, error: latest.error });
  const open = goal.decisions.filter((d) => d.answeredAt === null);
  open.forEach((decision) => out.push({ kind: "decision", decision }));
  const live = goal.tasks.filter((x) => !x.discarded && x.accepted === true);
  const ids = new Set([...live.map((x) => x.taskId), ...(goal.integration ? [goal.integration.taskId] : [])]);
  requests.filter((q) => q.answeredAt === null && ids.has(q.taskId)).forEach((request) => out.push({ kind: "request", request }));
  const decided = (kind: GoalDecisionView["kind"] | null, taskId: string | null) => open.some((d) => (kind === null || d.kind === kind) && (taskId === null || d.taskId === taskId));
  reportsToAccept(goal.tasks)
    .filter((id) => !decided("report", id))
    .forEach((taskId) => out.push({ kind: "report", taskId }));
  live.filter((x) => x.status === "failed" && !decided(null, x.taskId)).forEach((x) => out.push({ kind: "failed", taskId: x.taskId }));
  if (goal.halted && !decided("stop_rule", null)) out.push({ kind: "halted", reason: goal.halted.reason });
  if (goal.status === "needs_you" && goal.reason === "stuck" && !decided("stuck", null)) out.push({ kind: "stuck" });
  if (goal.status === "needs_you" && goal.reason === "empty") out.push({ kind: "empty" });
  return out;
}
