import { z } from "zod";
import type { OutputSchema } from "./adapter.ts";

// Schema-checked results for the roles whose output drives the crew (PLAN.md §9.1): the
// reviewer's verdict, the planner's plan and the researcher's findings. Shapes stay strict and simple (every field required,
// null instead of optional, no numeric bounds) so that every runner's structured output accepts
// them, including OpenAI-style strict schemas through Codex.

export const VerdictComment = z.strictObject({
  file: z.string(),
  /** First line the comment is about; null for a whole-file or general comment. */
  line: z.number().nullable(),
  severity: z.enum(["blocker", "major", "minor", "nit"]),
  body: z.string(),
});
export type VerdictComment = z.infer<typeof VerdictComment>;

export const ReviewVerdict = z.strictObject({
  verdict: z.enum(["pass", "changes"]),
  summary: z.string(),
  comments: z.array(VerdictComment),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

export const PlannerPlan = z.strictObject({
  summary: z.string(),
  steps: z.array(z.strictObject({ title: z.string(), detail: z.string() })),
  acceptanceCriteria: z.array(z.string()),
  risks: z.array(z.string()),
});
export type PlannerPlan = z.infer<typeof PlannerPlan>;

/**
 * A researcher's findings (docs/adr/0014): what it found, each with a severity, where (file and
 * line, or null for the whole project) and the task it suggests, so an analysis ends in reviewable
 * findings and follow-up drafts rather than free text. A finding with nothing to do has
 * `suggestedTask: null`.
 */
export const ResearchFinding = z.strictObject({
  title: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  file: z.string().nullable(),
  line: z.number().nullable(),
  detail: z.string(),
  suggestedTask: z
    .strictObject({
      title: z.string(),
      description: z.string(),
      kind: z.enum(["code", "research", "review", "docs"]),
      acceptanceCriteria: z.array(z.string()),
    })
    .nullable(),
});
export type ResearchFinding = z.infer<typeof ResearchFinding>;

export const ResearchFindings = z.strictObject({
  summary: z.string(),
  findings: z.array(ResearchFinding),
});
export type ResearchFindings = z.infer<typeof ResearchFindings>;

/** Builds the adapter-facing schema from a zod object: draft-07 JSON Schema plus our own check. */
export function zodOutputSchema(name: string, schema: z.ZodType): OutputSchema {
  const { $schema: _drop, ...jsonSchema } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return {
    name,
    jsonSchema,
    check(value) {
      const res = schema.safeParse(value);
      if (res.success) return null;
      const issue = res.error.issues[0];
      if (!issue) return "the value does not match the schema";
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    },
  };
}

export const REVIEW_VERDICT_OUTPUT = zodOutputSchema("review_verdict", ReviewVerdict);
export const PLANNER_PLAN_OUTPUT = zodOutputSchema("planner_plan", PlannerPlan);
export const RESEARCH_FINDINGS_OUTPUT = zodOutputSchema("research_findings", ResearchFindings);
