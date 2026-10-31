import { CirclePause, CirclePlay } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StatusItemDef } from "../../registry.ts";
import { useAutopilotGlobal } from "../../screens/settings/AutopilotSection.tsx";

// Autopilot's kill switch in the status bar (docs/adr/0017), shown while any project has it on or
// while the stop is pressed. One click refuses every Autopilot action at once; running agents go on.

function AutopilotStatus() {
  const { t } = useTranslation("autopilot");
  const g = useAutopilotGlobal();
  const v = g.data;
  if (!v || (!v.killed && v.projects.length === 0)) return null;
  // The action word wears its state colour (owner, 2026-10-31: use red, amber and green): Stop Autopilot in bad,
  // Lift the stop in ok, and the stopped state in bad like the kill switch in Settings. The words say it too.
  if (v.killed)
    return (
      <button type="button" className="sb" onClick={() => void g.kill(false)} title={t("status.lift")}>
        <CirclePlay size={13} strokeWidth={1.75} aria-hidden="true" color="var(--ok)" />
        <b style={{ color: "var(--bad)" }}>{t("status.stopped")}</b>
        <span style={{ color: "var(--ok)" }}>{t("status.lift")}</span>
      </button>
    );
  return (
    <button type="button" className="sb" onClick={() => void g.kill(true)} title={t("status.stopTitle")}>
      <CirclePause size={13} strokeWidth={1.75} aria-hidden="true" color="var(--bad)" />
      <span>{t("status.on", { count: v.projects.length })}</span>
      <b style={{ color: "var(--bad)" }}>{t("status.stop")}</b>
    </button>
  );
}

export const item: StatusItemDef = { id: "autopilot", side: "end", order: 80, component: AutopilotStatus };
