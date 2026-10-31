import { useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { CircleAlert, CircleX, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ACTIVITY_LOG_MAX, type LogLevel } from "@crewyard/core";
import { Button } from "@crewyard/ui";
import { useDaemon } from "../../ipc.ts";
import { ALL_LOGS, filterLogs, LOG_STEP, type LevelFilter, type LogFilter } from "./model.ts";

// Crewyard's own log lines (main process, daemon, updater), newest first. The daemon redacts every
// line before it answers; runner output and runner credentials are never part of these files.

const POLL_MS = 5000;

function LevelMark({ level }: { level: LogLevel }) {
  const { t } = useTranslation("activity");
  const Icon = level === "error" ? CircleX : level === "warn" ? CircleAlert : Info;
  return (
    <span className={`log-level l-${level}`}>
      <Icon size={12} strokeWidth={1.75} aria-hidden="true" />
      {t(`logs.level.${level}`)}
    </span>
  );
}

export function LogsPanel() {
  const { t, i18n } = useTranslation("activity");
  const [filter, setFilter] = useState<LogFilter>(ALL_LOGS);
  const [limit, setLimit] = useState(LOG_STEP);
  // Polls only while the tab is open: the drawer unmounts this panel when it closes.
  const logs = useDaemon("activity.logs", { limit }, { refetchInterval: POLL_MS, placeholderData: keepPreviousData });
  const lines = filterLogs(logs.data?.lines ?? [], filter);
  const fmt = new Intl.DateTimeFormat(i18n.language, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div className="logs">
      <div className="drawer-tools" role="group" aria-label={t("logs.filters")}>
        <label className="drawer-field">
          <span className="lbl" aria-hidden="true">{t("logs.source")}</span>
          <select aria-label={t("logs.source")} className="drawer-select" value={filter.source} onChange={(e) => setFilter({ ...filter, source: e.target.value as LogFilter["source"] })}>
            {(["all", "main", "daemon", "updater"] as const).map((s) => (
              <option key={s} value={s}>
                {t(`logs.sources.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="drawer-field">
          <span className="lbl" aria-hidden="true">{t("logs.levelLabel")}</span>
          <select aria-label={t("logs.levelLabel")} className="drawer-select" value={filter.level} onChange={(e) => setFilter({ ...filter, level: e.target.value as LevelFilter })}>
            {(["all", "warn", "error"] as const).map((l) => (
              <option key={l} value={l}>
                {t(`logs.levels.${l}`)}
              </option>
            ))}
          </select>
        </label>
        <span className="drawer-note muted">{t("logs.redacted")}</span>
        <div className="drawer-pager">
          {logs.data?.dir && (
            <Button variant="ghost" size="sm" onClick={() => window.crewyard.revealPath(logs.data!.dir)} title={logs.data.dir}>
              {t("logs.openFolder")}
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={!logs.data?.more || limit >= ACTIVITY_LOG_MAX} onClick={() => setLimit((n) => Math.min(ACTIVITY_LOG_MAX, n + LOG_STEP))}>
            {t("logs.older")}
          </Button>
        </div>
      </div>
      {logs.isError ? (
        <p className="drawer-empty">{t("logs.error")}</p>
      ) : logs.isPending ? (
        <p className="drawer-empty muted">{t("loading")}</p>
      ) : lines.length === 0 ? (
        <p className="drawer-empty muted">{(logs.data?.lines.length ?? 0) > 0 ? t("logs.noneFiltered") : t("logs.none")}</p>
      ) : (
        <ol className="log-list" aria-label={t("logs.listLabel")}>
          {lines.map((l) => (
            <li key={l.id} className="log-row">
              <time className="ev-time" dateTime={l.at ?? undefined}>
                {l.at ? fmt.format(new Date(l.at)) : ""}
              </time>
              <LevelMark level={l.level} />
              <span className="log-source">{t(`logs.sources.${l.source}`)}</span>
              <span className="log-text">{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
