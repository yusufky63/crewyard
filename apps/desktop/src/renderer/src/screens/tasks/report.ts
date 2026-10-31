import type { AssistantDraftView, ReportSeverity, TaskReport, TaskReportFinding } from "@crewyard/core";

// Pure helpers for the task report view (TaskReport.tsx, docs/adr/0014): which tone each severity
// and verdict takes, the counts the overview bar filters by, where a finding's file lives in the
// worktree, and what Copy puts on the clipboard. Severity always keeps its word; tone only adds to it.

export const SEVERITIES: readonly ReportSeverity[] = ["critical", "high", "medium", "low", "info"];

export type ReportTone = "ok" | "warn" | "bad" | "info" | "neutral";

/** Critical and high are bad, medium a warning, low a note, info carries no colour. */
export const SEVERITY_TONE: Record<ReportSeverity, ReportTone> = { critical: "bad", high: "bad", medium: "warn", low: "info", info: "neutral" };

/** The shared badge classes in packages/ui styles.css; neutral is the plain hairline badge. */
export const badgeClass = (tone: ReportTone): string => (tone === "neutral" ? "badge" : `badge badge-${tone}`);

/** Counts per severity, most severe first, leaving out the ones with none. */
export function severityCounts(findings: readonly Pick<TaskReportFinding, "severity">[]): Array<{ severity: ReportSeverity; count: number }> {
  return SEVERITIES.map((severity) => ({ severity, count: findings.filter((f) => f.severity === severity).length })).filter((c) => c.count > 0);
}

/** The most severe level present and how many findings have it, for the row's count badge. */
export function worstSeverity(findings: readonly Pick<TaskReportFinding, "severity">[]): { severity: ReportSeverity; count: number } | null {
  return severityCounts(findings)[0] ?? null;
}

/** The tone of the most severe finding, for a count badge that stands for all of them. */
export function worstTone(findings: readonly Pick<TaskReportFinding, "severity">[]): ReportTone | null {
  const worst = SEVERITIES.find((s) => findings.some((f) => f.severity === s));
  return worst ? SEVERITY_TONE[worst] : null;
}

/** A pass is ok; changes asked are a warning, or bad when a critical or high finding backs them. */
export function verdictTone(report: Pick<TaskReport, "verdict" | "findings">): ReportTone | null {
  if (!report.verdict) return null;
  if (report.verdict === "pass") return "ok";
  return worstTone(report.findings) === "bad" ? "bad" : "warn";
}

/** Drafts still on show: open and added ones, never discarded. */
export const visibleDrafts = (report: Pick<TaskReport, "drafts">): AssistantDraftView[] => report.drafts.filter((d) => d.status !== "discarded");

export const openDrafts = (report: Pick<TaskReport, "drafts">): AssistantDraftView[] => report.drafts.filter((d) => d.status === "open");

/** `file:line`, or just the file when the agent named no line. */
export const findingLocation = (f: Pick<TaskReportFinding, "file" | "line">): string => (f.file ? `${f.file}${f.line !== null ? `:${f.line}` : ""}` : "");

/**
 * A finding's file as a path inside the task worktree, the form the Files tab reads, or null when
 * it cannot be one: outside the worktree, climbing out with `..`, or empty. Agents write paths
 * relative (`src/a.ts`, `./src/a.ts`), absolute, or with Windows separators; the daemon confines
 * every read anyway, so this only decides whether opening is worth offering.
 */
export function findingPath(file: string | null, worktreePath: string | null): string | null {
  if (!file) return null;
  let p = file.trim().replace(/\\/g, "/");
  const absolute = /^[a-zA-Z]:\//.test(p) || p.startsWith("/");
  if (absolute) {
    if (!worktreePath) return null;
    const root = worktreePath.replace(/\\/g, "/").replace(/\/+$/, "");
    // Windows paths compare without case, like the file system does.
    if (!p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
    p = p.slice(root.length + 1);
  }
  p = p.replace(/^(\.\/)+/, "").replace(/\/+/g, "/").replace(/\/$/, "");
  if (!p || p.split("/").some((seg) => seg === "..")) return null;
  return p;
}

/** What Copy puts on the clipboard: the finding as plain text, severity word first. */
export function findingText(f: TaskReportFinding, severityWord: string): string {
  const where = findingLocation(f);
  return [`[${severityWord}] ${f.title}`, where, f.detail && f.detail !== f.title ? `\n${f.detail}` : ""].filter(Boolean).join("\n");
}
