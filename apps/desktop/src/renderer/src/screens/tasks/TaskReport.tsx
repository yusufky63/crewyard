import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, Check, ChevronDown, ChevronRight, Copy, FileText } from "lucide-react";
import type { ReportSeverity, TaskDetail, TaskReport as Report, TaskReportFinding } from "@crewyard/core";
import { Button, Label } from "@crewyard/ui";
import { useInspector } from "../../inspector.ts";
import { useNav } from "../../nav.ts";
import { MdBlock } from "../../shell/files/FilesTab.tsx";
import { parseMarkdown } from "../../shell/files/markdown.ts";
import { FIXTURE } from "../../shell/timeline/fixture.ts";
import { DraftCard } from "./Assistant.tsx";
import { act, useWork } from "./data.ts";
import { draftEdit, useDraftEdits, withEdits } from "./draftEdits.ts";
import { badgeClass, findingLocation, findingPath, findingText, openDrafts, SEVERITY_TONE, severityCounts, verdictTone, visibleDrafts, worstSeverity } from "./report.ts";
import "./assistant.css";
import "./report.css";

// A finished research, review or docs task's result, made visible (docs/adr/0014): a one-line
// summary on the row with counts and `Open report`, and the whole report in the inspector's
// Details: the summary as text-only Markdown, a severity bar that filters the findings, each
// finding as a row that expands, and the follow-up tasks they suggest as editable drafts, at the
// bottom of Details and in their own Suggested tab. Agent text is shown as text only: the Markdown
// reader builds elements from data, raw HTML stays visible, and links never open.

/** Whether a task can have a report: non-code work that finished. */
export const hasReport = (d: Pick<TaskDetail, "kind" | "status">) => d.kind !== "code" && d.status === "done";

const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;
/** Screenshot mode only: `report=open` opens every finding. */
const SHOT_OPEN = FIXTURE && new URLSearchParams(location.search).get("report") === "open";

/** The task's report, read once and shared by the row, Details and the Suggested tab. */
export function useTaskReport(detail: Pick<TaskDetail, "id" | "kind" | "status">) {
  const qc = useQueryClient();
  const taskId = detail.id;
  // Autopilot marking the task done (docs/adr/0017) changes the report without a task change.
  useEffect(() => window.crewyard.on("autopilot.changed", () => void qc.invalidateQueries({ queryKey: ["assistant.report", { taskId }] })), [qc, taskId]);
  return useWork("assistant.report", { taskId }, { enabled: hasReport(detail) });
}

function useRefreshReport(taskId: string) {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["assistant.report", { taskId }] });
}

/** Daemon errors arrive as codes ("assistant.draft_added"), wrapped by IPC as "...Error: <code>". */
const codeOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^.*Error: /, "").trim();

/** The words for a daemon error code, from the assistant namespace. */
function useReportError(): (err: unknown) => string {
  const { t } = useTranslation("assistant");
  return (err) => {
    const code = codeOf(err);
    return t(`errors.${code.replace(/\./g, "_")}`, { defaultValue: t("errors.other", { message: code }) });
  };
}

/** Copies text and says so for a moment; a refused clipboard says that instead. */
function useCopy(): [state: "idle" | "done" | "failed", copy: (text: string) => void] {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = (text: string) => {
    const settle = (s: "done" | "failed") => {
      setState(s);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 1600);
    };
    void navigator.clipboard.writeText(text).then(
      () => settle("done"),
      () => settle("failed"),
    );
  };
  return [state, copy];
}

function firstLine(s: string, max = 180): string {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Agent text as text-only Markdown elements; `className` picks the summary or the finding look. */
function ReportMarkdown({ text, className }: { text: string; className: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={`fl-md ${className}`}>
      {blocks.map((b, i) => (
        <MdBlock key={i} b={b} />
      ))}
    </div>
  );
}

/** On the task row: the report's first line, its counts as tone badges, and `Open report`. Nothing while there is none. */
export function ReportLine({ detail }: { detail: TaskDetail }) {
  const { t } = useTranslation("assistant");
  const report = useTaskReport(detail).data;
  const selectTask = useNav((s) => s.selectTask);
  const inspect = useInspector((s) => s.open);
  if (!report) return null;
  const open = openDrafts(report).length;
  const line = firstLine(report.summary) || (report.findings[0]?.title ?? "");
  const worst = worstSeverity(report.findings);
  // Each names its tab: the inspector keeps the tab shown last, which may be Files or Suggested.
  const show = (tab: "details" | "suggested") => {
    selectTask(detail.id);
    inspect({ taskId: detail.id, tab });
  };
  return (
    <div className="tk-report-line">
      {line && (
        <span className="tk-report-text" title={report.summary.slice(0, 2_000)}>
          {line}
        </span>
      )}
      {/* The worst severity is named, so the badge's colour is never the only signal. */}
      {worst && (
        <span className={`${badgeClass(SEVERITY_TONE[worst.severity])} num`}>
          {t("report.findingsWorst", { count: report.findings.length, n: worst.count, worst: t(`report.severity.${worst.severity}`) })}
        </span>
      )}
      {report.completed && <span className="badge badge-ok">{t("report.completedShort")}</span>}
      {open > 0 && (
        <button type="button" className="badge badge-info num tk-badge-btn" title={t("report.openSuggested")} onClick={() => show("suggested")}>
          {t("report.suggestedCount", { count: open })}
        </button>
      )}
      <Button size="sm" variant="ghost" onClick={() => show("details")}>
        {t("report.open")}
      </Button>
    </div>
  );
}

/** The Suggested tasks block at the bottom of Details, where the report header's count jumps to. */
const SUGGESTED_ID = "tk-suggested";

/** Where a draft card sits in the page, so a finding can jump to it. */
const draftAnchor = (draftId: string) => `tk-draft-${draftId}`;

/** Smooth scrolling is motion; with reduced motion asked for, a jump is instant (DESIGN.md §7). */
const scrollBehavior = (): ScrollBehavior => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

/** Scrolls to an element and moves the keyboard there too, so a screen reader follows the jump. */
function jumpTo(id: string, block: ScrollLogicalPosition) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block, behavior: scrollBehavior() });
  el.focus({ preventScroll: true });
}

const jumpToDraft = (draftId: string) => jumpTo(draftAnchor(draftId), "center");

function FindingRow({ finding, expanded, onToggle, detail, draftShown }: { finding: TaskReportFinding; expanded: boolean; onToggle: () => void; detail: TaskDetail; draftShown: boolean }) {
  const { t } = useTranslation("assistant");
  const inspect = useInspector((s) => s.open);
  const current = useInspector((s) => s.target);
  const [copied, copy] = useCopy();
  const [pathCopied, copyPath] = useCopy();
  const bodyId = useId();
  const sevWord = t(`report.severity.${finding.severity}`);
  const where = findingLocation(finding);
  const path = detail.worktree ? findingPath(finding.file, detail.worktree.path) : null;
  const hasDetail = Boolean(finding.detail && finding.detail !== finding.title);

  const openFile = () => {
    if (path) inspect({ ...(current?.taskId === detail.id ? current : {}), taskId: detail.id, tab: "files", file: path });
    else copyPath(where);
  };

  return (
    <li className={`tk-finding${expanded ? " open" : ""}`} data-severity={finding.severity}>
      <button type="button" className="tk-finding-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
        {expanded ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}
        <span className={badgeClass(SEVERITY_TONE[finding.severity])}>{sevWord}</span>
        <span className="tk-finding-title">{finding.title}</span>
      </button>
      {where && (
        <div className="tk-finding-where">
          <button type="button" className="tk-finding-file mono as-typed" onClick={openFile} title={path ? t("report.openFile", { path }) : t("report.copyPath", { path: where })}>
            <FileText {...ICON} />
            <span>{where}</span>
          </button>
          {pathCopied !== "idle" && (
            <span className="muted tk-small" role="status">
              {pathCopied === "done" ? t("report.pathCopied") : t("report.copyFailed")}
            </span>
          )}
        </div>
      )}
      {expanded && (
        <div className="tk-finding-body" id={bodyId}>
          {hasDetail && <ReportMarkdown text={finding.detail} className="tk-finding-detail" />}
          <div className="tk-finding-actions">
            <Button size="sm" variant="ghost" onClick={() => copy(findingText(finding, sevWord))}>
              {copied === "done" ? <Check {...ICON} /> : <Copy {...ICON} />}
              {copied === "done" ? t("report.copied") : copied === "failed" ? t("report.copyFailed") : t("report.copy")}
            </Button>
            {finding.draftId && draftShown && (
              <Button size="sm" variant="ghost" onClick={() => jumpToDraft(finding.draftId!)}>
                <ArrowDownToLine {...ICON} />
                {t("report.toDraft")}
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** Up and Down move between finding rows; Home and End go to the ends. Enter and Space expand (native buttons). */
function moveFocus(e: KeyboardEvent<HTMLOListElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const target = e.target as HTMLElement;
  if (!target.classList.contains("tk-finding-toggle")) return;
  const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".tk-finding-toggle")];
  const i = all.indexOf(target as HTMLButtonElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : i + (e.key === "ArrowDown" ? 1 : -1);
  if (next < 0 || next >= all.length) return;
  e.preventDefault();
  all[next]!.focus();
}

function Findings({ report, detail }: { report: Report; detail: TaskDetail }) {
  const { t } = useTranslation("assistant");
  const [filter, setFilter] = useState<ReportSeverity | null>(null);
  // Keyed by index: findings never reorder within one report.
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set(SHOT_OPEN ? report.findings.map((_, i) => i) : []));
  const counts = severityCounts(report.findings);
  const shownDrafts = new Set(visibleDrafts(report).map((d) => d.id));
  const rows = report.findings.map((f, i) => ({ f, i })).filter(({ f }) => !filter || f.severity === filter);
  const allOpen = rows.length > 0 && rows.every(({ i }) => open.has(i));
  const toggle = (i: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="tk-report-findings">
      <div className="tk-report-bar">
        <Label>{t("report.findings")}</Label>
        <div className="tk-sevbar" role="group" aria-label={t("report.severityFilter")}>
          {counts.map(({ severity, count }) => (
            <button
              key={severity}
              type="button"
              className={`${badgeClass(SEVERITY_TONE[severity])} tk-badge-btn num`}
              aria-pressed={filter === severity}
              data-dim={filter !== null && filter !== severity ? "" : undefined}
              onClick={() => setFilter((f) => (f === severity ? null : severity))}
            >
              {`${t(`report.severity.${severity}`)} ${count}`}
            </button>
          ))}
          {filter && (
            <button type="button" className="badge tk-badge-btn num" onClick={() => setFilter(null)}>
              {t("report.allFindings", { count: report.findings.length })}
            </button>
          )}
        </div>
        <Button size="sm" variant="ghost" className="tk-report-expand" onClick={() => setOpen(allOpen ? new Set() : new Set(rows.map(({ i }) => i)))}>
          {allOpen ? t("report.collapseAll") : t("report.expandAll")}
        </Button>
      </div>
      {filter && (
        <p className="muted tk-small" role="status">
          {t("report.findingsShown", { shown: rows.length, count: report.findings.length })}
        </p>
      )}
      <ol className="tk-finding-list" aria-label={t("report.findings")} onKeyDown={moveFocus}>
        {rows.map(({ f, i }) => (
          <FindingRow key={i} finding={f} expanded={open.has(i)} onToggle={() => toggle(i)} detail={detail} draftShown={Boolean(f.draftId && shownDrafts.has(f.draftId))} />
        ))}
      </ol>
    </div>
  );
}

/** In the inspector's Details: the whole report and its findings. The suggested drafts come at the bottom of Details. */
export function ReportSection({ detail }: { detail: TaskDetail }) {
  const { t, i18n } = useTranslation("assistant");
  const report: Report | null | undefined = useTaskReport(detail).data;
  if (!report) return null;
  const vTone = verdictTone(report);
  const suggested = visibleDrafts(report).length;
  if (!report.summary && report.findings.length === 0 && !report.completed) return null;
  return (
    <section className="ins-sec tk-report" aria-label={t("report.label")}>
      <div className="tk-report-head">
        <Label>{t("report.label")}</Label>
        <span className="badge">{t(`report.source.${report.source}`)}</span>
        {report.verdict && vTone && <span className={badgeClass(vTone)}>{t(`report.verdict.${report.verdict}`)}</span>}
        {suggested > 0 && (
          <button type="button" className="badge badge-info num tk-badge-btn tk-report-jump" onClick={() => jumpTo(SUGGESTED_ID, "start")}>
            <ArrowDownToLine {...ICON} />
            {t("report.suggestedCount", { count: suggested })}
          </button>
        )}
      </div>
      {report.completed && (
        <p className="tk-small tk-report-done">
          <span className="badge badge-ok">{t("report.completedShort")}</span>{" "}
          {t("report.completed", { time: new Date(report.completed.at).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" }) })}
          {report.completed.reason && (
            <span className="ap-quote" aria-label={t("report.completedReason")}>
              {report.completed.reason}
            </span>
          )}
        </p>
      )}
      {report.summary && <ReportMarkdown text={report.summary} className="tk-report-summary" />}
      {report.truncated && <p className="muted tk-small">{t("report.truncated")}</p>}
      {/* Keyed by the result: a follow-up's newer findings start unfiltered and closed. */}
      {report.findings.length > 0 && <Findings key={report.at} report={report} detail={detail} />}
    </section>
  );
}

/**
 * The suggested follow-up tasks as draft cards, with their count and, when several are open,
 * `Add all as drafts`. Each add goes through the same assistant.addDraft as a card's own button,
 * with the card's fields as they read now, so every task still waits for its crew approval;
 * nothing starts here. What you type lives in useDraftEdits, so Details and the Suggested tab show
 * the same edits and Add all adds them.
 */
export function SuggestedTasks({ detail, inTab = false }: { detail: TaskDetail; inTab?: boolean }) {
  const { t } = useTranslation("assistant");
  const report = useTaskReport(detail).data;
  const refresh = useRefreshReport(detail.id);
  const errorText = useReportError();
  const edits = useDraftEdits((s) => s.edits);
  const setEdit = useDraftEdits((s) => s.set);
  const clearEdit = useDraftEdits((s) => s.clear);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  if (!report) return null;
  const drafts = visibleDrafts(report);
  if (drafts.length === 0 && !inTab) return null;
  const open = openDrafts(report);
  // A card whose title you cleared cannot be added; its own Add is off too, so Add all waits.
  const untitled = open.some((d) => edits[d.id] && !edits[d.id]!.title.trim());

  const addAll = async () => {
    setBusy(true);
    setNote(null);
    setError(null);
    let added = 0;
    try {
      for (const d of open) {
        // Read at each step: the store holds the card's fields as you left them.
        const typed = useDraftEdits.getState().edits[d.id];
        try {
          await act("assistant.addDraft", { draftId: d.id, ...(typed ? { edit: draftEdit(typed) } : {}) });
        } catch (err) {
          // That card's own Add, pressed just before, is already proposing it; the rest still go.
          if (codeOf(err) === "assistant.draft_adding") continue;
          throw err;
        }
        clearEdit(d.id);
        added++;
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      if (added > 0) setNote(t("report.addedAll", { count: added }));
      refresh();
    }
  };

  return (
    // The block takes focus (not a tab stop) when the report header's count jumps to it.
    <section className="ins-sec tk-suggested" id={inTab ? undefined : SUGGESTED_ID} tabIndex={inTab ? undefined : -1} aria-labelledby={titleId}>
      <div className="tk-suggested-head">
        <h3 className="tk-suggested-title" id={titleId}>
          {t("report.suggested")}
        </h3>
        {open.length > 0 && <span className="badge badge-info num">{t("report.openCount", { count: open.length })}</span>}
        {open.length > 1 && (
          <Button size="sm" tone="ok" className="tk-suggested-all" disabled={busy || untitled} onClick={() => void addAll()}>
            {busy ? t("report.addingAll") : t("report.addAll", { count: open.length })}
          </Button>
        )}
      </div>
      <p className="muted tk-small">{open.length > 1 ? t("report.addAllNote") : t("report.suggestedNote")}</p>
      {open.length > 1 && untitled && (
        <p className="banner banner-warn tk-small" role="status">
          {t("report.addAllInvalid")}
        </p>
      )}
      {note && (
        <p className="banner banner-ok tk-small" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="tk-error" role="alert">
          {error}
        </p>
      )}
      {drafts.length === 0 ? (
        <p className="muted ins-empty">{t("report.suggestedEmpty")}</p>
      ) : (
        // While Add all runs, the disabled fieldset holds every card still: no edits it would miss,
        // and no second add of a draft it is about to add.
        <fieldset className="tk-suggested-list" disabled={busy} aria-busy={busy}>
          {drafts.map((d, i) => (
            // The wrapper is where a finding's `Suggested task` lands; it takes focus, not a tab stop.
            <div key={d.id} id={inTab ? undefined : draftAnchor(d.id)} tabIndex={-1} className="tk-suggested-slot">
              <DraftCard draft={withEdits(d, edits[d.id])} index={i + 1} onChanged={refresh} onEdit={(f) => setEdit(d.id, f)} />
            </div>
          ))}
        </fieldset>
      )}
    </section>
  );
}

/** For the inspector's tab bar: whether the Suggested tab shows, and how many drafts are still open. */
export function useSuggestedTab(detail: TaskDetail): { show: boolean; open: number } {
  const report = useTaskReport(detail).data;
  if (!report) return { show: false, open: 0 };
  return { show: visibleDrafts(report).length > 0, open: openDrafts(report).length };
}
