import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@crewyard/ui";
import type { WorktreeDiskItem } from "@crewyard/core";
import { call, useDaemon } from "../../ipc.ts";
import { formatBytes } from "../settings/model.ts";
import "./worktree-disk.css";

// Disk meter and park for task worktrees (worktree bootstrap). Owned by the worktree bootstrap work;
// mounted in the GitHub screen's worktrees panel. Strings live in the "worktrees" namespace.

const SHOWN = 5;

/** The daemon throws codes; Electron wraps them as "Error invoking remote method ...: Error: <code>". */
const codeOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).match(/([a-z]+\.[a-z_]+)\s*$/)?.[1] ?? "unknown";

function DiskRow({ item }: { item: WorktreeDiskItem }) {
  const { t, i18n } = useTranslation("worktrees");
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parked = item.state === "parked";
  const act = async () => {
    setBusy(true);
    setError(null);
    try {
      await call(parked ? "worktrees.unpark" : "worktrees.park", { taskId: item.taskId });
    } catch (err) {
      setError(t(`error.${codeOf(err)}`, { defaultValue: t("error.unknown") }));
    } finally {
      setBusy(false);
      setAsking(false);
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "worktrees.disk" || String(q.queryKey[0]).startsWith("github.") });
    }
  };
  const size = item.bytes === null ? t("noSize") : `${item.truncated ? "≥ " : ""}${formatBytes(item.bytes, i18n.language)}`;
  return (
    <div className="gh-note wt-disk-row" title={item.path}>
      <div className="gh-wt-row">
        <span className="wt-disk-name">
          <span>{item.title || item.branch}</span>
          <span className="mono">{parked ? t("parked") : size}</span>
          {item.port !== null && <span className="mono">{t("port", { port: item.port })}</span>}
          {item.state === "failed" && <span className="badge badge-bad">{t("state.failed")}</span>}
          {item.state === "waiting_approval" && <span className="badge badge-warn">{t("state.waiting_approval")}</span>}
        </span>
        {asking ? (
          <span className="gh-act-stack">
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
              {t("cancel")}
            </Button>
            {/* Parking commits the work and keeps the branch, so it can be undone: warn, like the Park that asked. */}
            <Button size="sm" variant="ghost" tone="warn" autoFocus onClick={() => void act()} disabled={busy}>
              {t("parkNow")}
            </Button>
          </span>
        ) : parked ? (
          <Button size="sm" variant="ghost" tone="ok" onClick={() => void act()} disabled={busy}>
            {t("unpark")}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" tone="warn" onClick={() => setAsking(true)} disabled={busy || item.running} title={item.running ? t("runningHint") : undefined}>
            {t("park")}
          </Button>
        )}
      </div>
      {asking && <span>{t("parkConfirm", { branch: item.branch })}</span>}
      {error && <span className="gh-bad">{error}</span>}
      {item.failure && (
        <details className="wt-disk-fail">
          <summary className="gh-bad">{t(item.failure.timedOut ? "failure.timedOut" : "failure.title", { command: item.failure.command })}</summary>
          <pre className="mono">{item.failure.tail || t("failure.noOutput")}</pre>
        </details>
      )}
    </div>
  );
}

export function WorktreeDisk({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation("worktrees");
  const qc = useQueryClient();
  const q = useDaemon("worktrees.disk", { projectId }, { staleTime: 60_000 });
  useEffect(() => window.crewyard.on("worktrees.changed", () => void qc.invalidateQueries({ queryKey: ["worktrees.disk"] })), [qc]);
  if (q.isError) return <span className="gh-note gh-bad">{t("error.load")}</span>;
  if (!q.data) return <span className="gh-note">{t("measuring")}</span>;
  if (q.data.items.length === 0) return null;
  return (
    <div className="wt-disk">
      <span className="gh-note">{t("total", { size: formatBytes(q.data.totalBytes, i18n.language), count: q.data.items.length })}</span>
      {q.data.items.slice(0, SHOWN).map((i) => (
        <DiskRow key={i.taskId} item={i} />
      ))}
      {q.data.items.length > SHOWN && <span className="gh-note">{t("more", { count: q.data.items.length - SHOWN })}</span>}
    </div>
  );
}
