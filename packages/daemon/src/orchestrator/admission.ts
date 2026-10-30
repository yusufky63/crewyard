import type { Reason } from "@crewyard/core";

// Admission control from day one (PLAN.md D7, PRIOR_ART.md: agent-orchestrator OOMs at ~15
// workers). Nothing spawns without a free project slot, a free profile slot, a free global slot
// and enough free memory. The first failing check is the reason the UI shows.

export interface AdmissionLimits {
  projectSlots: number;
  perProfile: number;
  globalSlots: number;
  minFreeMb: number;
}

export interface AdmissionLoad {
  projectActive: number;
  profileActive: number;
  globalActive: number;
  freeMb: number;
  /** A code-writing step waits while another run holds the task's worktree. */
  worktreeBusy: boolean;
  profileId: string;
}

export const DEFAULT_LIMITS: Omit<AdmissionLimits, "projectSlots"> = { perProfile: 2, globalSlots: 6, minFreeMb: 1024 };

export function admit(load: AdmissionLoad, limits: AdmissionLimits): Reason | null {
  if (load.worktreeBusy) return { code: "admission.worktree_busy" };
  if (load.projectActive >= limits.projectSlots) return { code: "admission.project_slots", params: { used: load.projectActive, slots: limits.projectSlots } };
  if (load.globalActive >= limits.globalSlots) return { code: "admission.global_slots", params: { used: load.globalActive, slots: limits.globalSlots } };
  if (load.profileActive >= limits.perProfile) return { code: "admission.profile_busy", params: { used: load.profileActive, limit: limits.perProfile, profileId: load.profileId } };
  if (load.freeMb < limits.minFreeMb) return { code: "admission.memory", params: { freeMb: Math.round(load.freeMb), neededMb: limits.minFreeMb } };
  return null;
}

export interface GroupLoad {
  projectActive: number;
  globalActive: number;
  freeMb: number;
  /** Per profile of the group: how many variants it takes and how many runs it has open now. */
  profiles: Array<{ profileId: string; needed: number; active: number }>;
}

/**
 * Best of N starts every variant at once or none, so a half-started group never holds slots
 * while the rest waits: all project, global and per-profile slots, and memory for each variant.
 */
export function admitGroup(load: GroupLoad, limits: AdmissionLimits): Reason | null {
  const needed = load.profiles.reduce((n, p) => n + p.needed, 0);
  const projectFree = limits.projectSlots - load.projectActive;
  if (projectFree < needed) return { code: "admission.group_slots", params: { variants: needed, free: Math.max(0, projectFree), scope: "project" } };
  const globalFree = limits.globalSlots - load.globalActive;
  if (globalFree < needed) return { code: "admission.group_slots", params: { variants: needed, free: Math.max(0, globalFree), scope: "global" } };
  for (const p of load.profiles) {
    const free = limits.perProfile - p.active;
    if (free < p.needed) return { code: "admission.group_slots", params: { variants: p.needed, free: Math.max(0, free), scope: "profile" } };
  }
  const neededMb = limits.minFreeMb * needed;
  if (load.freeMb < neededMb) return { code: "admission.group_memory", params: { freeMb: Math.round(load.freeMb), neededMb } };
  return null;
}
