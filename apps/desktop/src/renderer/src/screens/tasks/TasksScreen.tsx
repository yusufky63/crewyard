import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Panel } from "@crewyard/ui";
import { useInspector } from "../../inspector.ts";
import { useDaemon } from "../../ipc.ts";
import { matches } from "../../keys.ts";
import { useListKeys } from "../../listKeys.ts";
import { useNav } from "../../nav.ts";
import { AssistantPanel } from "./Assistant.tsx";
import { BestOfCompare } from "./BestOfCompare.tsx";
import { Composer } from "./Composer.tsx";
import { FIXTURE } from "./fixture.ts";
import { Schedules } from "./Schedules.tsx";
import { CrewProposal } from "./CrewProposal.tsx";
import { act, useWork } from "./data.ts";
import { useFixtureState } from "./fixtureState.ts";
import { FILTERS, filterCounts, matchesFilter, type Filter } from "./model.ts";
import { TaskRow } from "./TaskRow.tsx";
import "./tasks.css";
import { LazyRow } from "./LazyRow.tsx";

export function TasksScreen() {
  const { t } = useTranslation("tasks");
  useFixtureState();
  const { projectId, taskId, selectTask } = useNav();
  const [filter, setFilter] = useState<Filter>("all");
  // Schedules are the screen's second view; screenshot mode can open it with `view=schedules`.
  const [view, setView] = useState<"tasks" | "schedules">(() => (FIXTURE && new URLSearchParams(location.search).get("view") === "schedules" ? "schedules" : "tasks"));
  const schedules = useWork("schedules.list", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  const projects = useDaemon("projects.list", undefined);
  const project = projects.data?.find((p) => p.id === projectId);
  const tasks = useWork("tasks.list", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  const requests = useWork("requests.list", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  const selected = tasks.data?.find((x) => x.id === taskId);
  const draft = useWork("tasks.get", { taskId: selected?.id ?? "" }, { enabled: selected?.status === "proposed" });
  // A selected Best of N task that is still choosing shows its variants side by side.
  const comparing = selected?.bestOf && ["running", "choosing", "failed"].includes(selected.bestOf.phase) && !selected.cancelledAt;
  const group = useWork("tasks.get", { taskId: selected?.id ?? "" }, { enabled: Boolean(comparing) });
  const inspect = useInspector((s) => s.open);
  // The task assistant (docs/adr/0014) opens beside the composer; closing it stops its session.
  const [assistant, setAssistant] = useState(false);
  const closeAssistant = useCallback(() => {
    setAssistant(false);
    // Closing returns focus to the button that opens it again.
    requestAnimationFrame(() => document.getElementById("tk-assistant-toggle")?.focus({ preventScroll: true }));
  }, []);
  const toggleAssistant = useCallback(() => {
    if (!assistant) return setAssistant(true);
    // Closing stops the session; the conversation and drafts stay.
    if (projectId) void act("assistant.stop", { projectId }).catch(() => undefined);
    closeAssistant();
  }, [assistant, projectId, closeAssistant]);
  useEffect(() => {
    if (!projectId || view !== "tasks") return;
    const onKey = (e: KeyboardEvent) => {
      if (!matches(e, "assistant") || e.defaultPrevented || e.repeat || document.querySelector("dialog[open]")) return;
      e.preventDefault();
      toggleAssistant();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projectId, view, toggleAssistant]);
  const all = tasks.data ?? [];
  const shown = all.filter((x) => matchesFilter(x.status, filter));
  // J and K select as a click on the row does: the task, and the inspector on it.
  useListKeys(
    shown.map((x) => x.id),
    taskId,
    (id) => {
      selectTask(id);
      inspect({ taskId: id });
    },
    view === "tasks",
  );

  if (!projectId) return null;
  const counts = filterCounts(all);

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
          <Composer projectId={projectId} projectName={project?.name ?? ""} assistantOpen={assistant} onAssistant={toggleAssistant} />
          {assistant && <AssistantPanel key={projectId} projectId={projectId} onClose={closeAssistant} />}
          {selected?.status === "proposed" && draft.data && draft.data.id === selected.id && <CrewProposal key={selected.id} task={draft.data} onClose={() => selectTask(selected.id)} />}
          {comparing && group.data && group.data.id === selected.id && <BestOfCompare detail={group.data} />}

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
            {tasks.isSuccess && all.length === 0 && <p className="tk-empty muted">{t("empty.none")}</p>}
            {tasks.isSuccess && all.length > 0 && shown.length === 0 && <p className="tk-empty muted">{t("empty.filter")}</p>}
            {shown.map((s, i) => (
              <LazyRow key={s.id} index={i}>
                <TaskRow summary={s} requests={requests.data ?? []} />
              </LazyRow>
            ))}
          </Panel>
        </>
      )}
    </div>
  );
}
