import { GOAL_PLAN_OUTPUT, type AgentEvent } from "@crewyard/core";
import { describe, expect, it } from "vitest";
import { outputSchemaFor, planSteps, readResult } from "./results.ts";

type Ended = Extract<AgentEvent, { type: "run.ended" }>;
const ended = (over: Partial<Ended>): Ended => ({ type: "run.ended", reason: "completed", runId: "r", seq: 0, at: "2026-10-30T00:00:00.000Z", source: { adapter: "fake", cliVersion: null }, ...over });
const verdict = { verdict: "pass", summary: "Good.", comments: [] };
const plan = { summary: "Rate limit logins.", steps: [{ title: "Add a token bucket", detail: "5 per minute per account" }, { title: "Tests", detail: "" }], acceptanceCriteria: ["429 after five tries"], risks: ["clock skew"] };

describe("results", () => {
  it("asks only the planner, the reviewer and the researcher for a result", () => {
    expect(outputSchemaFor("reviewer")?.name).toBe("review_verdict");
    expect(outputSchemaFor("planner")?.name).toBe("planner_plan");
    expect(outputSchemaFor("researcher")?.name).toBe("research_findings");
    for (const role of ["implementer", "tester", "docs", "security"] as const) expect(outputSchemaFor(role)).toBeUndefined();
  });

  it("asks the Orchestra planner for a goal plan and hands its raw value on for parseGoalPlan", () => {
    expect(outputSchemaFor("goal-planner")).toBe(GOAL_PLAN_OUTPUT);
    // The planner's limits live in parseGoalPlan (GoalPlanner), so even an over-long plan passes through here.
    const value = { summary: "İki adım", tasks: Array.from({ length: 20 }, (_, i) => ({ key: `t${i}` })) };
    expect(readResult("goal-planner", ended({ output: { ok: true, value } }))).toEqual({ kind: "goal_plan", value });
    expect(readResult("goal-planner", ended({ output: { ok: false, error: "no JSON result was returned" } }))).toEqual({ kind: "invalid", error: "no JSON result was returned" });
    expect(readResult("goal-planner", ended({}))).toEqual({ kind: "invalid", error: "the runner returned no result" });
    expect(readResult("goal-planner", ended({ reason: "stopped", output: { ok: true, value } }))).toBeNull();
  });

  it("reads a researcher's findings, each with a severity, a place and a suggested task or none", () => {
    const findings = {
      summary: "Two problems.",
      findings: [
        { title: "Token in a log line", severity: "high", file: "src/log.ts", line: 12, detail: "The header is logged.", suggestedTask: { title: "Redact the header", description: "", kind: "code", acceptanceCriteria: ["No token in logs"] } },
        { title: "Old lockfile", severity: "info", file: null, line: null, detail: "Fine for now.", suggestedTask: null },
      ],
    };
    expect(readResult("researcher", ended({ output: { ok: true, value: findings } }))).toEqual({ kind: "findings", findings });
    expect(readResult("researcher", ended({ output: { ok: true, value: { summary: "x", findings: [{ title: "t", severity: "urgent" }] } } }))).toMatchObject({ kind: "invalid" });
  });

  it("reads a verdict and a plan, and re-checks stored values", () => {
    expect(readResult("reviewer", ended({ output: { ok: true, value: verdict } }))).toEqual({ kind: "review", verdict });
    expect(readResult("planner", ended({ output: { ok: true, value: plan } }))).toEqual({ kind: "plan", plan });
    expect(readResult("reviewer", ended({ output: { ok: true, value: { verdict: "lgtm" } } }))).toEqual({ kind: "invalid", error: expect.stringMatching(/^verdict: /) });
  });

  it("reports a missing or failed result instead of guessing, and ignores runs that did not complete", () => {
    expect(readResult("reviewer", ended({}))).toEqual({ kind: "invalid", error: "the runner returned no result" });
    expect(readResult("reviewer", ended({ output: { ok: false, error: "no JSON result was returned" } }))).toEqual({ kind: "invalid", error: "no JSON result was returned" });
    expect(readResult("reviewer", ended({ reason: "failed", output: { ok: true, value: verdict } }))).toBeNull();
    expect(readResult("implementer", ended({ output: { ok: true, value: verdict } }))).toBeNull();
  });

  it("turns a plan into the steps the next roles get", () => {
    expect(planSteps(plan)).toEqual([
      { title: "Add a token bucket: 5 per minute per account", status: "pending" },
      { title: "Tests", status: "pending" },
    ]);
  });
});
