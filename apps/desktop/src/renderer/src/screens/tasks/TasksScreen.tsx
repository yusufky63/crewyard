import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Panel } from "@crewyard/ui";
import { useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import { Composer } from "./Composer.tsx";
import { CrewProposal } from "./CrewProposal.tsx";
import { useWork } from "./data.ts";
import { useFixtureState } from "./fixtureState.ts";
import { FILTERS, filterCounts, matchesFilter, type Filter } from "./model.ts";
import { TaskRow } from "./TaskRow.tsx";
import "./tasks.css";

export function TasksScreen() {
  const { t } = useTranslation("tasks");
  useFixtureState();
  const { projectId, taskId, selectTask } = useNav();
  const [filter, setFilter] = useState<Filter>("all");
  const projects = useDaemon("projects.list", undefined);
  const project = projects.data?.find((p) => p.id === projectId);
  const tasks = useWork("tasks.list", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  const requests = useWork("requests.list", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  const selected = tasks.data?.find((x) => x.id === taskId);
  const draft = useWork("tasks.get", { taskId: selected?.id ?? "" }, { enabled: selected?.status === "proposed" });

  if (!projectId) return null;
  const all = tasks.data ?? [];
  const counts = filterCounts(all);
  const shown = all.filter((x) => matchesFilter(x.status, filter));

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <h1>{t("title")}</h1>
          {project && (
            <div className="lbl tk-context" title={project.path}>
              {project.name} · {project.path}
            </div>
          )}
        </div>
      </div>
      <Composer projectId={projectId} projectName={project?.name ?? ""} />
      {selected?.status === "proposed" && draft.data && draft.data.id === selected.id && <CrewProposal key={selected.id} task={draft.data} onClose={() => selectTask(selected.id)} />}

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
        {shown.map((s) => (
          <TaskRow key={s.id} summary={s} requests={requests.data ?? []} />
        ))}
      </Panel>
    </div>
  );
}
