import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleHelp, CircleX, FileText, GitBranch, GitMerge, ListChecks, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GOAL_LIMITS, GOAL_TASK_KINDS, GOAL_TASK_MODES, type GoalDecisionAction, type GoalDecisionView, type GoalDetail, type GoalStopPreview, type GoalTaskView, type RequestView, type TaskKind, type TaskMode } from "@crewyard/core";
import { Button, Label, Panel } from "@crewyard/ui";
import { useInspector } from "../../inspector.ts";
import { useListKeys } from "../../listKeys.ts";
import { useNav } from "../../nav.ts";
import { titleKey } from "../inbox/model.ts";
import { RiskBadge } from "../inbox/RiskBadge.tsx";
import { ProvBadge } from "../providers/shared.tsx";
import { act, useErrorText, useWork } from "./data.ts";
import { GoalSpend, GoalStatusLabel, GoalTaskLabel, useGoalFormat, useGoalsChanged } from "./GoalRow.tsx";
import { codeKey, currentRun, formatDuration, goalNeeds, goalNumber, goalStatusLine, goalTaskLine, type GoalNeed } from "./model.ts";
import { ConfirmButton, ErrorLine, useFormat, useNow } from "./parts.tsx";

// The goal view (docs/adr/0019, design §3.3): the goal bar with its status, spend against the goal
// budget, elapsed time and goal branch; what needs you, first; then the goal's tasks with why each
// one waits. Every action is one daemon call that the daemon checks again (§5.3). Goal, plan,
// report and agent text is untrusted: React renders it as plain text, capped here for the row.

/** Untrusted text shown in a row (findings, a provider's message): one line's worth, never markup. */
const ROW_TEXT_MAX = 600;
const capRow = (s: string) => (s.length > ROW_TEXT_MAX ? `${s.slice(0, ROW_TEXT_MAX - 1)}…` : s);

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

/**
 * The cost a planning run would have, read from goals.preview (which writes nothing), as the
 * Replan button says it: "~$0.31 Estimated" or "cost unknown". Null until it is known, and a
 * Replan button without its cost stays disabled: every model call starts from a click that showed it.
 */
export function useReplanCost(goal: Pick<GoalDetail, "projectId" | "text">, enabled: boolean): string | null {
  const g = useGoalFormat();
  const preview = useWork("goals.preview", { projectId: goal.projectId, text: goal.text }, { enabled, staleTime: 60_000 });
  const e = preview.data?.estimate;
  if (!e) return null;
  return e.usd === null ? g.t("replan.unknown") : g.t("replan.estimate", { usd: g.f.usd(e.usd) });
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

/**
 * One goal decision with its answers (GOAL_DECISION_ACTIONS, suggested first). The Inbox's goal
 * list shows the same row with the same buttons. Replan states its planning cost on the button.
 */
export function GoalDecisionRow({ goal, decision, apply, replanCost, locked = false }: { goal: GoalDetail; decision: GoalDecisionView; apply: Apply; replanCost: string | null; locked?: boolean }) {
  const { t } = useTranslation("goals");
  const text = useDecisionText(goal)(decision);
  const { selectTask } = useNav();
  const inspect = useInspector((s) => s.open);
  const Icon = DECISION_ICON[decision.kind];
  const answer = (action: GoalDecisionAction) => apply(() => act("goals.decide", { goalId: goal.id, decisionId: decision.id, action }));
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
              <ConfirmButton key={a} label={t("answer.stop")} confirm={t("answer.stopConfirm")} confirmLabel={t("answer.stop")} disabled={locked} onConfirm={() => answer(a)} />
            ) : a === "replan" ? (
              <Button key={a} size="sm" disabled={locked || replanCost === null} onClick={() => void answer(a)}>
                {replanCost ? t("replan.go", { cost: replanCost }) : t("answer.replan")}
              </Button>
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

function NeedRow({ need, goal, apply, replanCost, locked, onReviewPlan }: { need: GoalNeed; goal: GoalDetail; apply: Apply; replanCost: string | null; locked: boolean; onReviewPlan?: () => void }) {
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
      return plain(CircleAlert, t("view.halted", { reason: need.reason }), null, null);
    case "stuck": {
      const s = goal.stuck;
      const num = (id: string) => {
        const x = goal.tasks.find((y) => y.taskId === id);
        return x ? goalNumber(x.number) : id;
      };
      return plain(CircleAlert, s ? t("decision.stuck", { task: num(s.taskId), waitsFor: num(s.waitsFor), why: t(`why.${s.why}`) }) : t("decision.stuckPlain"), null, null);
    }
    case "empty":
      return plain(CircleAlert, t("view.empty"), null, null);
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
  if (!i) return null;
  const started = i.status !== "proposed" && i.status !== "queued";
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
          <span className="muted">{g.t("task.noSpend")}</span>
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
function AddTaskForm({ goal, apply, onDone }: { goal: GoalDetail; apply: Apply; onDone: () => void }) {
  const g = useGoalFormat();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<TaskKind>("code");
  const [mode, setMode] = useState<TaskMode>("crew");
  const [waits, setWaits] = useState<string[]>([]);
  const candidates = goal.tasks.filter((x) => x.accepted === true && !x.discarded && x.status !== "cancelled");
  const ready = title.trim().length > 0 && new TextEncoder().encode(title.trim()).length <= GOAL_LIMITS.titleBytes;
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
        <input value={title} maxLength={GOAL_LIMITS.titleBytes} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </label>
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
function ReplanForm({ goal, apply, cost, onDone }: { goal: GoalDetail; apply: Apply; cost: string | null; onDone: () => void }) {
  const g = useGoalFormat();
  const [note, setNote] = useState("");
  return (
    <form
      className="gv-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (cost === null) return;
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
        <Button size="sm" type="submit" disabled={cost === null}>
          {g.t("replan.go", { cost: cost ?? "…" })}
        </Button>
      </div>
    </form>
  );
}

/** `Stop goal…`: names how many tasks it cancels, the running agents and the spend so far first. */
function StopConfirm({ goal, apply, onDone }: { goal: GoalDetail; apply: Apply; onDone: () => void }) {
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
        <Button size="sm" variant="danger" disabled={!p} onClick={() => void apply(() => act("goals.stop", { goalId: goal.id })).then(onDone)}>
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
  const replanCost = useReplanCost(goal, !locked && goal.replansLeft > 0 && (slot === "replan" || needs.some((n) => n.kind === "decision" && n.decision.actions.includes("replan"))));
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
  const toggle = (s: Exclude<Slot, null>) => setSlot((cur) => (cur === s ? null : s));
  const approved = goal.approvedRevision !== null;

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
        <Button size="sm" aria-expanded={slot === "add"} disabled={locked || !approved} onClick={() => toggle("add")}>
          {g.t("action.addTask")}
        </Button>
        <Button size="sm" aria-expanded={slot === "replan"} disabled={locked || !approved || goal.replansLeft <= 0} onClick={() => toggle("replan")}>
          {goal.replansLeft > 0 ? g.t("action.replan", { count: goal.replansLeft }) : g.t("action.replanNone")}
        </Button>
        <Button size="sm" aria-expanded={slot === "limits"} variant="ghost" disabled={locked || !approved} onClick={() => toggle("limits")}>
          {g.t("action.more")}
        </Button>
        <Button size="sm" variant="danger" aria-expanded={slot === "stop"} disabled={locked} onClick={() => toggle("stop")}>
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
      {goal.status === "ready_for_review" && <p className="gv-note st-ok">{g.t("view.readyForPr")}</p>}
      {slot === "add" && <AddTaskForm goal={goal} apply={apply} onDone={() => setSlot(null)} />}
      {slot === "replan" && <ReplanForm goal={goal} apply={apply} cost={replanCost} onDone={() => setSlot(null)} />}
      {slot === "stop" && <StopConfirm goal={goal} apply={apply} onDone={() => setSlot(null)} />}
      {slot === "limits" && <LimitsForm goal={goal} apply={apply} onDone={() => setSlot(null)} />}
      <ErrorLine>{error}</ErrorLine>

      {needs.length > 0 && (
        <section className="gv-section" aria-label={g.t("view.needsYou", { count: needs.length })}>
          <div className="lbl gv-sub st-wait">{g.t("view.needsYou", { count: needs.length })}</div>
          {needs.map((n, i) => (
            <NeedRow key={n.kind === "decision" ? n.decision.id : n.kind === "request" ? n.request.id : `${n.kind}-${i}`} need={n} goal={goal} apply={apply} replanCost={replanCost} locked={locked} onReviewPlan={onReviewPlan} />
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
    </Panel>
  );
}
