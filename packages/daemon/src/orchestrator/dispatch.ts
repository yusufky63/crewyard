import type { CandidateView, Reason } from "@crewyard/core";
import { admit, DEFAULT_LIMITS } from "./admission.ts";
import type { OrchestratorContext, LaunchSpec } from "./context.ts";
import { Part } from "./part.ts";
import type { GroupRow } from "./best-of.ts";
import type { WakeCause } from "./hibernation.ts";
import type { MemberRow, RunRow, TaskRow, ProjectRow } from "./db.ts";
import type { Candidate } from "./directory.ts";

// The scheduling pass (PLAN.md D7, §9): every approved task's ready steps, in crew order, through
// admission control (slots, memory, a busy worktree, independence, spend held by other runs). A
// step that may start is launched; one that may not keeps the reason as `blockedBy`.

export interface DispatcherDeps {
  wakeRun(runId: string, cause: WakeCause): Promise<void>;
  startGroup(task: TaskRow, m: MemberRow, group: GroupRow, project: ProjectRow, slots: number, candidates: Candidate[]): Promise<void>;
  budgetHold(task: TaskRow, m: MemberRow, candidate: Candidate | undefined): Reason | null;
  launch(spec: LaunchSpec): Promise<string>;
  /**
   * The goal scheduler's pass (docs/adr/0019), run first: it releases goal tasks, merges finished
   * ones into their goal branch, and returns the goal tasks that must not start a new run (a paused
   * goal) and the finished steps that run again (a goal's last review after new merges).
   */
  goalPass(): Promise<{ held: ReadonlySet<string>; rerun: ReadonlySet<string> }>;
  /**
   * Orchestra's queued corrective planner turns (goals/planner.ts), started here so they pass the
   * same admission as every other step instead of taking a slot outside it.
   */
  goalTurns(admit: (task: TaskRow, m: MemberRow, profileId: string) => Promise<Reason | null>): Promise<void>;
}

const NO_GOAL_PASS = { held: new Set<string>(), rerun: new Set<string>() } as const;

export class Dispatcher extends Part {
  private ticking = false;
  private tickAgain = false;

  constructor(ctx: OrchestratorContext, private readonly deps: DispatcherDeps) {
    super(ctx);
  }

  /** One scheduling pass; re-entrant calls fold into one more pass. */
  async tick(): Promise<void> {
    if (this.closed) return;
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.tickAgain = false;
        await this.schedulePass();
      } while (this.tickAgain);
    } catch {
      // A failed pass (e.g. the store closing on exit) must not crash the daemon; the next tick retries.
    } finally {
      this.ticking = false;
    }
  }

  private async schedulePass(): Promise<void> {
    for (const [runId, cause] of [...this.pendingWake]) await this.deps.wakeRun(runId, cause);
    // The goal pass keeps each goal inside its own try/catch; this one only guards against the
    // pass itself failing, so a goal can never stop every other task from being scheduled.
    const goals = await this.deps.goalPass().catch(() => NO_GOAL_PASS);
    // Corrective planner turns come after the goal pass so they compete for admission with the
    // goal tasks it just released, under the same caps.
    await this.deps.goalTurns((task, m, profileId) => this.admitStep(task, m, profileId));
    for (const task of this.db.schedulable()) {
      if (goals.held.has(task.id)) continue;
      const status = this.db.status(task);
      if (status === "failed" || status === "cancelled") continue;
      const crew = this.db.crew(task.id)!;
      const members = this.db.members(crew.id);
      const project = this.db.project(task.project_id);
      const { config } = this.config(project);
      let candidates: Candidate[] | null = null;
      for (const m of members) {
        // A follow-up waits for its own approval; a skipped step never runs (Crew graph).
        if (m.pending_since || m.skipped_at) continue;
        const runs = this.db.runs(task.id);
        // A step runs once, and again only when a step it depends on finished again (the loops).
        const again = runs.some((r) => r.member_id === m.id) ? (this.rerunOf(m, members, runs) ?? (goals.rerun.has(m.id) ? this.goalRerun(m, runs) : null)) : null;
        if (runs.some((r) => r.member_id === m.id) && !again) {
          this.blocked.delete(m.id);
          continue;
        }
        const deps = JSON.parse(m.depends_on) as string[];
        const done = (step: string) => {
          const dep = members.find((x) => x.step === step);
          // A skipped step lets what waits for it go on without its result.
          return dep !== undefined && (!!dep.skipped_at || runs.some((r) => r.member_id === dep.id && r.end_reason === "completed"));
        };
        if (!deps.every(done)) continue;
        // A Best of N step runs as its variants' tasks until you keep one; then the kept run is its run.
        const group = this.bestOf.group(task.id);
        if (group?.member_id === m.id && !runs.some((r) => r.member_id === m.id)) {
          if (!group.started_at && !group.kept_variant_id) await this.deps.startGroup(task, m, group, project, config.rules.slots, (candidates ??= await this.candidates(project)));
          continue;
        }
        const chosen = m.chosen ? (JSON.parse(m.chosen) as CandidateView) : null;
        const reason = !chosen
          ? ({ code: "admission.no_profile" } as Reason)
          : !this.adapters.has(chosen.runner)
            ? ({ code: "admission.no_adapter", params: { runner: chosen.runner } } as Reason)
            : this.ranModels(m).has((chosen.model ?? `profile:${chosen.profileId}`).toLowerCase())
              ? ({ code: "no_independent_candidate" } as Reason)
              : (this.admission(task, m, chosen.profileId, config.rules.slots) ?? this.deps.budgetHold(task, m, (candidates ??= await this.candidates(project)).find((c) => c.profile.id === chosen.profileId)));
        if (reason) {
          const prev = this.blocked.get(m.id);
          this.blocked.set(m.id, reason);
          if (prev?.code !== reason.code) this.emitTask(task.id, "admission");
          continue;
        }
        this.blocked.delete(m.id);
        // A re-run stays on the profile that last ran the step (a handoff may have moved it off the proposal).
        if (again) await this.deps.launch({ task, member: m, target: { profileId: again.profile_id, runner: again.runner, model: again.model }, resumedFrom: again.id });
        else await this.deps.launch({ task, member: m, target: chosen! });
      }
    }
  }

  /** Admission plus the spend other runs hold, for a step started outside the crew loop below. */
  private async admitStep(task: TaskRow, m: MemberRow, profileId: string): Promise<Reason | null> {
    const project = this.db.project(task.project_id);
    const { config } = this.config(project);
    const admitted = this.admission(task, m, profileId, config.rules.slots);
    if (admitted) return admitted;
    return this.deps.budgetHold(task, m, (await this.candidates(project)).find((c) => c.profile.id === profileId));
  }

  private admission(task: TaskRow, m: MemberRow, profileId: string, projectSlots: number): Reason | null {
    const counts = this.db.activeCounts();
    const wt = this.db.worktree(task.id);
    const owner = wt?.owner_run_id ? this.db.run(wt.owner_run_id) : null;
    return admit(
      {
        projectActive: counts.byProject.get(task.project_id) ?? 0,
        profileActive: counts.byProfile.get(profileId) ?? 0,
        globalActive: counts.total,
        freeMb: this.freeMb(),
        // An undo rewrites the worktree; nothing starts in it until that is done.
        worktreeBusy: (m.writes_code === 1 && owner !== null && owner.ended_at === null) || this.turns.busy(task.id),
        profileId,
      },
      { ...DEFAULT_LIMITS, ...this.opts.limits, projectSlots },
    );
  }

  /** The goal pass asked for this finished step to run again: its latest run, if nothing continued it. */
  private goalRerun(m: MemberRow, runs: RunRow[]): RunRow | null {
    const latest = runs.filter((r) => r.member_id === m.id).at(-1);
    return latest && latest.end_reason === "completed" && !this.db.successor(latest, runs) ? latest : null;
  }

  /**
   * A completed step runs again when a step it depends on finished again after it started (the
   * review loop, a fix from PR feedback): Test and Review re-read the new head. Returns the run it
   * re-runs, or null.
   */
  private rerunOf(m: MemberRow, members: MemberRow[], runs: RunRow[]): RunRow | null {
    const mine = runs.filter((r) => r.member_id === m.id);
    const latest = mine.at(-1);
    if (!latest || latest.end_reason !== "completed" || this.db.successor(latest, runs)) return null;
    const deps = JSON.parse(m.depends_on) as string[];
    const newer = members
      .filter((d) => deps.includes(d.step))
      .some((d) => runs.some((r) => r.member_id === d.id && r.end_reason === "completed" && r.ended_at !== null && r.ended_at > latest.started_at && !this.db.successor(r, runs)));
    return newer ? latest : null;
  }
}
