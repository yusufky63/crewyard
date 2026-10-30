import { describe, expect, it } from "vitest";
import type { LimitNoticePayload, RequestView } from "@crewyard/core";
import { badgeCount, openRequests, recentNotices } from "./notices.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const at = (min: number) => new Date(NOW - min * 60_000).toISOString();

const notice = (profileId: string, window: LimitNoticePayload["window"], minAgo: number, kind: LimitNoticePayload["kind"] = "warn"): LimitNoticePayload => ({
  kind,
  profileId,
  window,
  usedPct: 85,
  resetsAt: null,
  provenance: "reported",
  minutesUntilFull: null,
  runId: null,
  taskId: null,
  observedAt: at(minAgo),
});

const request = (id: string, minAgo: number, answered = false): RequestView =>
  ({ id, taskId: "t", projectId: "p", runId: null, sessionId: null, kind: "question", risk: null, payload: { kind: "question", questions: [] }, createdAt: at(minAgo), answeredAt: answered ? at(0) : null, answer: null, answeredBy: null }) as RequestView;

describe("openRequests", () => {
  it("keeps unanswered requests, newest first", () => {
    expect(openRequests([request("a", 30), request("b", 5), request("c", 1, true)]).map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("recentNotices", () => {
  it("keeps the latest notice per account and window from the last day", () => {
    const list = recentNotices([notice("p1", "5h", 50), notice("p1", "5h", 10, "critical"), notice("p1", "weekly", 20), notice("p2", "5h", 60 * 25)], NOW);
    expect(list.map((n) => `${n.profileId}|${n.window}|${n.kind}`)).toEqual(["p1|5h|critical", "p1|weekly|warn"]);
  });
});

describe("badgeCount", () => {
  it("counts every open request and only notices newer than the last look", () => {
    const open = [request("a", 3)];
    const notices = [notice("p1", "5h", 10), notice("p2", "5h", 2)];
    expect(badgeCount(open, notices, null)).toBe(3);
    expect(badgeCount(open, notices, at(5))).toBe(2);
    expect(badgeCount([], notices, at(0))).toBe(0);
  });
});
