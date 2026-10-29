import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDaemon } from "../ipc.ts";
import { useNav } from "../nav.ts";

export function TitleBar() {
  const { t } = useTranslation();
  const { projectId, closeProject } = useNav();
  const projects = useDaemon("projects.list", undefined);
  const project = projects.data?.find((p) => p.id === projectId);

  return (
    <header className="titlebar">
      <div className="brand">
        <span className="mark" aria-hidden="true" />
        {t("app.name")}
      </div>
      <button className="tb-chip" onClick={closeProject} title={t("titlebar.allProjects")}>
        <FolderOpen size={15} strokeWidth={1.75} />
        {project?.name ?? t("titlebar.noProject")}
      </button>
      <div className="tb-drag" />
    </header>
  );
}
