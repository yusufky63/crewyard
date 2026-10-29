import { EMPTY_ALERT, evaluate, type AlertState, type LimitNoticePayload, type TasksTopics } from "@crewyard/core";

// Which daemon events become a Windows toast (PLAN.md §7.3). Limit notices go through the same
// `evaluate` hysteresis as the daemon: one toast per crossing of warn and of critical, re-armed
// only after the window resets or drops under the re-arm line. A repeated or replayed notice
// never toasts twice. Requests toast once, when they open.

export interface ToastState {
  alerts: Map<string, AlertState>;
  requests: Set<string>;
}

export const emptyToastState = (): ToastState => ({ alerts: new Map(), requests: new Set() });

/** The context window belongs to one run; plan windows belong to the account. */
const alertKey = (n: LimitNoticePayload) => `${n.profileId}|${n.window}|${n.window === "context" ? (n.runId ?? "") : ""}`;

export function limitToast(state: ToastState, n: LimitNoticePayload): "warn" | "critical" | null {
  if (n.kind !== "warn" && n.kind !== "critical") return null;
  const key = alertKey(n);
  const { state: next, notices } = evaluate(state.alerts.get(key) ?? EMPTY_ALERT, {
    profileId: n.profileId,
    window: n.window,
    usedPct: n.usedPct,
    resetsAt: n.resetsAt,
    provenance: n.provenance,
    observedAt: n.observedAt,
  });
  state.alerts.set(key, next);
  return notices.find((x) => x.kind === n.kind)?.kind ?? null;
}

export function requestToast(state: ToastState, ev: TasksTopics["requests.changed"]): boolean {
  if (!ev.open || state.requests.has(ev.requestId)) return false;
  state.requests.add(ev.requestId);
  return true;
}
