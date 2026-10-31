import { useTranslation } from "react-i18next";
import type { ConfigFallback, ProjectConfigStatus } from "@crewyard/core";
import { Row } from "./parts.tsx";

/** One line per value this build did not know: what the file says and what Crewyard uses instead. */
export function FallbackList({ fallbacks }: { fallbacks: ConfigFallback[] }) {
  const { t } = useTranslation("setup");
  return (
    <>
      {fallbacks.map((f) => (
        <span key={f.path} className="mono small block as-typed">
          {f.used === null ? t("config.dropped", { path: f.path, value: f.value }) : t("config.fallback", { path: f.path, value: f.value, used: f.used })}
        </span>
      ))}
    </>
  );
}

/** What reading .crewyard/project.json found, shown first on the Folder step. Nothing when there is no file. */
export function ConfigRow({ status }: { status: ProjectConfigStatus }) {
  const { t } = useTranslation("setup");
  if (status.state === "missing") return null;
  if (status.state === "valid") {
    const n = status.fallbacks.length;
    return (
      <Row state={n ? "wait" : "ok"} label={t("folder.existing")}>
        {t("folder.existingText")}
        {n > 0 && <span className="block">{t("config.unknown", { count: n })}</span>}
        <FallbackList fallbacks={status.fallbacks} />
      </Row>
    );
  }
  if (status.state === "newer") {
    return (
      <Row state="wait" label={t("config.newer")}>
        {t("config.newerText", { version: status.version })}
        {!status.understood && <span className="block">{t("config.newerUnknown")}</span>}
        {status.detail && <span className="mono small block as-typed">{status.detail}</span>}
        {status.fallbacks.length > 0 && <span className="block">{t("config.unknown", { count: status.fallbacks.length })}</span>}
        <FallbackList fallbacks={status.fallbacks} />
      </Row>
    );
  }
  return (
    <Row state="bad" label={t("config.invalid")}>
      {t(`config.reason.${status.reason}`)}
      {status.reason !== "not_object" && <span className="mono small block as-typed">{status.detail}</span>}
      <span className="block">{t("config.invalidAfter")}</span>
    </Row>
  );
}
