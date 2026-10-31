import {
  candidateConflict,
  dependencyRefusal,
  dependentsOf,
  MAX_STANDBY,
  type CandidateView,
  type CrewEditRefusal,
  type CrewMemberView,
  type EditEnv,
  type RequestView,
  type RoleRules,
  type RoleView,
  type RunView,
  type TaskDetail,
} from "@crewyard/core";
import type { HandoffAsk } from "./actions.ts";
import { latestRun } from "./model.ts";

// What the Crew graph's management needs from a task: which edits are open and why the others
// are not, from the same rules the daemon enforces (@crewyard/core crew-edit.ts).

/** Role rules for the edit checks, from Settings → Roles' listing (built-ins, role files). */
export function rulesFromRoles(roles: readonly RoleView[] | undefined): EditEnv["rules"] {
  const byId = new Map((roles ?? []).map((r) => [r.id, { writes: r.policy.writes, independentOf: r.independentOf } satisfies RoleRules]));
  return (role) => byId.get(role) ?? null;
}

/** Members that ran, and steps whose newest run completed. */
export function progress(task: TaskDetail): { started: Set<string>; finished: Set<string> } {
  const members = task.crew?.members ?? [];
  const started = new Set(members.filter((m) => task.runs.some((r) => r.memberId === m.id)).map((m) => m.id));
  const finished = new Set(members.filter((m) => latestRun(task.runs, m.id)?.endReason === "completed").map((m) => m.step));
  return { started, finished };
}

export type CheckEnv = Pick<EditEnv, "rules" | "started" | "approved">;

export function checkEnv(task: TaskDetail, rules: EditEnv["rules"]): CheckEnv {
  return { rules, started: progress(task).started, approved: !!task.crew?.approvedAt };
}

export interface CandidateRow {
  candidate: CandidateView;
  chosen: boolean;
  /** Index in the standby chain, or -1. */
  standby: number;
  /** The step it would share a model with, against the independence rule. */
  conflict: string | null;
}

/**
 * The step's candidates as the panel lists them: the chosen one first, then the chain in order,
 * then the rest by score. A candidate that only appears in the proposal (the daemon no longer
 * offers it) stays listed, so you can see what is set.
 */
export function candidateRows(members: readonly CrewMemberView[], member: CrewMemberView, ranked: readonly CandidateView[], rules: EditEnv["rules"]): CandidateRow[] {
  const seen = new Set<string>();
  const all = [member.chosen, ...member.standby, ...ranked].filter((c): c is CandidateView => {
    if (!c || seen.has(c.profileId)) return false;
    seen.add(c.profileId);
    return true;
  });
  return all.map((c) => ({
    candidate: c,
    chosen: c.profileId === member.chosen?.profileId,
    standby: member.standby.findIndex((s) => s.profileId === c.profileId),
    conflict: c.profileId === member.chosen?.profileId ? null : candidateConflict(members, member, c, rules),
  }));
}

/** The standby chain after moving one profile from `from` to `to` (both indexes in the chain). */
export function moveInChain(chain: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= chain.length) return [...chain];
  const next = [...chain];
  const [id] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, id!);
  return next;
}

/** Puts a candidate into the chain at `at`, or why it cannot go there. */
export function insertInChain(chain: readonly string[], profileId: string, at: number): string[] | "standby_too_long" {
  const without = chain.filter((id) => id !== profileId);
  if (without.length >= MAX_STANDBY) return "standby_too_long";
  without.splice(Math.max(0, Math.min(at, without.length)), 0, profileId);
  return without;
}

export interface DependencyOption {
  step: string;
  memberId: string;
  /** "02": the step's place in the crew. */
  index: string;
  checked: boolean;
  /** Why the box cannot change; null when it can. */
  refusal: CrewEditRefusal | null;
  params: Record<string, string>;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** One checkbox per other step: the keyboard and list-view way to draw or remove a dependency. */
export function dependencyOptions(members: readonly CrewMemberView[], member: CrewMemberView, env: CheckEnv): DependencyOption[] {
  return members.flatMap((o, i) => {
    if (o.id === member.id) return [];
    const checked = member.dependsOn.includes(o.step);
    const why = checked ? (env.started.has(member.id) ? { code: "started" as const } : env.approved && !member.pendingApproval ? { code: "approved" as const } : null) : dependencyRefusal(members, member, o.step, env);
    return [{ step: o.step, memberId: o.id, index: pad2(i + 1), checked, refusal: why?.code ?? null, params: why && "params" in why ? (why.params ?? {}) : {} }];
  });
}

/** Steps that wait for `memberId`, for the Skip confirm. */
export function skipDependents(task: TaskDetail, memberId: string): CrewMemberView[] {
  const members = task.crew?.members ?? [];
  const m = members.find((x) => x.id === memberId);
  return m ? dependentsOf(members, m.step) : [];
}

/** Follow-up steps of an approved crew that still wait for their own approval. */
export const pendingSteps = (task: TaskDetail): CrewMemberView[] => (task.crew?.approvedAt ? task.crew.members.filter((m) => m.pendingApproval) : []);

const LIVE: ReadonlyArray<RunView["state"]> = ["starting", "running", "waiting_input", "waiting_approval", "rate_limited", "hibernated"];

/** Runs Pause all would pause and Resume all would resume. */
export function bulkCounts(task: TaskDetail): { live: number; paused: number } {
  let live = 0;
  let paused = 0;
  for (const r of task.runs) {
    if (r.endedAt) continue;
    if (r.state === "paused") paused++;
    else if (LIVE.includes(r.state)) live++;
  }
  return { live, paused };
}

/** Open handoff questions by run: what the Inbox would offer for Hand off now and Wait for reset. */
export function handoffAsks(requests: readonly RequestView[] | undefined): Map<string, HandoffAsk> {
  const out = new Map<string, HandoffAsk>();
  for (const q of requests ?? []) {
    if (q.answeredAt || !q.runId || q.payload.kind !== "handoff") continue;
    // A budget or unknown-price pause is answered with Continue in the Inbox, not with a handoff.
    if (q.payload.trigger === "budget" || q.payload.trigger === "unpriced") continue;
    out.set(q.runId, { requestId: q.id, resetsAt: q.payload.resetsAt, candidates: q.payload.candidates, proposed: q.payload.proposedTarget });
  }
  return out;
}
