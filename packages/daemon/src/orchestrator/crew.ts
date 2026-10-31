import { estimateCost, peakFactor, type CandidateView, type CustomRoleStep, type CostEstimate, type Headroom, type Reason, type RoleId, type RunnerId, type TaskKind, type TaskSize } from "@crewyard/core";
import type { Candidate } from "./directory.ts";
import { customPlanSteps, planFor, templateOf, TOKENS_BY_SIZE, TURN_OVERHEAD_TOKENS, type RoleRef, type RoleTemplate } from "./roles.ts";

// Crew proposal v1 (PLAN.md §9): rule-based and deterministic. Same inputs, same crew. It learns
// only from the user's own history (completed runs and crew edits), never from a hidden model call.

/** Weights of the four scored factors; they add up to 100 so a score reads as a percentage. */
export const WEIGHTS = { fit: 35, headroom: 30, cost: 25, history: 10 } as const;
const PROVIDER_BONUS = 8;
const PREFERENCE_BONUS = 5;
/** PLAN.md §8.2: a target needs more than 20% left on its windows. */
export const MIN_HEADROOM = 20;
const STANDBY = 2;

export interface ScoringContext {
  size: TaskSize;
  budgetUsd: number | null;
  hasAdapter(runner: RunnerId): boolean;
  headroom(profileId: string): Headroom;
  history(runner: RunnerId, role: RoleId): { accepted: number; total: number };
  /** Net count of times the user picked (+) or replaced (-) this profile for this role. */
  preference(role: RoleId, profileId: string): number;
  pins?: Partial<Record<RoleId, string>>;
  exclude?: string[];
  /** When the proposal is made, for peak-hour prices; the wall clock when left out. */
  now?: Date;
}

export interface ProposedMember {
  step: string;
  role: RoleId;
  /** The role as resolved for this project (a role file or the built-in). */
  template: RoleTemplate;
  dependsOn: string[];
  required: boolean;
  writesCode: boolean;
  chosen: CandidateView | null;
  standby: CandidateView[];
  reasons: Reason[];
}

export const modelKey = (c: Candidate) => (c.model?.id ?? c.profile.defaultModel ?? `profile:${c.profile.id}`).toLowerCase();
const viewKey = (v: CandidateView) => (v.model ?? `profile:${v.profileId}`).toLowerCase();

/** A profile you marked read-only never takes a role that writes, however it got there (proposal, edit, handoff). */
export const readOnlyConflict = (c: Candidate, role: RoleRef) => Boolean(c.readOnly) && templateOf(role).policy.writes !== "none";

/** Hard requirements: a candidate that fails one is never offered for the role. */
export function eligible(c: Candidate, role: RoleRef, ctx: Pick<ScoringContext, "hasAdapter" | "exclude">): boolean {
  const tpl = templateOf(role);
  if (!c.ready || !ctx.hasAdapter(c.profile.runner)) return false;
  if (ctx.exclude?.includes(c.profile.id)) return false;
  if (!c.capabilities.launch || !c.capabilities.stream || !c.capabilities.approveTools) return false;
  if (readOnlyConflict(c, role)) return false;
  return !tpl.needsReadOnly || c.capabilities.readOnlyMode;
}

/** `at` is when the run would start: a step proposed in a provider's peak hours is priced at its peak rate. */
export function estimateFor(c: Candidate, role: RoleRef, size: TaskSize, at: Date = new Date()): CostEstimate {
  if (c.profile.credential.kind !== "api_key") return { usd: 0, provenance: "estimated" };
  if (!c.model) return { usd: null, provenance: "unknown" };
  const t = TOKENS_BY_SIZE[size];
  const share = templateOf(role).tokenShare;
  const turns = Math.max(1, Math.round(t.turns * share));
  const overhead = (TURN_OVERHEAD_TOKENS[c.profile.runner] ?? 0) * turns;
  const usd = estimateCost(c.model, Math.round(t.tokensIn * share) + overhead, Math.round(t.tokensOut * share));
  return usd === null ? { usd: null, provenance: "unknown" } : { usd: Math.round(usd * peakFactor(c.peak, at) * 10_000) / 10_000, provenance: "estimated" };
}

/** Scores one candidate for one role; `avoid` holds the implementer's models and providers. */
export function scoreCandidate(c: Candidate, role: RoleRef, ctx: ScoringContext, avoid: { providers: Set<string> } = { providers: new Set() }): CandidateView {
  const tpl = templateOf(role);
  const reasons: Reason[] = [];
  const need = TOKENS_BY_SIZE[ctx.size].context;

  let fit: number;
  if (!c.model) {
    fit = 40;
    reasons.push({ code: "fit.model_unknown" });
  } else {
    fit = tpl.prefersReasoning ? 50 : 65;
    if (tpl.prefersReasoning && c.model.reasoning) {
      fit += 30;
      reasons.push({ code: "fit.reasoning" });
    }
    if (c.model.context !== null && c.model.context >= need) {
      fit += 20;
      reasons.push({ code: "fit.context", params: { context: c.model.context } });
    } else if (c.model.context !== null) {
      fit -= 20;
      reasons.push({ code: "fit.context_small", params: { context: c.model.context, needed: need } });
    }
  }

  const headroom = ctx.headroom(c.profile.id);
  let room: number;
  if (headroom.pct === null) {
    room = 50;
    reasons.push({ code: "headroom.unknown" });
  } else if (headroom.pct < MIN_HEADROOM) {
    room = 0;
    reasons.push({ code: "headroom.low", params: { pct: Math.round(headroom.pct), window: headroom.window ?? "" } });
  } else {
    // Reported beats Estimated at the same number (PLAN.md §9 step 3).
    room = headroom.pct * (headroom.provenance === "reported" ? 1 : 0.9);
    reasons.push({ code: "headroom", params: { pct: Math.round(headroom.pct), provenance: headroom.provenance, window: headroom.window ?? "" } });
  }

  const estimate = estimateFor(c, role, ctx.size, ctx.now);
  let cost: number;
  if (estimate.usd === null) {
    cost = 50;
    reasons.push({ code: "cost.unknown" });
  } else if (ctx.budgetUsd !== null && estimate.usd > ctx.budgetUsd) {
    cost = 0;
    reasons.push({ code: "cost.over_budget", params: { usd: estimate.usd, budget: ctx.budgetUsd } });
  } else if (estimate.usd === 0) {
    cost = 100;
    reasons.push({ code: "cost.plan" });
  } else {
    // $0 -> 100, $1 -> 50, $4 -> 20: monotone and easy to explain.
    cost = 100 / (1 + estimate.usd);
    reasons.push({ code: "cost.estimate", params: { usd: estimate.usd } });
  }

  const h = ctx.history(c.profile.runner, tpl.id);
  let history = 50;
  if (h.total >= 3) {
    history = (100 * h.accepted) / h.total;
    reasons.push({ code: "history.accepted", params: { accepted: h.accepted, total: h.total } });
  }

  let score = (WEIGHTS.fit * clamp(fit) + WEIGHTS.headroom * clamp(room) + WEIGHTS.cost * clamp(cost) + WEIGHTS.history * clamp(history)) / 100;
  // The user's own "when to use" note leads the one-line reason; it never changes the score.
  if (c.note) reasons.unshift({ code: "profile.note", params: { note: c.note } });
  if (tpl.independentOf.length > 0 && avoid.providers.size > 0 && !avoid.providers.has(c.profile.providerId)) {
    score += PROVIDER_BONUS;
    reasons.unshift({ code: "independence.provider" });
  }
  const pref = ctx.preference(tpl.id, c.profile.id);
  if (pref > 0) {
    score += Math.min(3, pref) * PREFERENCE_BONUS;
    reasons.push({ code: "history.preferred" });
  }

  return {
    profileId: c.profile.id,
    alias: c.profile.alias,
    runner: c.profile.runner,
    providerId: c.profile.providerId,
    model: c.model?.id ?? c.profile.defaultModel,
    score: Math.round(score * 10) / 10,
    headroom,
    estimate,
    reasons,
    // Only when the runner cannot take a kind, so the proposal can say what it gets as a path.
    ...(c.capabilities.attachments?.images && c.capabilities.attachments.files ? {} : { attachments: { images: c.capabilities.attachments?.images === true, files: c.capabilities.attachments?.files === true } }),
  };
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Ranks every eligible candidate for a role, best first; ties break on profile id. */
export function rankForRole(candidates: Candidate[], role: RoleRef, ctx: ScoringContext, avoid: { models: Set<string>; providers: Set<string> }): CandidateView[] {
  const pinned = ctx.pins?.[templateOf(role).id];
  return candidates
    .filter((c) => eligible(c, role, ctx) && !avoid.models.has(modelKey(c)))
    .map((c) => {
      const v = scoreCandidate(c, role, ctx, avoid);
      if (pinned === c.profile.id) v.reasons.unshift({ code: "pinned" });
      return v;
    })
    .sort((a, b) => Number(b.profileId === pinned) - Number(a.profileId === pinned) || b.score - a.score || a.profileId.localeCompare(b.profileId));
}

/**
 * The project's roles for a proposal: templates resolved from role files (built-ins when left out)
 * and the custom steps its project.json adds to the templates.
 */
export interface ProjectRoleSet {
  templates: ReadonlyMap<RoleId, RoleTemplate>;
  steps: CustomRoleStep[];
}

export function proposeCrew(kind: TaskKind, security: boolean, candidates: Candidate[], ctx: ScoringContext, roles?: ProjectRoleSet): { members: ProposedMember[]; estimate: CostEstimate } {
  const chosenByRole = new Map<RoleId, CandidateView>();
  const base = planFor(kind, ctx.size, security);
  const plan = roles ? [...base, ...customPlanSteps(base, roles.steps, kind, ctx.size)] : base;
  const members = plan.map((step): ProposedMember => {
    const tpl = roles?.templates.get(step.role) ?? templateOf(step.role);
    const avoid = { models: new Set<string>(), providers: new Set<string>() };
    for (const other of tpl.independentOf) {
      const v = chosenByRole.get(other);
      if (v) {
        avoid.models.add(viewKey(v));
        avoid.providers.add(v.providerId);
      }
    }
    const ranked = rankForRole(candidates, tpl, ctx, avoid);
    const [chosen, ...rest] = ranked;
    const reasons: Reason[] = [];
    const dropped = pinDropped(candidates, tpl, ctx, avoid, chosen);
    if (dropped) reasons.push(dropped);
    if (!chosen) {
      const anyEligible = candidates.some((c) => eligible(c, tpl, ctx));
      reasons.push({ code: anyEligible && avoid.models.size > 0 ? "no_independent_candidate" : "no_candidate" });
    } else {
      chosenByRole.set(step.role, chosen);
      if (avoid.models.size > 0) chosen.reasons.unshift({ code: "independence.model", params: { model: [...avoid.models][0] ?? "" } });
      if (rest.length === 0) reasons.push({ code: "only_candidate" });
    }
    return { ...step, template: tpl, writesCode: tpl.writesCode, chosen: chosen ?? null, standby: rest.slice(0, STANDBY), reasons };
  });
  return { members, estimate: sumEstimates(members.map((m) => m.chosen?.estimate ?? { usd: null, provenance: "unknown" })) };
}

/**
 * Why your pin for a role is not the chosen profile, so the proposal can say so instead of
 * silently picking another one (the live run pinned a reviewer on the implementer's model).
 */
function pinDropped(candidates: Candidate[], role: RoleRef, ctx: ScoringContext, avoid: { models: Set<string> }, chosen: CandidateView | undefined): Reason | null {
  const pin = ctx.pins?.[templateOf(role).id];
  if (!pin || chosen?.profileId === pin) return null;
  const c = candidates.find((x) => x.profile.id === pin);
  const cause = !c ? "unavailable" : readOnlyConflict(c, role) ? "read_only" : !eligible(c, role, ctx) ? "unavailable" : avoid.models.has(modelKey(c)) ? "independence" : null;
  return cause ? { code: "pin.dropped", params: { alias: c?.profile.alias ?? pin, cause } } : null;
}

export function sumEstimates(parts: CostEstimate[]): CostEstimate {
  if (parts.length === 0) return { usd: 0, provenance: "estimated" };
  if (parts.some((p) => p.usd === null)) return { usd: null, provenance: "unknown" };
  return { usd: Math.round(parts.reduce((a, p) => a + (p.usd ?? 0), 0) * 10_000) / 10_000, provenance: "estimated" };
}

/** True when two views would break the independence rule (same model). */
export const sameModel = (a: CandidateView, b: CandidateView) => viewKey(a) === viewKey(b);
