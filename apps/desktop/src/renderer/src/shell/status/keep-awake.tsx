import { BatteryLow, Coffee } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StatusItemDef } from "../../registry.ts";
import { useBatteryReport, useKeepAwake, useKeepAwakeLine } from "../../screens/settings/KeepAwake.tsx";
import { openSettings } from "../../screens/settings/model.ts";

// Keep-awake state on the right of the status bar (feature scan A15), next to quiet hours. Hidden
// while the setting is off. Always mounted, so it also feeds the battery guard the charge.

function KeepAwakeStatus() {
  const { t } = useTranslation("settings");
  useBatteryReport();
  const s = useKeepAwake();
  const line = useKeepAwakeLine();
  if (!s || s.state === "off") return null;
  const Icon = s.state === "battery" ? BatteryLow : Coffee;
  return (
    <button type="button" className="sb" onClick={() => openSettings("startup")} title={line(s)}>
      <Icon size={13} strokeWidth={1.75} />
      {s.state === "active" ? <b>{t("status.awake")}</b> : s.state === "battery" ? t("status.awakeBattery") : t("status.awakeIdle")}
    </button>
  );
}

export const item: StatusItemDef = { id: "keep-awake", side: "end", order: 85, component: KeepAwakeStatus };
