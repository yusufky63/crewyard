import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Moon, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { inQuietHours, type AppSettings } from "@crewyard/core";
import { useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import type { StatusItemDef } from "../../registry.ts";
import { openSettings } from "../../screens/settings/model.ts";

// Quiet hours on the right of the status bar (DESIGN.md §4), and the way into Settings from every
// screen, including Start, where the sidebar is hidden.

function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function SettingsStatus() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const screen = useNav((s) => s.screen);
  const settings = useDaemon("settings.get", undefined);
  const now = useMinute();
  useEffect(() => window.crewyard.on("settings.changed", (p) => qc.setQueryData(["settings.get", undefined], p as AppSettings)), [qc]);
  const q = settings.data?.notifications.quietHours;
  const active = q ? inQuietHours(q, now) : false;
  return (
    <>
      {q?.enabled && (
        <button type="button" className="sb" onClick={() => openSettings("notifications")} title={t("status.quietTitle")}>
          <Moon size={13} strokeWidth={1.75} />
          {active ? <b>{t("status.quietActive")}</b> : t("status.quiet", { from: q.start, to: q.end })}
        </button>
      )}
      <button type="button" className="sb" onClick={() => openSettings()} aria-current={screen === "settings" ? "page" : undefined} title={t("status.settings")}>
        <Settings size={13} strokeWidth={1.75} />
        {t("status.settings")}
      </button>
    </>
  );
}

export const item: StatusItemDef = { id: "settings", side: "end", order: 90, component: SettingsStatus };
