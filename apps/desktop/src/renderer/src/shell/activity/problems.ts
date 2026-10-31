import { providerErrorLine, redactLogLine, splitEndDetail, type CredentialSummary, type KeyCheckView, type ProblemSources, type ProjectConfigStatus, type RoleProblem, type ShareView, type StallAlertView } from "@crewyard/core";

// The Problems tab (DESIGN.md §4): everything that failed or needs fixing in the open project, in
// one list, newest first. Pure: the tab reads each source, this words nothing and decides the order,
// the links and what a dismissal hides.
//
// A dismissal remembers the problem's id and its fingerprint (what the cause looked like). It hides
// the row while both match; a cause that changes, or that went away and came back, shows again.

export type ProblemKind = "run" | "event" | "stall" | "check" | "config" | "role" | "agentfile" | "key";
export type ProblemSeverity = "danger" | "warning";

/** Where a row's fix is. */
export type ProblemLink =
  | { to: "task"; taskId: string; memberId: string | null; runId: string | null }
  | { to: "inbox"; taskId: string; requestId: string | null }
  | { to: "github"; taskId: string }
  | { to: "settings"; section: "projects" | "roles" | "agentfiles" }
  | { to: "providers" }
  | { to: "events" };

export interface Problem {
  /** Stable for the same cause. */
  id: string;
  /** Changes when the cause does. */
  fingerprint: string;
  kind: ProblemKind;
  severity: ProblemSeverity;
  /** When it happened or was seen; null when the source keeps no time (a file read now). */
  at: string | null;
  /** Translation key under `activity:problems.title` and its params. */
  title: { key: string; params: Record<string, string | number> };
  /** A code of ours to translate (`tasks:endDetail.*`, a role problem code), or null. */
  code: string | null;
  /** Untrusted text (a provider's error, a check's output, a payload preview); shown as text only. */
  text: string | null;
  /** The task it belongs to, for the row's context line. */
  taskTitle: string | null;
  link: ProblemLink;
}

export interface ProblemInputs {
  projectId: string;
  sources?: ProblemSources;
  stalls?: StallAlertView[];
  configNotices?: Array<{ projectId: string; name: string; path: string; status: ProjectConfigStatus }>;
  roleProblems?: RoleProblem[];
  shares?: ShareView[];
  keyChecks?: KeyCheckView[];
  credentials?: CredentialSummary[];
}

/** One project's dismissals: problem id to the fingerprint it had when dismissed. */
export type Dismissed = Record<string, string>;

/** Free text from runners, tools and GitHub, capped and with anything key-shaped hidden before it is shown. */
const safeText = (s: string | null | undefined) => (s ? redactLogLine(s) : null);

function failedRuns(sources: ProblemSources): Problem[] {
  return sources.failedRuns.map((r) => {
    const why = splitEndDetail(r.detail);
    return {
      id: `run:${r.runId}`,
      fingerprint: r.detail ?? "",
      kind: "run",
      severity: "danger",
      at: r.endedAt,
      title: { key: "run", params: { role: r.role, runner: r.runner } },
      code: why.code,
      text: why.text ? safeText(providerErrorLine(why.text)) : null,
      taskTitle: r.taskTitle,
      link: { to: "task", taskId: r.taskId, memberId: r.memberId, runId: r.runId },
    };
  });
}

function failedEvents(sources: ProblemSources): Problem[] {
  return sources.failedEvents.map((e) => ({
    id: `event:${e.seq}`,
    fingerprint: "",
    kind: "event",
    severity: "warning",
    at: e.at,
    title: { key: "event", params: { kind: e.kind } },
    code: null,
    text: safeText(e.preview),
    taskTitle: e.taskTitle,
    // Agent files have no task; their fix is in Settings. A row with a task opens it.
    link: e.kind.startsWith("agentfiles.") ? { to: "settings", section: "agentfiles" } : e.taskId ? { to: "task", taskId: e.taskId, memberId: null, runId: e.runId } : { to: "events" },
  }));
}

function failingChecks(sources: ProblemSources): Problem[] {
  return sources.failingChecks.map((c) => ({
    id: `check:${c.feedbackId}`,
    fingerprint: c.headSha,
    kind: "check",
    severity: "danger",
    at: c.observedAt,
    title: { key: "check", params: { name: c.name, pr: c.pr } },
    code: null,
    text: safeText(c.excerpt.split("\n").find((l) => l.trim()) ?? null),
    taskTitle: c.taskTitle,
    link: { to: "github", taskId: c.taskId },
  }));
}

function stalls(list: StallAlertView[], projectId: string): Problem[] {
  return list
    .filter((a) => a.projectId === projectId && !a.dismissedAt && !a.clearedAt)
    .map((a) => ({
      id: `stall:${a.alertId}`,
      fingerprint: a.rule,
      kind: "stall",
      severity: "warning",
      at: a.observedAt,
      title: { key: `stall.${a.rule}`, params: { minutes: a.minutes ?? 0, count: a.count ?? 0 } },
      code: null,
      text: a.rule === "same_failure" ? a.detail : null,
      taskTitle: null,
      link: { to: "inbox", taskId: a.taskId, requestId: a.requestId },
    }));
}

function configNotices(list: NonNullable<ProblemInputs["configNotices"]>, projectId: string): Problem[] {
  const n = list.find((x) => x.projectId === projectId);
  if (!n || n.status.state === "missing") return [];
  const s = n.status;
  if (s.state === "valid" && s.fallbacks.length === 0) return [];
  const key = s.state === "invalid" ? "configInvalid" : s.state === "newer" ? (s.understood ? "configNewer" : "configNewerUnknown") : "configReplaced";
  return [
    {
      id: `config:${projectId}`,
      fingerprint: JSON.stringify(s),
      kind: "config",
      severity: s.state === "invalid" ? "danger" : "warning",
      at: null,
      title: { key, params: { version: s.state === "newer" ? s.version : 0, count: "fallbacks" in s ? s.fallbacks.length : 0 } },
      code: s.state === "invalid" ? s.reason : null,
      text: s.file,
      taskTitle: null,
      link: { to: "settings", section: "projects" },
    },
  ];
}

function roleProblems(list: RoleProblem[]): Problem[] {
  return list.map((p) => ({
    id: `role:${p.source}:${p.path}:${p.role ?? ""}:${p.code}`,
    fingerprint: JSON.stringify(p.params),
    kind: "role",
    severity: "warning",
    at: null,
    title: { key: "role", params: { role: p.role ?? "" } },
    code: p.code,
    text: p.path,
    taskTitle: null,
    link: { to: "settings", section: "roles" },
  }));
}

function agentFiles(list: ShareView[]): Problem[] {
  return list.flatMap((s) =>
    s.copies
      .filter((c) => c.error !== null || c.state === "source_missing")
      .map((c) => ({
        id: `agentfile:${s.id}:${c.profileId}`,
        fingerprint: `${c.error ?? c.state}`,
        kind: "agentfile" as const,
        severity: (c.error ? "danger" : "warning") as ProblemSeverity,
        at: c.copiedAt,
        title: { key: c.error ? "agentfileError" : "agentfileGone", params: { name: s.name, profile: c.profileAlias } },
        code: c.error,
        text: c.error ? c.dest : s.source,
        taskTitle: null,
        link: { to: "settings" as const, section: "agentfiles" as const },
      })),
  );
}

function keyChecks(list: KeyCheckView[], credentials: CredentialSummary[]): Problem[] {
  return list
    .filter((k) => k.state === "invalid")
    .map((k) => ({
      id: `key:${k.credentialId}`,
      fingerprint: `${k.reason ?? ""}:${k.status ?? ""}`,
      kind: "key",
      severity: "danger",
      at: k.checkedAt,
      title: { key: "key", params: { alias: credentials.find((c) => c.id === k.credentialId)?.alias ?? k.providerId, provider: k.providerId } },
      code: k.reason,
      text: k.status !== null ? String(k.status) : null,
      taskTitle: null,
      link: { to: "providers" },
    }));
}

/** Every problem the inputs hold, newest first; the ones without a time after the dated ones. */
export function buildProblems(inputs: ProblemInputs): Problem[] {
  const all = [
    ...(inputs.sources ? [...failedRuns(inputs.sources), ...failedEvents(inputs.sources), ...failingChecks(inputs.sources)] : []),
    ...stalls(inputs.stalls ?? [], inputs.projectId),
    ...configNotices(inputs.configNotices ?? [], inputs.projectId),
    ...roleProblems(inputs.roleProblems ?? []),
    ...agentFiles(inputs.shares ?? []),
    ...keyChecks(inputs.keyChecks ?? [], inputs.credentials ?? []),
  ];
  const rank = (p: Problem) => (p.severity === "danger" ? 0 : 1);
  return all.sort((a, b) => {
    if (a.at && b.at) return a.at < b.at ? 1 : a.at > b.at ? -1 : a.id.localeCompare(b.id);
    if (a.at || b.at) return a.at ? -1 : 1;
    return rank(a) - rank(b) || a.id.localeCompare(b.id);
  });
}

export function isDismissed(p: Problem, dismissed: Dismissed): boolean {
  return dismissed[p.id] === p.fingerprint;
}

export function visibleProblems(all: Problem[], dismissed: Dismissed): Problem[] {
  return all.filter((p) => !isDismissed(p, dismissed));
}

export interface ProblemCounts {
  total: number;
  danger: number;
  warning: number;
}

export function problemCounts(visible: Problem[]): ProblemCounts {
  const danger = visible.filter((p) => p.severity === "danger").length;
  return { total: visible.length, danger, warning: visible.length - danger };
}

/**
 * Forgets dismissals whose cause is gone, so it shows again if it comes back. Only call it with a
 * complete list (every source read): a source that failed to load would otherwise forget its rows.
 * Returns the same object when nothing changed.
 */
export function pruneDismissed(dismissed: Dismissed, complete: Problem[]): Dismissed {
  const present = new Set(complete.map((p) => p.id));
  const kept = Object.entries(dismissed).filter(([id]) => present.has(id));
  return kept.length === Object.keys(dismissed).length ? dismissed : Object.fromEntries(kept);
}
