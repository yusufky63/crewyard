import { useRef, useState } from "react";
import { ArrowLeftRight, CircleDollarSign, CircleHelp, Gauge, Terminal, Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LimitNoticePayload, RequestAnswer, RequestPayload, RequestView, TaskDetail } from "@crewyard/core";
import { Button, Label, Panel } from "@crewyard/ui";
import { useDaemon } from "../../ipc.ts";
import { useListKeys } from "../../listKeys.ts";
import { useNav } from "../../nav.ts";
import { ProvBadge } from "../providers/shared.tsx";
import { act, useErrorText, useRecheck, useWork } from "../tasks/data.ts";
import { useFixtureState } from "../tasks/fixtureState.ts";
import { useActivity } from "../tasks/live.ts";
import { codeKey, profileNames } from "../tasks/model.ts";
import { ConfirmButton, ErrorLine, useFormat, Who } from "../tasks/parts.tsx";
import { ApprovalActions } from "./ApprovalActions.tsx";
import { InboxSplit } from "./InboxSplit.tsx";
import { ReportList, useReports } from "./Reports.tsx";
import { RiskBadge } from "./RiskBadge.tsx";
import { GoalList, useGoals, useGoalTaskLabel } from "./Goals.tsx";
import { StallList, useStalls } from "./Stalls.tsx";
import { SwitchList, useSwitches } from "./Switches.tsx";
import { defaultTarget, emptyForm, formAnswer, formReady, handoffChoices, infoNotices, orderRequests, titleKey, type QuestionForm } from "./model.ts";
import "../tasks/tasks.css";
import "./inbox.css";

type Payload<K extends RequestPayload["kind"]> = Extract<RequestPayload, { kind: K }>;

function KindIcon({ q }: { q: RequestView }) {
  const p = q.payload;
  const Icon = p.kind === "approval" ? Terminal : p.kind === "question" ? CircleHelp : p.trigger === "budget" ? Wallet : p.trigger === "unpriced" ? CircleDollarSign : p.trigger === "manual" ? ArrowLeftRight : Gauge;
  return <Icon size={16} strokeWidth={1.75} aria-hidden="true" className={q.risk === "high" ? "ib-high" : "ib-icon"} />;
}

function useTitle() {
  const { t } = useTranslation("inbox");
  const f = useFormat();
  return (q: RequestView) => {
    const p = q.payload;
    if (p.kind === "question") return p.questions[0]?.prompt ?? t("title.question");
    if (p.kind === "approval") return t(`title.${titleKey(p)}`, { command: p.command ?? "", count: p.paths.length });
    return t(`title.${titleKey(p)}`, { window: f.window(p.window), usd: p.cap ? f.usd(p.cap.capUsd) : "", model: p.unpriced?.model ?? t("detail.unknownModel") });
  };
}

/** "Role · Runner · alias · task": who asked, in one muted line. */
function useAsker(task: TaskDetail | undefined, q: RequestView): string {
  const f = useFormat();
  const title = useGoalTaskLabel(task);
  if (!task) return "";
  const run = task.runs.find((r) => r.id === q.runId);
  const who = run ? `${f.role(run.role)} · ${f.runner(run.runner)} · ${profileNames(task).get(run.profileId)?.alias ?? run.profileId}` : "";
  return [who, title].filter(Boolean).join(" · ");
}

function Item({ q, selected, onSelect }: { q: RequestView; selected: boolean; onSelect: () => void }) {
  const f = useFormat();
  const title = useTitle();
  const task = useWork("tasks.get", { taskId: q.taskId });
  const asker = useAsker(task.data, q);
  const asleep = task.data?.runs.some((r) => r.id === q.runId && r.hibernatedAt && !r.endedAt);
  return (
    <button type="button" className="ib-item" role="option" aria-selected={selected} data-list-id={q.id} onClick={onSelect}>
      <KindIcon q={q} />
      <span className="ib-text">
        <span className={`t${q.payload.kind === "approval" && q.payload.command ? " mono" : ""}`}>{title(q)}</span>
        <span className="s">
          {q.risk && <RiskBadge risk={q.risk} />}
          {asleep ? `${asker} · ${f.t("tasks:step.hibernated")}` : asker}
        </span>
      </span>
      <span className="k">{f.when.ago(q.createdAt)}</span>
    </button>
  );
}

function Approval({ q, p, task, answer }: { q: RequestView; p: Payload<"approval">; task: TaskDetail | undefined; answer: (a: RequestAnswer) => Promise<void> }) {
  const { t } = useTranslation("inbox");
  const f = useFormat();
  const run = task?.runs.find((r) => r.id === q.runId);
  const risk = q.risk ?? "medium";
  return (
    <>
      {p.command && <pre className="ib-code">{p.command}</pre>}
      <dl className="ib-kv">
        <dt>{t("detail.cwd")}</dt>
        <dd className="mono">{p.cwd ?? run?.cwd ?? "—"}</dd>
        {p.paths.length > 0 && (
          <>
            <dt>{t("detail.paths")}</dt>
            <dd className="mono">
              {p.paths.map((x) => (
                <div key={x}>{x}</div>
              ))}
            </dd>
          </>
        )}
        <dt>{t("detail.scope")}</dt>
        <dd>
          {t(`scope.${risk}`)} {p.network ? t("scope.network") : t("scope.noNetwork")}
        </dd>
        <dt>{t("detail.policy")}</dt>
        <dd>{p.policy ? t(`policy.${p.policy.replace(/\./g, "_")}`, { defaultValue: p.policy }) : t("policy.notAllowlisted")}</dd>
        {run && (
          <>
            <dt>{t("detail.requestedBy")}</dt>
            <dd>
              {f.role(run.role)} · <Who c={{ runner: run.runner, alias: profileNames(task!).get(run.profileId)?.alias ?? run.profileId, model: run.model }} />
            </dd>
          </>
        )}
      </dl>
      <ApprovalActions q={q} answer={answer} />
    </>
  );
}

function Question({ p, answer }: { p: Payload<"question">; answer: (a: RequestAnswer) => Promise<void> }) {
  const { t } = useTranslation("inbox");
  const [form, setForm] = useState<QuestionForm>(() => emptyForm(p));
  const set = (i: number, patch: Partial<QuestionForm[number]>) => setForm((f) => f.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <>
      {p.questions.map((q, i) => (
        <fieldset key={i} className="ib-question">
          <legend>{q.prompt}</legend>
          {q.options.map((o) => (
            <label key={o.label} className="ib-opt">
              <input type="radio" name={`q${i}`} checked={form[i]?.selected === o.label} onChange={() => set(i, { selected: o.label })} />
              <span>
                <span className="t">{o.label}</span>
                {o.description && <span className="s">{o.description}</span>}
              </span>
            </label>
          ))}
          {q.allowFreeText && <textarea className="ib-note-input" rows={2} value={form[i]?.text ?? ""} onChange={(e) => set(i, { text: e.target.value })} placeholder={t("detail.freeText")} aria-label={t("detail.freeText")} />}
        </fieldset>
      ))}
      <div className="ib-actions">
        <Button variant="primary" disabled={!formReady(p, form)} onClick={() => void answer(formAnswer(form))}>
          {t("action.send")}
        </Button>
        <Button variant="ghost" onClick={() => void answer({ kind: "cancel" })}>
          {t("action.dismiss")}
        </Button>
      </div>
    </>
  );
}

function Handoff({ p, answer }: { p: Payload<"handoff">; answer: (a: RequestAnswer) => Promise<void> }) {
  const { t } = useTranslation("inbox");
  const f = useFormat();
  const [target, setTarget] = useState<string | null>(() => defaultTarget(p));
  const choices = handoffChoices(p);
  const picked = p.candidates.find((c) => c.profileId === target) ?? null;
  return (
    <>
      {p.cap && (
        <dl className="ib-kv">
          <dt>{t("detail.spent")}</dt>
          <dd>
            <span className="num">{f.usd(p.cap.spentUsd)}</span> / <span className="num">{f.usd(p.cap.capUsd)}</span> <ProvBadge value="estimated" />
          </dd>
          {p.cap.reservedUsd !== undefined && (
            <>
              <dt>{t("detail.reserved")}</dt>
              <dd>
                <span className="num">{f.usd(p.cap.reservedUsd)}</span> <ProvBadge value="estimated" />
              </dd>
            </>
          )}
          {p.cap.estimateUsd !== undefined && (
            <>
              <dt>{t("detail.stepEstimate")}</dt>
              <dd>
                <span className="num">{f.usd(p.cap.estimateUsd)}</span> <ProvBadge value="estimated" />
              </dd>
            </>
          )}
          <dt>{t("detail.cap")}</dt>
          <dd>{t(`cap.${p.cap.kind}`)}</dd>
        </dl>
      )}
      {p.unpriced && (
        <dl className="ib-kv">
          <dt>{t("detail.model")}</dt>
          <dd className="mono">{p.unpriced.model ?? t("detail.unknownModel")}</dd>
          <dt>{t("detail.price")}</dt>
          <dd>
            <ProvBadge value="unknown" />
          </dd>
          <dt>{t("detail.capsOnTask")}</dt>
          <dd>{p.unpriced.caps.map((c) => t(`cap.${c}`)).join(" · ")}</dd>
        </dl>
      )}
      {p.resetsAt && <p className="sec ib-line">{t("detail.resets", { time: f.when.at(p.resetsAt) })}</p>}
      {p.detail && <p className="sec ib-line">{t(`handoffDetail.${codeKey(p.detail)}`, { defaultValue: p.detail })}</p>}
      {p.candidates.length > 0 && (
        <fieldset className="ib-question">
          <legend>{t("detail.targets")}</legend>
          {p.candidates.map((c) => (
            <label key={c.profileId} className="ib-opt">
              <input type="radio" name="target" checked={target === c.profileId} onChange={() => setTarget(c.profileId)} />
              <span>
                <span className="t">
                  <Who c={c} />
                  {p.proposedTarget?.profileId === c.profileId && <span className="badge ib-proposed">{t("detail.proposed")}</span>}
                </span>
                <span className="s">
                  {c.headroom.pct !== null ? t("detail.headroom", { pct: Math.round(c.headroom.pct), window: f.window(c.headroom.window) }) : t("detail.headroomUnknown")}
                  {" · "}
                  {c.estimate.usd === null ? t("detail.estimateUnknown") : c.estimate.usd === 0 ? t("detail.noTokenCost") : t("detail.estimate", { usd: f.usd(c.estimate.usd) })}
                  {c.reasons[0] ? ` · ${f.reason(c.reasons[0])}` : ""}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="ib-actions">
        {choices.handOff && (
          <Button variant="primary" disabled={!picked} onClick={() => picked && void answer({ kind: "handoff", decision: "hand_off", targetProfileId: picked.profileId })}>
            {picked ? t("action.handOffTo", { target: `${f.runner(picked.runner)} · ${picked.alias}` }) : t("action.pickTarget")}
          </Button>
        )}
        {/* Waiting is the safe choice and stays neutral; going on past a spend cap costs money, so it takes warn
            (DESIGN.md §3 "State colors on actions"). */}
        {choices.waitForReset && p.resetsAt && <Button onClick={() => void answer({ kind: "handoff", decision: "wait_for_reset" })}>{t("action.waitForReset", { time: f.when.at(p.resetsAt) })}</Button>}
        {choices.continuePastCap && <Button tone="warn" onClick={() => void answer({ kind: "handoff", decision: "continue" })}>{p.trigger === "unpriced" ? t("action.continueUnpriced") : t("action.continuePastCap")}</Button>}
        <ConfirmButton label={t("action.stop")} confirm={t("action.stopConfirm")} onConfirm={() => answer({ kind: "handoff", decision: "stop" })} size="md" />
      </div>
      {choices.continuePastCap && <p className="ib-note">{p.trigger === "unpriced" ? t("detail.unpricedNote") : t("detail.continueNote")}</p>}
    </>
  );
}

function Detail({ q }: { q: RequestView }) {
  const { t } = useTranslation("inbox");
  const f = useFormat();
  const title = useTitle();
  const errorText = useErrorText();
  const recheck = useRecheck();
  const { selectTask, go } = useNav();
  const task = useWork("tasks.get", { taskId: q.taskId });
  const [error, setError] = useState<string | null>(null);
  const p = q.payload;
  const run = task.data?.runs.find((r) => r.id === q.runId);
  const members = task.data?.crew?.members ?? [];
  const step = run ? members.findIndex((m) => m.id === run.memberId) + 1 : 0;
  const answer = async (a: RequestAnswer) => {
    setError(null);
    try {
      // The run and session you saw go along; if a handoff replaced them, the daemon refuses and we re-read.
      await act("requests.answer", { requestId: q.id, answer: a, runId: q.runId, sessionId: q.sessionId });
    } catch (err) {
      setError(errorText(err));
      recheck(err);
    }
  };
  return (
    <Panel className="ib-detail" aria-live="polite">
      <div className="ib-eyebrow">
        <Label>{t(`eyebrow.${p.kind}`)}</Label>
        {q.risk && <RiskBadge risk={q.risk} />}
      </div>
      <h2>{title(q)}</h2>
      {task.data && (
        <p className="sec ib-line">
          {t("detail.askedIn")}{" "}
          <button
            type="button"
            className="ib-link"
            onClick={() => {
              selectTask(q.taskId);
              go("tasks");
            }}
          >
            {task.data.title}
          </button>
          {step > 0 && ` · ${t("detail.step", { step, total: members.length, role: f.role(run!.role) })}`}
        </p>
      )}
      {run?.hibernatedAt && !run.endedAt && (
        <p className="ib-note" role="note">
          {t("detail.hibernated")}
        </p>
      )}
      {p.kind === "approval" && <Approval q={q} p={p} task={task.data} answer={answer} />}
      {p.kind === "question" && <Question key={q.id} p={p} answer={answer} />}
      {p.kind === "handoff" && <Handoff key={q.id} p={p} answer={answer} />}
      <ErrorLine>{error}</ErrorLine>
    </Panel>
  );
}

function Notice({ n, alias }: { n: LimitNoticePayload; alias: string }) {
  const { t } = useTranslation("inbox");
  const f = useFormat();
  // The task's crew names the account with its runner; outside a task the profile alias has to do.
  const task = useWork("tasks.get", { taskId: n.taskId ?? "" }, { enabled: Boolean(n.taskId) });
  const c = task.data ? profileNames(task.data).get(n.profileId) : undefined;
  const who = c ? `${f.runner(c.runner)} · ${c.alias}` : alias;
  const pct = n.usedPct === null ? "—" : Math.round(n.usedPct);
  return (
    <div className="ib-item ib-info">
      <Gauge size={16} strokeWidth={1.75} aria-hidden="true" className="ib-icon" />
      <span className="ib-text">
        <span className="t">{t(`notice.${n.kind}`, { who, window: f.window(n.window), pct, minutes: n.minutesUntilFull ?? 0 })}</span>
        <span className="s">
          {n.resetsAt ? t("detail.resets", { time: f.when.at(n.resetsAt) }) : t("notice.noReset")} · <ProvBadge value={n.provenance} />
        </span>
      </span>
      <span className="k">{f.when.ago(n.observedAt)}</span>
    </div>
  );
}

export function InboxScreen() {
  const { t } = useTranslation("inbox");
  useFixtureState();
  const { projectId, taskId } = useNav();
  const requests = useWork("requests.list", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  const tasks = useWork("tasks.list", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  const profiles = useDaemon("providers.profiles", undefined, { staleTime: 60_000 });
  const stalls = useStalls(projectId ?? "");
  const reports = useReports(projectId ?? "");
  const switches = useSwitches(projectId ?? "");
  // Goals that need you are listed below the requests (Goals.tsx) and count with them.
  const goalsNeeding = useGoals(projectId ?? "").filter((g) => g.status === "needs_you").length;
  const errorText = useErrorText();
  const notices = useActivity((s) => s.notices);
  const [picked, setPicked] = useState<string | null>(null);
  const [stallError, setStallError] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const open = orderRequests((requests.data ?? []).filter((q) => q.answeredAt === null), taskId);
  const selected = open.find((q) => q.id === picked) ?? open[0] ?? null;
  useListKeys(open.map((q) => q.id), selected?.id ?? null, setPicked);
  if (!projectId) return null;

  const info = infoNotices(notices, new Set((tasks.data ?? []).map((x) => x.id)));
  const aliasOf = (id: string) => profiles.data?.find((p) => p.id === id)?.alias ?? id;
  const stalled = stalls.data ?? [];

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <h1>{t("title.page")}</h1>
          {/* Switches are for your information too: nothing waits on you there. */}
          <div className="lbl ib-context">{stalled.length > 0 ? t("contextStalls", { open: open.length + goalsNeeding, stalls: stalled.length, info: info.length + (switches.data?.length ?? 0) }) : t("context", { open: open.length + goalsNeeding, info: info.length + (switches.data?.length ?? 0) })}</div>
        </div>
      </div>
      {requests.isError && <p className="muted">{t("errors.load")}</p>}
      <div className={selected ? "ib-grid split" : "ib-grid"} ref={grid}>
        <div className="ib-col" id="inbox-list">
          <Panel className="ib-list" role="listbox" aria-label={t("listLabel")}>
            {open.length === 0 && requests.isSuccess && <p className="ib-empty muted">{t(goalsNeeding > 0 ? "emptyGoals" : "empty")}</p>}
            {open.map((q) => (
              <Item key={q.id} q={q} selected={selected?.id === q.id} onSelect={() => setPicked(q.id)} />
            ))}
          </Panel>
          <ReportList reports={reports.data ?? []} onError={(e) => setStallError(errorText(e))} />
          <GoalList projectId={projectId} />
          <StallList alerts={stalled} onOpenRequest={setPicked} onError={(e) => setStallError(errorText(e))} />
          <SwitchList switches={switches.data ?? []} onError={(e) => setStallError(errorText(e))} />
          <ErrorLine>{stallError}</ErrorLine>
          {info.length > 0 && (
            <>
              <div className="ib-sub lbl">{t("forInfo")}</div>
              <Panel className="ib-list">
                {info.map((n) => (
                  <Notice key={`${n.profileId}|${n.window}`} n={n} alias={aliasOf(n.profileId)} />
                ))}
              </Panel>
            </>
          )}
        </div>
        {selected && <InboxSplit grid={grid} list="inbox-list" />}
        {selected && <Detail key={selected.id} q={selected} />}
      </div>
    </div>
  );
}
