import type { LimitNoticePayload, RequestAnswer, RequestPayload, RequestView, RiskLevel } from "@crewyard/core";

// Pure Inbox logic (PLAN.md §11): ordering, titles, which answers each request allows, and how a
// question form becomes an answer. Kept free of React so it is tested directly.

/** Newest first; the selected task's requests lead, so "Open" from a task row lands on its item. */
export function orderRequests(requests: RequestView[], taskId: string | null): RequestView[] {
  return [...requests].sort((a, b) => {
    const pa = a.taskId === taskId ? 0 : 1;
    const pb = b.taskId === taskId ? 0 : 1;
    return pa - pb || b.createdAt.localeCompare(a.createdAt);
  });
}

/** Key under `title.` in the inbox namespace. Question titles are the agent's own words instead. */
export function titleKey(p: RequestPayload): string {
  switch (p.kind) {
    case "approval":
      if (p.command) return "approvalCommand";
      if (p.paths.length > 0) return "approvalPaths";
      if (p.network) return "approvalNetwork";
      return "approval";
    case "question":
      return "question";
    case "handoff":
      if (p.trigger === "budget") return p.cap ? `cap_${p.cap.kind}` : "budget";
      return `handoff_${p.trigger}`;
  }
}

/** "Always allow in this project" is never offered for high risk (PLAN.md §11). */
export const canAllowAlways = (risk: RiskLevel | null) => risk !== "high";

export interface HandoffChoices {
  handOff: boolean;
  waitForReset: boolean;
  /** Only a spend pause can be approved past; a provider limit cannot. */
  continuePastCap: boolean;
}

export function handoffChoices(p: Extract<RequestPayload, { kind: "handoff" }>): HandoffChoices {
  return { handOff: p.candidates.length > 0, waitForReset: p.resetsAt !== null, continuePastCap: p.trigger === "budget" };
}

/** Ask mode names a target; Manual leaves the choice to you, and nothing is preselected. */
export const defaultTarget = (p: Extract<RequestPayload, { kind: "handoff" }>): string | null => p.proposedTarget?.profileId ?? null;

export type QuestionForm = Array<{ selected: string | null; text: string }>;

export function emptyForm(p: Extract<RequestPayload, { kind: "question" }>): QuestionForm {
  return p.questions.map(() => ({ selected: null, text: "" }));
}

/** Every question needs an option, or text where free text is allowed. */
export function formReady(p: Extract<RequestPayload, { kind: "question" }>, form: QuestionForm): boolean {
  return p.questions.every((q, i) => {
    const f = form[i];
    return Boolean(f && (f.selected !== null || (q.allowFreeText && f.text.trim() !== "")));
  });
}

export function formAnswer(form: QuestionForm): Extract<RequestAnswer, { kind: "question" }> {
  return { kind: "question", answers: form.map((f) => ({ selected: f.selected === null ? [] : [f.selected], ...(f.text.trim() ? { text: f.text.trim() } : {}) })) };
}

/**
 * Limit notices worth listing "for your information": the latest per account and window, warn or
 * critical or ahead of pace, newest first. Reached limits are already requests.
 */
export function infoNotices(notices: LimitNoticePayload[], taskIds: Set<string>): LimitNoticePayload[] {
  const latest = new Map<string, LimitNoticePayload>();
  for (const n of notices) {
    if (n.kind === "reached") continue;
    if (n.taskId !== null && !taskIds.has(n.taskId)) continue;
    const key = `${n.profileId}|${n.window}`;
    const prev = latest.get(key);
    if (!prev || n.observedAt >= prev.observedAt) latest.set(key, n);
  }
  return [...latest.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}
