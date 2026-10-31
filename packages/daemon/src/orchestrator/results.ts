import { PLANNER_PLAN_OUTPUT, PlannerPlan, RESEARCH_FINDINGS_OUTPUT, ResearchFindings, REVIEW_VERDICT_OUTPUT, ReviewVerdict, type AgentEvent, type OutputSchema, type RoleId } from "@crewyard/core";
import type { OrchestratorDb } from "./db.ts";

// Schema-checked results (feature scan A3): the reviewer's verdict, the planner's plan and the
// researcher's findings (docs/adr/0014) come back
// as JSON the runner validated, instead of free text the crew has to guess at. The adapters ask
// the runner for the shape and check it; this module decides which roles ask, and reads what came
// back at the end of the run.

/** The JSON shape a role's run must end with; undefined for roles whose output is free-form. */
export function outputSchemaFor(role: RoleId): OutputSchema | undefined {
  if (role === "reviewer") return REVIEW_VERDICT_OUTPUT;
  if (role === "planner") return PLANNER_PLAN_OUTPUT;
  if (role === "researcher") return RESEARCH_FINDINGS_OUTPUT;
  return undefined;
}

export type RoleResult = { kind: "review"; verdict: ReviewVerdict } | { kind: "plan"; plan: PlannerPlan } | { kind: "findings"; findings: ResearchFindings } | { kind: "invalid"; error: string };

type Ended = Extract<AgentEvent, { type: "run.ended" }>;

/**
 * Reads a run's result. The value is parsed again here: the adapter checked it, but the event may
 * come from a stored log or a runner we cannot vouch for. Null when the role asks for no result or
 * the run did not complete.
 */
export function readResult(role: RoleId, ev: Ended): RoleResult | null {
  if (!outputSchemaFor(role) || ev.reason !== "completed") return null;
  const output = ev.output;
  if (!output) return { kind: "invalid", error: "the runner returned no result" };
  if (!output.ok) return { kind: "invalid", error: output.error };
  if (role === "reviewer") {
    const res = ReviewVerdict.safeParse(output.value);
    return res.success ? { kind: "review", verdict: res.data } : { kind: "invalid", error: REVIEW_VERDICT_OUTPUT.check(output.value) ?? "invalid verdict" };
  }
  if (role === "researcher") {
    const res = ResearchFindings.safeParse(output.value);
    return res.success ? { kind: "findings", findings: res.data } : { kind: "invalid", error: RESEARCH_FINDINGS_OUTPUT.check(output.value) ?? "invalid findings" };
  }
  const res = PlannerPlan.safeParse(output.value);
  return res.success ? { kind: "plan", plan: res.data } : { kind: "invalid", error: PLANNER_PLAN_OUTPUT.check(output.value) ?? "invalid plan" };
}

/** The plan in the shape runs.plan keeps, so the next roles get it as their "Approved plan". */
export function planSteps(plan: PlannerPlan): Array<{ title: string; status: "pending" }> {
  return plan.steps.map((s) => ({ title: s.detail ? `${s.title}: ${s.detail}` : s.title, status: "pending" }));
}

/**
 * Called once per run.ended. A planner's checked plan replaces whatever its task list said, since
 * it is the plan the crew works from; a verdict is recorded in the audit log, where the review gate
 * and the task view read it. A result that failed its check is recorded too, never guessed at.
 */
export function applyResult(db: OrchestratorDb, runId: string, ev: Ended, audit: (kind: string, payload: unknown) => void): RoleResult | null {
  const run = db.run(runId);
  const result = readResult(run.role, ev);
  if (!result) return null;
  if (result.kind === "plan") {
    db.exec("update runs set plan = ? where id = ?", JSON.stringify(planSteps(result.plan)), runId);
    audit("plan.result", { plan: result.plan });
  } else if (result.kind === "review") {
    audit("review.verdict", { verdict: result.verdict.verdict, summary: result.verdict.summary, comments: result.verdict.comments });
  } else if (result.kind === "findings") {
    audit("research.findings", { summary: result.findings.summary, findings: result.findings.findings });
  } else {
    audit("result.invalid", { role: run.role, error: result.error });
  }
  return result;
}
