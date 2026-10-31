import { Download, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StatusItemDef } from "../../registry.ts";
import { openSettings } from "../../screens/settings/model.ts";
import { useUpdates } from "../../screens/settings/Updates.tsx";

// A found or downloaded update on the right of the status bar (docs/adr/0011). Hidden otherwise,
// so an automatic check that finds nothing never adds noise. A click opens Settings → Updates;
// downloading and installing stay there, behind their own buttons.

function UpdateStatus() {
  const { t } = useTranslation("settings");
  const s = useUpdates();
  const version = s?.available?.version ?? "";
  if (s?.phase === "available") {
    return (
      <button type="button" className="sb" onClick={() => openSettings("updates")} title={t("status.updateTitle", { version })}>
        <Download size={13} strokeWidth={1.75} />
        {t("status.update", { version })}
      </button>
    );
  }
  if (s?.phase === "downloading") {
    return (
      <button type="button" className="sb" onClick={() => openSettings("updates")} title={t("updates.downloading")}>
        <span className="spin" />
        {t("status.updateDownloading", { pct: Math.floor(s.progress?.percent ?? 0) })}
      </button>
    );
  }
  if (s?.phase === "downloaded") {
    return (
      <button type="button" className="sb" onClick={() => openSettings("updates")} title={t("status.updateReadyTitle", { version })}>
        <RotateCcw size={13} strokeWidth={1.75} color="var(--ok)" />
        <b style={{ color: "var(--ok)" }}>{t("status.updateReady")}</b>
      </button>
    );
  }
  return null;
}

export const item: StatusItemDef = { id: "update", side: "end", order: 88, component: UpdateStatus };
