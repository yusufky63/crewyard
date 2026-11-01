import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GoalDetail, GoalSummary } from "@crewyard/core";
import { Panel } from "@crewyard/ui";
import { useInspector } from "../../inspector.ts";
import { useDaemon } from "../../ipc.ts";
import { useListKeys } from "../../listKeys.ts";
import { useNav } from "../../nav.ts";
import { BestOfCompare } from "./BestOfCompare.tsx";
import { Composer } from "./Composer.tsx";
import { FIXTURE } from "./fixture.ts";
import { Schedules } from "./Schedules.tsx";
import { CrewProposal } from "./CrewProposal.tsx";
import { useWork } from "./data.ts";
import { usePrefs } from "../../prefs.ts";
import { toggleAssistant } from "../../shell/activity/panel.ts";
import { useFixtureState } from "./fixtureState.ts";
import { GoalPlanReview } from "./GoalPlanReview.tsx";
import { GoalRow, useGoalsChanged } from "./GoalRow.tsx";
import { GoalView } from "./GoalView.tsx";
import { useGoalNav } from "./goalNav.ts";
import { latestRevision, showsPlanReview } from "./goalsModel.ts";
import { FILTERS, filterCounts, goalMatchesFilter, offersCrewProposal, taskMatchesFilter, type Filter } from "./model.ts";
import { TaskRow } from "./TaskRow.tsx";
import "./tasks.css";
import { LazyRow } from "./LazyRow.tsx";
import { useTaskReveal } from "./assistant/openTask.ts";

const GOAL_ID = "goal:";

export function TasksScreen() {
  const { t } = useTranslation("tasks");
  useFixtureState();
  useGoalsChanged();
  const { projectId, taskId, selectTask } = useNav();
  const [filter, setFilter] = useState<Filter>("all");
  // Schedules are the screen's second view; screenshot mode can open it with `view=schedules`.
  const [view, setView] = useState<"tasks" | "schedules">(() => (FIXTURE && new URLSearchParams(location.search).get("view") === "schedules" ? "schedules" : "tasks"));
  const schedules = useWork("schedules.list", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  const projects = useDaemon("projects.list", undefined);
  const daemon = useDaemon("daemon.status", undefined, { retry: 5, retryDelay: 800, refetchInterval: 15_000 });
  const offline = daemon.isError;
  const project = projects.data?.find((p) => p.id === projectId);
  const tasks = useWork("tasks.list", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  const requests = useWork("requests.list", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  // Orchestra goals (docs/adr/0019): group rows in the list, and the goal or its plan in the slot.
  const goalList = useWork("goals.list", { projectId: projectId ?? "" }, { enabled: Boolean(projectId), retry: false });
  const goals: GoalSummary[] = Array.isArray(goalList.data) ? goalList.data : [];
  const orchestra = useWork("goals.state", undefined, { retry: false, staleTime: 60_000 });
  const { goalId, open: openGoal } = useGoalNav();
  const goalRead = useWork("goals.get", { goalId: goalId ?? "" }, { enabled: Boolean(goalId), retry: false });
  const goal: GoalDetail | null = goalRead.data && goalRead.data.id === goalId && Array.isArray(goalRead.data.revisions) && goalRead.data.projectId === projectId ? goalRead.data : null;
  // A replan or added task of a running goal is reviewed in the same slot, from the goal view.
  // Kept by goal id, so opening another goal starts on its goal view.
  const [reviewing, setReviewing] = useState<string | null>(null);
  const latest = goal ? latestRevision(goal) : null;
  const planOpen = goal !== null && (showsPlanReview(goal) || (reviewing === goal.id && latest !== null && (latest.state === "ready" || latest.state === "planning" || latest.state === "failed")));

  const selected = tasks.data?.find((x) => x.id === taskId);
  // No crew proposal and no Approve for a goal task waiting for its turn (docs/adr/0019).
  const proposing = offersCrewProposal(selected);
  const draft = useWork("tasks.get", { taskId: selected?.id ?? "" }, { enabled: proposing });
  // A selected Best of N task that is still choosing shows its variants side by side.
  const comparing = selected?.bestOf && ["running", "choosing", "failed"].includes(selected.bestOf.phase) && !selected.cancelledAt;
  const group = useWork("tasks.get", { taskId: selected?.id ?? "" }, { enabled: Boolean(comparing) });
  const inspect = useInspector((s) => s.open);
  // The task assistant (docs/adr/0014) lives in the bottom panel's Assistant tab; this button opens
  // it there, or stops it and closes the panel, as Ctrl Shift A does on every project screen.
  const assistant = usePrefs((s) => s.drawerOpen && s.drawerTab === "assistant");
  const all = tasks.data ?? [];
  const shownGoals = goals.filter((g) => goalMatchesFilter(g, filter));
  const goalShown = new Set(shownGoals.map((g) => g.id));
  // Goal tasks show under their goal's row; on their own only when that row is not in this tab (model.ts).
  const shown = all.filter((x) => taskMatchesFilter(x, filter) && !(x.goal && goalShown.has(x.goal.goalId)));
  // J and K select as a click on the row does: the task and the inspector on it, or the goal in the slot.
  useListKeys(
    [...shownGoals.map((g) => GOAL_ID + g.id), ...shown.map((x) => x.id)],
    goalId && goalShown.has(goalId) ? GOAL_ID + goalId : taskId,
    (id) => {
      if (id.startsWith(GOAL_ID)) {
        openGoal(id.slice(GOAL_ID.length));
        return;
      }
      openGoal(null);
      selectTask(id);
      inspect({ taskId: id });
    },
    view === "tasks" && goal === null,
  );
  // Selecting a task that is not the open goal's own closes the goal, so its crew proposal can show.
  const lastTask = useRef(taskId);
  useEffect(() => {
    if (taskId === lastTask.current) return;
    lastTask.current = taskId;
    const picked = tasks.data?.find((x) => x.id === taskId);
    if (goalId && picked && picked.goal?.goalId !== goalId) openGoal(null);
  }, [taskId, goalId, tasks.data, openGoal]);
  // Open task (assistant drafts, a report's suggested tasks, the Autopilot log) lands here: back to
  // the task list, and off a filter that would hide the task.
  useEffect(
    () =>
      useTaskReveal.subscribe((s, prev) => {
        if (s.n === prev.n || !s.taskId) return;
        setView("tasks");
        const task = tasks.data?.find((x) => x.id === s.taskId);
        if (!task || !taskMatchesFilter(task, filter)) setFilter("all");
      }),
    [tasks.data, filter],
  );

  if (!projectId) return null;
  const counts = filterCounts(all, goals);
  // A plan of one task, or Run as one task, became an ordinary task: show it as that task.
  const onCollapsed = (id: string) => {
    openGoal(null);
    selectTask(id);
  };
  const empty = tasks.isSuccess && all.length === 0 && goals.length === 0;

  return (
    <div className="screen">
      <div className="page-head">
        <div className="tk-head-main">
          <h1>{t("title")}</h1>
          {project && (
            <div className="lbl tk-context" title={project.path}>
              <span className="as-typed">
                {project.name} · {project.path}
              </span>
            </div>
          )}
        </div>
        <div className="right">
          <div className="seg" role="group" aria-label={t("view.label")}>
            <button type="button" aria-pressed={view === "tasks"} onClick={() => setView("tasks")}>
              {t("view.tasks")}
            </button>
            <button type="button" aria-pressed={view === "schedules"} onClick={() => setView("schedules")}>
              {t("view.schedules")}
              <span className="muted num"> {schedules.data?.length ?? 0}</span>
            </button>
          </div>
        </div>
      </div>
      {view === "schedules" && (
        <Schedules
          projectId={projectId}
          onOpenTask={(id) => {
            selectTask(id);
            setView("tasks");
          }}
        />
      )}
      {view === "tasks" && (
        <>
          {/* One focus at a time (DESIGN.md principle 2): the composer folds while a goal or plan is open. */}
          <Composer key={projectId} projectId={projectId} projectName={project?.name ?? ""} projectPath={project?.path ?? null} assistantOpen={assistant} onAssistant={() => toggleAssistant(projectId)} folded={goal !== null} />
          {goal && planOpen && (
            <GoalPlanReview key={goal.id} goal={goal} offline={offline} onClose={() => openGoal(null)} onBack={goal.approvedRevision !== null ? () => setReviewing(null) : undefined} onCollapsed={onCollapsed} />
          )}
          {goal && !planOpen && <GoalView key={goal.id} goal={goal} requests={requests.data ?? []} offline={offline} keyboard onReviewPlan={() => setReviewing(goal.id)} onClose={() => openGoal(null)} />}
          {!goal && proposing && selected && draft.data && draft.data.id === selected.id && <CrewProposal key={selected.id} task={draft.data} onClose={() => selectTask(selected.id)} />}
          {!goal && comparing && group.data && group.data.id === selected.id && <BestOfCompare detail={group.data} />}

          <div className="tk-list-head">
            <div className="tabs" role="tablist" aria-label={t("filters.label")}>
              {FILTERS.map((f) => (
                <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
                  {t(`filters.${f}`)}
                  <span className="muted num">{counts[f]}</span>
                </button>
              ))}
            </div>
          </div>
          <Panel className="tk-list">
            {tasks.isError && <p className="tk-empty muted">{t("errors.load")}</p>}
            {empty && (
              <p className="tk-empty muted">
                {t("empty.none")}
                {orchestra.data?.enabled === true && (
                  <>
                    <br />
                    {t("empty.goals")}
                  </>
                )}
              </p>
            )}
            {tasks.isSuccess && !empty && shown.length === 0 && shownGoals.length === 0 && <p className="tk-empty muted">{t("empty.filter")}</p>}
            {shownGoals.map((g) => (
              <GoalRow
                key={g.id}
                goal={g}
                tasks={all}
                requests={requests.data ?? []}
                selected={g.id === goalId}
                onSelect={(id) => openGoal(id === goalId ? null : id)}
                renderTask={(x) => <TaskRow summary={x} requests={requests.data ?? []} />}
              />
            ))}
            {shown.map((s, i) => (
              <LazyRow key={s.id} index={i + shownGoals.length} force={s.id === taskId}>
                <TaskRow summary={s} requests={requests.data ?? []} />
              </LazyRow>
            ))}
          </Panel>
        </>
      )}
    </div>
  );
}
