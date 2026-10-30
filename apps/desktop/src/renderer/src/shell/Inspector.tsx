import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, PanelRightClose, PanelRightOpen, Pause, Play, RotateCw, Send, X } from "lucide-react";
import type { CandidateView, RequestAnswer, RunView, TaskDetail } from "@crewyard/core";
import { BrandIcon, Button, Label, Splitter, TickMeter } from "@crewyard/ui";
import { useInspector, type InspectorTarget } from "../inspector.ts";
import { useNav } from "../nav.ts";
import { usePrefs } from "../prefs.ts";
import { INSPECTOR, inspectorBounds, sidebarColumn } from "./layout.ts";
import { useViewportWidth } from "./useMedia.ts";
import { TaskPullSection } from "../screens/github/TaskPull.tsx";
import { ProvBadge } from "../screens/providers/shared.tsx";
import { ApprovalActions } from "../screens/inbox/ApprovalActions.tsx";
import { act, useErrorText, useRecheck, useWork } from "../screens/tasks/data.ts";
import { useActivity } from "../screens/tasks/live.ts";
import { formatDuration, latestRunOf, limitBanner, profileNames, resolveTarget, runDuration, stepState } from "../screens/tasks/model.ts";
import { ConfirmButton, ErrorLine, LimitBanner, useFormat, useNow } from "../screens/tasks/parts.tsx";
import { DiffStat } from "../screens/tasks/TaskRow.tsx";
import { DiffReview } from "../screens/tasks/DiffReview.tsx";
import "../screens/tasks/tasks.css";
import "./inspector.css";

// The right-hand inspector (DESIGN.md §4, `Inspector`): 380 px by default, resizable by its left
// edge, collapsible to a 44 px strip, and an overlay below 1280 px. Closing or collapsing it only
// hides the panel; it never stops an agent, and the panel says so.

const INSPECTOR_ID = "app-inspector";

type Tab = "details" | "changes" | "usage";

function Actions({ detail, run, onError }: { detail: TaskDetail; run: RunView; onError: (err: unknown) => void }) {
  const f = useFormat();
  const [text, setText] = useState("");
  const member = detail.crew?.members.find((m) => m.id === run.memberId);
  const targets = [member?.chosen, ...(member?.standby ?? [])].filter((c): c is CandidateView => Boolean(c) && c!.profileId !== run.profileId);
  const [target, setTarget] = useState(targets[0]?.profileId ?? "");
  const open = run.endedAt === null;
  const superseded = detail.runs.some((r) => r.resumedFrom === run.id);
  const canRetry = !superseded && run.endReason !== "completed" && (run.endedAt !== null || run.limitReached || run.resumeAt !== null);
  const canHandOff = !superseded && run.endReason !== "completed" && targets.length > 0 && run.state !== "handing_off" && !detail.cancelledAt;
  const canMessage = run.endReason !== "completed" && !detail.cancelledAt;
  const go = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="ins-actions">
      {canMessage && (
        <form
          className="ins-message"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            void go(async () => {
              await act("runs.message", { runId: run.id, text: text.trim(), sessionId: run.nativeSessionId });
              setText("");
            });
          }}
        >
          <label className="lbl" htmlFor="ins-msg">
            {f.t("inspector.message")}
          </label>
          <textarea id="ins-msg" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={open && !run.pausedAt ? f.t("inspector.messageLive") : f.t("inspector.messageQueued")} />
          <Button type="submit" variant="primary" disabled={!text.trim()}>
            <Send aria-hidden="true" />
            {f.t("inspector.send")}
          </Button>
        </form>
      )}
      <div className="ins-buttons">
        {open && !run.pausedAt && (
          <Button onClick={() => void go(() => act("runs.pause", { runId: run.id, sessionId: run.nativeSessionId }))}>
            <Pause aria-hidden="true" />
            {f.t("action.pause")}
          </Button>
        )}
        {open && run.pausedAt && !run.limitReached && (
          <Button onClick={() => void go(() => act("runs.resume", { runId: run.id }))}>
            <Play aria-hidden="true" />
            {f.t("action.resume")}
          </Button>
        )}
        {canRetry && (
          <Button onClick={() => void go(() => act("runs.retry", { runId: run.id }))}>
            <RotateCw aria-hidden="true" />
            {f.t("action.retry")}
          </Button>
        )}
      </div>
      {canHandOff && (
        <div className="ins-handoff">
          <label className="lbl" htmlFor="ins-target">
            {f.t("inspector.handOffTo")}
          </label>
          <div className="row">
            <select id="ins-target" value={target} onChange={(e) => setTarget(e.target.value)}>
              {targets.map((c) => (
                <option key={c.profileId} value={c.profileId}>
                  {`${f.runner(c.runner)} · ${c.alias}${c.model ? ` · ${c.model}` : ""}`}
                </option>
              ))}
            </select>
            <Button disabled={!target} onClick={() => void go(() => act("runs.handoff", { runId: run.id, targetProfileId: target }))}>
              <ArrowLeftRight aria-hidden="true" />
              {f.t("inspector.handOff")}
            </Button>
          </div>
        </div>
      )}
      {open && (
        <ConfirmButton
          size="md"
          label={f.t("inspector.stop")}
          confirm={f.t("inspector.stopConfirm", { who: `${f.role(run.role)} · ${f.runner(run.runner)}` })}
          onConfirm={() => go(() => act("runs.stop", { runId: run.id, sessionId: run.nativeSessionId }))}
        />
      )}
    </div>
  );
}

/** The run's open tool approval, answerable here with the same buttons and deny reason as the Inbox. */
function PendingApproval({ detail, run, onError }: { detail: TaskDetail; run: RunView; onError: (err: unknown) => void }) {
  const f = useFormat();
  const requests = useWork("requests.list", { taskId: detail.id }, { enabled: run.pendingRequestId !== null });
  const q = requests.data?.find((r) => r.id === run.pendingRequestId);
  if (!q || q.payload.kind !== "approval") return null;
  const answer = async (a: RequestAnswer) => {
    try {
      await act("requests.answer", { requestId: q.id, answer: a, runId: q.runId, sessionId: q.sessionId });
    } catch (err) {
      onError(err);
    }
  };
  return (
    <div className="ins-sec">
      <Label>{f.t("inspector.approval")}</Label>
      {q.payload.command && <pre className="ib-code">{q.payload.command}</pre>}
      <ApprovalActions key={q.id} q={q} answer={answer} />
    </div>
  );
}

function Body({ detail, target }: { detail: TaskDetail; target: InspectorTarget }) {
  const f = useFormat();
  const errorText = useErrorText();
  const recheck = useRecheck();
  const inspect = useInspector((s) => s.open);
  const { selectTask, go } = useNav();
  const [tab, setTab] = useState<Tab>("details");
  const [error, setError] = useState<string | null>(null);
  const { run, memberId } = resolveTarget(detail, target);
  const members = detail.crew?.members ?? [];
  const member = members.find((m) => m.id === memberId) ?? null;
  const index = member ? members.indexOf(member) + 1 : 0;
  const names = profileNames(detail);
  const activity = useActivity((s) => (run ? s.runs[run.id] : undefined));
  const notices = useActivity((s) => s.notices);
  const now = useNow(1000, Boolean(run && !run.endedAt));
  const banner = limitBanner({ ...detail, runs: run ? [run] : [] }, notices);
  const lineage = member ? detail.runs.filter((r) => r.memberId === member.id).sort((a, b) => a.startedAt.localeCompare(b.startedAt)) : [];
  const alias = run ? (names.get(run.profileId)?.alias ?? run.profileId) : (member?.chosen?.alias ?? "");
  const runner = run?.runner ?? member?.chosen?.runner ?? null;
  const state = member ? stepState(member, run) : null;
  const ctx = activity?.context ?? null;
  const contextPct = ctx ? Math.min(100, (100 * ctx.used) / ctx.size) : null;
  const tokens = run ? run.tokensIn + run.tokensOut : 0;
  const diffFiles = run?.diff ?? [];
  const diffStat = diffFiles.length ? { files: diffFiles.length, added: diffFiles.reduce((n, x) => n + x.added, 0), removed: diffFiles.reduce((n, x) => n + x.removed, 0) } : null;

  return (
    <>
      <div className="ins-head">
        <Label>{member ? f.t("inspector.eyebrow", { index: String(index).padStart(2, "0"), role: f.role(member.role) }) : f.t("inspector.task")}</Label>
        <h2>
          {runner && <BrandIcon id={runner} size={16} />}
          {runner ? `${f.runner(runner)} · ${alias}` : detail.title}
        </h2>
        <div className="ins-sub">
          {state && <span className={`st ins-state s-${state}`}>{f.t(`step.${state}`)}</span>}
          {run?.model && <span className="mono muted">{run.model}</span>}
        </div>
        <button
          type="button"
          className="ins-task"
          onClick={() => {
            selectTask(detail.id);
            go("tasks");
          }}
        >
          {detail.title}
        </button>
      </div>
      <div className="ins-tabs" role="tablist">
        {(["details", "changes", "usage"] as const).map((x) => (
          <button key={x} type="button" role="tab" aria-selected={tab === x} onClick={() => setTab(x)}>
            {f.t(`inspector.tab.${x}`)}
          </button>
        ))}
      </div>
      {banner && run && (
        <div className="ins-sec">
          <LimitBanner
            info={banner}
            who={`${f.runner(run.runner)} · ${alias}`}
            onHandOff={banner.target ? () => void act("runs.handoff", { runId: run.id, targetProfileId: banner.target!.profileId }).catch((e) => setError(errorText(e))) : undefined}
            onOpenInbox={() => {
              selectTask(detail.id);
              go("inbox");
            }}
          />
        </div>
      )}
      {tab === "details" && (
        <>
          {detail.kind === "code" && (detail.status === "review" || detail.status === "merged") && <TaskPullSection taskId={detail.id} className="ins-sec" />}
          {activity?.now && run && !run.endedAt && (
            <div className="ins-sec">
              <Label>{f.t("inspector.now")}</Label>
              <div className="ins-now">{activity.now}</div>
            </div>
          )}
          {run?.plan && run.plan.length > 0 && (
            <div className="ins-sec">
              <Label>{f.t("inspector.plan")}</Label>
              <ol className="ins-plan">
                {run.plan.map((s, i) => (
                  <li key={i} className={`p-${s.status}`}>
                    <span className="mark" aria-hidden="true" />
                    <span>{s.title}</span>
                    <span className="sr">{f.t(`inspector.planStatus.${s.status}`)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className="ins-sec">
            <Label>{f.t("inspector.steps")}</Label>
            <ol className="ins-steps">
              {members.map((m, i) => {
                const r = latestRunOf(detail, m.id);
                const s = stepState(m, r);
                return (
                  <li key={m.id}>
                    <button type="button" aria-current={m.id === memberId ? "step" : undefined} onClick={() => inspect({ taskId: detail.id, memberId: m.id })}>
                      <span className={`tk-step-dot s-${s}`} aria-hidden="true" />
                      <span className="num muted">{String(i + 1).padStart(2, "0")}</span>
                      <span>{f.role(m.role)}</span>
                      <span className="muted">{f.t(`step.${s}`)}</span>
                      <span className="num muted">{r ? formatDuration(runDuration(r, now)) : ""}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
          {lineage.length > 1 && (
            <div className="ins-sec">
              <Label>{f.t("inspector.runs")}</Label>
              <ol className="ins-lineage">
                {lineage.map((r) => (
                  <li key={r.id}>
                    <button type="button" aria-current={r.id === run?.id ? "true" : undefined} onClick={() => inspect({ taskId: detail.id, memberId: r.memberId, runId: r.id })}>
                      <BrandIcon id={r.runner} size={14} />
                      <span>{`${f.runner(r.runner)} · ${names.get(r.profileId)?.alias ?? r.profileId}`}</span>
                      <span className="muted">{r.endedAt ? f.t(`endReason.${r.endReason}`, { defaultValue: r.endReason ?? "" }) : f.t("inspector.live")}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {run && (
            <div className="ins-sec">
              <Label>{f.t("inspector.folder")}</Label>
              <div className="mono ins-path">{run.cwd}</div>
              {detail.worktree && run.worktreeId && <div className="mono muted ins-path">{detail.worktree.branch}</div>}
            </div>
          )}
        </>
      )}
      {tab === "changes" && (
        <div className="ins-sec">
          {diffStat ? (
            <>
              <DiffStat stat={diffStat} />
              <ul className="ins-files">
                {diffFiles.map((x) => (
                  <li key={x.path}>
                    <span className="mono">{x.path}</span>
                    <span className="mono add">+{x.added}</span>
                    <span className="mono del">−{x.removed}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted ins-empty">{f.t("inspector.noChanges")}</p>
          )}
        </div>
      )}
      {tab === "changes" && <DiffReview detail={detail} run={run} />}
      {tab === "usage" && run && (
        <>
          <div className="ins-sec">
            <div className="ins-mrow">
              <div className="row">
                <span className="sec">{f.t("inspector.context")}</span>
                <span className="mono">{contextPct === null ? "—" : `${Math.round(contextPct)}%`}</span>
              </div>
              <TickMeter value={contextPct} label={contextPct === null ? f.t("inspector.contextUnknown") : f.t("inspector.contextMeter", { pct: Math.round(contextPct) })} />
              {contextPct === null && <span className="muted ins-small">{f.t("inspector.contextNote")}</span>}
            </div>
          </div>
          <div className="ins-sec ins-facts">
            <div>
              <Label>{f.t("inspector.tokens")}</Label>
              <div className="v num">{tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens}</div>
              <div className="muted ins-small">{f.t("inspector.tokensSplit", { input: run.tokensIn, output: run.tokensOut })}</div>
            </div>
            <div>
              <Label>{f.t("inspector.elapsed")}</Label>
              <div className="v num">{formatDuration(runDuration(run, now))}</div>
            </div>
            <div>
              <Label>{f.t("inspector.cost")}</Label>
              <div className="v num">{run.cost.usd === null ? "—" : f.usd(run.cost.usd)}</div>
              <ProvBadge value={run.cost.provenance} />
            </div>
            <div>
              <Label>{f.t("inspector.queued")}</Label>
              <div className="v num">{run.queuedMessages}</div>
            </div>
          </div>
        </>
      )}
      {run && !run.endedAt && (
        <PendingApproval
          detail={detail}
          run={run}
          onError={(e) => {
            setError(errorText(e));
            recheck(e);
          }}
        />
      )}
      {run && (
        <Actions
          key={run.id}
          detail={detail}
          run={run}
          onError={(e) => {
            setError(errorText(e));
            recheck(e);
          }}
        />
      )}
      <div className="ins-pad">
        <ErrorLine>{error}</ErrorLine>
      </div>
    </>
  );
}

/** The handle on the inspector's left edge; limits follow the window so the main view keeps room. */
function InspectorSplitter() {
  const { t } = useTranslation();
  const width = usePrefs((s) => s.inspectorWidth);
  const setWidth = usePrefs((s) => s.setInspectorWidth);
  const sidebarWidth = usePrefs((s) => s.sidebarWidth);
  const sidebarCollapsed = usePrefs((s) => s.sidebarCollapsed);
  const viewport = useViewportWidth();
  const bounds = inspectorBounds(viewport, sidebarColumn(viewport, { sidebarWidth, sidebarCollapsed }));
  return (
    <Splitter
      value={width}
      min={bounds.min}
      max={bounds.max}
      defaultValue={INSPECTOR.default}
      edge="start"
      label={t("layout.inspector.resize")}
      title={t("layout.resetHint")}
      controls={INSPECTOR_ID}
      onChange={setWidth}
    />
  );
}

/** Rendered by the shell next to the main view while a target is set. */
export function Inspector() {
  const { t } = useTranslation();
  const target = useInspector((s) => s.target);
  const close = useInspector((s) => s.close);
  const collapsed = usePrefs((s) => s.inspectorCollapsed);
  const setCollapsed = usePrefs((s) => s.setInspectorCollapsed);
  const f = useFormat();
  const detail = useWork("tasks.get", { taskId: target?.taskId ?? "" }, { enabled: Boolean(target) });

  useEffect(() => {
    if (!target) return;
    // Esc closes the topmost layer; an open dialog handles its own Esc first.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("dialog[open]")) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, close]);

  if (!target) return null;
  const closeButton = (
    <button type="button" className="ins-close" onClick={close} aria-label={f.t("inspector.close")} title={f.t("inspector.close")}>
      <X size={16} strokeWidth={1.75} />
    </button>
  );
  if (collapsed) {
    return (
      <div className="ins-col collapsed">
        <aside id={INSPECTOR_ID} className="inspector ins-strip" aria-label={f.t("inspector.label")}>
          <button type="button" className="ins-collapse" onClick={() => setCollapsed(false)} aria-label={t("layout.inspector.expand")} title={t("layout.inspector.expand")} aria-expanded="false" aria-controls={INSPECTOR_ID}>
            <PanelRightOpen size={16} strokeWidth={1.75} />
          </button>
          {closeButton}
          {detail.data && detail.data.id === target.taskId && <span className="ins-strip-title">{detail.data.title}</span>}
        </aside>
      </div>
    );
  }
  return (
    <div className="ins-col">
      <InspectorSplitter />
      <aside id={INSPECTOR_ID} className="inspector" aria-label={f.t("inspector.label")}>
        <div className="ins-tools">
          <button type="button" className="ins-collapse" onClick={() => setCollapsed(true)} aria-label={t("layout.inspector.collapse")} title={t("layout.inspector.collapse")} aria-expanded="true" aria-controls={INSPECTOR_ID}>
            <PanelRightClose size={16} strokeWidth={1.75} />
          </button>
          {closeButton}
        </div>
        {detail.data && detail.data.id === target.taskId ? <Body detail={detail.data} target={target} /> : <p className="muted ins-pad">{detail.isError ? f.t("errors.load") : f.t("inspector.loading")}</p>}
        <p className="ins-note">{f.t("inspector.closeNote")}</p>
      </aside>
    </div>
  );
}
