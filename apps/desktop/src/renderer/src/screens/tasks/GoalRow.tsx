import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, CircleHelp, Clock, GitBranch, GitPullRequest, Pause, Square, Target } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CostEstimate, GoalSummary, Reason, RequestView, TaskGoalRef, TaskMode, TaskSummary } from "@crewyard/core";
import { TickMeter } from "@crewyard/ui";
import { ProvBadge } from "../providers/shared.tsx";
import { useWork } from "./data.ts";
import { joinList } from "./goalsModel.ts";
import { useActivity } from "./live.ts";
import { codeKey, currentRun, formatDuration, goalFolded, goalNumber, goalSpendPct, goalStatusLine, profileNames, type GoalIcon, type GoalLine, type GoalTaskLine } from "./model.ts";
import { STATUS_ICONS, useFormat, useNow } from "./parts.tsx";
import "./goal-view.css";

// Orchestra goals in the task list (docs/adr/0019, design §3.4): a goal is one group row with its
// status, progress and spend against its budget, and its tasks indented under it. Goal text and
// titles are untrusted: React renders them as plain text, and nothing in them becomes a link.

export { useGoalNav } from "./goalNav.ts";

/** Keeps every goals.* read fresh: the daemon pushes `goals.changed` when a goal's facts change. */
export function useGoalsChanged(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const refresh = () => void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("goals.") });
    const offs = [window.crewyard.on("goals.changed", refresh), window.crewyard.on("daemon.ready", refresh)];
    return () => offs.forEach((off) => off());
  }, [qc]);
}

/** Formatting for goal labels: hold reasons, costs with their provenance, modes. */
export function useGoalFormat() {
  const { t, i18n } = useTranslation("goals");
  const f = useFormat();
  /** Task numbers as a list in the UI language ("02, 03 and 04"). */
  const list = (items: readonly string[]) => joinList(items, i18n.language);
  /** A goal hold reason (`goal.*`): `task` is already the task's number ("01"). */
  const hold = (r: Reason) => t(`hold.${codeKey(r.code)}`, { ...(r.params ?? {}), defaultValue: t("hold.other") });
  const mode = (m: TaskMode, steps: number) => (m === "solo" ? t("mode.solo") : t("mode.crew", { count: steps }));
  /** "$1.12", or null when the number is unknown (the caller shows the Unknown badge alone). */
  const usd = (c: Pick<CostEstimate, "usd">) => (c.usd === null ? null : f.usd(c.usd));
  return { t, f, hold, mode, usd, list };
}

const GOAL_ICONS: Record<Exclude<GoalIcon, "spinner">, typeof Check> = { question: CircleHelp, pause: Pause, check: Check, pr: GitPullRequest, square: Square };
const TONE_CLASS = { run: "st-run", wait: "st-wait", ok: "st-ok", bad: "st-bad", ink: "st-rev", muted: "muted" } as const;

/** A goal's status (design §3.9): icon and text in the state color, never color alone. */
export function GoalStatusLabel({ line }: { line: GoalLine }) {
  const { t } = useTranslation("goals");
  const Icon = line.icon === "spinner" ? null : GOAL_ICONS[line.icon];
  const text = t(`status.${line.key}`, { done: line.done, total: line.total, reason: line.reason ? t(`needs.${line.reason}`) : "" });
  return (
    <span className={`st ${TONE_CLASS[line.tone]}`}>
      {Icon ? <Icon size={14} strokeWidth={1.75} aria-hidden="true" /> : <span className="spin" aria-hidden="true" />}
      <span className="st-text">{text}</span>
    </span>
  );
}

/** A goal task's status in the goal view: its hold reason while it waits, else what it is doing. */
export function GoalTaskLabel({ line }: { line: GoalTaskLine }) {
  const g = useGoalFormat();
  const Icon = line.icon === "spinner" ? null : line.icon === "pause" ? Pause : STATUS_ICONS[line.icon];
  const text = line.hold ? g.hold(line.hold) : g.t(`task.${line.key}`);
  return (
    <span className={`st ${TONE_CLASS[line.tone]}`}>
      {Icon ? <Icon size={14} strokeWidth={1.75} aria-hidden="true" /> : <span className="spin" aria-hidden="true" />}
      <span className="st-text">{text}</span>
    </span>
  );
}

/** "$1.12 of $3.00 Reported" with the goal's spend meter; every cost carries its provenance. */
export function GoalSpend({ goal, meter = "sm" }: { goal: Pick<GoalSummary, "spend" | "budgetUsd">; meter?: "sm" | "md" | null }) {
  const g = useGoalFormat();
  const spent = g.usd(goal.spend);
  const pct = goalSpendPct(goal);
  const text = spent === null ? g.t("spendUnknown") : goal.budgetUsd ? g.t("spend", { spent, budget: g.f.usd(goal.budgetUsd) }) : g.t("spendNoBudget", { spent });
  return (
    <span className="gl-spend">
      {meter && <TickMeter value={pct} size={meter} ticks={meter === "md" ? 32 : 24} label={pct === null ? g.t("meterUnknown") : g.t("meter", { pct: Math.round(pct) })} />}
      <span className="num">{text}</span>
      <ProvBadge value={spent === null ? "unknown" : goal.spend.provenance} />
    </span>
  );
}

/**
 * The goal chip on a task row: "Goal · 02", the goal's title in the tooltip. A waiting goal task
 * never offers Review crew; it starts with its plan.
 */
export function GoalChip({ goalRef }: { goalRef: TaskGoalRef }) {
  const g = useGoalFormat();
  const goal = useWork("goals.get", { goalId: goalRef.goalId }, { staleTime: 60_000 });
  const number = goalNumber(goalRef.number);
  const title = typeof goal.data?.title === "string" ? goal.data.title : null;
  return (
    <span className="tk-goal" title={title ? g.t("chipTitle", { goal: title, number }) : undefined}>
      <Target size={13} strokeWidth={1.75} aria-hidden="true" />
      {g.t("chip", { number })}
    </span>
  );
}

/** The planning run of a goal that is planning: who plans, how long it has run, and what it just did. */
function PlannerLine({ taskId }: { taskId: string }) {
  const g = useGoalFormat();
  const detail = useWork("tasks.get", { taskId });
  const run = detail.data ? currentRun(detail.data) : null;
  const open = run !== null && run.endedAt === null;
  const now = useNow(1000, open);
  const latest = useActivity((s) => (run ? (s.runs[run.id]?.now ?? null) : null));
  if (!detail.data) return null;
  if (!run) return <span className="muted tk-small">{g.t("row.plannerWaits")}</span>;
  const alias = profileNames(detail.data).get(run.profileId)?.alias ?? run.profileId;
  const who = [g.f.runner(run.runner), alias, run.model].filter(Boolean).join(" · ");
  const elapsed = formatDuration(Math.max(0, (run.endedAt ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt)));
  return (
    <span className="muted tk-small gl-planner">
      <span>{g.t("row.planner", { who })}</span>
      <span className="num">{elapsed}</span>
      {latest && <span className="gl-latest as-typed">{latest}</span>}
    </span>
  );
}

/**
 * DESIGN.md `TaskRow` for a goal (design §3.4): the goal's title, status, `n of m` and spend against
 * its budget; its tasks indented under it and folded once it is finished. A click selects the goal
 * for the goal view. Rows never expand or fold on their own when events arrive.
 */
export function GoalRow({
  goal,
  tasks,
  requests,
  selected,
  onSelect,
  renderTask,
}: {
  goal: GoalSummary;
  /** The goal's tasks from tasks.list; hidden ones (planning, the last review) are left out here. */
  tasks: TaskSummary[];
  requests: RequestView[];
  selected: boolean;
  onSelect: (goalId: string) => void;
  /** How a task row draws (the Tasks screen passes TaskRow). */
  renderTask: (task: TaskSummary) => ReactNode;
}) {
  const g = useGoalFormat();
  const [open, setOpen] = useState(() => !goalFolded(goal));
  const live = goal.status === "planning" || goal.status === "running";
  const now = useNow(1000, live);
  const line = goalStatusLine(goal);
  const shown = tasks.filter((x) => x.goal && x.goal.goalId === goal.id && !x.goal.hidden).sort((a, b) => (a.goal?.number ?? 0) - (b.goal?.number ?? 0));
  const planning = goal.status === "planning" ? tasks.find((x) => x.goal?.goalId === goal.id && x.goal.role === "planning") : undefined;
  const asking = requests.filter((q) => q.answeredAt === null && shown.some((x) => x.id === q.taskId)).length;
  return (
    <div className="tk-row gl-row" aria-current={selected ? "true" : undefined}>
      <div className="tk-top">
        <button type="button" className="tk-top-main" data-list-id={`goal:${goal.id}`} onClick={() => onSelect(goal.id)}>
          <div className="tk-title">
            <span className="lbl gl-eyebrow">{g.t("eyebrow")}</span> <span className="gl-title">{goal.title}</span>
          </div>
          <div className="tk-meta">
            {goal.branch && (
              <span>
                <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" />
                <span className="mono">{goal.branch}</span>
              </span>
            )}
            {shown.length > 0 && <span>{g.t("row.tasks", { count: shown.length })}</span>}
            {asking > 0 && (
              <span className="st-wait">
                <Clock size={13} strokeWidth={1.75} aria-hidden="true" />
                {g.t("needs.request")}
              </span>
            )}
          </div>
        </button>
        <span className="tk-right num">{goalFolded(goal) ? g.f.when.ago(goal.createdAt) : formatDuration(Math.max(0, now - Date.parse(goal.createdAt)))}</span>
        {shown.length > 0 && (
          <button type="button" className="tk-expand" aria-expanded={open} aria-label={open ? g.t("row.collapse") : g.t("row.expand")} onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronUp size={16} strokeWidth={1.75} /> : <ChevronDown size={16} strokeWidth={1.75} />}
          </button>
        )}
      </div>
      <div className="tk-status">
        <GoalStatusLabel line={line} />
        {line.key !== "running" && goal.total > 0 && <span className="muted tk-small num">{g.t("progress", { done: goal.done, total: goal.total })}</span>}
        {planning && <PlannerLine taskId={planning.id} />}
        <div className="end">
          <GoalSpend goal={goal} />
        </div>
      </div>
      {open && shown.length > 0 && <div className="gl-tasks">{shown.map((x) => <div key={x.id}>{renderTask(x)}</div>)}</div>}
    </div>
  );
}
