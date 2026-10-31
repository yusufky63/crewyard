import { useTranslation } from "react-i18next";
import { Dot } from "@crewyard/ui";
import { useDaemon } from "../../ipc.ts";
import type { StatusItemDef } from "../../registry.ts";

function DaemonState() {
  const { t } = useTranslation();
  const status = useDaemon("daemon.status", undefined, { retry: 5, retryDelay: 800, refetchInterval: 15_000 });
  const state = status.isSuccess ? "running" : status.isError ? "down" : "starting";
  const color = state === "running" ? "var(--ok)" : state === "down" ? "var(--bad)" : "var(--warn)";
  const title = status.data ? `Node ${status.data.versions.node} · SQLite ${status.data.versions.sqlite} · ${status.data.dbPath}` : undefined;
  // The word takes the state colour with its dot: running in ok, starting in warn, offline in bad (owner,
  // 2026-10-31: use red, amber and green). The word still says the state.
  return (
    <span className="sb" title={title}>
      <Dot color={color} />
      <span style={{ color }}>{t(`status.daemon.${state}`)}</span>
    </span>
  );
}

export const item: StatusItemDef = { id: "daemon", side: "start", order: 0, component: DaemonState };
