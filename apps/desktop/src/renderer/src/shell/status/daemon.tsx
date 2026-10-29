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
  return (
    <span className="sb" title={title}>
      <Dot color={color} />
      {t(`status.daemon.${state}`)}
    </span>
  );
}

export const item: StatusItemDef = { id: "daemon", side: "start", order: 0, component: DaemonState };
