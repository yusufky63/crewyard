import type { ActivityEvent, ActivityEventFilter, ActivityFacets, LogLevel, LogLine, LogSource } from "@crewyard/core";

// The Activity drawer's state rules (DESIGN.md §4): filters, keyset paging, which live updates
// concern the open page, and the batching that keeps a busy run from re-rendering per token. Pure,
// so the drawer only draws what these return.

export interface EventFilter {
  taskId: string | null;
  runId: string | null;
  /** Exact kind, or a family ending in a dot (`run.`). */
  kind: string | null;
  /** Include streamed text (message and thought deltas). */
  stream: boolean;
}

export const NO_FILTER: EventFilter = { taskId: null, runId: null, kind: null, stream: false };

export const isFiltered = (f: EventFilter) => Boolean(f.taskId || f.runId || f.kind || f.stream);

/** Kinds that carry streamed text, a few words per event; mirrors the daemon's STREAM_KINDS. */
export const STREAM_KINDS = ["run.message.delta", "run.thought.delta"];

/**
 * Picking a task keeps the run only when it belongs to that task; picking a run selects its task,
 * so the two filters never contradict each other.
 */
export function withTask(f: EventFilter, taskId: string | null, runs: ActivityFacets["runs"]): EventFilter {
  const keepRun = f.runId && taskId && runs.some((r) => r.runId === f.runId && r.taskId === taskId);
  return { ...f, taskId, runId: keepRun ? f.runId : null };
}

export function withRun(f: EventFilter, runId: string | null, runs: ActivityFacets["runs"]): EventFilter {
  const run = runId ? runs.find((r) => r.runId === runId) : undefined;
  return { ...f, runId: run ? run.runId : null, taskId: run ? run.taskId : f.taskId };
}

/** Runs the run filter offers: those of the chosen task, or all. */
export const runsFor = (runs: ActivityFacets["runs"], taskId: string | null) => (taskId ? runs.filter((r) => r.taskId === taskId) : runs);

export interface KindOption {
  value: string;
  count: number;
  /** A family (`run.`) groups every kind that starts with it. */
  family: boolean;
}

/** Families first (only those with more than one kind), each followed by its kinds, most frequent first. */
export function kindOptions(kinds: ActivityFacets["kinds"], stream: boolean): KindOption[] {
  const visible = kinds.filter((k) => stream || !STREAM_KINDS.includes(k.kind));
  const families = new Map<string, KindOption[]>();
  for (const k of visible) {
    const dot = k.kind.indexOf(".");
    const family = dot > 0 ? k.kind.slice(0, dot + 1) : "";
    const list = families.get(family) ?? [];
    list.push({ value: k.kind, count: k.count, family: false });
    families.set(family, list);
  }
  const out: KindOption[] = [];
  const total = (l: KindOption[]) => l.reduce((n, k) => n + k.count, 0);
  for (const [family, list] of [...families].sort((a, b) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0]))) {
    list.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    if (family && list.length > 1) out.push({ value: family, count: total(list), family: true });
    out.push(...list);
  }
  return out;
}

export function eventParams(projectId: string, f: EventFilter, before: number | null): ActivityEventFilter & { before: number | null } {
  return { projectId, taskId: f.taskId, runId: f.runId, kind: f.kind, stream: f.stream, before };
}

/**
 * Keyset paging: the cursors of the pages walked so far, newest page first. Page 1 has no cursor,
 * so it always shows the newest events; older pages stay put while new ones arrive.
 */
export interface Paging {
  cursors: Array<number | null>;
}

export const FIRST_PAGE: Paging = { cursors: [null] };
export const cursorOf = (p: Paging) => p.cursors[p.cursors.length - 1] ?? null;
export const pageNumber = (p: Paging) => p.cursors.length;
export const isNewest = (p: Paging) => p.cursors.length === 1;
export const older = (p: Paging, cursor: number | null): Paging => (cursor == null ? p : { cursors: [...p.cursors, cursor] });
export const newer = (p: Paging): Paging => (p.cursors.length > 1 ? { cursors: p.cursors.slice(0, -1) } : p);

/** What a live topic tells the drawer, when it is about the open project. */
export interface LiveHint {
  projectId?: string;
  taskId?: string;
  runId?: string;
  /** Known only for agent events (`run.<type>`); a task change may write several audit kinds. */
  kind?: string;
}

/** Topics that mean a new row may be in the event log. */
export const LIVE_TOPICS = ["runs.event", "tasks.changed", "requests.changed", "stalls.changed", "switches.changed"] as const;

export function liveHint(topic: string, payload: unknown): LiveHint {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const event = p.event && typeof p.event === "object" ? (p.event as Record<string, unknown>) : null;
  return { projectId: str(p.projectId), taskId: str(p.taskId), runId: str(p.runId), kind: topic === "runs.event" && event ? `run.${String(event.type)}` : undefined };
}

/**
 * Whether a live update may add a row to what the filter shows. `taskProject` answers for topics
 * that carry only a task id (runs.event); unknown tasks count as another project's.
 */
export function concerns(h: LiveHint, projectId: string, f: EventFilter, taskProject: (taskId: string) => string | undefined): boolean {
  const project = h.projectId ?? (h.taskId ? taskProject(h.taskId) : undefined);
  if (project !== projectId) return false;
  if (f.taskId && h.taskId !== f.taskId) return false;
  if (f.runId && h.runId && h.runId !== f.runId) return false;
  if (f.runId && !h.runId && h.kind) return false;
  if (h.kind) {
    if (!f.stream && STREAM_KINDS.includes(h.kind) && f.kind !== h.kind) return false;
    if (f.kind && !(f.kind.endsWith(".") ? h.kind.startsWith(f.kind) : h.kind === f.kind)) return false;
  }
  return true;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/**
 * Collects live updates and flushes at most once per `ms` (DESIGN.md §8: batched, never per token).
 * The first update starts the window; later ones within it only add to the count.
 */
export function batcher(flush: (count: number) => void, ms = 1000, timers: Timers = realTimers) {
  let count = 0;
  let handle: unknown = null;
  return {
    push() {
      count++;
      if (handle != null) return;
      handle = timers.set(() => {
        handle = null;
        const n = count;
        count = 0;
        flush(n);
      }, ms);
    },
    cancel() {
      if (handle != null) timers.clear(handle);
      handle = null;
      count = 0;
    },
  };
}

/** Characters of an event's preview shown on its row; the rest opens with "Show all". */
export const ROW_PREVIEW = 160;

/** The row's text: the preview's first line, cut to ROW_PREVIEW, and whether there is more to read. */
export function rowText(e: Pick<ActivityEvent, "preview" | "size">): { text: string; more: boolean } {
  const line = e.preview.replace(/\s+/g, " ").trim();
  const text = line.length > ROW_PREVIEW ? `${line.slice(0, ROW_PREVIEW)}…` : line;
  // Anything past the row text: a longer preview, more lines, or a payload with other fields.
  return { text, more: line.length > ROW_PREVIEW || e.preview.includes("\n") || e.size > e.preview.length + 2 };
}

export type LevelFilter = "all" | "warn" | "error";

export interface LogFilter {
  source: LogSource | "all";
  level: LevelFilter;
}

export const ALL_LOGS: LogFilter = { source: "all", level: "all" };

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function filterLogs(lines: LogLine[], f: LogFilter): LogLine[] {
  const min = f.level === "error" ? RANK.error : f.level === "warn" ? RANK.warn : 0;
  return lines.filter((l) => (f.source === "all" || l.source === f.source) && RANK[l.level] >= min);
}

/** Log lines asked for per step of "Show older". */
export const LOG_STEP = 500;
