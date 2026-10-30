import { describe, expect, it } from "vitest";
import type { ChecksSummary } from "@crewyard/core";
import { evaluateGate, mergeBlock, mergeStateStatus, summarizeChecks, toMergeState } from "./gate.ts";

const passed: ChecksSummary = { state: "passed", total: 3, passed: 3, failing: 0, pending: 0, failingNames: [] };
const base = { checks: passed, behindBy: 0, mergeState: "clean" as const, draft: false, openQuestions: 0, ownerApproved: false };
const statusOf = (g: ReturnType<typeof evaluateGate>) => Object.fromEntries(g.items.map((i) => [i.id, i.status]));

describe("merge gate", () => {
  it("waits only for the owner when everything else passes", () => {
    const g = evaluateGate(base);
    expect(statusOf(g)).toEqual({ checks: "pass", up_to_date: "pass", merge_state: "pass", questions: "pass", approval: "wait" });
    expect(g.readyForApproval).toBe(true);
    expect(g.mergeable).toBe(false);
    expect(evaluateGate({ ...base, ownerApproved: true }).mergeable).toBe(true);
  });

  it("merges only with a pass verdict for exactly this head (pinned review)", () => {
    expect(evaluateGate({ ...base, ownerApproved: true, reviewed: "pass" }).mergeable).toBe(true);
    for (const r of ["changes", "stale"] as const) {
      const g = evaluateGate({ ...base, ownerApproved: true, reviewed: r });
      expect([statusOf(g).reviewed, g.mergeable]).toEqual(["fail", false]);
      expect(mergeBlock(g, "clean")).toBe("Merge gate not passed: reviewed");
    }
    expect(statusOf(evaluateGate({ ...base, reviewed: "missing" })).reviewed).toBe("wait");
    // A PR no task with a reviewer owns has no such item.
    expect(statusOf(evaluateGate({ ...base, reviewed: null }))).not.toHaveProperty("reviewed");
  });

  it("blocks on failing or pending checks", () => {
    expect(evaluateGate({ ...base, ownerApproved: true, checks: { ...passed, state: "failing" } }).mergeable).toBe(false);
    const pending = evaluateGate({ ...base, checks: { ...passed, state: "pending" } });
    expect(statusOf(pending).checks).toBe("wait");
    expect(pending.readyForApproval).toBe(false);
  });

  it("never treats unknown as passing", () => {
    const g = evaluateGate({ ...base, ownerApproved: true, behindBy: null, mergeState: null, openQuestions: null, checks: { ...passed, state: "none", total: 0 } });
    expect(statusOf(g)).toEqual({ checks: "unknown", up_to_date: "unknown", merge_state: "unknown", questions: "unknown", approval: "pass" });
    expect(g.mergeable).toBe(false);
  });

  it("blocks a branch that is behind, has open questions or is a draft", () => {
    expect(statusOf(evaluateGate({ ...base, behindBy: 2 })).up_to_date).toBe("fail");
    expect(statusOf(evaluateGate({ ...base, openQuestions: 1 })).questions).toBe("wait");
    const draft = evaluateGate({ ...base, draft: true, ownerApproved: true });
    expect(draft.mergeable).toBe(false);
    expect(draft.readyForApproval).toBe(false);
  });
});

describe("merge state", () => {
  it("holds the merge on DIRTY and BEHIND and names the reason", () => {
    for (const state of ["dirty", "behind"] as const) {
      const g = evaluateGate({ ...base, mergeState: state, ownerApproved: true });
      expect(statusOf(g).merge_state).toBe("fail");
      expect(g.mergeable).toBe(false);
      expect(g.readyForApproval).toBe(false);
      expect(mergeBlock(g, state)).toBe(`merge.${state}`);
    }
  });

  it("shows BLOCKED and UNSTABLE as a warning that GitHub enforces itself", () => {
    for (const state of ["blocked", "unstable"] as const) {
      const g = evaluateGate({ ...base, mergeState: state, ownerApproved: true });
      expect(statusOf(g).merge_state).toBe("warn");
      expect(g.mergeable).toBe(true);
      expect(mergeBlock(g, state)).toBeNull();
    }
  });

  it("lets CLEAN and HAS_HOOKS through and never treats an uncomputed state as passing", () => {
    expect(mergeStateStatus("clean", false)).toBe("pass");
    expect(mergeStateStatus("has_hooks", false)).toBe("pass");
    const g = evaluateGate({ ...base, mergeState: "unknown", ownerApproved: true });
    expect(g.mergeable).toBe(false);
    expect(mergeBlock(g, "unknown")).toBe("Merge gate not passed: merge_state");
    expect(mergeStateStatus("draft", true)).toBe("wait");
  });

  it("maps GitHub's REST values and keeps anything new as unknown", () => {
    expect(toMergeState("CLEAN")).toBe("clean");
    expect(toMergeState("behind")).toBe("behind");
    expect(toMergeState("something_new")).toBe("unknown");
    expect(toMergeState(null)).toBe("unknown");
  });
});

describe("checks summary", () => {
  it("counts runs and statuses and names the failing ones", () => {
    const s = summarizeChecks(
      [
        { name: "check", status: "completed", conclusion: "success" },
        { name: "e2e", status: "completed", conclusion: "failure" },
        { name: "docs", status: "completed", conclusion: "skipped" },
        { name: "lint", status: "in_progress", conclusion: null },
      ],
      [
        { context: "vercel", state: "error" },
        { context: "vercel", state: "success" },
      ],
    );
    expect(s).toEqual({ state: "failing", total: 5, passed: 2, failing: 2, pending: 1, failingNames: ["e2e", "vercel"] });
  });

  it("reports none without any check", () => {
    expect(summarizeChecks([], []).state).toBe("none");
  });

  it("is pending while a run has not finished and nothing failed", () => {
    expect(summarizeChecks([{ name: "a", status: "queued", conclusion: null }], [{ context: "b", state: "success" }]).state).toBe("pending");
  });
});
