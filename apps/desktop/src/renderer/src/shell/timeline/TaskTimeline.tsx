import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleHelp, Flag, Lightbulb, MessageSquare, Milestone, Play, RotateCw, ShieldQuestion, Timer, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { buildTimeline, timeIn, visibleSegments, type CrewReportType, type Lane, type LaneState, type McpTopics, type TaskDetail, type TasksTopics, type TimelineEntry, type ToolStep } from "@crewyard/core";
import { BrandIcon, Button, Label } from "@crewyard/ui";
import { call } from "../../ipc.ts";
import { formatDuration, loopLook } from "../../screens/tasks/model.ts";
import { STATUS_ICONS, useFormat } from "../../screens/tasks/parts.tsx";
import { FIXTURE, timelineFixture } from "./fixture.ts";
import "./timeline.css";

// The task's timeline (PLAN.md M5) for the inspector: a lane per run showing working, waiting and
// limited stretches to scale, then what happened in order. Tool calls fold into one entry per
// burst, the list shows the newest entries first in pages, and a cut tool output says how large
// it was and where its full text is, so a long task stays readable and a huge one stays fast.

const PAGE = 40;
/** Screenshot mode only: `timeline=open` scrolls the inspector to the timeline and opens the first burst. */
const SHOT = FIXTURE ? new URLSearchParams(location.search).get("timeline") : null;
const STEP_PAGE = 50;
const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;
const STATES: LaneState[] = ["work", "input", "approval", "limited", "paused", "handoff"];

function useTimeline(detail: TaskDetail) {
  const qc = useQueryClient();
  const taskId = detail.id;
  useEffect(() => {
    if (FIXTURE) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Runs stream many events a second; re-read the timeline at most once a second.
    const later = () =>
      (timer ??= setTimeout(() => {
        timer = null;
        void qc.invalidateQueries({ queryKey: ["usage.timeline", { taskId }] });
      }, 1000));
    const off = window.crewyard.on("runs.event", (p) => {
      if ((p as TasksTopics["runs.event"]).taskId === taskId) later();
    });
    // A report from the agent is not a run event; it has its own topic (docs/adr/0007).
    const offReports = window.crewyard.on("mcp.reports.changed", (p) => {
      if ((p as McpTopics["mcp.reports.changed"]).taskId === taskId) later();
    });
    return () => {
      off();
      offReports();
      if (timer) clearTimeout(timer);
    };
  }, [qc, taskId]);
  return useQuery({ queryKey: ["usage.timeline", { taskId }], queryFn: () => (FIXTURE ? Promise.resolve(timelineFixture(detail)) : call("usage.timeline", { taskId })) });
}

function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const bytes = (n: number, locale: string) => {
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: u === 0 ? 0 : 1 }).format(v)} ${units[u]}`;
};

function LaneRow({ lane, tl, who }: { lane: Lane; tl: { start: number; end: number }; who: string }) {
  const { t } = useTranslation("timeline");
  const spent = timeIn(lane);
  const sentence = STATES.filter((s) => spent[s]).map((s) => t("lane.part", { state: t(`state.${s}`), time: formatDuration(spent[s]!) }));
  return (
    <li className="tl-lane">
      <span className="tl-who" title={who}>
        <BrandIcon id={lane.run.runner} size={14} />
        <span className="tl-ellipsis">{who}</span>
      </span>
      <div className="tl-track" role="img" aria-label={t("lane.aria", { who, parts: sentence.join(", "), open: lane.open ? t("lane.open") : "" })}>
        {visibleSegments(lane, tl).map((s, i) => (
          <span key={i} className={`tl-seg tl-${s.state}`} style={{ left: `${s.left}%`, width: `${s.width}%`, "--c": `var(--series-${seriesOf(lane.run.runner)})` } as CSSProperties} />
        ))}
      </div>
    </li>
  );
}

const seriesOf = (runner: string) => (runner === "claude-code" ? "claude" : runner === "codex" ? "codex" : runner === "gemini-cli" ? "gemini" : runner === "opencode" ? "opencode" : "other");

function StepRow({ step, locale }: { step: ToolStep; locale: string }) {
  const { t } = useTranslation("timeline");
  const [open, setOpen] = useState(false);
  const took = step.end === null ? null : step.end - step.start;
  const hasOutput = Boolean(step.preview) || step.truncatedBytes !== null;
  return (
    <li className={`tl-step${step.status === "failed" ? " failed" : ""}`}>
      <div className="tl-step-row">
        <span className="tl-kind">{t(`tool.${step.toolKind}`, { defaultValue: step.toolKind })}</span>
        <span className="tl-ellipsis as-typed" title={step.title}>
          {step.title}
        </span>
        <span className="num muted">{took === null ? t("step.running") : formatDuration(took)}</span>
      </div>
      {step.truncatedBytes !== null && (
        <div className="tl-cut">
          <span className="tl-chip">{step.binary ? t("step.binary", { size: bytes(step.truncatedBytes, locale) }) : t("step.truncated", { size: bytes(step.truncatedBytes, locale) })}</span>
          {step.keptAt ? (
            <button type="button" className="tl-link" onClick={() => window.crewyard.revealPath(step.keptAt!)} title={step.keptAt}>
              {t("step.showFull")}
            </button>
          ) : (
            !step.binary && <span className="muted">{t("step.headOnly")}</span>
          )}
        </div>
      )}
      {step.preview && (
        <>
          <button type="button" className="tl-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? t("step.hideOutput") : t("step.showOutput")}
          </button>
          {open && (
            <pre className="tl-out" tabIndex={0} aria-label={t("step.outputOf", { title: step.title })}>
              {step.preview}
              {step.truncatedBytes !== null && `\n… ${t("step.truncated", { size: bytes(step.truncatedBytes, locale) })}`}
            </pre>
          )}
        </>
      )}
      {!hasOutput && step.status === "failed" && <span className="tl-failed">{t("step.failed")}</span>}
    </li>
  );
}

function ToolsEntry({ entry, locale, first }: { entry: Extract<TimelineEntry, { kind: "tools" }>; locale: string; first: boolean }) {
  const { t } = useTranslation("timeline");
  const [open, setOpen] = useState(SHOT === "open" && first);
  const [shown, setShown] = useState(STEP_PAGE);
  const cut = entry.steps.filter((s) => s.truncatedBytes !== null).length;
  const kinds = entry.counts.map(([k, n]) => `${t(`tool.${k}`, { defaultValue: k })} ${n}`).join(" · ");
  return (
    <>
      <button type="button" className="tl-expand" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}
        <span>
          {t("entry.tools", { count: entry.steps.length })}
          <span className="muted tl-kinds"> · {kinds}</span>
          {cut > 0 && (
            <>
              <br />
              <span className="tl-chip tl-chip-inline">{t("entry.cut", { count: cut })}</span>
            </>
          )}
        </span>
      </button>
      {open && (
        <ol className="tl-steps">
          {entry.steps.slice(0, shown).map((s) => (
            <StepRow key={s.toolCallId} step={s} locale={locale} />
          ))}
          {entry.steps.length > shown && (
            <li>
              <Button size="sm" variant="ghost" onClick={() => setShown((n) => n + STEP_PAGE)}>
                {t("more", { count: Math.min(STEP_PAGE, entry.steps.length - shown) })}
              </Button>
            </li>
          )}
        </ol>
      )}
    </>
  );
}

const ENTRY_ICON: Record<TimelineEntry["kind"], typeof Play> = {
  started: Play,
  tools: Wrench,
  wait: Timer,
  request: ShieldQuestion,
  handoff: ArrowLeftRight,
  message: MessageSquare,
  retry: RotateCw,
  // Drawn with the decision's own status icon instead (loopLook).
  loop: RotateCw,
  // Drawn with the report's own icon instead (REPORT_ICON).
  report: Milestone,
  ended: Flag,
};

export const REPORT_ICON: Record<CrewReportType, typeof Play> = { checkpoint: Milestone, needs_input: CircleHelp, stuck: CircleAlert, done: CircleCheck, followup: Lightbulb };

/**
 * What the agent said through the report tool. Its words are untrusted: React renders them as
 * text, and the "from the agent" line keeps them apart from what Crewyard says.
 */
function ReportText({ e, who }: { e: Extract<TimelineEntry, { kind: "report" }>; who: string }) {
  const { t } = useTranslation("timeline");
  return (
    <span className="tl-report">
      <span>{t(`entry.report.${e.report}`, { who })}</span>
      {e.title && <span className="tl-report-title">{e.title}</span>}
      {e.text && (
        <span className="tl-quote" aria-label={t("entry.fromAgent")}>
          {e.text}
        </span>
      )}
    </span>
  );
}

/** One loop decision as a sentence: what the tests or the reviewer said, and what the loop did next. */
function LoopText({ e, role }: { e: Extract<TimelineEntry, { kind: "loop" }>; role: string }) {
  const { t } = useTranslation("timeline");
  const f = useFormat();
  const p = e.reason.params ?? {};
  const sha = typeof p.sha === "string" ? p.sha.slice(0, 7) : "";
  const text = t(`loop.${e.decision}`, {
    reason: f.reason(e.reason),
    role,
    iteration: e.iteration,
    max: e.max,
    sha,
    command: typeof p.command === "string" ? p.command : "",
    runner: typeof p.runner === "string" ? f.runner(p.runner) : "",
    cap: typeof p.cap === "string" ? f.t(`capKind.${p.cap}`, { defaultValue: p.cap }) : "",
    context: (e.decision === "review_passed" || e.decision === "review_changes") && !sha ? "nosha" : undefined,
  });
  return <span>{text}</span>;
}

function EntryText({ e, who, roleOf, now, locale, first }: { e: TimelineEntry; who: (runId: string | null) => string; roleOf: (memberId: string | null, runId: string | null) => string; now: number; locale: string; first: boolean }) {
  const { t } = useTranslation("timeline");
  switch (e.kind) {
    case "started":
      return <span>{t("entry.started", { who: who(e.runId) })}</span>;
    case "tools":
      return <ToolsEntry entry={e} locale={locale} first={first} />;
    case "wait":
      return <span>{t(`entry.wait.${e.state}`, { who: who(e.runId) })}</span>;
    case "request":
      return (
        <span>
          {t(`entry.request.${e.request}`, { who: who(e.runId) })}
          <span className="muted"> · {e.answeredAt === null ? t("entry.waiting", { time: formatDuration(now - e.at) }) : t("entry.answered", { time: formatDuration(e.answeredAt - e.at) })}</span>
        </span>
      );
    case "handoff":
      return <span>{t(`entry.handoff.${e.phase}`, { who: who(e.runId), trigger: e.trigger ? t(`trigger.${e.trigger}`, { defaultValue: e.trigger }) : "" })}</span>;
    case "message":
      return <span>{e.queued ? t("entry.messageQueued") : t("entry.message")}</span>;
    case "retry":
      return <span>{t("entry.retry", { who: who(e.runId) })}</span>;
    case "loop":
      return <LoopText e={e} role={roleOf(e.memberId, e.runId)} />;
    case "report":
      return <ReportText e={e} who={who(e.runId)} />;
    case "ended":
      return <span>{t("entry.ended", { who: who(e.runId), reason: t(`reason.${e.reason ?? "completed"}`, { defaultValue: e.reason ?? "" }) })}</span>;
  }
}

const durationOf = (e: TimelineEntry, now: number): number | null =>
  e.kind === "tools" || e.kind === "wait" ? e.end - e.at : e.kind === "request" ? (e.answeredAt ?? now) - e.at : null;

/** Mounted once in the inspector's Details tab. */
export function TaskTimeline({ detail }: { detail: TaskDetail }) {
  const { t, i18n } = useTranslation("timeline");
  const q = useTimeline(detail);
  const live = detail.runs.some((r) => !r.endedAt);
  const now = useClock(live);
  const [shown, setShown] = useState(PAGE);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (SHOT) ref.current?.scrollIntoView({ block: "start" });
  }, []);
  const runs = useMemo(() => detail.runs.map((r) => ({ id: r.id, memberId: r.memberId, role: r.role, runner: r.runner, profileId: r.profileId, startedAt: r.startedAt, endedAt: r.endedAt, endReason: r.endReason })), [detail.runs]);
  const tl = useMemo(() => buildTimeline(runs, q.data?.events ?? [], now), [runs, q.data, now]);
  if (detail.runs.length === 0) return null;
  const role = (r: string) => t(`tasks:role.${r}`, { defaultValue: r });
  const runner = (r: string) => t(`providers:runner.${r}`, { defaultValue: r });
  const whoOf = (runId: string | null) => {
    const r = detail.runs.find((x) => x.id === runId);
    return r ? `${role(r.role)} · ${runner(r.runner)}` : t("task");
  };
  // The step a loop decision is about: the implementer, also when the reviewer's run reported it.
  const roleOf = (memberId: string | null, runId: string | null) => {
    const m = detail.crew?.members.find((x) => x.id === memberId);
    const r = m ? null : detail.runs.find((x) => x.id === runId);
    return role(m?.role ?? r?.role ?? "implementer");
  };
  const clock = new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" });
  const present = STATES.filter((s) => tl.lanes.some((l) => l.segments.some((x) => x.state === s)));
  // Newest first, in pages, so a task with thousands of steps renders a screenful.
  const entries = [...tl.entries].reverse();
  const visible = entries.slice(0, shown);

  return (
    <section ref={ref} className="ins-sec tl" aria-label={t("title")}>
      <div className="tl-head">
        <Label>{t("title")}</Label>
        <span className="num muted">{t("span", { time: formatDuration(tl.end - tl.start) })}</span>
      </div>
      <ol className="tl-lanes">
        {tl.lanes.map((l) => (
          <LaneRow key={l.run.id} lane={l} tl={tl} who={whoOf(l.run.id)} />
        ))}
      </ol>
      <div className="tl-axis num muted" aria-hidden="true">
        <span>{clock.format(tl.start)}</span>
        <span>{live ? t("now") : clock.format(tl.end)}</span>
      </div>
      {present.length > 0 && (
        <ul className="tl-legend" aria-label={t("legend")}>
          {present.map((s) => (
            <li key={s}>
              <span className={`tl-key tl-${s}`} style={{ "--c": `var(--series-${seriesOf(tl.lanes[0]?.run.runner ?? "")})` } as CSSProperties} aria-hidden="true" />
              {t(`state.${s}`)}
            </li>
          ))}
        </ul>
      )}
      {q.isError && <p className="pv-error tl-small">{t("loadFailed")}</p>}
      {q.data && q.data.omitted > 0 && <p className="muted tl-small">{t("omitted", { count: q.data.omitted })}</p>}
      <ol className="tl-entries">
        {visible.map((e, i) => {
          const look = e.kind === "loop" ? loopLook(e.decision) : null;
          const Icon = look ? STATUS_ICONS[look.icon] : e.kind === "request" && e.request === "question" ? CircleHelp : e.kind === "report" ? REPORT_ICON[e.report] : ENTRY_ICON[e.kind];
          const d = durationOf(e, now);
          return (
            <li key={`${e.kind}-${e.at}-${i}`} className={`tl-entry tl-e-${e.kind}${e.kind === "wait" ? ` tl-w-${e.state}` : ""}${e.kind === "report" ? ` tl-r-${e.report}` : ""}${look ? ` tl-l-${look.tone}` : ""}`}>
              <time className="num muted" dateTime={new Date(e.at).toISOString()}>
                {clock.format(e.at)}
              </time>
              <Icon {...ICON} />
              <div className="tl-text">
                <EntryText e={e} who={whoOf} roleOf={roleOf} now={now} locale={i18n.language} first={visible.findIndex((x) => x.kind === "tools") === i} />
              </div>
              <span className="num muted tl-dur">{d === null ? "" : formatDuration(Math.max(0, d))}</span>
            </li>
          );
        })}
      </ol>
      {entries.length > shown && (
        <Button size="sm" variant="ghost" className="tl-more" onClick={() => setShown((n) => n + PAGE)}>
          {t("earlier", { count: Math.min(PAGE, entries.length - shown) })}
        </Button>
      )}
    </section>
  );
}
