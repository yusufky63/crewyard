import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CirclePause } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StatusItemDef } from "../../registry.ts";
import { act, useWork } from "../../screens/tasks/data.ts";
import { useGoalsChanged } from "../../screens/tasks/GoalRow.tsx";

// `Pause all goals` in the status bar (docs/adr/0019, design §3.6 and §5.2). Nothing shows while
// goals run: the work and need-you counts already include goal tasks. Only while the global switch
// is on does this item say so, with `Resume`; lifting it is your click.

function GoalsStatus() {
  const { t } = useTranslation("goals");
  useGoalsChanged();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const state = useWork("goals.state", undefined, { staleTime: 10_000, retry: false });
  // Screenshot fixtures answer unknown methods with a task; only a boolean `pausedAll` counts.
  if (state.data?.pausedAll !== true) return null;
  return (
    <button
      type="button"
      className="sb"
      disabled={busy}
      title={t("statusbar.title")}
      onClick={() => {
        setBusy(true);
        void act("goals.pauseAll", { on: false })
          .then((r) => qc.setQueryData(["goals.state", undefined], { ...state.data, pausedAll: r.pausedAll }))
          .catch(() => void qc.invalidateQueries({ queryKey: ["goals.state"] }))
          .finally(() => setBusy(false));
      }}
    >
      <CirclePause size={13} strokeWidth={1.75} aria-hidden="true" color="var(--warn)" />
      <b style={{ color: "var(--warn)" }}>{t("statusbar.paused")}</b>
      <span style={{ color: "var(--ok)" }}>{t("statusbar.resume")}</span>
    </button>
  );
}

export const item: StatusItemDef = { id: "goals", side: "end", order: 75, component: GoalsStatus };
