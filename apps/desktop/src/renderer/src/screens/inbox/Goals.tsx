import { useState } from "react";
import { Target } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GoalDetail, GoalSummary, TaskDetail } from "@crewyard/core";
import { Button, Panel } from "@crewyard/ui";
import { useNav } from "../../nav.ts";
import { useWork } from "../tasks/data.ts";
import { GoalStatusLabel, useGoalNav, useGoalsChanged } from "../tasks/GoalRow.tsx";
import { GoalDecisionRow, useGoalApply, useReplanCost } from "../tasks/GoalView.tsx";
import { goalNumber, goalStatusLine } from "../tasks/model.ts";
import { ErrorLine } from "../tasks/parts.tsx";

// Goal decisions in the Inbox (docs/adr/0019, design §3.6). They are not requests: a conflicted
// merge, a failed prerequisite, the stop rule, a stuck goal, a `changes` verdict or a report to
// accept get their own list beside Stalls and Switches, with the same buttons as the goal view.
// Goals that need you without a decision (a plan to review, a request) link to the goal instead.

/** The project's goals, kept fresh by `goals.changed`. Empty while the daemon has no goals yet. */
export function useGoals(projectId: string) {
  useGoalsChanged();
  const q = useWork("goals.list", { projectId }, { enabled: Boolean(projectId) });
  // Screenshot fixtures answer methods they do not know with a task; only a list is goals.
  return Array.isArray(q.data) ? q.data : [];
}

/** "Passkeys · 02 Server": how the Inbox names a request from a goal task (design §3.6). */
export function useGoalTaskLabel(task: Pick<TaskDetail, "title" | "goal"> | undefined): string {
  const { t } = useTranslation("goals");
  const goal = useWork("goals.get", { goalId: task?.goal?.goalId ?? "" }, { enabled: Boolean(task?.goal && !task.goal.hidden), staleTime: 60_000 });
  if (!task) return "";
  const title = typeof goal.data?.title === "string" ? goal.data.title : null;
  if (!task.goal || !title) return task.title;
  return t("taskLabel", { goal: title, number: goalNumber(task.goal.number), task: task.title });
}

function GoalItem({ summary }: { summary: GoalSummary }) {
  const { t } = useTranslation("goals");
  const { go } = useNav();
  const openGoal = useGoalNav((s) => s.open);
  const [error, setError] = useState<string | null>(null);
  const q = useWork("goals.get", { goalId: summary.id });
  const goal: GoalDetail | undefined = q.data && Array.isArray(q.data.decisions) ? q.data : undefined;
  const apply = useGoalApply(summary.id, setError);
  const open = goal?.decisions.filter((d) => d.answeredAt === null) ?? [];
  const replanCost = useReplanCost(goal ?? { projectId: summary.projectId, text: "" }, Boolean(goal && goal.replansLeft > 0 && open.some((d) => d.actions.includes("replan"))));
  return (
    <div className="ib-item ib-goal">
      <Target size={16} strokeWidth={1.75} aria-hidden="true" className="ib-warn" />
      <span className="ib-text">
        <span className="t">{summary.title}</span>
        <span className="s">
          <GoalStatusLabel line={goalStatusLine(summary)} />
        </span>
        {goal && open.map((d) => <GoalDecisionRow key={d.id} goal={goal} decision={d} apply={apply} replanCost={replanCost} />)}
        <span className="ib-stall-acts">
          <Button
            size="sm"
            onClick={() => {
              openGoal(summary.id);
              go("tasks");
            }}
          >
            {t("action.openGoal")}
          </Button>
        </span>
        <ErrorLine>{error}</ErrorLine>
      </span>
      <span className="k" />
    </div>
  );
}

/** Goals that need you, newest first, with their open decisions. Nothing shows when none does. */
export function GoalList({ projectId }: { projectId: string }) {
  const { t } = useTranslation("goals");
  const goals = useGoals(projectId).filter((g) => g.status === "needs_you");
  if (goals.length === 0) return null;
  return (
    <>
      <div className="ib-sub lbl">{t("inbox.section", { count: goals.length })}</div>
      <Panel className="ib-list" aria-live="polite">
        {goals.map((g) => (
          <GoalItem key={g.id} summary={g} />
        ))}
      </Panel>
    </>
  );
}
