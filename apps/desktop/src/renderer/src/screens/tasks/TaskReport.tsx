import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { ReportSeverity, TaskDetail, TaskReport as Report } from "@crewyard/core";
import { Button, Label } from "@crewyard/ui";
import { useInspector } from "../../inspector.ts";
import { useNav } from "../../nav.ts";
import { DraftCard } from "./Assistant.tsx";
import { useWork } from "./data.ts";
import "./assistant.css";

// A finished research, review or docs task's result, made visible (docs/adr/0014): a one-line
// summary on the row with `Open report`, and the whole report in the inspector's Details, with its
// findings and the follow-up tasks they suggest as editable drafts. Agent text, shown as text only.

/** Whether a task can have a report: non-code work that finished. */
export const hasReport = (d: Pick<TaskDetail, "kind" | "status">) => d.kind !== "code" && d.status === "done";

const SEVERITY_CLASS: Record<ReportSeverity, string> = { critical: "tk-sev-bad", high: "tk-sev-bad", medium: "tk-sev-warn", low: "muted", info: "muted" };

function useReport(taskId: string, enabled: boolean) {
  const qc = useQueryClient();
  // Autopilot marking the task done (docs/adr/0017) changes the report without a task change.
  useEffect(() => window.crewyard.on("autopilot.changed", () => void qc.invalidateQueries({ queryKey: ["assistant.report", { taskId }] })), [qc, taskId]);
  return useWork("assistant.report", { taskId }, { enabled });
}

function firstLine(s: string, max = 180): string {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** On the task row: the report's first line and `Open report`. Nothing while there is none. */
export function ReportLine({ detail }: { detail: TaskDetail }) {
  const { t } = useTranslation("assistant");
  const report = useReport(detail.id, hasReport(detail)).data;
  const selectTask = useNav((s) => s.selectTask);
  const inspect = useInspector((s) => s.open);
  if (!report) return null;
  const open = report.drafts.filter((d) => d.status === "open").length;
  const line = firstLine(report.summary) || (report.findings[0]?.title ?? "");
  return (
    <div className="tk-report-line">
      {line && (
        <span className="tk-report-text" title={report.summary.slice(0, 2_000)}>
          {line}
        </span>
      )}
      {report.findings.length > 0 && <span className="lbl num">{t("report.findingsCount", { count: report.findings.length })}</span>}
      {report.completed && <span className="lbl">{t("report.completedShort")}</span>}
      {open > 0 && <span className="lbl num">{t("report.suggestedCount", { count: open })}</span>}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          selectTask(detail.id);
          inspect({ taskId: detail.id });
        }}
      >
        {t("report.open")}
      </Button>
    </div>
  );
}

/** In the inspector's Details: the whole report, its findings and the suggested drafts. */
export function ReportSection({ detail }: { detail: TaskDetail }) {
  const { t, i18n } = useTranslation("assistant");
  const qc = useQueryClient();
  const q = useReport(detail.id, hasReport(detail));
  const report: Report | null | undefined = q.data;
  if (!report) return null;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["assistant.report", { taskId: detail.id }] });
  const drafts = report.drafts.filter((d) => d.status !== "discarded");
  return (
    <section className="ins-sec tk-report" aria-label={t("report.label")}>
      <div className="tk-report-head">
        <Label>{t("report.label")}</Label>
        <span className="lbl">{t(`report.source.${report.source}`)}</span>
        {report.verdict && <span className={report.verdict === "pass" ? "tk-sev-ok lbl" : "tk-sev-warn lbl"}>{t(`report.verdict.${report.verdict}`)}</span>}
      </div>
      {report.completed && (
        <p className="tk-small tk-report-done">
          {t("report.completed", { time: new Date(report.completed.at).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" }) })}
          {report.completed.reason && (
            <span className="ap-quote" aria-label={t("report.completedReason")}>
              {report.completed.reason}
            </span>
          )}
        </p>
      )}
      {report.summary && <p className="tk-report-summary">{report.summary}</p>}
      {report.truncated && <p className="muted tk-small">{t("report.truncated")}</p>}
      {report.findings.length > 0 && (
        <ol className="tk-findings" aria-label={t("report.findings")}>
          {report.findings.map((f, i) => (
            <li key={i}>
              <div className="tk-finding-top">
                <span className={`lbl ${SEVERITY_CLASS[f.severity]}`}>{t(`report.severity.${f.severity}`)}</span>
                <span className="tk-finding-title">{f.title}</span>
              </div>
              {f.file && (
                <div className="mono muted tk-small as-typed">
                  {f.file}
                  {f.line !== null ? `:${f.line}` : ""}
                </div>
              )}
              {f.detail && f.detail !== f.title && <p className="tk-finding-detail">{f.detail}</p>}
            </li>
          ))}
        </ol>
      )}
      {drafts.length > 0 && (
        <div className="tk-report-drafts">
          <Label>{t("report.suggested")}</Label>
          <p className="muted tk-small">{t("report.suggestedNote")}</p>
          {drafts.map((d, i) => (
            <DraftCard key={d.id} draft={d} index={i + 1} onChanged={refresh} />
          ))}
        </div>
      )}
    </section>
  );
}
