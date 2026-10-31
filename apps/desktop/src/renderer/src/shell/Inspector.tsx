import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, PanelRightClose, PanelRightOpen, Pause, Play, RotateCw, X } from "lucide-react";
import { readProviderError, providerErrorLine, splitEndDetail, type CandidateView, type HandoffStop, type RequestAnswer, type RunView, type TaskDetail } from "@crewyard/core";
import { BrandIcon, Button, Label, Splitter, TickMeter } from "@crewyard/ui";
import { useInspector, type InspectorTarget } from "../inspector.ts";
import { useNav } from "../nav.ts";
import { usePrefs } from "../prefs.ts";
import { INSPECTOR, inspectorBounds, sidebarColumn } from "./layout.ts";
import { useViewportWidth } from "./useMedia.ts";
import { MessageForm, QueueSection, UndoControl } from "./TurnControls.tsx";
import { TaskPullSection } from "../screens/github/TaskPull.tsx";
import { ProvBadge } from "../screens/providers/shared.tsx";
import { ApprovalActions } from "../screens/inbox/ApprovalActions.tsx";
import { act, useErrorText, useRecheck, useWork } from "../screens/tasks/data.ts";
import { useActivity } from "../screens/tasks/live.ts";
import { canChooseHandoffStop, formatDuration, handoffsOf, latestRunOf, limitBanner, profileNames, resolveTarget, runDuration, stepState } from "../screens/tasks/model.ts";
import { ConfirmButton, ErrorLine, HandoffStopChoice, LimitBanner, useFormat, useNow } from "../screens/tasks/parts.tsx";
import { DiffStat } from "../screens/tasks/TaskRow.tsx";
import { ReportSection, SuggestedTasks, useSuggestedTab } from "../screens/tasks/TaskReport.tsx";
import { DiffReview } from "../screens/tasks/DiffReview.tsx";
import { BestOfCompare } from "../screens/tasks/BestOfCompare.tsx";
import { TaskTimeline } from "./timeline/TaskTimeline.tsx";
import { FIXTURE } from "./timeline/fixture.ts";
import { FilesTab } from "./files/FilesTab.tsx";
import { PreviewTab } from "./preview/PreviewTab.tsx";
import { usePreviewLifecycle } from "./preview/store.ts";
import "../screens/tasks/tasks.css";
import "./inspector.css";

// The right-hand inspector (DESIGN.md §4, `Inspector`): 380 px by default, resizable by its left
// edge, collapsible to a 44 px strip, and an overlay below 1280 px. Closing or collapsing it only
// hides the panel; it never stops an agent, and the panel says so.

const INSPECTOR_ID = "app-inspector";

type Tab = "details" | "suggested" | "changes" | "usage" | "files" | "preview";
/** Suggested sits right after Details and shows only while the task's report has drafts. */
const TABS: readonly Tab[] = ["details", "suggested", "changes", "usage", "files", "preview"];
/** Screenshot mode only: `inspectorTab=<tab>` opens the inspector on that tab. */
const SHOT_TAB = FIXTURE ? (new URLSearchParams(location.search).get("inspectorTab") as Tab | null) : null;

function Actions({ detail, run, onError }: { detail: TaskDetail; run: RunView; onError: (err: unknown) => void }) {
  const f = useFormat();
  const member = detail.crew?.members.find((m) => m.id === run.memberId);
  const targets = [member?.chosen, ...(member?.standby ?? [])].filter((c): c is CandidateView => Boolean(c) && c!.profileId !== run.profileId);
  const [target, setTarget] = useState(targets[0]?.profileId ?? "");
  const [stop, setStop] = useState<HandoffStop>("interrupt");
  const open = run.endedAt === null;
  const choosesStop = canChooseHandoffStop(run);
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
      {canMessage && <MessageForm key={run.id} run={run} onError={onError} />}
      <div className="ins-buttons">
        {open && !run.pausedAt && (
          <Button tone="warn" onClick={() => void go(() => act("runs.pause", { runId: run.id, sessionId: run.nativeSessionId }))}>
            <Pause aria-hidden="true" />
            {f.t("action.pause")}
          </Button>
        )}
        {open && run.pausedAt && !run.limitReached && (
          <Button tone="ok" onClick={() => void go(() => act("runs.resume", { runId: run.id }))}>
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
      <UndoControl key={run.id} run={run} onError={onError} />
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
            <Button disabled={!target} onClick={() => void go(() => act("runs.handoff", { runId: run.id, targetProfileId: target, ...(choosesStop ? { stop } : {}) }))}>
              <ArrowLeftRight aria-hidden="true" />
              {f.t("inspector.handOff")}
            </Button>
          </div>
          {choosesStop && <HandoffStopChoice name={`ins-stop-${run.id}`} value={stop} onChange={setStop} />}
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

/** How work moved into or out of this run: who to whom, how the session carried over, how the source stopped. */
function HandoffRecord({ detail, run }: { detail: TaskDetail; run: RunView }) {
  const f = useFormat();
  const names = profileNames(detail);
  const list = handoffsOf(detail.handoffs, run.id);
  if (list.length === 0) return null;
  const aliasOf = (profileId: string | null | undefined) => (profileId ? (names.get(profileId)?.alias ?? profileId) : "");
  return (
    <div className="ins-sec">
      <Label>{f.t("inspector.handoffs")}</Label>
      <ul className="ins-handoffs">
        {list.map((h) => {
          const out = h.fromRunId === run.id;
          const source = detail.runs.find((r) => r.id === h.fromRunId);
          return (
            <li key={h.id}>
              <span>{out ? f.t("handoffRecord.out", { target: aliasOf(h.targetProfileId) }) : f.t("handoffRecord.in", { source: aliasOf(source?.profileId) })}</span>
              <span className="muted">{[h.kind ? f.t(`handoffKind.${h.kind}`) : f.t("handoffKind.pending"), f.t(`handoffStop.done.${h.stop}`)].join(" · ")}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Why a run ended, whole: our code in words, then the runner's own text as the daemon kept it (redacted). */
function EndDetail({ run }: { run: RunView }) {
  const f = useFormat();
  const { code, text } = splitEndDetail(run.endDetail);
  if (!run.endedAt || (!code && !text)) return null;
  const reason = f.t(`endReason.${run.endReason}`, { defaultValue: run.endReason ?? "" });
  return (
    <div className="ins-sec">
      <Label>{f.t("inspector.endLabel")}</Label>
      <div className="ins-now">{code ? `${reason} · ${f.t(`endDetail.${code}`, { defaultValue: code })}` : text && readProviderError(text) ? `${reason} · ${providerErrorLine(text)}` : reason}</div>
      {text && (
        <>
          <span className="muted ins-small">{f.t("inspector.endText")}</span>
          <pre className="ins-end-text">{text}</pre>
        </>
      )}
    </div>
  );
}

function Body({ detail, target }: { detail: TaskDetail; target: InspectorTarget }) {
  const f = useFormat();
  const errorText = useErrorText();
  const recheck = useRecheck();
  const inspect = useInspector((s) => s.open);
  const { selectTask, go } = useNav();
  const [chosenTab, setTab] = useState<Tab>(target.tab ?? (SHOT_TAB && TABS.includes(SHOT_TAB) ? SHOT_TAB : "details"));
  const suggested = useSuggestedTab(detail);
  const tabs = TABS.filter((x) => x !== "suggested" || suggested.show);
  // A Suggested tab whose drafts went away (or are not loaded yet) falls back to Details.
  const tab: Tab = tabs.includes(chosenTab) ? chosenTab : "details";
  // A report finding's `file:line` asks the Files tab to preview that file, once per request.
  const reveal = useMemo(() => (target.tab === "files" && target.file ? { path: target.file } : undefined), [target]);
  // A target that names a tab (the Crew graph's Open changes, Open files) switches to it once.
  const [seenTarget, setSeenTarget] = useState(target);
  if (seenTarget !== target) {
    setSeenTarget(target);
    if (target.tab) setTab(target.tab);
  }
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
            const home = detail.variantOf?.taskId ?? detail.id;
            selectTask(home);
            go("tasks");
          }}
        >
          {detail.title}
        </button>
        {detail.variantOf && (
          <button type="button" className="ins-task muted" onClick={() => inspect({ taskId: detail.variantOf!.taskId })}>
            {f.t("bestOf.variantOf", { index: detail.variantOf.position, count: detail.variantOf.n })}
          </button>
        )}
      </div>
      <div className="ins-tabs" role="tablist">
        {tabs.map((x) => (
          <button key={x} type="button" role="tab" aria-selected={tab === x} onClick={() => setTab(x)}>
            {x === "preview" ? f.t("preview:tab") : f.t(`inspector.tab.${x}`)}
            {/* The space keeps the accessible name "Suggested 2"; flex layout drops it visually. */}
            {x === "suggested" && suggested.open > 0 && " "}
            {x === "suggested" && suggested.open > 0 && <span className="badge badge-info num ins-tab-count">{suggested.open}</span>}
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
          <ReportSection detail={detail} />
          {run?.hibernatedAt && !run.endedAt && (
            <div className="ins-sec">
              <Label>{f.t("hibernation.title")}</Label>
              <p className="ins-small">{f.t(run.pendingRequestId ? "hibernation.waitingOnYou" : "hibernation.idle", { time: f.when.ago(run.hibernatedAt) })}</p>
            </div>
          )}
          {detail.bestOfGroup && detail.bestOfGroup.phase !== "proposed" && (!member || member.id === detail.bestOfGroup.memberId) && <BestOfCompare detail={detail} stacked />}
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
          {run && <EndDetail run={run} />}
          {run && <HandoffRecord detail={detail} run={run} />}
          <TaskTimeline detail={detail} />
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
          {run?.transcriptPath && (
            <div className="ins-sec">
              <Label>{f.t("inspector.transcript")}</Label>
              <div className="mono ins-path as-typed">{run.transcriptPath}</div>
              <span className="muted ins-small">{f.t("inspector.transcriptNote")}</span>
            </div>
          )}
          <SuggestedTasks detail={detail} />
        </>
      )}
      {tab === "suggested" && <SuggestedTasks detail={detail} inTab />}
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
      {tab === "files" && <FilesTab detail={detail} reveal={reveal} />}
      {tab === "preview" && <PreviewTab detail={detail} run={run} />}
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
        <QueueSection
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
  // The preview page belongs to the task shown here; another task or a closed panel unloads it.
  usePreviewLifecycle(target?.taskId ?? null);

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
