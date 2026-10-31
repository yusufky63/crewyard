import type { RolePolicy } from "./adapter.ts";
import type { CandidateView, CostEstimate, CrewMemberView, RoleId } from "./ipc/tasks.ts";

// Editing a crew in the Crew graph (PLAN.md §9 step 6). Every rule is a pure function of the
// member views, so the renderer can say why an edit is off before you try it and the daemon
// applies the same rules before it writes anything. Scoring stays in the daemon: edits that need
// candidates for a role get them through `EditEnv.rank`.

/** What an edit needs to know about a role; the daemon has the template, the renderer `roles.list`. */
export interface RoleRules {
  writes: RolePolicy["writes"];
  /** Roles whose model this role must not share (the independence rule). */
  independentOf: RoleId[];
}

/** Steps one crew may have; the graph and the scheduler both stay readable at this size. */
export const MAX_CREW_STEPS = 12;
/** Standby candidates a step may keep in its chain (PLAN.md §8). */
export const MAX_STANDBY = 4;

/** Why an edit was refused; thrown by the daemon as `crew.<code>` and translated as `edit.why.<code>`. */
export type CrewEditRefusal =
  | "unknown_step" // { memberId } or { step }
  | "unknown_role" // { role }
  | "self" // a step cannot depend on itself
  | "exists" // the dependency is already there
  | "missing" // there is no such dependency to remove
  | "cycle" // { path }: the dependency would make a loop
  | "started" // the step already ran or runs
  | "approved" // the step is part of the approved crew; only new steps can change
  | "not_finished" // a follow-up goes after a finished step
  | "last_step" // a crew keeps at least one step
  | "too_many" // { max } steps
  | "unknown_candidate" // { profileId } was not scored for this role
  | "independence" // { step, other }: same model as a step this one must stay independent of
  | "read_only_lease" // { step }: a read-only role never gets the worktree's write lease
  | "standby_chosen" // the step's chosen profile cannot also stand by for it
  | "standby_duplicate"
  | "standby_too_long" // { max }
  | "skipped" // the step is already skipped
  | "not_approved" // skipping is for a step of the approved crew; a proposal or a follow-up is removed instead
  | "best_of" // the step runs as a Best of N group, which keeps its place
  | "no_candidate"; // { step }: a step has no profile yet

export class CrewEditError extends Error {
  constructor(
    readonly refusal: CrewEditRefusal,
    readonly params: Record<string, string | number> = {},
  ) {
    super(`crew.${refusal}`);
  }
}

export type CrewProposalEdit =
  /** A new step for `role`, depending on the steps in `after` (DAG step ids). */
  | { kind: "add_step"; role: RoleId; after: string[] }
  /** Removes a step; whatever depended on it depends on its own dependencies instead. */
  | { kind: "remove_step"; memberId: string }
  /** Gives the step another role; its profile is chosen again for that role. */
  | { kind: "set_role"; memberId: string; role: RoleId }
  /** One of the candidates scored for the step's role, with its model. */
  | { kind: "set_candidate"; memberId: string; profileId: string }
  | { kind: "add_dependency"; memberId: string; dependsOn: string }
  | { kind: "remove_dependency"; memberId: string; dependsOn: string }
  /** The whole standby chain, in order; every profile must be a candidate for the role. */
  | { kind: "set_standby"; memberId: string; profileIds: string[] };

export interface EditEnv {
  rules(role: RoleId): RoleRules | null;
  /** Every eligible candidate for the role, best first, without the independence filter. */
  rank(role: RoleId): CandidateView[];
  newId(): string;
  /** Members that have a run, and steps whose last run completed. */
  started: ReadonlySet<string>;
  finished: ReadonlySet<string>;
  /** The crew is approved: only steps that wait for their own approval (follow-ups) may change. */
  approved: boolean;
}

const modelKey = (v: CandidateView) => (v.model ?? `profile:${v.profileId}`).toLowerCase();

/** Steps that wait for `step`, directly or through others, in crew order. */
export function dependentsOf(members: readonly CrewMemberView[], step: string): CrewMemberView[] {
  const out = new Set<string>();
  const visit = (s: string) => {
    for (const m of members) {
      if (m.dependsOn.includes(s) && !out.has(m.step)) {
        out.add(m.step);
        visit(m.step);
      }
    }
  };
  visit(step);
  return members.filter((m) => out.has(m.step));
}

/**
 * The loop that `step` depending on `dependsOn` would close, as step ids from `dependsOn` back to
 * itself, or null. A loop exists when `dependsOn` already waits for `step`.
 */
export function cyclePath(members: readonly CrewMemberView[], step: string, dependsOn: string): string[] | null {
  if (step === dependsOn) return [step];
  const byStep = new Map(members.map((m) => [m.step, m]));
  const seen = new Set<string>();
  // Walk down dependsOn's own dependencies; reaching `step` means the new edge closes a loop.
  const walk = (s: string, path: string[]): string[] | null => {
    if (s === step) return path;
    if (seen.has(s)) return null;
    seen.add(s);
    for (const d of byStep.get(s)?.dependsOn ?? []) {
      const found = walk(d, [...path, d]);
      if (found) return found;
    }
    return null;
  };
  return walk(dependsOn, [dependsOn]);
}

/** Why `member` may not start depending on `dependsOn`, or null when it may. */
export function dependencyRefusal(members: readonly CrewMemberView[], member: CrewMemberView, dependsOn: string, env: Pick<EditEnv, "started" | "approved">): { code: CrewEditRefusal; params?: Record<string, string> } | null {
  if (!members.some((m) => m.step === dependsOn)) return { code: "unknown_step", params: { step: dependsOn } };
  if (member.step === dependsOn) return { code: "self" };
  const lock = lockRefusal(member, env);
  if (lock) return { code: lock };
  if (member.dependsOn.includes(dependsOn)) return { code: "exists" };
  const loop = cyclePath(members, member.step, dependsOn);
  if (loop) return { code: "cycle", params: { path: [member.step, ...loop].join(" → ") } };
  return null;
}

/** A step that ran, or one the approved crew already holds, keeps its place and its profile. */
function lockRefusal(member: CrewMemberView, env: Pick<EditEnv, "started" | "approved">): CrewEditRefusal | null {
  if (env.started.has(member.id)) return "started";
  if (env.approved && !member.pendingApproval) return "approved";
  return null;
}

/** Pairs of steps that would share a model against the independence rule. */
export function independenceConflicts(members: readonly CrewMemberView[], rules: EditEnv["rules"]): Array<{ step: string; other: string }> {
  const out: Array<{ step: string; other: string }> = [];
  for (const m of members) {
    if (!m.chosen || m.skippedAt) continue;
    for (const role of rules(m.role)?.independentOf ?? []) {
      for (const o of members) {
        if (o === m || o.role !== role || !o.chosen || o.skippedAt) continue;
        if (modelKey(o.chosen) === modelKey(m.chosen)) out.push({ step: m.step, other: o.step });
      }
    }
  }
  return out;
}

/**
 * Whether `candidate` on `member` breaks the independence rule in either direction: the step must
 * stay off the model of the roles it is independent of, and those that must stay independent of
 * it must stay off its model. Returns the other step, or null.
 */
export function candidateConflict(members: readonly CrewMemberView[], member: CrewMemberView, candidate: CandidateView, rules: EditEnv["rules"], role: RoleId = member.role, oneWay = false): string | null {
  const placed = { ...member, role, chosen: candidate };
  // A step being drafted is not in the list yet.
  const trial = members.some((m) => m.id === member.id) ? members.map((m) => (m.id === member.id ? placed : m)) : [...members, placed];
  const hit = independenceConflicts(trial, rules).find((c) => c.step === member.step || (!oneWay && c.other === member.step));
  if (!hit) return null;
  return hit.step === member.step ? hit.other : hit.step;
}

/** The worktree lease follows the role: anything that writes gets it, a read-only role never. */
export const writesCodeFor = (rules: RoleRules): boolean => rules.writes !== "none";

/** Everything that keeps a crew from being approved as it stands, first problem first. */
export function crewProblems(members: readonly CrewMemberView[], rules: EditEnv["rules"]): Array<{ code: CrewEditRefusal; params: Record<string, string> }> {
  const out: Array<{ code: CrewEditRefusal; params: Record<string, string> }> = [];
  const steps = new Set(members.map((m) => m.step));
  for (const m of members) {
    const r = rules(m.role);
    if (!r) out.push({ code: "unknown_role", params: { role: m.role } });
    else if (m.writesCode && !writesCodeFor(r)) out.push({ code: "read_only_lease", params: { step: m.step } });
    if (!m.chosen && !m.skippedAt) out.push({ code: "no_candidate", params: { step: m.step } });
    for (const d of m.dependsOn) {
      if (!steps.has(d)) out.push({ code: "unknown_step", params: { step: d } });
      else if (d === m.step || dependsTransitively(members, d, m.step)) out.push({ code: "cycle", params: { path: `${m.step} → ${d}` } });
    }
  }
  for (const c of independenceConflicts(members, rules)) out.push({ code: "independence", params: c });
  return out;
}

/** True when `from` waits for `to` through its dependencies. */
function dependsTransitively(members: readonly CrewMemberView[], from: string, to: string): boolean {
  const byStep = new Map(members.map((m) => [m.step, m]));
  const seen = new Set<string>();
  const stack = [...(byStep.get(from)?.dependsOn ?? [])];
  while (stack.length) {
    const s = stack.pop()!;
    if (s === to) return true;
    if (seen.has(s)) continue;
    seen.add(s);
    stack.push(...(byStep.get(s)?.dependsOn ?? []));
  }
  return false;
}

/** What the crew is forecast to cost: every step's chosen estimate; a skipped step costs nothing. */
export function crewEstimate(members: readonly CrewMemberView[]): CostEstimate {
  const parts = members.filter((m) => !m.skippedAt).map((m) => m.chosen?.estimate ?? { usd: null, provenance: "unknown" as const });
  if (parts.length === 0) return { usd: 0, provenance: "estimated" };
  if (parts.some((p) => p.usd === null)) return { usd: null, provenance: "unknown" };
  return { usd: Math.round(parts.reduce((a, p) => a + (p.usd ?? 0), 0) * 10_000) / 10_000, provenance: "estimated" };
}

/** A step id for a new step of `role`: the role id, or `role-2`, `role-3`… when it is taken. */
export function nextStepId(members: readonly CrewMemberView[], role: RoleId): string {
  const taken = new Set(members.map((m) => m.step));
  if (!taken.has(role)) return role;
  for (let n = 2; ; n++) if (!taken.has(`${role}-${n}`)) return `${role}-${n}`;
}

/** The best candidate that keeps the independence rule, and the next ones as its standby chain. */
function pick(members: readonly CrewMemberView[], member: CrewMemberView, role: RoleId, env: EditEnv): Pick<CrewMemberView, "chosen" | "standby" | "reasons"> {
  const fits = env.rank(role).filter((c) => candidateConflict(members, member, c, env.rules, role) === null);
  const [chosen, ...rest] = fits;
  return {
    chosen: chosen ?? null,
    standby: rest.slice(0, 2),
    reasons: chosen ? (rest.length === 0 ? [{ code: "only_candidate" }] : []) : [{ code: env.rank(role).length > 0 ? "no_independent_candidate" : "no_candidate" }],
  };
}

function find(members: readonly CrewMemberView[], memberId: string): CrewMemberView {
  const m = members.find((x) => x.id === memberId);
  if (!m) throw new CrewEditError("unknown_step", { memberId });
  return m;
}

function rulesOf(env: EditEnv, role: RoleId): RoleRules {
  const r = env.rules(role);
  if (!r) throw new CrewEditError("unknown_role", { role });
  return r;
}

function unlocked(member: CrewMemberView, env: EditEnv): void {
  const lock = lockRefusal(member, env);
  if (lock) throw new CrewEditError(lock);
}

/**
 * Applies one edit and returns the new member list in crew order. Throws CrewEditError with the
 * refusal; the input is never changed. Steps added to an approved crew wait for their own
 * approval (`pendingApproval`), so nothing new runs without a click (PLAN.md D8).
 */
export function applyCrewEdit(members: readonly CrewMemberView[], edit: CrewProposalEdit, env: EditEnv): CrewMemberView[] {
  switch (edit.kind) {
    case "add_step": {
      if (members.length >= MAX_CREW_STEPS) throw new CrewEditError("too_many", { max: MAX_CREW_STEPS });
      const r = rulesOf(env, edit.role);
      const after = [...new Set(edit.after)];
      for (const s of after) if (!members.some((m) => m.step === s)) throw new CrewEditError("unknown_step", { step: s });
      if (env.approved && (after.length === 0 || after.some((s) => !env.finished.has(s)))) throw new CrewEditError("not_finished");
      const draft: CrewMemberView = {
        id: env.newId(),
        step: nextStepId(members, edit.role),
        role: edit.role,
        dependsOn: after,
        required: true,
        writesCode: writesCodeFor(r),
        chosen: null,
        standby: [],
        reasons: [],
        edited: true,
        blockedBy: null,
        ...(env.approved ? { pendingApproval: true } : {}),
      };
      return [...members, { ...draft, ...pick(members, draft, edit.role, env) }];
    }
    case "remove_step": {
      const m = find(members, edit.memberId);
      unlocked(m, env);
      if (members.length <= 1) throw new CrewEditError("last_step");
      return members
        .filter((x) => x.id !== m.id)
        .map((x) => (x.dependsOn.includes(m.step) ? { ...x, dependsOn: [...new Set(x.dependsOn.flatMap((d) => (d === m.step ? m.dependsOn : [d])))] } : x));
    }
    case "set_role": {
      const m = find(members, edit.memberId);
      unlocked(m, env);
      const r = rulesOf(env, edit.role);
      if (m.role === edit.role) return [...members];
      const next: CrewMemberView = { ...m, role: edit.role, writesCode: writesCodeFor(r), edited: true };
      delete next.roleTitle;
      const others = members.map((x) => (x.id === m.id ? next : x));
      return others.map((x) => (x.id === m.id ? { ...next, ...pick(others, next, edit.role, env) } : x));
    }
    case "set_candidate": {
      const m = find(members, edit.memberId);
      unlocked(m, env);
      const c = env.rank(m.role).find((x) => x.profileId === edit.profileId);
      if (!c) throw new CrewEditError("unknown_candidate", { profileId: edit.profileId });
      const other = candidateConflict(members, m, c, env.rules);
      if (other) throw new CrewEditError("independence", { step: m.step, other });
      // The profile it replaces moves to the front of the standby chain, so nothing is lost.
      const standby = [...(m.chosen && m.chosen.profileId !== c.profileId ? [m.chosen] : []), ...m.standby.filter((s) => s.profileId !== c.profileId)].slice(0, MAX_STANDBY);
      return members.map((x) => (x.id === m.id ? { ...m, chosen: c, standby, reasons: [], edited: true } : x));
    }
    case "add_dependency": {
      const m = find(members, edit.memberId);
      const why = dependencyRefusal(members, m, edit.dependsOn, env);
      if (why) throw new CrewEditError(why.code, why.params);
      return members.map((x) => (x.id === m.id ? { ...m, dependsOn: [...m.dependsOn, edit.dependsOn], edited: true } : x));
    }
    case "remove_dependency": {
      const m = find(members, edit.memberId);
      unlocked(m, env);
      if (!m.dependsOn.includes(edit.dependsOn)) throw new CrewEditError("missing");
      return members.map((x) => (x.id === m.id ? { ...m, dependsOn: m.dependsOn.filter((d) => d !== edit.dependsOn), edited: true } : x));
    }
    case "set_standby": {
      const m = find(members, edit.memberId);
      // The chain is only who takes over next; a running crew keeps it editable for every step that has not started.
      if (env.started.has(m.id)) throw new CrewEditError("started");
      if (edit.profileIds.length > MAX_STANDBY) throw new CrewEditError("standby_too_long", { max: MAX_STANDBY });
      if (new Set(edit.profileIds).size !== edit.profileIds.length) throw new CrewEditError("standby_duplicate");
      const ranked = env.rank(m.role);
      const chain = edit.profileIds.map((id) => {
        if (id === m.chosen?.profileId) throw new CrewEditError("standby_chosen");
        const c = ranked.find((x) => x.profileId === id);
        if (!c) throw new CrewEditError("unknown_candidate", { profileId: id });
        // One way only, as in the proposal: a standby avoids the models its role must stay off;
        // whether a later reviewer clashes is checked again when a handoff picks a target.
        const other = candidateConflict(members, m, c, env.rules, m.role, true);
        if (other) throw new CrewEditError("independence", { step: m.step, other });
        return c;
      });
      return members.map((x) => (x.id === m.id ? { ...m, standby: chain, edited: true } : x));
    }
  }
}

/** Why a not-started step of a running crew cannot be skipped, or null. */
export function skipRefusal(member: CrewMemberView, started: ReadonlySet<string>): CrewEditRefusal | null {
  if (member.pendingApproval) return "not_approved";
  if (member.skippedAt) return "skipped";
  if (started.has(member.id)) return "started";
  return null;
}
