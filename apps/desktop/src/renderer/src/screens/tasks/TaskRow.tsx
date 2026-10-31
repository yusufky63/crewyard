import { useState } from "react";
import { CalendarClock, ChevronDown, ChevronUp, GitBranch, Layers } from "lucide-react";
import type { RequestView, TaskSummary } from "@crewyard/core";
import { BrandIcon, Button } from "@crewyard/ui";
import { useInspector } from "../../inspector.ts";
import { useNav } from "../../nav.ts";
import { TaskPullChip } from "../github/TaskPull.tsx";
import { act, useErrorText, useWork } from "./data.ts";
import { useActivity } from "./live.ts";
import { ReportLine } from "./TaskReport.tsx";
import { GoalChip, GoalTaskLabel } from "./GoalRow.tsx";
import { currentRun, diffTotals, elapsedMs, formatDuration, goalRowStatus, latestRunOf, limitBanner, profileNames, runDuration, runnersOf, statusLine, stepState } from "./model.ts";
import { ConfirmButton, ErrorLine, LimitBanner, StatusLabel, useFormat, useNow } from "./parts.tsx";

export function DiffStat({ stat }: { stat: { files: number; added: number; removed: number } }) {
  const f = useFormat();
  return (
    <span className="tk-diff" aria-label={f.t("row.diffAria", { files: stat.files, added: stat.added, removed: stat.removed })}>
      <span className="add">+{stat.added}</span>
      <span className="del">−{stat.removed}</span>
      <span className="tk-diffbar" aria-hidden="true">
        <span style={{ flex: Math.max(1, stat.added) }} />
        <span style={{ flex: Math.max(1, stat.removed) }} />
      </span>
      <span className="muted">{f.t("row.files", { count: stat.files })}</span>
    </span>
  );
}

/**
 * DESIGN.md `TaskRow`: title, branch, runner marks, elapsed and one status line; the expanded
 * body lists the crew's steps. Rows never expand on their own when events arrive. A task of an
 * Orchestra goal (docs/adr/0019) carries its goal chip, says why it waits instead of "Waiting for
 * approval", and never offers Review crew: it starts with its plan. Hidden goal tasks (planning,
 * the last review) draw nothing here; they show inside the goal.
 */
export function TaskRow({ summary, requests }: { summary: TaskSummary; requests: RequestView[] }) {
  const f = useFormat();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { taskId: selected, selectTask, go } = useNav();
  const inspect = useInspector((s) => s.open);
  const hidden = summary.goal?.hidden === true;
  const detailQ = useWork("tasks.get", { taskId: summary.id }, { enabled: !hidden });
  const notices = useActivity((s) => s.notices);
  const live = summary.activeRuns > 0;
  const now = useNow(1000, live);
  const detail = detailQ.data;

  if (hidden) return null;
  if (!detail) {
    return (
      <div className="tk-row" aria-busy="true">
        <div className="tk-title">{summary.title}</div>
      </div>
    );
  }

  const line = statusLine(detail, requests);
  const goalRef = summary.goal ?? detail.goal ?? null;
  const goalLine = goalRowStatus(goalRef, detail.status);
  const run = currentRun(detail);
  const elapsed = elapsedMs(detail, now);
  const diff = diffTotals(detail);
  const runners = runnersOf(detail);
  const banner = limitBanner(detail, notices);
  const showBanner = banner && !(banner.kind !== "reached" && dismissed === `${banner.runId}|${banner.kind}`);
  const names = profileNames(detail);
  const bannerWho = banner ? `${f.runner(detail.runs.find((r) => r.id === banner.runId)?.runner ?? "")} · ${names.get(banner.profileId)?.alias ?? banner.profileId}` : "";
  const failed = [...detail.runs].reverse().find((r) => r.endReason === "failed" && detail.resumableRunIds.includes(r.id));
  const resumable = detail.status !== "failed" ? detail.resumableRunIds[0] : undefined;

  const run$ = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="tk-row" aria-current={selected === detail.id ? "true" : undefined}>
      <div className="tk-top">
        <button
          type="button"
          className="tk-top-main"
          data-list-id={detail.id}
          onClick={() => {
            selectTask(detail.id);
            inspect({ taskId: detail.id });
          }}
        >
          <div className="tk-title">{detail.title}</div>
          <div className="tk-meta">
            {detail.worktree && (
              <span>
                <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" />
                {detail.worktree.branch}
              </span>
            )}
            {runners.length > 0 && (
              <span>
                {runners.map((r) => (
                  <BrandIcon key={r} id={r} size={14} label={f.runner(r)} />
                ))}
                {f.t("row.agents", { count: detail.crew?.members.length ?? runners.length })}
              </span>
            )}
            {goalRef && <GoalChip goalRef={goalRef} />}
            <span>{f.t(`kind.${detail.kind}`)}</span>
            {detail.bestOf && (
              <span>
                <Layers size={13} strokeWidth={1.75} aria-hidden="true" />
                {f.t("bestOf.chip", { count: detail.bestOf.n })}
              </span>
            )}
            {detail.scheduled && (
              <span className="tk-sched" title={detail.scheduled.autoApproved ? f.t("row.scheduledAuto") : undefined}>
                <CalendarClock size={13} strokeWidth={1.75} aria-hidden="true" />
                <span className="as-typed">{f.t("row.scheduled", { title: detail.scheduled.title })}</span>
              </span>
            )}
          </div>
        </button>
        <span className="tk-right num">{elapsed !== null ? formatDuration(elapsed) : f.when.ago(detail.createdAt)}</span>
        <button type="button" className="tk-expand" aria-expanded={open} aria-label={open ? f.t("row.collapse") : f.t("row.expand")} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronUp size={16} strokeWidth={1.75} /> : <ChevronDown size={16} strokeWidth={1.75} />}
        </button>
      </div>
      <div className="tk-status">
        {goalLine ? <GoalTaskLabel line={goalLine} /> : <StatusLabel line={line} />}
        {run && !run.endedAt && <span className="muted tk-small">{`${f.runner(run.runner)} · ${names.get(run.profileId)?.alias ?? run.profileId}${run.model ? ` · ${run.model}` : ""}`}</span>}
        {diff && <DiffStat stat={diff} />}
        {/* A goal task's branch is merged into the goal branch, never pushed or pulled on its own. */}
        {detail.kind === "code" && !goalRef && (detail.status === "review" || detail.status === "merged") && (
          <TaskPullChip
            taskId={detail.id}
            onOpen={() => {
              selectTask(detail.id);
              inspect({ taskId: detail.id });
            }}
          />
        )}
        <div className="end">
          {detail.status === "proposed" && !goalRef && (
            <Button size="sm" onClick={() => selectTask(detail.id)}>
              {f.t("row.reviewCrew")}
            </Button>
          )}
          {detail.bestOf && ["running", "choosing", "failed"].includes(detail.bestOf.phase) && !detail.cancelledAt && (
            <Button size="sm" onClick={() => selectTask(detail.id)}>
              {f.t("bestOf.compare")}
            </Button>
          )}
          {detail.status === "needs_input" && detail.bestOf?.phase !== "choosing" && (
            <Button
              size="sm"
              onClick={() => {
                selectTask(detail.id);
                go("inbox");
              }}
            >
              {f.t("row.openInbox")}
            </Button>
          )}
          {failed && (
            <Button size="sm" onClick={() => void run$(() => act("runs.retry", { runId: failed.id }))}>
              {f.t("action.retry")}
            </Button>
          )}
          {resumable && !detail.cancelledAt && detail.activeRuns === 0 && (
            <Button size="sm" onClick={() => void run$(() => act("runs.resume", { runId: resumable }))}>
              {f.t("action.resume")}
            </Button>
          )}
          {!detail.cancelledAt && detail.status !== "proposed" && !["review", "merged", "done"].includes(detail.status) && (
            <ConfirmButton
              label={f.t("row.cancel")}
              confirm={f.t("row.cancelConfirm", { count: detail.activeRuns })}
              onConfirm={() => run$(() => act("tasks.cancel", { taskId: detail.id }))}
            />
          )}
        </div>
      </div>
      <ReportLine detail={detail} />
      {showBanner && banner && (
        <LimitBanner
          info={banner}
          who={bannerWho}
          onDismiss={() => setDismissed(`${banner.runId}|${banner.kind}`)}
          onHandOff={banner.target ? () => void run$(() => act("runs.handoff", { runId: banner.runId, targetProfileId: banner.target!.profileId })) : undefined}
          onOpenInbox={() => {
            selectTask(detail.id);
            go("inbox");
          }}
        />
      )}
      <ErrorLine>{error}</ErrorLine>
      {open && (
        <ol className="tk-steps">
          {(detail.crew?.members ?? []).map((m) => {
            const r = latestRunOf(detail, m.id);
            const state = stepState(m, r);
            const c = r ? (names.get(r.profileId) ?? m.chosen) : m.chosen;
            return (
              <li key={m.id}>
                <button type="button" className={`tk-step${state === "running" ? " now" : ""}`} onClick={() => inspect({ taskId: detail.id, memberId: m.id })}>
                  <span className={`tk-step-dot s-${state}`} aria-hidden="true" />
                  <span>
                    {f.role(m.role)}
                    {c && <span className="who"> · {`${f.runner(c.runner)} · ${c.alias}`}</span>}
                  </span>
                  <span className="sec">{state === "blocked" && m.blockedBy ? f.reason(m.blockedBy) : f.t(`step.${state}`)}</span>
                  <span className="t num">{r ? formatDuration(runDuration(r, now)) : ""}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
