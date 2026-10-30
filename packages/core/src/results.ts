import { z } from "zod";
import type { OutputSchema } from "./adapter.ts";

// Schema-checked results for the roles whose output drives the crew (PLAN.md §9.1): the
// reviewer's verdict and the planner's plan. Shapes stay strict and simple (every field required,
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
