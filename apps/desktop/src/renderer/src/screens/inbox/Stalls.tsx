import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Clock, Hourglass, Repeat } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StallAlertView } from "@crewyard/core";
import { Button, Panel } from "@crewyard/ui";
import { useInspector } from "../../inspector.ts";
import { act, useWork } from "../tasks/data.ts";
import { profileNames } from "../tasks/model.ts";
import { ConfirmButton, useFormat } from "../tasks/parts.tsx";
import { stallText } from "./model.ts";

// Stall alerts in the Inbox (feature scan A7): a run that went quiet, a step failing the same way
// again and again, a request nobody answered. Each is its own item until it clears on its own or
// you dismiss it; what to do about it stays your call, so the actions only open, stop or dismiss.

const ICON = { no_events: Hourglass, same_failure: Repeat, request_unanswered: Clock } as const;

/** Keeps `stalls.list` fresh; the daemon pushes `stalls.changed` when an item opens or closes. */
export function useStalls(projectId: string) {
  const qc = useQueryClient();
  useEffect(() => window.crewyard.on("stalls.changed", () => void qc.invalidateQueries({ queryKey: ["stalls.list"] })), [qc]);
  return useWork("stalls.list", { projectId });
}

function StallItem({ a, onOpenRequest, onError }: { a: StallAlertView; onOpenRequest: (requestId: string) => void; onError: (err: unknown) => void }) {
  const { t } = useTranslation("inbox");
  const f = useFormat();
  const inspect = useInspector((s) => s.open);
  const task = useWork("tasks.get", { taskId: a.taskId });
  const run = task.data?.runs.find((r) => r.id === a.runId);
  const who = run && task.data ? `${f.role(run.role)} · ${f.runner(run.runner)} · ${profileNames(task.data).get(run.profileId)?.alias ?? run.profileId}` : "";
  const text = stallText(a);
  const Icon = ICON[a.rule];
  const go = (fn: () => Promise<unknown>) => void fn().catch(onError);
  return (
    <div className="ib-item ib-stall">
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="ib-warn" />
      <span className="ib-text">
        <span className="t">
          {t(text.key, {
            ...text.params,
            who: who || t("stall.someone"),
            failure: text.failure ? t(text.failure.status ? "stall.failureWithStatus" : "stall.failureOnly", { kind: t(`stall.failure.${text.failure.kind}`), status: text.failure.status ?? "" }) : "",
          })}
        </span>
        {/* A quiet run already names who in its title; the line under it then only says where. */}
        <span className="s">{[a.rule === "no_events" ? "" : who, task.data?.title].filter(Boolean).join(" · ")}</span>
        <span className="ib-stall-acts">
          {a.rule === "request_unanswered" && a.requestId ? (
            <Button size="sm" onClick={() => onOpenRequest(a.requestId!)}>
              {t("stall.openRequest")}
            </Button>
          ) : (
            run && (
              <Button size="sm" onClick={() => inspect({ taskId: a.taskId, memberId: run.memberId, runId: run.id })}>
                {t("stall.openRun")}
              </Button>
            )
          )}
          {a.rule === "no_events" && run && run.endedAt === null && (
            <ConfirmButton label={t("stall.stop")} confirm={t("stall.stopConfirm", { who })} onConfirm={() => act("runs.stop", { runId: run.id, sessionId: run.nativeSessionId }).catch(onError)} />
          )}
          <Button size="sm" variant="ghost" onClick={() => go(() => act("stalls.dismiss", { alertId: a.alertId }))}>
            {t("stall.dismiss")}
          </Button>
        </span>
      </span>
      <span className="k">{f.when.ago(a.observedAt)}</span>
    </div>
  );
}

export function StallList({ alerts, onOpenRequest, onError }: { alerts: StallAlertView[]; onOpenRequest: (requestId: string) => void; onError: (err: unknown) => void }) {
  const { t } = useTranslation("inbox");
  if (alerts.length === 0) return null;
  return (
    <>
      <div className="ib-sub lbl">{t("stall.section", { count: alerts.length })}</div>
      <Panel className="ib-list" aria-live="polite">
        {alerts.map((a) => (
          <StallItem key={a.alertId} a={a} onOpenRequest={onOpenRequest} onError={onError} />
        ))}
      </Panel>
    </>
  );
}
