import { useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleHelp, Lightbulb } from "lucide-react";
import { useTranslation } from "react-i18next";
import { REPORT_LIMITS, type CrewReportView } from "@crewyard/core";
import { Button, Panel } from "@crewyard/ui";
import { useInspector } from "../../inspector.ts";
import { useNav } from "../../nav.ts";
import { act, useWork } from "../tasks/data.ts";
import { profileNames } from "../tasks/model.ts";
import { useFormat } from "../tasks/parts.tsx";

// Crew reports in the Inbox (feature scan A14, docs/adr/0007): an agent that needs your input, one
// that is stuck, and follow-up tasks it proposes. The agent's words are untrusted data: rendered as
// text in a quoted block, under a line Crewyard writes. A follow-up becomes a task only on your
// click, and only as a draft whose crew still waits for your approval.

const ICON = { needs_input: CircleHelp, stuck: CircleAlert, followup: Lightbulb } as const;

/** Keeps `mcp.reports.list` fresh; the daemon pushes `mcp.reports.changed` when one opens or closes. */
export function useReports(projectId: string) {
  const qc = useQueryClient();
  useEffect(() => window.crewyard.on("mcp.reports.changed", () => void qc.invalidateQueries({ queryKey: ["mcp.reports.list"] })), [qc]);
  return useWork("mcp.reports.list", { projectId }, { enabled: Boolean(projectId) });
}

function ReportItem({ r, onError }: { r: CrewReportView; onError: (err: unknown) => void }) {
  const { t } = useTranslation("inbox");
  const f = useFormat();
  const inspect = useInspector((s) => s.open);
  const nav = useNav();
  const task = useWork("tasks.get", { taskId: r.taskId });
  const run = task.data?.runs.find((x) => x.id === r.runId);
  const who = run && task.data ? `${f.role(run.role)} · ${f.runner(run.runner)} · ${profileNames(task.data).get(run.profileId)?.alias ?? run.profileId}` : t("report.someone");
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const replyId = useId();
  const type = r.type as keyof typeof ICON;
  const Icon = ICON[type] ?? CircleHelp;
  const go = (fn: () => Promise<unknown>) => {
    setBusy(true);
    void fn()
      .catch(onError)
      .finally(() => setBusy(false));
  };
  const answerable = (r.type === "needs_input" || r.type === "stuck") && run?.endedAt === null;
  return (
    <div className="ib-item ib-report">
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className={r.type === "followup" ? "ib-muted" : "ib-warn"} />
      <span className="ib-text">
        <span className="t">{t(`report.${r.type}`, { who })}</span>
        <span className="s">{task.data?.title}</span>
        {r.title && <span className="ib-report-title">{r.title}</span>}
        {r.text && (
          <span className="ib-quote" aria-label={t("report.fromAgent")}>
            {r.text}
          </span>
        )}
        {r.artifacts.length > 0 && (
          <span className="ib-artifacts">
            <span className="lbl">{t("report.artifacts")}</span>
            {r.artifacts.map((a) => (
              <code key={a} className="as-typed">
                {a}
              </code>
            ))}
          </span>
        )}
        {replying && (
          <span className="ib-reply">
            <label htmlFor={replyId} className="lbl">
              {t("report.replyLabel")}
            </label>
            <textarea id={replyId} className="ib-note-input" rows={3} maxLength={REPORT_LIMITS.descriptionBytes} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("report.replyHint")} />
          </span>
        )}
        <span className="ib-stall-acts">
          {answerable && !replying && (
            <Button size="sm" onClick={() => setReplying(true)}>
              {t("report.reply")}
            </Button>
          )}
          {replying && (
            <>
              <Button size="sm" disabled={busy || !text.trim()} onClick={() => go(() => act("mcp.reports.reply", { reportId: r.id, text, sessionId: run?.nativeSessionId ?? null }))}>
                {t("report.send")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setReplying(false)}>
                {t("report.cancel")}
              </Button>
            </>
          )}
          {r.type === "followup" && (
            <Button
              size="sm"
              tone="ok"
              disabled={busy}
              onClick={() =>
                go(async () => {
                  const res = await act("mcp.followups.accept", { reportId: r.id });
                  nav.selectTask(res.taskId);
                  nav.go("tasks");
                })
              }
            >
              {t("report.accept")}
            </Button>
          )}
          {run && !replying && (
            <Button size="sm" variant="ghost" onClick={() => inspect({ taskId: r.taskId, memberId: run.memberId, runId: run.id })}>
              {t("report.openRun")}
            </Button>
          )}
          {!replying && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => go(() => act("mcp.reports.dismiss", { reportId: r.id }))}>
              {t("report.dismiss")}
            </Button>
          )}
        </span>
        {r.type === "followup" && <span className="s">{t("report.acceptNote")}</span>}
      </span>
      <span className="k">{f.when.ago(r.createdAt)}</span>
    </div>
  );
}

export function ReportList({ reports, onError }: { reports: CrewReportView[]; onError: (err: unknown) => void }) {
  const { t } = useTranslation("inbox");
  if (reports.length === 0) return null;
  return (
    <>
      <div className="ib-sub lbl">{t("report.section", { count: reports.length })}</div>
      <Panel className="ib-list" aria-live="polite">
        {reports.map((r) => (
          <ReportItem key={r.id} r={r} onError={onError} />
        ))}
      </Panel>
    </>
  );
}
