import { useTranslation } from "react-i18next";
import type { ProjectConfigStatus } from "@crewyard/core";
import { useDaemon } from "../../ipc.ts";

// Notices for projects whose .crewyard/project.json came from a newer Crewyard, cannot be used, or
// had values this version does not know. Owned by the project setup work; the daemon side is
// setup.configNotices.

function statusText(t: (key: string, opts?: Record<string, unknown>) => string, status: ProjectConfigStatus): string {
  if (status.state === "newer") return t(status.understood ? "configNotice.newer" : "configNotice.newerUnknown", { version: status.version });
  if (status.state === "invalid") return t("configNotice.invalid", { reason: t(`configNotice.reason.${status.reason}`) });
  if (status.state === "valid") return t("configNotice.fallbacks", { count: status.fallbacks.length });
  return "";
}

export function ConfigNotices() {
  const { t } = useTranslation("settings");
  const notices = useDaemon("setup.configNotices", undefined);
  if (!notices.data?.length) return null;
  return (
    <>
      <p className="st-note">{t("configNotice.lead")}</p>
      <div className="st-list" role="list" aria-label={t("configNotice.label")}>
        {notices.data.map((n) => (
          <div className="st-item st-config" role="listitem" key={n.projectId}>
            <span className="st-item-name">{n.name}</span>
            <span className="st-config-text">
              <span className={n.status.state === "invalid" ? "st-bad" : "st-warn"}>{statusText(t, n.status)}</span>
              {n.status.state !== "missing" && (
                <span className="st-item-path mono as-typed muted" title={n.status.file}>
                  {n.status.file}
                </span>
              )}
              {"fallbacks" in n.status &&
                n.status.fallbacks.map((f) => (
                  <span key={f.path} className="st-item-path mono as-typed muted">
                    {f.used === null ? t("configNotice.dropped", { path: f.path, value: f.value }) : t("configNotice.fallback", { path: f.path, value: f.value, used: f.used })}
                  </span>
                ))}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
