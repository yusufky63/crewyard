import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import i18n from "i18next";
import { create } from "zustand";
import type { AgentEvent, LimitNoticePayload, TasksTopics } from "@crewyard/core";
import { call } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import { FIXTURE, fixtureNotices } from "./fixture.ts";
import { emptyToastState, limitToast, requestToast } from "./toasts.ts";

// Live state from the daemon's push topics. Facts stay in the daemon and are re-read with
// tasks.get; this store only keeps what exists nowhere else: the latest limit notices and what
// each run is doing right now. Neither is persisted, so a restart shows only what is stored.

export interface RunActivity {
  /** Latest tool call title or plan step; never message text, which can be long and private. */
  now: string | null;
  at: string;
  context: { used: number; size: number } | null;
}

interface Activity {
  notices: LimitNoticePayload[];
  runs: Record<string, RunActivity>;
  addNotice(n: LimitNoticePayload): void;
  onEvent(runId: string, ev: AgentEvent): void;
}

const MAX_NOTICES = 200;

export const useActivity = create<Activity>()((set) => ({
  notices: FIXTURE ? fixtureNotices() : [],
  runs: {},
  addNotice: (n) => set((s) => ({ notices: [...s.notices, n].slice(-MAX_NOTICES) })),
  onEvent: (runId, ev) =>
    set((s) => {
      const prev = s.runs[runId] ?? { now: null, at: ev.at, context: null };
      let next: RunActivity | null = null;
      if (ev.type === "tool.call") next = { ...prev, now: ev.title, at: ev.at };
      else if (ev.type === "plan.update") next = { ...prev, now: ev.steps.find((x) => x.status === "in_progress")?.title ?? prev.now, at: ev.at };
      else if (ev.type === "usage.update" && ev.contextUsed !== null && ev.contextSize !== null) next = { ...prev, context: { used: ev.contextUsed, size: ev.contextSize }, at: ev.at };
      return next ? { runs: { ...s.runs, [runId]: next } } : s;
    }),
}));

/** Event types that change what tasks.get returns; text deltas do not. */
const REFRESHING = new Set<AgentEvent["type"]>(["run.state", "run.ended", "plan.update", "diff.update", "usage.update", "limit.update", "request.question", "request.approval"]);

function invalidateTask(qc: QueryClient, taskId: string): void {
  void qc.invalidateQueries({ queryKey: ["tasks.get", { taskId }] });
}

const isWorkQuery = (key: unknown) => typeof key === "string" && (key.startsWith("tasks.") || key.startsWith("requests."));

function toast(title: string, body: string, onClick: () => void, tag: string): void {
  if (FIXTURE || typeof Notification === "undefined" || Notification.permission === "denied") return;
  const n = new Notification(title, { body, tag });
  n.onclick = () => {
    window.focus();
    onClick();
  };
}

/**
 * Mounted once by the shell: keeps every tasks.* and requests.* query fresh, feeds the activity
 * store and raises Windows toasts through the renderer Notification API (no main-process work).
 */
export function useWorkLive(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const toasts = emptyToastState();
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Runs stream many events a second; refetch each task at most every 750 ms.
    const queue = (taskId: string) => {
      pending.add(taskId);
      timer ??= setTimeout(() => {
        timer = null;
        pending.forEach((id) => invalidateTask(qc, id));
        pending.clear();
      }, 750);
    };
    const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: "tasks", ...opts });

    const offs = [
      window.crewyard.on("tasks.changed", (p) => {
        const ev = p as TasksTopics["tasks.changed"];
        void qc.invalidateQueries({ queryKey: ["tasks.list"] });
        invalidateTask(qc, ev.taskId);
      }),
      window.crewyard.on("requests.changed", (p) => {
        const ev = p as TasksTopics["requests.changed"];
        void qc.invalidateQueries({ queryKey: ["requests.list"] });
        void qc.invalidateQueries({ queryKey: ["tasks.list"] });
        invalidateTask(qc, ev.taskId);
        if (!requestToast(toasts, ev)) return;
        void call("tasks.get", { taskId: ev.taskId })
          .then((task) =>
            toast(
              t("toast.requestTitle"),
              t("toast.requestBody", { task: task.title }),
              () => {
                useNav.getState().selectTask(ev.taskId);
                useNav.getState().go("inbox");
              },
              `request-${ev.requestId}`,
            ),
          )
          .catch(() => undefined);
      }),
      window.crewyard.on("runs.event", (p) => {
        const ev = p as TasksTopics["runs.event"];
        useActivity.getState().onEvent(ev.runId, ev.event);
        if (REFRESHING.has(ev.event.type)) queue(ev.taskId);
      }),
      window.crewyard.on("limits.notice", (p) => {
        const n = p as LimitNoticePayload;
        useActivity.getState().addNotice(n);
        if (n.taskId) queue(n.taskId);
        const level = limitToast(toasts, n);
        if (!level) return;
        const pct = n.usedPct === null ? "" : Math.round(n.usedPct);
        toast(
          t(`toast.${level}Title`),
          t("toast.limitBody", { window: t(`window.${n.window}`), pct }),
          () => {
            if (n.taskId) useNav.getState().selectTask(n.taskId);
            useNav.getState().go(n.taskId ? "tasks" : "limits");
          },
          `limit-${n.profileId}-${n.window}-${level}`,
        );
      }),
      window.crewyard.on("daemon.ready", () => void qc.invalidateQueries({ predicate: (q) => isWorkQuery(q.queryKey[0]) })),
    ];
    return () => {
      offs.forEach((off) => off());
      if (timer) clearTimeout(timer);
    };
  }, [qc]);
}
