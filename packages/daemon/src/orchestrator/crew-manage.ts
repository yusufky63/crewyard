import { randomUUID } from "node:crypto";
import {
  applyCrewEdit,
  crewEstimate,
  CrewEditError,
  crewProblems,
  isBuiltinRole,
  skipRefusal,
  type CandidateView,
  type CrewBulkResult,
  type CrewMemberView,
  type CrewProposalEdit,
  type EditEnv,
  type ProjectConfig,
  type RoleId,
  type TaskChangeCause,
  type TaskDetail,
  type TaskSize,
} from "@crewyard/core";
import { rankForRole, readOnlyConflict, type ScoringContext } from "./crew.ts";
import { memberView, type MemberRow, type OrchestratorDb, type ProjectRow, type RunRow, type TaskRow } from "./db.ts";
import type { Candidate } from "./directory.ts";
import { OrchestratorError } from "./errors.ts";
import { projectRoles, type ResolvedRole } from "./role-files.ts";
import { templateOf, type RoleTemplate } from "./roles.ts";

// Managing a crew from the Crew graph (PLAN.md §9 step 6): proposal edits, follow-ups that wait
// for approval, skipping a step, Pause all and Resume all. The rules are @crewyard/core's
// crew-edit.ts, the same the renderer checks before it calls; this part loads the rows, ranks
// candidates the way the proposal does, applies one edit and writes the result in one
// transaction. It reaches the orchestrator only through CrewHost, so it does not depend on how
// the orchestrator is split into parts.

export interface CrewHost {
  readonly db: OrchestratorDb;
  readonly dataDir: string;
  candidates(project: ProjectRow): Promise<Candidate[]>;
  scoring(projectId: string, size: TaskSize, budgetUsd: number | null): ScoringContext;
  config(project: ProjectRow): { config: ProjectConfig };
  /** The role a member works as: its snapshot from a role file, else the built-in. */
  template(member: MemberRow): RoleTemplate;
  /** The member a Best of N group runs as, if the task has one. */
  bestOfMember(taskId: string): string | null;
  get(taskId: string): TaskDetail;
  emitTask(taskId: string, cause: TaskChangeCause): void;
  audit(taskId: string, runId: string | null, kind: string, payload: unknown): void;
  tick(): Promise<void>;
  pause(runId: string): Promise<unknown>;
  resume(runId: string): Promise<unknown>;
  now(): Date;
}

interface Loaded {
  task: TaskRow;
  crewId: string;
  approved: boolean;
  project: ProjectRow;
  rows: MemberRow[];
  runs: RunRow[];
  views: CrewMemberView[];
  roles: ReadonlyMap<RoleId, ResolvedRole>;
}

export class CrewManager {
  constructor(private readonly host: CrewHost) {}

  private get db() {
    return this.host.db;
  }

  /** Every eligible candidate for `role` in the task's project, best first, independence clashes included. */
  async candidates(taskId: string, role: RoleId): Promise<CandidateView[]> {
    const c = this.load(taskId);
    const tpl = this.templateFor(c, role);
    return this.ranker(c, await this.host.candidates(c.project))(tpl);
  }

  async edit(taskId: string, edit: CrewProposalEdit): Promise<TaskDetail> {
    const c = this.load(taskId);
    if (c.task.cancelled_at) throw new OrchestratorError("task.cancelled");
    const touches = "memberId" in edit ? edit.memberId : null;
    if (touches && touches === this.host.bestOfMember(c.task.id) && (edit.kind === "remove_step" || edit.kind === "set_role")) throw new CrewEditError("best_of");
    const rank = this.ranker(c, await this.host.candidates(c.project));
    const cache = new Map<RoleId, CandidateView[]>();
    const env: EditEnv = {
      rules: this.rules(c),
      rank: (role) => cache.get(role) ?? cache.set(role, rank(this.templateFor(c, role))).get(role)!,
      newId: randomUUID,
      started: new Set(c.views.filter((m) => c.runs.some((r) => r.member_id === m.id)).map((m) => m.id)),
      finished: new Set(c.views.filter((m) => this.completed(c, m.id)).map((m) => m.step)),
      approved: c.approved,
    };
    const next = applyCrewEdit(c.views, edit, env);
    // The lease follows the role (core sets it); refuse anything that would still disagree.
    const lease = crewProblems(next, env.rules).find((p) => p.code === "read_only_lease");
    if (lease) throw new CrewEditError("read_only_lease", lease.params);
    this.write(c, next, edit);
    this.host.audit(c.task.id, null, "crew.edited", { edit });
    this.host.emitTask(c.task.id, "crew_edited");
    return this.host.get(c.task.id);
  }

  /** Approves every follow-up that waits; they start under admission control like any step. */
  async approveSteps(taskId: string): Promise<TaskDetail> {
    const c = this.load(taskId);
    if (c.task.cancelled_at) throw new OrchestratorError("task.cancelled");
    const pending = c.views.filter((m) => m.pendingApproval);
    if (pending.length === 0) return this.host.get(c.task.id);
    const steps = new Set(pending.map((m) => m.step));
    const problem = crewProblems(c.views, this.rules(c)).find((p) => steps.has(p.params.step ?? "") || steps.has(p.params.other ?? ""));
    if (problem) throw new CrewEditError(problem.code, problem.params);
    const candidates = await this.host.candidates(c.project);
    for (const m of pending) {
      const cand = candidates.find((x) => x.profile.id === m.chosen?.profileId);
      if (!cand) throw new OrchestratorError("crew.unknown_profile", { profileId: m.chosen?.profileId ?? "" });
      if (readOnlyConflict(cand, this.templateFor(c, m.role, m.id))) throw new OrchestratorError("crew.read_only_profile", { profileId: cand.profile.id, role: m.role });
    }
    this.db.tx(() => {
      for (const m of pending) this.db.exec("update crew_members set pending_since = null where id = ?", m.id);
    });
    this.host.audit(c.task.id, null, "crew.steps_approved", { members: pending.map((m) => m.id) });
    this.host.emitTask(c.task.id, "crew_edited");
    await this.host.tick();
    return this.host.get(c.task.id);
  }

  /** Skips a step of the approved crew that has not started; whatever waits for it goes on without it. */
  async skip(taskId: string, memberId: string): Promise<TaskDetail> {
    const c = this.load(taskId);
    if (c.task.cancelled_at) throw new OrchestratorError("task.cancelled");
    if (!c.approved) throw new CrewEditError("not_approved");
    const m = c.views.find((x) => x.id === memberId);
    if (!m) throw new CrewEditError("unknown_step", { memberId });
    if (memberId === this.host.bestOfMember(c.task.id)) throw new CrewEditError("best_of");
    const why = skipRefusal(m, new Set(c.runs.map((r) => r.member_id)));
    if (why) throw new CrewEditError(why);
    this.db.exec("update crew_members set skipped_at = ? where id = ?", this.host.now().toISOString(), memberId);
    this.host.audit(c.task.id, null, "crew.step_skipped", { memberId, step: m.step });
    this.host.emitTask(c.task.id, "crew_edited");
    await this.host.tick();
    return this.host.get(c.task.id);
  }

  /** Pauses every open run that is not paused yet; one that refuses (handing off, ended meanwhile) is counted, not fatal. */
  async pauseAll(taskId: string): Promise<CrewBulkResult> {
    const task = this.db.task(taskId);
    return this.bulk(task.id, (r) => r.ended_at === null && r.paused_at === null, (id) => this.host.pause(id));
  }

  async resumeAll(taskId: string): Promise<CrewBulkResult> {
    const task = this.db.task(taskId);
    return this.bulk(task.id, (r) => r.ended_at === null && r.paused_at !== null, (id) => this.host.resume(id));
  }

  private async bulk(taskId: string, pick: (r: RunRow) => boolean, act: (runId: string) => Promise<unknown>): Promise<CrewBulkResult> {
    const runIds: string[] = [];
    let skipped = 0;
    for (const r of this.db.runs(taskId).filter(pick)) {
      try {
        await act(r.id);
        runIds.push(r.id);
      } catch {
        skipped++;
      }
    }
    return { taskId, runIds, skipped };
  }

  // ---- loading and writing

  private load(taskId: string): Loaded {
    const task = this.db.task(taskId);
    const crew = this.db.crew(task.id);
    if (!crew) throw new OrchestratorError("task.not_proposed");
    const project = this.db.project(task.project_id);
    const rows = this.db.members(crew.id);
    const roles = projectRoles(this.host.dataDir, project.path, this.host.config(project).config, null).set.roles;
    const views = rows.map((r) => memberView(r, null, isBuiltinRole(r.role) ? undefined : this.host.template(r).title));
    return { task, crewId: crew.id, approved: !!crew.approved_at, project, rows, runs: this.db.runs(task.id), views, roles };
  }

  private completed(c: Loaded, memberId: string): boolean {
    let latest: RunRow | null = null;
    for (const r of c.runs) if (r.member_id === memberId && (!latest || r.started_at > latest.started_at)) latest = r;
    return latest?.end_reason === "completed";
  }

  /**
   * The template a role id means here: the snapshot an existing member of that role was proposed
   * with (what you approved is what runs), else the project's role set, else the built-in.
   */
  private templateFor(c: Loaded, role: RoleId, memberId?: string): RoleTemplate {
    const row = c.rows.find((r) => r.id === memberId && r.role === role) ?? c.rows.find((r) => r.role === role);
    if (row) return this.host.template(row);
    const resolved = c.roles.get(role);
    if (resolved) return resolved.template;
    if (isBuiltinRole(role)) return templateOf(role);
    throw new CrewEditError("unknown_role", { role });
  }

  private rules(c: Loaded): EditEnv["rules"] {
    return (role) => {
      try {
        const tpl = this.templateFor(c, role);
        return { writes: tpl.policy.writes, independentOf: tpl.independentOf };
      } catch {
        return null;
      }
    };
  }

  /** Ranks as the proposal does, without dropping the models a role must stay off: the rules mark those. */
  private ranker(c: Loaded, candidates: Candidate[]): (tpl: RoleTemplate) => CandidateView[] {
    const ctx = this.host.scoring(c.project.id, c.task.size, c.task.budget_usd);
    return (tpl) => {
      const providers = new Set(c.views.filter((m) => tpl.independentOf.includes(m.role) && m.chosen).map((m) => m.chosen!.providerId));
      return rankForRole(candidates, tpl, ctx, { models: new Set(), providers });
    };
  }

  private write(c: Loaded, next: CrewMemberView[], edit: CrewProposalEdit): void {
    const before = new Map(c.rows.map((r) => [r.id, r]));
    const keep = new Set(next.map((m) => m.id));
    const at = this.host.now().toISOString();
    this.db.tx(() => {
      for (const r of c.rows) {
        if (keep.has(r.id)) continue;
        this.db.exec("delete from crew_member_roles where member_id = ?", r.id);
        this.db.exec("delete from crew_members where id = ?", r.id);
      }
      next.forEach((m, i) => {
        const r = before.get(m.id);
        const cols = [i, m.step, m.role, JSON.stringify(m.dependsOn), m.writesCode ? 1 : 0, m.chosen ? JSON.stringify(m.chosen) : null, JSON.stringify(m.standby), JSON.stringify(m.reasons), m.edited ? 1 : 0] as const;
        if (!r) {
          this.db.exec(
            `insert into crew_members (id, crew_id, position, step, role, depends_on, required, writes_code, chosen, standby, reasons, edited, pending_since)
             values (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
            m.id,
            c.crewId,
            ...cols,
            m.pendingApproval ? at : null,
          );
        } else {
          this.db.exec("update crew_members set position = ?, step = ?, role = ?, depends_on = ?, writes_code = ?, chosen = ?, standby = ?, reasons = ?, edited = ? where id = ?", ...cols, m.id);
        }
        // A new role takes its template as the project has it now; the old snapshot goes.
        if (!r || r.role !== m.role) {
          this.db.exec("delete from crew_member_roles where member_id = ?", m.id);
          const resolved = c.roles.get(m.role);
          if (resolved && resolved.source !== "builtin") this.db.saveRoleTemplate(m.id, resolved);
        }
      });
      const estimate = crewEstimate(next);
      this.db.exec("update crews set estimate_usd = ?, estimate_provenance = ? where id = ?", estimate.usd, estimate.provenance, c.crewId);
      // Picking another profile for a role is remembered as a preference (PLAN.md §9 step 6), as approve does.
      if (edit.kind === "set_candidate") {
        const old = c.views.find((m) => m.id === edit.memberId);
        const now = next.find((m) => m.id === edit.memberId);
        if (old && now?.chosen && old.chosen?.profileId !== now.chosen.profileId) {
          this.db.bumpPreference(c.project.id, now.role, now.chosen.profileId, 1);
          if (old.chosen) this.db.bumpPreference(c.project.id, old.role, old.chosen.profileId, -1);
        }
      }
    });
  }
}
