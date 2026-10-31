import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleHelp, CircleX, FileText, GitBranch, GitMerge, ListChecks, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GOAL_LIMITS, GOAL_TASK_KINDS, GOAL_TASK_MODES, type ActivityEvent, type GoalDecisionAction, type GoalDecisionView, type GoalDetail, type GoalStopPreview, type GoalTaskView, type RequestView, type TaskKind, type TaskMode } from "@crewyard/core";
import { Button, Label, Panel } from "@crewyard/ui";
import { useInspector } from "../../inspector.ts";
import { useListKeys } from "../../listKeys.ts";
import { useNav } from "../../nav.ts";
import { titleKey } from "../inbox/model.ts";
import { RiskBadge } from "../inbox/RiskBadge.tsx";
import { ProvBadge } from "../providers/shared.tsx";
import { act, useErrorText, useWork } from "./data.ts";
import { GoalSpend, GoalStatusLabel, GoalTaskLabel, useGoalFormat, useGoalsChanged } from "./GoalRow.tsx";
import { codeKey, currentRun, formatDuration, GOAL_FEED_PAGE, goalNeeds, goalNumber, goalStatusLine, goalTaskLine, haltKey, planCost, utf8Bytes, type GoalNeed } from "./model.ts";
import { ErrorLine, useFormat, useNow } from "./parts.tsx";

// The goal view (docs/adr/0019, design §3.3): the goal bar with its status, spend against the goal
// budget, elapsed time and goal branch; what needs you, first; then the goal's tasks with why each
// one waits. Every action is one daemon call that the daemon checks again (§5.3). Goal, plan,
// report and agent text is untrusted: React renders it as plain text, capped here for the row.

/** Untrusted text shown in a row (findings, a provider's message): one line's worth, never markup. */
export const ROW_TEXT_MAX = 600;
export const capRow = (s: string) => (s.length > ROW_TEXT_MAX ? `${s.slice(0, ROW_TEXT_MAX - 1)}…` : s);

/** Goal refusals arrive as `goal.*` codes and read from the goals namespace; anything else as Tasks reads it. */
export function useGoalErrorText(): (err: unknown) => string {
  const { t } = useTranslation("goals");
  const fallback = useErrorText();
  return (err) => {
    const code = (err instanceof Error ? err.message : String(err)).replace(/^.*Error: /, "").trim();
    return code.startsWith("goal.") ? t(`errors.${codeKey(code)}`, { defaultValue: fallback(err) }) : fallback(err);
  };
}

type Apply = (fn: () => Promise<unknown>) => Promise<void>;

/** Runs a goal call; a GoalDetail answer replaces the cached goal at once, before `goals.changed` arrives. */
export function useGoalApply(goalId: string, onError: (message: string | null) => void): Apply {
  const qc = useQueryClient();
  const errorText = useGoalErrorText();
  return async (fn) => {
    onError(null);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "revisions" in r && (r as GoalDetail).id === goalId) qc.setQueryData(["goals.get", { goalId }], r);
    } catch (err) {
      onError(errorText(err));
    }
  };
}

/** A planning run's cost as a button says it, or why no planning run can start. */
export interface ReplanCost {
  /** "~$0.31 Estimated, up to $0.93", "cost unknown" or "no API cost"; null until it is known. */
  label: string | null;
  /** Set when no profile can plan here (or Orchestra is off): the button stays disabled with this beside it. */
  blocked: string | null;
}

/**
 * The cost a planning run would have, read from goals.preview (which writes nothing), with the
 * planning run's ceiling. A Replan button without its cost stays disabled: every model call starts
 * from a click that showed it (design §1.3).
 */
export function useReplanCost(goal: Pick<GoalDetail, "projectId" | "text">, enabled: boolean): ReplanCost {
  const g = useGoalFormat();
  const preview = useWork("goals.preview", { projectId: goal.projectId, text: goal.text }, { enabled, staleTime: 60_000 });
  const p = preview.data;
  // Screenshot fixtures answer unknown methods with a task; only a preview has `canPlan`.
  if (!enabled || !p || typeof p.canPlan !== "boolean") return { label: null, blocked: null };
  if (!p.canPlan) return { label: null, blocked: g.t(`errors.${codeKey(p.reason?.code ?? "goal.no_planner")}`, { defaultValue: g.t("errors.goal_no_planner") }) };
  const c = planCost(p.estimate, p.ceilingUsd);
  return { label: g.t(`replan.${c.key}`, { usd: c.usd === null ? "" : g.f.usd(c.usd), ceiling: c.ceiling === null ? "" : g.f.usd(c.ceiling) }), blocked: null };
}

/** "02 Server: passkey registration", or the last review, for decision and need lines. */
function useTaskName(goal: Pick<GoalDetail, "tasks" | "integration">) {
  const { t } = useTranslation("goals");
  return (taskId: string | null | undefined): string => {
    if (!taskId) return "";
    const x = goal.tasks.find((y) => y.taskId === taskId);
    if (x) return `${goalNumber(x.number)} ${x.title}`;
    if (goal.integration?.taskId === taskId) return t("view.integration");
    return taskId;
  };
}

const DECISION_TONE: Partial<Record<GoalDecisionAction, "ok" | "warn">> = {
  retry: "ok",
  resume: "ok",
  accept_report: "ok",
  leave_out: "warn",
  run_without: "warn",
  cancel_dependents: "warn",
};

/** What a goal decision says, as plain text: a title and up to two lines of facts. */
function useDecisionText(goal: Pick<GoalDetail, "tasks" | "integration" | "stuck">) {
  const { t } = useTranslation("goals");
  const name = useTaskName(goal);
  const number = (id: string) => {
    const x = goal.tasks.find((y) => y.taskId === id);
    return x ? goalNumber(x.number) : id;
  };
  return (d: GoalDecisionView): { title: string; lines: string[] } => {
    const p = d.payload;
    const lines: string[] = [];
    const detail = () => p.detail && lines.push(t("decision.detail", { detail: capRow(p.detail) }));
    switch (d.kind) {
      case "conflict":
        if (p.paths?.length) lines.push(t("decision.conflictPaths", { paths: capRow(p.paths.join(", ")) }));
        detail();
        return { title: t("decision.conflict", { task: name(d.taskId) }), lines };
      case "prerequisite":
        if (p.waiting?.length) lines.push(t("decision.waiting", { tasks: p.waiting.map(number).join(", ") }));
        detail();
        return { title: t("decision.prerequisite", { task: name(d.taskId) }), lines };
      case "stop_rule":
        detail();
        return { title: t(p.rule === "failed_tasks" ? "decision.stop_rule_failed" : "decision.stop_rule_same"), lines };
      case "stuck": {
        const s = goal.stuck;
        detail();
        return { title: s ? t("decision.stuck", { task: number(s.taskId), waitsFor: number(s.waitsFor), why: t(`why.${s.why}`) }) : t("decision.stuckPlain"), lines };
      }
      case "changes":
        if (p.findings) lines.push(capRow(p.findings));
        return { title: t("decision.changes"), lines };
      case "report":
        return { title: t("decision.report", { task: name(d.taskId) }), lines };
      case "profile_gone":
        return { title: t("decision.profile_gone", { profile: p.profileId ?? "—" }), lines };
    }
  };
}

const DECISION_ICON = { conflict: GitMerge, prerequisite: CircleX, stop_rule: CircleAlert, stuck: CircleAlert, changes: ListChecks, report: FileText, profile_gone: CircleAlert } as const;

/** A Replan button: its planning cost on the button, disabled until that cost is known. */
function ReplanButton({ cost, locked, onClick, label }: { cost: ReplanCost; locked: boolean; onClick: (e: MouseEvent<HTMLElement>) => void; label?: string }) {
  const { t } = useTranslation("goals");
  return (
    <>
      <Button size="sm" disabled={locked || cost.label === null} onClick={onClick}>
        {cost.label ? t("replan.go", { cost: cost.label }) : (label ?? t("answer.replan"))}
      </Button>
      {cost.blocked && <span className="muted tk-small">{cost.blocked}</span>}
    </>
  );
}

/**
 * One goal decision with its answers (GOAL_DECISION_ACTIONS, suggested first). The Inbox's goal
 * list shows the same row with the same buttons. Replan states its planning cost on the button,
 * and Stop goal names what it cancels and the spend so far before it asks.
 */
export function GoalDecisionRow({ goal, decision, apply, replanCost, locked = false }: { goal: GoalDetail; decision: GoalDecisionView; apply: Apply; replanCost: ReplanCost; locked?: boolean }) {
  const { t } = useTranslation("goals");
  const text = useDecisionText(goal)(decision);
  const { selectTask } = useNav();
  const inspect = useInspector((s) => s.open);
  const [stopping, setStopping] = useState(false);
  const stopButton = useRef<HTMLElement | null>(null);
  const Icon = DECISION_ICON[decision.kind];
  const answer = (action: GoalDecisionAction) => apply(() => act("goals.decide", { goalId: goal.id, decisionId: decision.id, action }));
  const closeStop = () => {
    setStopping(false);
    stopButton.current?.focus();
  };
  return (
    <div className="gv-need">
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="gv-need-icon st-wait" />
      <span className="gv-need-text">
        <span className="t">{text.title}</span>
        {text.lines.map((l, i) => (
          <span key={i} className="s as-typed">
            {l}
          </span>
        ))}
        <span className="gv-acts">
          {decision.actions.map((a) =>
            a === "stop" ? (
              <Button
                key={a}
                size="sm"
                variant="danger"
                aria-expanded={stopping}
                disabled={locked}
                onClick={(e) => {
                  stopButton.current = e.currentTarget;
                  setStopping((v) => !v);
                }}
              >
                {t("action.stop")}
              </Button>
            ) : a === "replan" ? (
              <ReplanButton key={a} cost={replanCost} locked={locked} onClick={() => void answer(a)} />
            ) : (
              <Button key={a} size="sm" tone={DECISION_TONE[a]} disabled={locked} onClick={() => void answer(a)}>
                {t(`answer.${a}`)}
              </Button>
            ),
          )}
          {decision.taskId && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                selectTask(decision.taskId);
                inspect({ taskId: decision.taskId! });
              }}
            >
              {t(decision.kind === "report" ? "action.openReport" : "action.openTask")}
            </Button>
          )}
        </span>
        {stopping && <StopConfirm goal={goal} onConfirm={() => answer("stop")} onDone={closeStop} />}
      </span>
    </div>
  );
}

/** An Inbox request of a goal task, named the way the Inbox names it, with `Open in Inbox`. */
function RequestNeed({ q, name }: { q: RequestView; name: string }) {
  const { t } = useTranslation("goals");
  const f = useFormat();
  const ti = useTranslation("inbox").t;
  const { selectTask, go } = useNav();
  const p = q.payload;
  const title =
    p.kind === "question"
      ? (p.questions[0]?.prompt ?? ti("title.question"))
      : p.kind === "approval"
        ? ti(`title.${titleKey(p)}`, { command: p.command ?? "", count: p.paths.length })
        : ti(`title.${titleKey(p)}`, { window: f.window(p.window), usd: p.cap ? f.usd(p.cap.capUsd) : "", model: p.unpriced?.model ?? ti("detail.unknownModel") });
  const Icon = p.kind === "approval" ? Terminal : CircleHelp;
  return (
    <div className="gv-need">
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="gv-need-icon st-wait" />
      <span className="gv-need-text">
        <span className="t">
          <span className="num">{name}</span> · <span className={p.kind === "approval" && p.command ? "mono" : undefined}>{capRow(title)}</span>
          {q.risk && (
            <>
              {" "}
              <RiskBadge risk={q.risk} />
            </>
          )}
        </span>
        <span className="gv-acts">
          <Button
            size="sm"
            onClick={() => {
              selectTask(q.taskId);
              go("inbox");
            }}
          >
            {t("action.openInbox")}
          </Button>
        </span>
      </span>
    </div>
  );
}

/** Opens one of the goal view's forms (Replan, Stop goal…, Add task) from a Needs you line. */
type OpenSlot = (slot: "replan" | "stop" | "add", e: MouseEvent<HTMLElement>) => void;

/**
 * A Needs you line with no open decision behind it (halted after its decision was answered, stuck,
 * nothing left): what can be done without one (design §3.8). Replan opens its form, which states
 * the planning cost; Stop goal… shows what it cancels first.
 */
function FallbackActions({ goal, locked, onSlot, add = false }: { goal: GoalDetail; locked: boolean; onSlot?: OpenSlot; add?: boolean }) {
  const { t } = useTranslation("goals");
  if (!onSlot) return null;
  return (
    <>
      {add && (
        <Button size="sm" disabled={locked} onClick={(e) => onSlot("add", e)}>
          {t("action.addTask")}
        </Button>
      )}
      {goal.replansLeft > 0 && (
        <Button size="sm" disabled={locked} onClick={(e) => onSlot("replan", e)}>
          {t("action.replan", { count: goal.replansLeft })}
        </Button>
      )}
      <Button size="sm" variant="danger" disabled={locked} onClick={(e) => onSlot("stop", e)}>
        {t("action.stop")}
      </Button>
    </>
  );
}

function NeedRow({ need, goal, apply, replanCost, locked, onReviewPlan, onSlot }: { need: GoalNeed; goal: GoalDetail; apply: Apply; replanCost: ReplanCost; locked: boolean; onReviewPlan?: () => void; onSlot?: OpenSlot }) {
  const { t } = useTranslation("goals");
  const name = useTaskName(goal);
  const { selectTask } = useNav();
  const inspect = useInspector((s) => s.open);
  const open = (taskId: string) => {
    selectTask(taskId);
    inspect({ taskId });
  };
  const plain = (Icon: typeof CircleAlert, title: string, extra: string | null, actions: ReactNode) => (
    <div className="gv-need">
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="gv-need-icon st-wait" />
      <span className="gv-need-text">
        <span className="t">{title}</span>
        {extra && <span className="s as-typed">{capRow(extra)}</span>}
        {actions && <span className="gv-acts">{actions}</span>}
      </span>
    </div>
  );
  switch (need.kind) {
    case "decision":
      return <GoalDecisionRow goal={goal} decision={need.decision} apply={apply} replanCost={replanCost} locked={locked} />;
    case "request":
      return <RequestNeed q={need.request} name={name(need.request.taskId)} />;
    case "plan":
      return plain(
        need.state === "ready" ? ListChecks : CircleAlert,
        t(need.state === "ready" ? "view.planReady" : "view.planFailed"),
        need.error,
        onReviewPlan ? (
          <Button size="sm" onClick={onReviewPlan}>
            {t("action.reviewPlan")}
          </Button>
        ) : null,
      );
    case "report": {
      const x = goal.tasks.find((y) => y.taskId === need.taskId);
      return plain(
        FileText,
        t("view.reportWaits", { number: x ? goalNumber(x.number) : "", title: x?.title ?? need.taskId }),
        null,
        <>
          <Button size="sm" tone="ok" disabled={locked} onClick={() => void apply(() => act("goals.acceptReport", { goalId: goal.id, taskId: need.taskId }))}>
            {t("action.acceptReport")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => open(need.taskId)}>
            {t("action.openReport")}
          </Button>
        </>,
      );
    }
    case "failed": {
      const x = goal.tasks.find((y) => y.taskId === need.taskId);
      return plain(
        CircleX,
        t("view.taskFailed", { number: x ? goalNumber(x.number) : "", title: x?.title ?? need.taskId }),
        null,
        <Button size="sm" onClick={() => open(need.taskId)}>
          {t("action.openTask")}
        </Button>,
      );
    }
    case "halted":
      return plain(CircleAlert, t("view.halted", { reason: t(`halt.${haltKey(need.reason)}`) }), null, <FallbackActions goal={goal} locked={locked} onSlot={onSlot} />);
    case "stuck": {
      const s = goal.stuck;
      const num = (id: string) => {
        const x = goal.tasks.find((y) => y.taskId === id);
        return x ? goalNumber(x.number) : id;
      };
      return plain(
        CircleAlert,
        s ? t("decision.stuck", { task: num(s.taskId), waitsFor: num(s.waitsFor), why: t(`why.${s.why}`) }) : t("decision.stuckPlain"),
        null,
        <>
          {s && (
            <Button size="sm" onClick={() => open(s.waitsFor)}>
              {t("action.openBlocking", { number: num(s.waitsFor) })}
            </Button>
          )}
          <FallbackActions goal={goal} locked={locked} onSlot={onSlot} />
        </>,
      );
    }
    case "empty":
      return plain(CircleAlert, t("view.empty"), null, <FallbackActions goal={goal} locked={locked} onSlot={onSlot} add />);
  }
}

/** One task of the goal: number, title, Solo or Crew, why it waits or what it does, and its spend. */
function TaskLine({ task, goal, requests, selected, feedsWriter }: { task: GoalTaskView; goal: GoalDetail; requests: RequestView[]; selected: boolean; feedsWriter: boolean }) {
  const g = useGoalFormat();
  const { selectTask } = useNav();
  const inspect = useInspector((s) => s.open);
  const pending = requests.find((q) => q.taskId === task.taskId && q.answeredAt === null)?.kind ?? null;
  const line = goalTaskLine(task, { pending, feedsWriter, paused: goal.paused });
  // The current step only while a run is under way; the read is shared with the task's own row.
  const active = task.released && (task.status === "running" || task.status === "needs_input" || task.status === "limited" || task.status === "handing_off");
  const detail = useWork("tasks.get", { taskId: task.taskId }, { enabled: active });
  const run = active && detail.data ? currentRun(detail.data) : null;
  const spent = g.usd(task.spend);
  const hasSpend = task.released && task.spend.usd !== null && task.spend.usd > 0;
  return (
    <button
      type="button"
      className="gv-task"
      data-list-id={task.taskId}
      aria-current={selected ? "true" : undefined}
      onClick={() => {
        selectTask(task.taskId);
        inspect({ taskId: task.taskId });
      }}
    >
      <span className="gv-num mono">{goalNumber(task.number)}</span>
      <span className="gv-task-title">{task.title}</span>
      <span className="badge gv-mode">{g.mode(task.mode, task.crewSteps)}</span>
      <span className="gv-task-state">
        <GoalTaskLabel line={line} />
        {run && run.endedAt === null && <span className="muted tk-small">{g.t("task.step", { role: g.f.role(run.role) })}</span>}
      </span>
      <span className="gv-task-spend">
        {hasSpend || (task.released && spent === null) ? (
          <>
            {spent !== null && <span className="num">{spent}</span>}
            <ProvBadge value={spent === null ? "unknown" : task.spend.provenance} />
          </>
        ) : (
          <span className="muted">{g.t("task.noSpend")}</span>
        )}
      </span>
    </button>
  );
}

/** The last review of all changes, pinned to the goal branch head (design §4.12). */
function IntegrationLine({ goal }: { goal: GoalDetail }) {
  const g = useGoalFormat();
  const { selectTask } = useNav();
  const inspect = useInspector((s) => s.open);
  const i = goal.integration;
  const started = i !== null && i.status !== "proposed" && i.status !== "queued";
  // Once the last review runs it spends; GoalDetail carries only its estimate, so its spend is read
  // from the task, as its own row would.
  const detail = useWork("tasks.get", { taskId: i?.taskId ?? "" }, { enabled: started });
  if (!i) return null;
  const spend = started && detail.data && detail.data.spend ? detail.data.spend : null;
  const line = i.reviewPassed
    ? { key: "integrationPassed", tone: "st-ok" }
    : i.status === "failed"
      ? { key: "failed", tone: "st-bad" }
      : i.status === "running" || i.status === "needs_input" || i.status === "handing_off"
        ? { key: "running", tone: "st-run" }
        : { key: "integrationWaits", tone: "muted" };
  const text = line.key.startsWith("integration") ? g.t(`view.${line.key}`) : g.t(`task.${line.key}`);
  return (
    <button
      type="button"
      className="gv-task gv-integration"
      data-list-id={i.taskId}
      onClick={() => {
        selectTask(i.taskId);
        inspect({ taskId: i.taskId });
      }}
    >
      <span className="gv-num" />
      <span className="gv-task-title">{g.t("view.integration")}</span>
      <span />
      <span className={`gv-task-state st ${line.tone}`}>{text}</span>
      <span className="gv-task-spend">
        {started ? (
          <>
            {spend && spend.usd !== null && <span className="num">{g.f.usd(spend.usd)}</span>}
            <ProvBadge value={spend && spend.usd !== null ? spend.provenance : "unknown"} />
          </>
        ) : i.estimate.usd !== null ? (
          <>
            <span className="num">{g.f.usd(i.estimate.usd)}</span>
            <ProvBadge value={i.estimate.provenance} />
          </>
        ) : (
          <ProvBadge value="unknown" />
        )}
      </span>
    </button>
  );
}

/** `Add task`: a task you write, joined to the goal as a one-task revision with no planner call (§4.10). */
export function AddTaskForm({ goal, apply, onDone, initialTitle = "" }: { goal: GoalDetail; apply: Apply; onDone: () => void; initialTitle?: string }) {
  const g = useGoalFormat();
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<TaskKind>("code");
  const [mode, setMode] = useState<TaskMode>("crew");
  const [waits, setWaits] = useState<string[]>([]);
  const candidates = goal.tasks.filter((x) => x.accepted === true && !x.discarded && x.status !== "cancelled");
  // The cap counts UTF-8 bytes; the field's maxLength counts characters, so a Turkish title can
  // fit the field and still be too long. The reason is said beside the field, never a bare disabled button.
  const tooLong = utf8Bytes(title.trim()) > GOAL_LIMITS.titleBytes;
  const ready = title.trim().length > 0 && !tooLong;
  return (
    <form
      className="gv-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        void apply(() => act("goals.addTask", { goalId: goal.id, draft: { title: title.trim(), kind, mode, description: description.trim() || undefined }, dependsOn: waits })).then(onDone);
      }}
      onKeyDown={(e) => e.key === "Escape" && onDone()}
    >
      <Label>{g.t("add.title")}</Label>
      <label className="gv-field">
        <span className="lbl">{g.t("add.taskTitle")}</span>
        <input value={title} maxLength={GOAL_LIMITS.titleBytes} aria-invalid={tooLong || undefined} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </label>
      {tooLong && <p className="tk-small st-bad">{g.t("add.titleTooLong", { max: GOAL_LIMITS.titleBytes })}</p>}
      <label className="gv-field">
        <span className="lbl">{g.t("add.description")}</span>
        <textarea rows={3} value={description} maxLength={GOAL_LIMITS.descriptionBytes} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="gv-form-row">
        <label className="gv-field">
          <span className="lbl">{g.t("add.kind")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
            {GOAL_TASK_KINDS.map((k) => (
              <option key={k} value={k}>
                {g.f.t(`kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="gv-field">
          <span className="lbl">{g.t("add.mode")}</span>
          <div className="seg" role="group" aria-label={g.t("add.mode")}>
            {GOAL_TASK_MODES.map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m === "solo" ? g.t("mode.solo") : g.t("mode.crewPlain")}
              </button>
            ))}
          </div>
        </div>
      </div>
      <fieldset className="gv-waits">
        <legend className="lbl">{g.t("add.waitsFor")}</legend>
        {candidates.length === 0 && <span className="muted">{g.t("add.none")}</span>}
        {candidates.map((x) => (
          <label key={x.taskId} className="gv-check">
            <input type="checkbox" checked={waits.includes(x.taskId)} onChange={(e) => setWaits((w) => (e.target.checked ? [...w, x.taskId] : w.filter((id) => id !== x.taskId)))} />
            <span>
              <span className="mono">{goalNumber(x.number)}</span> {x.title}
            </span>
          </label>
        ))}
      </fieldset>
      <p className="muted tk-small">{g.t("add.note")}</p>
      <div className="gv-acts">
        <Button size="sm" variant="ghost" onClick={onDone}>
          {g.t("add.cancel")}
        </Button>
        <Button size="sm" type="submit" disabled={!ready}>
          {g.t("add.submit")}
        </Button>
      </div>
    </form>
  );
}

/** `Replan`: your note and the current plan go to the planner as a new revision, at the cost on the button. */
function ReplanForm({ goal, apply, cost, onDone }: { goal: GoalDetail; apply: Apply; cost: ReplanCost; onDone: () => void }) {
  const g = useGoalFormat();
  const [note, setNote] = useState("");
  return (
    <form
      className="gv-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (cost.label === null) return;
        void apply(() => act("goals.replan", { goalId: goal.id, note: note.trim() || undefined })).then(onDone);
      }}
      onKeyDown={(e) => e.key === "Escape" && onDone()}
    >
      <label className="gv-field">
        <span className="lbl">{g.t("replan.note")}</span>
        <textarea rows={2} value={note} maxLength={GOAL_LIMITS.noteBytes} onChange={(e) => setNote(e.target.value)} autoFocus />
      </label>
      <p className="muted tk-small">{g.t("replan.hint")}</p>
      <div className="gv-acts">
        <Button size="sm" variant="ghost" onClick={onDone}>
          {g.t("replan.cancel")}
        </Button>
        <Button size="sm" type="submit" disabled={cost.label === null}>
          {g.t("replan.go", { cost: cost.label ?? "…" })}
        </Button>
        {cost.blocked && <span className="muted tk-small">{cost.blocked}</span>}
      </div>
    </form>
  );
}

/**
 * `Stop goal…`: names how many tasks it cancels, the running agents and the spend so far first
 * (goals.stopPreview). The goal bar's Stop and a decision's Stop answer both confirm here.
 */
export function StopConfirm({ goal, onConfirm, onDone }: { goal: Pick<GoalDetail, "id">; onConfirm: () => Promise<unknown>; onDone: () => void }) {
  const g = useGoalFormat();
  const preview = useWork("goals.stopPreview", { goalId: goal.id }, { staleTime: 0 });
  const p: GoalStopPreview | undefined = preview.data && typeof preview.data.cancelTasks === "number" ? preview.data : undefined;
  const spend = p ? (p.spend.usd === null ? g.t("spendUnknown") : g.f.usd(p.spend.usd)) : "";
  return (
    <div className="gv-form" role="alertdialog" aria-label={g.t("stop.confirm")} onKeyDown={(e) => e.key === "Escape" && onDone()}>
      {p ? (
        <p className="sec">
          {g.t("stop.preview", { tasks: g.t("stop.tasks", { count: p.cancelTasks }), runs: g.t("stop.runs", { count: p.runningRuns }), spend })} <ProvBadge value={p.spend.usd === null ? "unknown" : p.spend.provenance} />
        </p>
      ) : (
        <p className="muted">{g.t("stop.loading")}</p>
      )}
      <div className="gv-acts">
        <Button size="sm" variant="ghost" onClick={onDone} autoFocus>
          {g.t("stop.keep")}
        </Button>
        <Button size="sm" variant="danger" disabled={!p} onClick={() => void onConfirm().then(onDone)}>
          {g.t("stop.confirm")}
        </Button>
      </div>
    </div>
  );
}

/** The goal budget and `At once`; the daemon checks the bounds again (§5.1). */
function LimitsForm({ goal, apply, onDone }: { goal: GoalDetail; apply: Apply; onDone: () => void }) {
  const g = useGoalFormat();
  const [budget, setBudget] = useState(goal.budgetUsd !== null ? String(goal.budgetUsd) : "");
  const [atOnce, setAtOnce] = useState(goal.maxParallel);
  const value = Number(budget);
  const ok = budget.trim() !== "" && Number.isFinite(value) && value > 0 && value <= GOAL_LIMITS.budgetMaxUsd;
  return (
    <form
      className="gv-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        void apply(() => act("goals.setLimits", { goalId: goal.id, budgetUsd: value, maxParallel: atOnce })).then(onDone);
      }}
      onKeyDown={(e) => e.key === "Escape" && onDone()}
    >
      <div className="gv-form-row">
        <label className="gv-field">
          <span className="lbl">{g.t("limits.budget")}</span>
          <input type="number" inputMode="decimal" min={0} max={GOAL_LIMITS.budgetMaxUsd} step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} autoFocus />
        </label>
        <label className="gv-field">
          <span className="lbl">{g.t("limits.atOnce")}</span>
          <select value={atOnce} onChange={(e) => setAtOnce(Number(e.target.value))}>
            {Array.from({ length: GOAL_LIMITS.maxParallelMax - GOAL_LIMITS.maxParallelMin + 1 }, (_, i) => GOAL_LIMITS.maxParallelMin + i).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted tk-small">{g.t("limits.hint")}</p>
      <div className="gv-acts">
        <Button size="sm" variant="ghost" onClick={onDone}>
          {g.t("replan.cancel")}
        </Button>
        <Button size="sm" type="submit" disabled={!ok}>
          {g.t("limits.save")}
        </Button>
      </div>
    </form>
  );
}

/** A goal event as one plain line: when, what happened, and its readable text when it has one. */
function FeedLine({ e }: { e: ActivityEvent }) {
  const g = useGoalFormat();
  // A payload with no readable string comes back as its JSON; that is for the Activity drawer, not this line.
  const preview = e.preview.trim();
  const readable = preview !== "" && !preview.startsWith("{") && !preview.startsWith("[");
  return (
    <li className="gv-feed-line">
      <span className="num muted">{g.f.when.at(e.at)}</span>
      <span>{g.t(`feed.kind.${codeKey(e.kind)}`, { defaultValue: e.kind })}</span>
      {readable && <span className="muted as-typed">{capRow(preview)}</span>}
    </li>
  );
}

/** One page of the goal's events, newest first; the last page offers the next older one. */
function FeedPage({ goal, before, onOlder }: { goal: Pick<GoalDetail, "id" | "projectId">; before: number | null; onOlder: ((seq: number) => void) | null }) {
  const g = useGoalFormat();
  const page = useWork("activity.events", { projectId: goal.projectId, kind: "goal.", goalId: goal.id, limit: GOAL_FEED_PAGE, before }, { staleTime: 10_000 });
  const data = page.data && Array.isArray(page.data.events) ? page.data : null;
  if (!data) return null;
  if (data.events.length === 0 && before === null) return <li className="muted">{g.t("feed.empty")}</li>;
  return (
    <>
      {data.events.map((e) => (
        <FeedLine key={e.seq} e={e} />
      ))}
      {onOlder && data.older !== null && (
        <li>
          <Button size="sm" variant="ghost" onClick={() => onOlder(data.older!)}>
            {g.t("feed.older")}
          </Button>
        </li>
      )}
    </>
  );
}

/**
 * The goal's `goal.*` events in a `Details` fold, newest first, in pages of 40 (design §3.3). It
 * reads only while open, and a goal change refreshes it. The inspector's timeline for a task is unchanged.
 */
export function GoalFeed({ goal, defaultOpen = false }: { goal: Pick<GoalDetail, "id" | "projectId">; defaultOpen?: boolean }) {
  const g = useGoalFormat();
  const qc = useQueryClient();
  const [open, setOpen] = useState(defaultOpen);
  const [pages, setPages] = useState<Array<number | null>>([null]);
  useEffect(() => {
    if (!open) return;
    return window.crewyard.on("goals.changed", (p) => {
      if ((p as { goalId?: string } | null)?.goalId === goal.id) void qc.invalidateQueries({ queryKey: ["activity.events", { goalId: goal.id }] });
    });
  }, [open, goal.id, qc]);
  return (
    <details className="gv-section gv-feed" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="lbl">{g.t("feed.title")}</summary>
      {open && (
        <ol>
          {pages.map((before, i) => (
            <FeedPage key={before ?? "newest"} goal={goal} before={before} onOlder={i === pages.length - 1 ? (seq) => setPages((x) => [...x, seq]) : null} />
          ))}
        </ol>
      )}
    </details>
  );
}

type Slot = "add" | "replan" | "stop" | "limits" | null;

/**
 * DESIGN.md `GoalView` (design §3.3), shown in the Tasks slot above the list when a goal row is
 * selected. `offline` keeps the last state with every action disabled (§3.8). `keyboard` gives J
 * and K to the goal's task rows; the Tasks screen hands them over while the view is open.
 */
export function GoalView({ goal, requests, offline = false, keyboard = false, onReviewPlan, onClose }: { goal: GoalDetail; requests: RequestView[]; offline?: boolean; keyboard?: boolean; onReviewPlan?: () => void; onClose?: () => void }) {
  useGoalsChanged();
  const g = useGoalFormat();
  const { taskId: selectedTask, selectTask } = useNav();
  const inspect = useInspector((s) => s.open);
  const [slot, setSlot] = useState<Slot>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = useGoalApply(goal.id, setError);
  const live = goal.status === "running" || goal.status === "planning";
  const now = useNow(1000, live);
  const line = goalStatusLine(goal);
  const ended = goal.status === "stopped" || goal.status === "finished";
  const locked = offline || ended;
  const needs = goalNeeds(goal, requests);
  const rows = goal.tasks.filter((x) => !x.discarded).sort((a, b) => a.number - b.number);
  const approved = goal.approvedRevision !== null;
  // Read whenever a replan can start, so the top button states its cost too (design §3.3).
  const replanCost = useReplanCost(goal, !locked && approved && goal.replansLeft > 0);
  const writersWaitOn = new Set(goal.tasks.filter((x) => x.writes && x.accepted === true && !x.discarded).flatMap((x) => x.dependsOn.map((d) => d.taskId)));
  const joined = goal.joins.filter((j) => j.outcome === "joined");
  useListKeys(
    [...rows.map((r) => r.taskId), ...(goal.integration ? [goal.integration.taskId] : [])],
    selectedTask,
    (id) => {
      selectTask(id);
      inspect({ taskId: id });
    },
    keyboard,
  );
  // Esc or Cancel in a form returns focus to the button that opened it (keyboard pass).
  const opener = useRef<HTMLElement | null>(null);
  const toggle = (s: Exclude<Slot, null>, e: MouseEvent<HTMLElement>) => {
    opener.current = e.currentTarget;
    setSlot((cur) => (cur === s ? null : s));
  };
  const openSlot: OpenSlot = (s, e) => {
    opener.current = e.currentTarget;
    setSlot(s);
  };
  const close = () => {
    setSlot(null);
    opener.current?.focus();
  };

  return (
    <Panel className="gv" aria-label={g.t("view.label", { title: goal.title })}>
      {offline && (
        <div className="banner banner-info gv-banner" role="status">
          {g.t("view.offline")}
        </div>
      )}
      <div className="gv-head">
        <Label>{g.t("eyebrow")}</Label>
        <GoalStatusLabel line={line} />
        {line.key !== "running" && goal.total > 0 && <span className="muted tk-small num">{g.t("progress", { done: goal.done, total: goal.total })}</span>}
        {onClose && (
          <Button size="sm" variant="ghost" className="gv-close" onClick={onClose}>
            {g.t("action.close")}
          </Button>
        )}
      </div>
      <div className="gv-bar">
        <h2 className="gv-title">{goal.title}</h2>
        <GoalSpend goal={goal} meter="md" />
      </div>
      <div className="gv-meta muted tk-small">
        <span className="num">{g.t("view.elapsed", { time: ended ? g.f.when.ago(goal.createdAt) : formatDuration(Math.max(0, now - Date.parse(goal.createdAt))) })}</span>
        {goal.branch ? (
          <span>
            <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" /> {g.t("view.branchLabel")} <span className="mono">{goal.branch}</span>
            {joined.length > 0 && ` (${g.t("view.added", { count: joined.length })})`}
          </span>
        ) : (
          approved && <span>{g.t("view.noBranch")}</span>
        )}
      </div>
      <div className="gv-actions">
        {goal.paused ? (
          <Button size="sm" tone="ok" disabled={locked} onClick={() => void apply(() => act("goals.resume", { goalId: goal.id }))}>
            {g.t("action.resume")}
          </Button>
        ) : (
          <Button size="sm" tone="warn" disabled={locked || !approved} onClick={() => void apply(() => act("goals.pause", { goalId: goal.id }))}>
            {g.t("action.pause")}
          </Button>
        )}
        <Button size="sm" aria-expanded={slot === "add"} disabled={locked || !approved} onClick={(e) => toggle("add", e)}>
          {g.t("action.addTask")}
        </Button>
        <Button size="sm" aria-expanded={slot === "replan"} disabled={locked || !approved || goal.replansLeft <= 0} onClick={(e) => toggle("replan", e)}>
          {goal.replansLeft <= 0 ? g.t("action.replanNone") : replanCost.label ? g.t("action.replanCost", { count: goal.replansLeft, cost: replanCost.label }) : g.t("action.replan", { count: goal.replansLeft })}
        </Button>
        <Button size="sm" aria-expanded={slot === "limits"} variant="ghost" disabled={locked || !approved} onClick={(e) => toggle("limits", e)}>
          {g.t("action.more")}
        </Button>
        <Button size="sm" variant="danger" aria-expanded={slot === "stop"} disabled={locked} onClick={(e) => toggle("stop", e)}>
          {g.t("action.stop")}
        </Button>
        {goal.status === "ready_for_review" && goal.integration && (
          <Button
            variant="primary"
            className="gv-pr"
            disabled={offline}
            onClick={() => {
              selectTask(goal.integration!.taskId);
              inspect({ taskId: goal.integration!.taskId });
            }}
          >
            {g.t("action.openPr")}
          </Button>
        )}
      </div>
      {replanCost.blocked && <p className="muted tk-small">{replanCost.blocked}</p>}
      {goal.status === "ready_for_review" && <p className="gv-note st-ok">{g.t("view.readyForPr")}</p>}
      {slot === "add" && <AddTaskForm goal={goal} apply={apply} onDone={close} />}
      {slot === "replan" && <ReplanForm goal={goal} apply={apply} cost={replanCost} onDone={close} />}
      {slot === "stop" && <StopConfirm goal={goal} onConfirm={() => apply(() => act("goals.stop", { goalId: goal.id }))} onDone={close} />}
      {slot === "limits" && <LimitsForm goal={goal} apply={apply} onDone={close} />}
      <ErrorLine>{error}</ErrorLine>

      {needs.length > 0 && (
        <section className="gv-section" aria-label={g.t("view.needsYou", { count: needs.length })}>
          <div className="lbl gv-sub st-wait">{g.t("view.needsYou", { count: needs.length })}</div>
          {needs.map((n, i) => (
            <NeedRow key={n.kind === "decision" ? n.decision.id : n.kind === "request" ? n.request.id : `${n.kind}-${i}`} need={n} goal={goal} apply={apply} replanCost={replanCost} locked={locked} onReviewPlan={onReviewPlan} onSlot={openSlot} />
          ))}
        </section>
      )}

      {(rows.length > 0 || goal.integration) && (
        <section className="gv-section" aria-label={g.t("view.tasks")}>
          <div className="lbl gv-sub">{g.t("view.tasks")}</div>
          {rows.map((x) => (
            <TaskLine key={x.taskId} task={x} goal={goal} requests={requests} selected={selectedTask === x.taskId} feedsWriter={writersWaitOn.has(x.taskId)} />
          ))}
          <IntegrationLine goal={goal} />
        </section>
      )}

      {joined.length > 0 && (
        <details className="gv-section gv-merges">
          <summary className="lbl">{g.t("view.mergeOrder")}</summary>
          <ol>
            {joined.map((j) => {
              const x = goal.tasks.find((y) => y.taskId === j.taskId);
              return (
                <li key={j.id} className="as-typed">
                  {g.t("view.mergeLine", { number: x ? goalNumber(x.number) : "", title: x?.title ?? j.taskId, sha: (j.afterSha ?? "").slice(0, 7) })}
                </li>
              );
            })}
          </ol>
        </details>
      )}
      <GoalFeed goal={goal} />
    </Panel>
  );
}
