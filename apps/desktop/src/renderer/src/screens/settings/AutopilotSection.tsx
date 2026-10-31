import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AutopilotGlobal } from "@crewyard/core";
import { call } from "../../ipc.ts";
import { Row, Section, Toggle } from "./parts.tsx";

// Autopilot's kill switch (docs/adr/0017). Autopilot is turned on per project in the task
// assistant; this section and the status bar item stop it everywhere at once. It never stops a
// running agent: steps already started finish under their own budgets.

const KEY = ["autopilot.global"];

/** Shared by this section and the status bar item; live through `autopilot.changed`. */
export function useAutopilotGlobal() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => call("autopilot.global", {}), staleTime: 30_000 });
  useEffect(() => window.crewyard.on("autopilot.changed", () => void qc.invalidateQueries({ queryKey: KEY })), [qc]);
  const kill = async (killed: boolean): Promise<AutopilotGlobal> => {
    const next = await call("autopilot.kill", { killed });
    qc.setQueryData(KEY, next);
    return next;
  };
  return { data: q.data, kill };
}

export function AutopilotSection({ index }: { index: number }) {
  const { t } = useTranslation("autopilot");
  const ts = useTranslation("settings").t;
  const g = useAutopilotGlobal();
  const v = g.data;
  return (
    <Section id="autopilot" index={index} title={ts("sections.autopilot")}>
      <Row label={t("settings.kill")} hint={t("settings.killHint")}>
        <Toggle label={t("settings.kill")} value={v?.killed ?? false} onChange={(on) => void g.kill(on)} disabled={!v} />
      </Row>
      <Row label={t("settings.projects")} hint={t("settings.hint")}>
        <span className="st-note">{v && v.projects.length > 0 ? v.projects.map((p) => (p.halted ? `${p.name} (${t("settings.halted")})` : p.name)).join(", ") : t("settings.none")}</span>
      </Row>
    </Section>
  );
}
