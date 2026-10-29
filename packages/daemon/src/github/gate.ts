import type { ChecksSummary, GateItem, MergeGate } from "@crewyard/core";

// Merge needs every gate (PLAN.md §10): checks passed, branch up to date, no open questions, and
// the owner's approval. Unknown never counts as passing.

export interface GateInput {
  checks: ChecksSummary;
  /** Commits behind the base; null while GitHub has not computed it. */
  behindBy: number | null;
  draft: boolean;
  /** Open agent questions on this branch, from the orchestrator; null when nobody can say. */
  openQuestions: number | null;
  ownerApproved: boolean;
}

export function evaluateGate(input: GateInput): MergeGate {
  const checks: GateItem["status"] =
    input.checks.state === "passed" ? "pass" : input.checks.state === "failing" ? "fail" : input.checks.state === "pending" ? "wait" : "unknown";
  const upToDate: GateItem["status"] = input.behindBy === null ? "unknown" : input.behindBy === 0 ? "pass" : "fail";
  const questions: GateItem["status"] = input.openQuestions === null ? "unknown" : input.openQuestions === 0 ? "pass" : "wait";
  const approval: GateItem["status"] = input.draft ? "wait" : input.ownerApproved ? "pass" : "wait";
  const items: GateItem[] = [
    { id: "checks", status: checks },
    { id: "up_to_date", status: upToDate },
    { id: "questions", status: questions },
    { id: "approval", status: approval },
  ];
  const others = items.filter((i) => i.id !== "approval").every((i) => i.status === "pass");
  return { items, mergeable: others && approval === "pass", readyForApproval: others && !input.draft };
}

export interface CheckRunLike {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface StatusLike {
  context: string;
  state: string;
}

const PASSING = new Set(["success", "neutral", "skipped"]);

/** One summary from check runs and legacy commit statuses. A re-run of a job replaces its earlier result. */
export function summarizeChecks(runs: CheckRunLike[], statuses: StatusLike[]): ChecksSummary {
  const latest = new Map<string, "passed" | "failing" | "pending">();
  for (const r of runs) {
    const s = r.status !== "completed" ? "pending" : PASSING.has(r.conclusion ?? "") ? "passed" : "failing";
    latest.set(`run:${r.name}`, s);
  }
  // The statuses API lists newest first; keep the first entry per context.
  for (const st of statuses) {
    const key = `status:${st.context}`;
    if (latest.has(key)) continue;
    latest.set(key, st.state === "success" ? "passed" : st.state === "pending" ? "pending" : "failing");
  }
  const values = [...latest.entries()];
  const count = (s: string) => values.filter(([, v]) => v === s).length;
  const failingNames = values.filter(([, v]) => v === "failing").map(([k]) => k.replace(/^(run|status):/, ""));
  const total = values.length;
  const failing = count("failing");
  const pending = count("pending");
  const state = total === 0 ? "none" : failing > 0 ? "failing" : pending > 0 ? "pending" : "passed";
  return { state, total, passed: count("passed"), failing, pending, failingNames };
}
