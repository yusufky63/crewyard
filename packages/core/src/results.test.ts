import { describe, expect, it } from "vitest";
import { checkOutput, outputInstruction, outputRetryPrompt, parseOutputText } from "./adapter.ts";
import { PLANNER_PLAN_OUTPUT, REVIEW_VERDICT_OUTPUT } from "./results.ts";

const verdict = { verdict: "changes", summary: "One bug.", comments: [{ file: "src/a.ts", line: 12, severity: "major", body: "Off by one." }] };

/** Walks a JSON Schema and returns every object node. */
function objects(node: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (!node || typeof node !== "object") return out;
  const n = node as Record<string, unknown>;
  if (n.type === "object") out.push(n);
  for (const v of Object.values(n)) objects(v, out);
  return out;
}

describe("result schemas", () => {
  it("are strict enough for OpenAI-style structured output", () => {
    for (const schema of [REVIEW_VERDICT_OUTPUT, PLANNER_PLAN_OUTPUT]) {
      expect(schema.jsonSchema.$schema).toBeUndefined();
      const nodes = objects(schema.jsonSchema);
      expect(nodes.length).toBeGreaterThan(1);
      for (const node of nodes) {
        expect(node.additionalProperties).toBe(false);
        expect([...(node.required as string[])].sort()).toEqual(Object.keys(node.properties as object).sort());
      }
      // Numeric and length bounds are not accepted by every provider.
      expect(JSON.stringify(schema.jsonSchema)).not.toMatch(/minimum|maximum|minLength|maxLength/);
    }
  });

  it("accepts a well-formed verdict and names the first problem of a bad one", () => {
    expect(checkOutput(REVIEW_VERDICT_OUTPUT, verdict)).toEqual({ ok: true, value: verdict });
    expect(checkOutput(REVIEW_VERDICT_OUTPUT, { ...verdict, verdict: "maybe" })).toEqual({ ok: false, error: expect.stringMatching(/^verdict: /) });
    expect(checkOutput(REVIEW_VERDICT_OUTPUT, { ...verdict, extra: 1 })).toMatchObject({ ok: false });
    expect(checkOutput(REVIEW_VERDICT_OUTPUT, { ...verdict, comments: [{ file: "a", line: null, severity: "nit" }] })).toEqual({ ok: false, error: expect.stringMatching(/^comments\.0\.body: /) });
    expect(checkOutput(REVIEW_VERDICT_OUTPUT, undefined)).toEqual({ ok: false, error: "no JSON result was returned" });
  });

  it("checks a plan", () => {
    const plan = { summary: "s", steps: [{ title: "a", detail: "b" }], acceptanceCriteria: ["tests pass"], risks: [] };
    expect(checkOutput(PLANNER_PLAN_OUTPUT, plan).ok).toBe(true);
    expect(checkOutput(PLANNER_PLAN_OUTPUT, { ...plan, steps: "a" }).ok).toBe(false);
  });
});

describe("parseOutputText", () => {
  it("reads plain JSON, fenced JSON and JSON inside a sentence", () => {
    expect(parseOutputText(JSON.stringify(verdict))).toEqual({ ok: true, value: verdict });
    expect(parseOutputText("```json\n{\"a\": 1}\n```")).toEqual({ ok: true, value: { a: 1 } });
    expect(parseOutputText("Here it is: {\"a\": {\"b\": 2}} done.")).toEqual({ ok: true, value: { a: { b: 2 } } });
  });

  it("reports empty, missing and broken JSON", () => {
    expect(parseOutputText("  ")).toEqual({ ok: false, error: "the final message was empty" });
    expect(parseOutputText("looks good to me")).toEqual({ ok: false, error: "the final message contained no JSON object" });
    expect(parseOutputText("{\"a\": }")).toMatchObject({ ok: false, error: expect.stringMatching(/^the final message was not valid JSON/) });
  });
});

describe("prompts", () => {
  it("carry the schema and the problem", () => {
    expect(outputInstruction(REVIEW_VERDICT_OUTPUT)).toContain(JSON.stringify(REVIEW_VERDICT_OUTPUT.jsonSchema));
    const retry = outputRetryPrompt(REVIEW_VERDICT_OUTPUT, "verdict: bad");
    expect(retry).toContain("review_verdict");
    expect(retry).toContain("verdict: bad");
  });
});
