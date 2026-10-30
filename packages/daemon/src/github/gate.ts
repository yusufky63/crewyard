import type { ChecksSummary, GateItem, GateStatus, MergeGate, MergeState } from "@crewyard/core";

// Merge needs every gate (PLAN.md §10): checks passed, branch up to date, no open questions, and
// the owner's approval. Unknown never counts as passing. A repository that runs no CI at all has
// nothing GitHub could report, so that item is a visible warning instead of a wall: the task's own
// Test step and the owner's approval decide. A check that exists but has not reported still holds.

export interface GateInput {
  checks: ChecksSummary;
  /** Commits behind the base; null while GitHub has not computed it. */
  behindBy: number | null;
  /** GitHub's mergeable_state; null when it was not read. */
  mergeState: MergeState | null;
  draft: boolean;
  /**
   * Whether the repository has GitHub workflows at all; null when unknown. With none, zero checks
   * is the final answer; with workflows, zero checks only means CI has not started yet.
   */
  ciConfigured: boolean | null;
  /** Open agent questions on this branch, from the orchestrator; null when nobody can say. */
  openQuestions: number | null;
  ownerApproved: boolean;
}

/**
 * DIRTY (conflicts) and BEHIND (protection wants the branch up to date) hold the merge with that
 * reason. BLOCKED and UNSTABLE are shown as a warning: the first is GitHub's own protection, which
 * it enforces when the merge is sent; the second means a non-required check is not green, which
 * the checks item already reports.
 */
export function mergeStateStatus(state: MergeState | null, draft: boolean): GateStatus {
  switch (state) {
    case "clean":
    case "has_hooks":
      return "pass";
    case "dirty":
    case "behind":
      return "fail";
    case "blocked":
    case "unstable":
      return "warn";
    case "draft":
      return draft ? "wait" : "unknown";
    default:
      return "unknown";
  }
}

/** The merge may go ahead past this item; only the merge-state and no-CI warnings are allowed through. */
const clears = (i: GateItem) => i.status === "pass" || ((i.id === "merge_state" || i.id === "checks") && i.status === "warn");

export function evaluateGate(input: GateInput): MergeGate {
  const checks: GateItem["status"] =
    input.checks.state === "passed"
      ? "pass"
      : input.checks.state === "failing"
        ? "fail"
        : input.checks.state === "pending"
          ? "wait"
          : input.checks.state === "none"
            ? input.ciConfigured === false
              ? "warn"
              : input.ciConfigured === true
                ? "wait"
                : "unknown"
            : "unknown";
  const upToDate: GateItem["status"] = input.behindBy === null ? "unknown" : input.behindBy === 0 ? "pass" : "fail";
  const questions: GateItem["status"] = input.openQuestions === null ? "unknown" : input.openQuestions === 0 ? "pass" : "wait";
  const approval: GateItem["status"] = input.draft ? "wait" : input.ownerApproved ? "pass" : "wait";
  const items: GateItem[] = [
    { id: "checks", status: checks },
    { id: "up_to_date", status: upToDate },
    { id: "merge_state", status: mergeStateStatus(input.mergeState, input.draft) },
    { id: "questions", status: questions },
    { id: "approval", status: approval },
  ];
  const others = items.filter((i) => i.id !== "approval").every(clears);
  return { items, mergeable: others && approval === "pass", readyForApproval: others && !input.draft };
}

/** Why a merge is refused, as an error code the UI translates; null when the gate lets it through. */
export function mergeBlock(gate: MergeGate, state: MergeState | null): string | null {
  // Conflicts and a stale branch say exactly what to do, so they get their own reason.
  if (state === "dirty" || state === "behind") return `merge.${state}`;
  const blocking = gate.items.filter((i) => !clears(i)).map((i) => i.id);
  // The gate items themselves say which one holds; the code only tells the UI to show them.
  return blocking.length ? `merge.gate: ${blocking.join(", ")}` : null;
}

/** GitHub's REST value, kept only when it is one we know. */
export function toMergeState(raw: string | null | undefined): MergeState {
  const v = (raw ?? "").toLowerCase();
  return (["clean", "dirty", "behind", "blocked", "unstable", "has_hooks", "draft"] as const).find((s) => s === v) ?? "unknown";
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
