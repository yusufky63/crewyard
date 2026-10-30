import type { LimitNoticePayload, RequestView } from "@crewyard/core";

// What the title bar's notifications popover lists (DESIGN.md §5): open requests first, then the
// recent limit notices. Pure, so the rules are tested without React.

export const NOTICE_WINDOW_MS = 24 * 60 * 60_000;

/** Open requests, newest first. */
export function openRequests(requests: RequestView[]): RequestView[] {
  return requests.filter((r) => r.answeredAt === null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The latest notice per account and window from the last day, newest first. Older notices for the
 * same window say less than the newest one, so they are dropped rather than stacked.
 */
export function recentNotices(notices: LimitNoticePayload[], now: number, windowMs = NOTICE_WINDOW_MS): LimitNoticePayload[] {
  const latest = new Map<string, LimitNoticePayload>();
  for (const n of notices) {
    if (now - Date.parse(n.observedAt) > windowMs) continue;
    const key = `${n.profileId}|${n.window}`;
    const prev = latest.get(key);
    if (!prev || n.observedAt >= prev.observedAt) latest.set(key, n);
  }
  return [...latest.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}

/** The bell's count: every open request, plus notices that arrived since the popover was last opened. */
export function badgeCount(open: RequestView[], notices: LimitNoticePayload[], seenAt: string | null): number {
  return open.length + notices.filter((n) => seenAt === null || n.observedAt > seenAt).length;
}
