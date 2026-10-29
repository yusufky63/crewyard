import { useTranslation } from "react-i18next";
import { Dot } from "@crewyard/ui";
import { useNav } from "../../nav.ts";
import type { StatusItemDef } from "../../registry.ts";
import { useWork } from "../../screens/tasks/data.ts";

// Running / queued runs and "need you" for the open project (DESIGN.md §4 status bar, left side).
// Each opens its screen. Nothing shows without a project.

function WorkStatus() {
  const { t } = useTranslation("tasks");
  const { projectId, go } = useNav();
  const tasks = useWork("tasks.list", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  const requests = useWork("requests.list", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  if (!projectId || !tasks.data) return null;
  const running = tasks.data.reduce((n, x) => n + x.activeRuns, 0);
  const queued = tasks.data.filter((x) => x.status === "queued").length;
  const needYou = requests.data?.filter((q) => q.answeredAt === null).length ?? 0;
  return (
    <>
      <button className="sb" onClick={() => go("tasks")} title={t("statusbar.runningTitle")}>
        <Dot color={running > 0 ? "var(--accent)" : "var(--ink-3)"} />
        {t("statusbar.running", { running, queued })}
      </button>
      {needYou > 0 && (
        <button className="sb" onClick={() => go("inbox")} title={t("statusbar.needYouTitle")}>
          <Dot color="var(--warn)" />
          {t("statusbar.needYou", { count: needYou })}
        </button>
      )}
    </>
  );
}

export const item: StatusItemDef = { id: "work", side: "start", order: 10, component: WorkStatus };
