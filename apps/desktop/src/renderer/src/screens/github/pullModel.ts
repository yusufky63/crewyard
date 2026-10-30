import type { GateItem, MergeState, TaskPullView } from "@crewyard/core";

// Pure view rules for a task's PR; used by the task row, the inspector and the GitHub screen.

/** The one next step a task's PR waits for, or null when it waits on something else (review, checks, GitHub). */
export type PullStep = "push" | "open" | "merge" | "feedback" | "cleanup";

export function nextStep(v: TaskPullView): PullStep | null {
  const held = v.feedback.some((f) => f.state === "held");
  if (!v.pull || v.pull.state === "closed") {
    const gate = v.draft?.gate;
    if (!gate) return null;
    if (gate.ready) return "open";
    const pending = gate.items.filter((i) => i.status !== "pass").map((i) => i.id);
    return pending.length === 1 && pending[0] === "pushed" ? "push" : null;
  }
  if (v.pull.state === "merged") return v.cleanup?.ok ? "cleanup" : null;
  if (held) return "feedback";
  if (v.pull.state === "open" && v.live?.gate?.readyForApproval) return "merge";
  return null;
}

/** Only a PR GitHub reported as merged reads "merged"; everything else keeps its own label. */
export type PullLabel = "none" | "open" | "draft" | "merged" | "closed";

export function pullLabel(v: TaskPullView): PullLabel {
  return v.pull?.state ?? "none";
}

/** i18n key of a merge-gate chip; the merge-state chip names GitHub's own state. */
export function gateTextKey(i: GateItem, mergeState: MergeState | null): string {
  return i.id === "merge_state" ? `pulls.mergeState.${mergeState ?? "unknown"}` : `pulls.gate.${i.id}.${i.status}`;
}

/** Tooltip key that says why a chip holds the merge, or what a warning means. */
export function gateTitleKey(i: GateItem, mergeState: MergeState | null, draft: boolean): string | undefined {
  if (i.id === "merge_state") return `pulls.mergeStateTitle.${mergeState ?? "unknown"}`;
  if (i.id === "questions" && i.status === "unknown") return "pulls.gateTitle.questions_unknown";
  if (i.id === "approval" && draft) return "pulls.gateTitle.draft";
  return undefined;
}
