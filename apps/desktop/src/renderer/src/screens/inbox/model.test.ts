import { describe, expect, it } from "vitest";
import type { CandidateView, LimitNoticePayload, RequestPayload, RequestView } from "@crewyard/core";
import { canAllowAlways, defaultTarget, denyAnswer, emptyForm, formAnswer, formReady, handoffChoices, infoNotices, orderRequests, stallText, titleKey } from "./model.ts";

type Handoff = Extract<RequestPayload, { kind: "handoff" }>;
const req = (id: string, taskId: string, createdAt: string): RequestView =>
  ({ id, taskId, projectId: "p", runId: null, sessionId: null, kind: "question", risk: null, payload: { kind: "question", questions: [] }, createdAt, answeredAt: null, answer: null, answeredBy: null }) as RequestView;
const target = { profileId: "b" } as CandidateView;
const handoff = (over: Partial<Handoff>): Handoff => ({ kind: "handoff", trigger: "limit", window: "5h", resetsAt: null, proposedTarget: null, candidates: [target], detail: null, ...over });

describe("inbox", () => {
  it("lists newest first, with the selected task's requests on top", () => {
    const list = [req("a", "t1", "2026-10-30T10:00:00Z"), req("b", "t2", "2026-10-30T10:05:00Z"), req("c", "t1", "2026-10-30T10:01:00Z")];
    expect(orderRequests(list, null).map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(orderRequests(list, "t1").map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("titles each request by what it asks", () => {
    const approval: Extract<RequestPayload, { kind: "approval" }> = { kind: "approval", toolCallId: null, command: null, cwd: null, paths: [], network: false, policy: null };
    expect(titleKey({ ...approval, command: "pnpm test" })).toBe("approvalCommand");
    expect(titleKey({ ...approval, paths: ["a.ts"] })).toBe("approvalPaths");
    expect(titleKey({ ...approval, network: true })).toBe("approvalNetwork");
    expect(titleKey(handoff({ trigger: "budget", cap: { kind: "daily_cap", spentUsd: 2, capUsd: 2, credentialId: "c" } }))).toBe("cap_daily_cap");
    expect(titleKey(handoff({ trigger: "crashed" }))).toBe("handoff_crashed");
    expect(titleKey(handoff({ trigger: "budget", cap: { kind: "task_cap", spentUsd: 0, capUsd: 1, credentialId: "c", reservedUsd: 0.6, estimateUsd: 0.5 } }))).toBe("capWould_task_cap");
    expect(titleKey(handoff({ trigger: "unpriced", unpriced: { model: "m", caps: ["task_budget"] } }))).toBe("handoff_unpriced");
  });

  it("never offers always-allow for high risk, and continue only for a spend pause", () => {
    expect([canAllowAlways("low"), canAllowAlways("medium"), canAllowAlways("high")]).toEqual([true, true, false]);
    expect(handoffChoices(handoff({}))).toEqual({ handOff: true, waitForReset: false, continuePastCap: false });
    expect(handoffChoices(handoff({ trigger: "budget", resetsAt: "x", candidates: [] }))).toEqual({ handOff: false, waitForReset: true, continuePastCap: true });
    expect(handoffChoices(handoff({ trigger: "unpriced" })).continuePastCap).toBe(true);
    // Manual mode preselects nothing; Ask names its target.
    expect(defaultTarget(handoff({}))).toBeNull();
    expect(defaultTarget(handoff({ proposedTarget: target }))).toBe("b");
  });

  it("sends a deny's reason only when you wrote one", () => {
    expect(denyAnswer("  use pnpm ")).toEqual({ kind: "approval", decision: "deny", message: "use pnpm" });
    expect(denyAnswer("   ")).toEqual({ kind: "approval", decision: "deny" });
  });

  it("turns a question form into an answer once every question has one", () => {
    const p: Extract<RequestPayload, { kind: "question" }> = {
      kind: "question",
      questions: [
        { prompt: "Store?", options: [{ label: "redis" }, { label: "memory" }], allowFreeText: false },
        { prompt: "Notes?", options: [], allowFreeText: true },
      ],
    };
    const form = emptyForm(p);
    expect(formReady(p, form)).toBe(false);
    form[0]!.selected = "redis";
    expect(formReady(p, form)).toBe(false);
    form[1]!.text = "  keep it small ";
    expect(formReady(p, form)).toBe(true);
    expect(formAnswer(form)).toEqual({ kind: "question", answers: [{ selected: ["redis"] }, { selected: [], text: "keep it small" }] });
  });

  it("keeps the latest notice per account and window for this project, without reached limits", () => {
    const n = (over: Partial<LimitNoticePayload>): LimitNoticePayload => ({ kind: "warn", profileId: "a", window: "5h", usedPct: 81, resetsAt: null, provenance: "reported", minutesUntilFull: null, runId: null, taskId: null, observedAt: "2026-10-30T10:00:00Z", ...over });
    const out = infoNotices([n({}), n({ kind: "critical", usedPct: 96, observedAt: "2026-10-30T10:10:00Z" }), n({ kind: "reached", observedAt: "2026-10-30T10:20:00Z" }), n({ taskId: "other", profileId: "z" }), n({ taskId: "t1", profileId: "b" })], new Set(["t1"]));
    expect(out.map((x) => [x.profileId, x.kind])).toEqual([
      ["a", "critical"],
      ["b", "warn"],
    ]);
  });
});

describe("stall alerts", () => {
  it("names each rule with its own numbers, never the agent's text", () => {
    expect(stallText({ rule: "no_events", minutes: 12, count: null, detail: null })).toEqual({ key: "stall.no_events", params: { minutes: 12 }, failure: null });
    expect(stallText({ rule: "request_unanswered", minutes: 45, count: null, detail: null })).toEqual({ key: "stall.request_unanswered", params: { minutes: 45 }, failure: null });
    expect(stallText({ rule: "same_failure", minutes: null, count: 3, detail: "transient 429" })).toEqual({ key: "stall.same_failure", params: { count: 3 }, failure: { kind: "transient", status: "429" } });
    expect(stallText({ rule: "same_failure", minutes: null, count: 4, detail: "other" }).failure).toEqual({ kind: "other", status: null });
  });
});
