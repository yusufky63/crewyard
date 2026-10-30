import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SidebarBlockDef } from "../../registry.ts";
import { openSettings } from "../../screens/settings/model.ts";

// "Settings" at the foot of the sidebar, under the accounts block (DESIGN.md §4).

function SettingsLink() {
  const { t } = useTranslation("settings");
  return (
    <button type="button" className="nav" onClick={() => openSettings()} title={t("nav")}>
      <Settings size={16} strokeWidth={1.75} />
      <span className="t">{t("nav")}</span>
    </button>
  );
}

export const block: SidebarBlockDef = { id: "settings", order: 90, component: SettingsLink };
