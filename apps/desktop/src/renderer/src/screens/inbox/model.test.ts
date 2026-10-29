import { describe, expect, it } from "vitest";
import type { CandidateView, LimitNoticePayload, RequestPayload, RequestView } from "@crewyard/core";
import { canAllowAlways, defaultTarget, emptyForm, formAnswer, formReady, handoffChoices, infoNotices, orderRequests, titleKey } from "./model.ts";

type Handoff = Extract<RequestPayload, { kind: "handoff" }>;
const req = (id: string, taskId: string, createdAt: string): RequestView =>
  ({ id, taskId, projectId: "p", runId: null, kind: "question", risk: null, payload: { kind: "question", questions: [] }, createdAt, answeredAt: null, answer: null, answeredBy: null }) as RequestView;
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
  });

  it("never offers always-allow for high risk, and continue only for a spend pause", () => {
    expect([canAllowAlways("low"), canAllowAlways("medium"), canAllowAlways("high")]).toEqual([true, true, false]);
    expect(handoffChoices(handoff({}))).toEqual({ handOff: true, waitForReset: false, continuePastCap: false });
    expect(handoffChoices(handoff({ trigger: "budget", resetsAt: "x", candidates: [] }))).toEqual({ handOff: false, waitForReset: true, continuePastCap: true });
    // Manual mode preselects nothing; Ask names its target.
    expect(defaultTarget(handoff({}))).toBeNull();
    expect(defaultTarget(handoff({ proposedTarget: target }))).toBe("b");
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
