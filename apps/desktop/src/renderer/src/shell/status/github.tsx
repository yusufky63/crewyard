import { GitPullRequest } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import type { StatusItemDef } from "../../registry.ts";
import { useGithubLive, useMinuteTick, useNumber, useRelative } from "../../screens/github/live.ts";
import "../../screens/github/github.css";

// Last GitHub sync and Actions minutes, right side of the status bar (DESIGN.md §4). Both open the GitHub screen.

function GithubStatus() {
  const { t } = useTranslation("github");
  const { projectId, go } = useNav();
  useGithubLive();
  const now = useMinuteTick();
  const rel = useRelative();
  const fmt = useNumber();
  const sync = useDaemon("github.sync", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  const minutes = useDaemon("github.minutes", { projectId }, { staleTime: 10 * 60_000 });
  const open = projectId ? () => go("github") : undefined;
  const m = minutes.data;
  const used = m?.provenance === "reported" && m.usedMinutes !== null ? fmt(m.usedMinutes) : null;
  const value = used === null ? t("status.unknown") : m?.includedMinutes ? `${used}/${fmt(m.includedMinutes)}` : used;
  const s = sync.data;
  const syncText = s?.refreshing ? t("status.syncing") : s?.syncedAt ? rel(s.syncedAt, now) : t("status.never");
  return (
    <>
      {projectId && (
        <button className="sb sb-gh" onClick={open} title={t("status.syncTitle")}>
          <GitPullRequest size={13} strokeWidth={1.75} />
          {t("status.sync")} <b>{syncText}</b>
        </button>
      )}
      {m && (
        <button className="sb sb-gh" onClick={open} disabled={!open} title={t("status.actionsTitle")}>
          {t("status.actions")} <b>{value}</b>
        </button>
      )}
    </>
  );
}

export const item: StatusItemDef = { id: "github", side: "end", order: 50, component: GithubStatus };
