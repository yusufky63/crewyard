import { Plug } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StatusItemDef } from "../../registry.ts";
import { useExternalAccess } from "../../screens/settings/ExternalSection.tsx";
import { openSettings } from "../../screens/settings/model.ts";

// Shown only while external access is on (docs/adr/0021), so it is never on without you seeing it:
// how many clients are connected now. A click opens Settings → External access.

function ExternalStatus() {
  const { t } = useTranslation("settings");
  const { data: v } = useExternalAccess();
  if (!v?.enabled) return null;
  const connected = v.clients.filter((c) => c.connected > 0).length;
  return (
    <button type="button" className="sb" onClick={() => openSettings("external")} title={t("external.statusTitle")}>
      <Plug size={13} strokeWidth={1.75} aria-hidden="true" color={v.error ? "var(--bad)" : "var(--ok)"} />
      <span>{v.error ? t("external.statusFailed") : t("external.status", { count: connected })}</span>
    </button>
  );
}

export const item: StatusItemDef = { id: "external", side: "end", order: 75, component: ExternalStatus };
