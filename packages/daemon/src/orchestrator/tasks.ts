import { randomUUID } from "node:crypto";
import type { CandidateView, TaskDetail, TaskSummary, TasksIpc, EndReason, BestOfView, TaskKind, TaskSize } from "@crewyard/core";
import type { OrchestratorContext, ProposeParams } from "./context.ts";
import { Part } from "./part.ts";
import type { BestOfRunner } from "./best-of.ts";
import { classifyTask } from "./classify.ts";
import { eligible, proposeCrew, readOnlyConflict, sameModel, scoreCandidate, sumEstimates } from "./crew.ts";
import { OrchestratorError } from "./errors.ts";
import { projectRoles } from "./role-files.ts";
import type { RequestRow, TaskRow } from "./db.ts";

// A task from proposal to cancel (PLAN.md §9): classify it and store a draft crew (no process, no
// worktree, no network), approve the crew with your edits (remembered as preferences), and
// cancel, which stops every run and closes what is open but keeps the worktrees.

export interface TaskFlowDeps {
  groupView(task: TaskRow): BestOfView | null;
  groupCandidates: BestOfRunner["groupCandidates"];
  approvedVariants: BestOfRunner["approvedVariants"];
  cancelAutoRetry(runId: string): void;
  stopRun(runId: string, detail: string, reason?: EndReason): Promise<void>;
  closeRequest(q: RequestRow, by: "system" | "policy"): void;
  closeHandoff(id: string, outcome: "completed" | "failed" | "cancelled" | "interrupted", detail: string | null): void;
  tick(): Promise<void>;
}

export class TaskFlow extends Part {
  constructor(ctx: OrchestratorContext, private readonly deps: TaskFlowDeps) {
    super(ctx);
  }

  /** The task list; a Best of N variant's hidden task shows inside its parent, not as a row. */
  list(projectId?: string): TaskSummary[] {
    const variants = this.bestOf.variantTaskIds();
    return this.db
      .tasks(projectId)
      .filter((t) => !variants.has(t.id))
      .map((t) => this.db.summary(t));
  }

  get(taskId: string): TaskDetail {
    const task = this.db.task(taskId);
    const attachments = this.attachments.taskViews(task.id);
    return { ...this.db.detail(task, this.blocked), bestOfGroup: this.deps.groupView(task), accountSwitch: this.switches.taskEnabled(task.id), ...(attachments.length > 0 ? { attachments } : {}) };
  }

  /** Classifies the task and stores a draft crew. No process, worktree or network call. */
  async propose(p: ProposeParams): Promise<TaskDetail> {
    const project = this.db.project(p.projectId);
    const { config, fromFile } = this.config(project);
    const description = p.description ?? "";
    const attachmentIds = p.attachments ?? [];
    this.attachments.check(attachmentIds);
    const budgetUsd = p.budgetUsd ?? (fromFile ? config.budget.perTaskUsd : null);
    const draft = await this.draftCrew(project, p.title, description, { kind: p.kind, size: p.size }, budgetUsd, p);
    const { cls, crew } = draft;
    const taskId = randomUUID();
    const at = this.iso();
    this.db.tx(() => {
      this.db.exec(
        `insert into tasks (id, project_id, title, description, kind, size, base_branch, fallback, wait_reset_minutes, budget_usd, classification, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        taskId,
        project.id,
        p.title,
        description,
        cls.kind,
        cls.size,
        p.baseBranch ?? null,
        p.fallback ?? config.rules.fallback,
        p.waitResetMinutes ?? 20,
        budgetUsd,
        JSON.stringify(cls.reasons),
        at,
      );
      this.writeCrew(taskId, draft, at);
    });
    if (attachmentIds.length > 0) this.attachments.claim(attachmentIds, taskId, null);
    this.audit(taskId, null, "task.proposed", { kind: cls.kind, size: cls.size, members: crew.members.map((m) => ({ role: m.role, profileId: m.chosen?.profileId ?? null })), bestOf: draft.group?.candidates.map((c) => c.profileId) ?? null, ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}) });
    this.emitTask(taskId, "proposed");
    return this.get(taskId);
  }

  /** Classification and crew for a task's text, scored on today's candidates; nothing is written. */
  private async draftCrew(project: ReturnType<OrchestratorContext["db"]["project"]>, title: string, description: string, given: { kind?: TaskKind; size?: TaskSize }, budgetUsd: number | null, p: Pick<ProposeParams, "pins" | "exclude" | "bestOf"> = {}) {
    const { config } = this.config(project);
    const cls = classifyTask(title, description, given);
    const candidates = await this.candidates(project);
    const ctx = this.scoring(project.id, cls.size, budgetUsd, p.pins, p.exclude);
    const roles = projectRoles(this.opts.dataDir, project.path, config, null);
    const crew = proposeCrew(cls.kind, cls.security, candidates, ctx, { templates: new Map([...roles.set.roles].map(([id, r]) => [id, r.template])), steps: roles.steps });
    for (const m of crew.members) {
      const path = roles.set.roles.get(m.role)?.path;
      if (path) m.reasons.unshift({ code: "role.file", params: { path } });
    }
    const group = p.bestOf === undefined ? null : this.deps.groupCandidates(crew.members, candidates, ctx, p.bestOf);
    const estimate = group ? sumEstimates(crew.members.flatMap((m, i) => (i === group.index ? group.candidates.map((c) => c.estimate) : [m.chosen?.estimate ?? { usd: null, provenance: "unknown" as const }]))) : crew.estimate;
    return { cls, crew, roles, group, estimate };
  }

  /** Stores a drafted crew for the task; inside the caller's transaction. */
  private writeCrew(taskId: string, d: Awaited<ReturnType<TaskFlow["draftCrew"]>>, at: string): void {
    const { crew, roles, group, estimate } = d;
    const crewId = randomUUID();
    const memberIds = crew.members.map(() => randomUUID());
    this.db.exec("insert into crews (id, task_id, proposed_at, estimate_usd, estimate_provenance) values (?, ?, ?, ?, ?)", crewId, taskId, at, estimate.usd, estimate.provenance);
    crew.members.forEach((m, i) =>
      this.db.exec(
        `insert into crew_members (id, crew_id, position, step, role, depends_on, required, writes_code, chosen, standby, reasons)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        memberIds[i]!,
        crewId,
        i,
        m.step,
        m.role,
        JSON.stringify(m.dependsOn),
        m.required ? 1 : 0,
        m.writesCode ? 1 : 0,
        m.chosen ? JSON.stringify(m.chosen) : null,
        JSON.stringify(m.standby),
        JSON.stringify(m.reasons),
      ),
    );
    crew.members.forEach((m, i) => {
      const r = roles.set.roles.get(m.role);
      if (r && r.source !== "builtin") this.db.saveRoleTemplate(memberIds[i]!, r);
    });
    if (group) this.bestOf.create(taskId, memberIds[group.index]!, group.candidates);
  }

  /**
   * Changes the title, description or kind of a task whose crew is still a proposal (docs/adr/0017).
   * A new kind is classified and proposed again, replacing the crew; nothing has run, so nothing
   * else points at the old members. A Best of N task keeps its kind. A budget may only go down.
   */
  async edit(taskId: string, patch: { title?: string; description?: string; kind?: TaskKind; budgetUsd?: number }): Promise<TaskDetail> {
    const task = this.db.task(taskId);
    if (task.cancelled_at) throw new OrchestratorError("task.cancelled");
    const crew = this.db.crew(task.id);
    if (!crew || crew.approved_at) throw new OrchestratorError("task.not_proposed");
    const title = patch.title ?? task.title;
    const description = patch.description ?? task.description;
    const rekind = patch.kind !== undefined && patch.kind !== task.kind;
    if (rekind && this.bestOf.group(task.id)) throw new OrchestratorError("task.best_of_kind");
    const budgetUsd = patch.budgetUsd !== undefined && (task.budget_usd === null || patch.budgetUsd < task.budget_usd) ? patch.budgetUsd : task.budget_usd;
    const project = this.db.project(task.project_id);
    const draft = rekind ? await this.draftCrew(project, title, description, { kind: patch.kind, size: task.size }, budgetUsd) : null;
    this.db.tx(() => {
      this.db.exec("update tasks set title = ?, description = ?, budget_usd = ? where id = ?", title, description, budgetUsd, task.id);
      if (!draft) return;
      const members = this.db.members(crew.id).map((m) => m.id);
      for (const id of members) {
        this.db.exec("delete from crew_member_roles where member_id = ?", id);
        this.db.exec("delete from crew_member_flags where member_id = ?", id);
      }
      this.db.exec("delete from crew_members where crew_id = ?", crew.id);
      this.db.exec("delete from crews where id = ?", crew.id);
      this.db.exec("update tasks set kind = ?, size = ?, classification = ? where id = ?", draft.cls.kind, draft.cls.size, JSON.stringify(draft.cls.reasons), task.id);
      this.writeCrew(task.id, draft, this.iso());
    });
    this.audit(task.id, null, "task.edited", { title: patch.title !== undefined, description: patch.description !== undefined, kind: rekind ? patch.kind : null, ...(budgetUsd !== task.budget_usd ? { budgetUsd } : {}) });
    this.emitTask(task.id, "edited");
    return this.get(task.id);
  }

  /** Approves the crew, with optional edits, then lets the scheduler start ready steps. */
  async approve(p: TasksIpc["tasks.approve"]["params"]): Promise<TaskDetail> {
    const task = this.db.task(p.taskId);
    if (task.cancelled_at) throw new OrchestratorError("task.cancelled");
    const crew = this.db.crew(task.id);
    if (!crew || crew.approved_at) throw new OrchestratorError("task.not_proposed");
    const project = this.db.project(task.project_id);
    const members = this.db.members(crew.id);
    const views = new Map(members.map((m) => [m.id, m.chosen ? (JSON.parse(m.chosen) as CandidateView) : null]));

    const candidates = await this.candidates(project);
    if (p.edits?.length) {
      const ctx = this.scoring(project.id, task.size, task.budget_usd);
      for (const edit of p.edits) {
        const m = members.find((x) => x.id === edit.memberId);
        if (!m) throw new OrchestratorError("crew.member_not_found", { memberId: edit.memberId });
        const c = candidates.find((x) => x.profile.id === edit.profileId);
        if (c && readOnlyConflict(c, this.tpl(m))) throw new OrchestratorError("crew.read_only_profile", { profileId: c.profile.id, role: m.role });
        if (!c || !eligible(c, this.tpl(m), ctx)) throw new OrchestratorError("crew.unknown_profile", { profileId: edit.profileId });
        const v = scoreCandidate(c, this.tpl(m), ctx);
        if (edit.model) v.model = edit.model;
        views.set(m.id, v);
      }
    }

    const group = this.bestOf.group(task.id);
    if (p.bestOf && !group) throw new OrchestratorError("best_of.not_found");
    const groupCands = group ? this.deps.approvedVariants(task, project, members, views, candidates, group, p) : null;

    for (const m of members) {
      const v = views.get(m.id);
      if (!v) throw new OrchestratorError("crew.missing_profile", { role: m.role });
      // Checked for every member, not only edited ones: the profile may have been marked read-only after the proposal.
      const c = candidates.find((x) => x.profile.id === v.profileId);
      if (c && readOnlyConflict(c, this.tpl(m))) throw new OrchestratorError("crew.read_only_profile", { profileId: c.profile.id, role: m.role });
      for (const other of this.tpl(m).independentOf) {
        const o = members.find((x) => x.role === other);
        const ov = o ? views.get(o.id) : null;
        if (ov && sameModel(v, ov)) throw new OrchestratorError("crew.independence", { role: m.role });
        // Any variant may be the one you keep, so a reviewer must be independent of all of them.
        if (o && group?.member_id === o.id && groupCands?.some((g) => sameModel(v, g))) throw new OrchestratorError("crew.independence", { role: m.role });
      }
    }

    this.db.tx(() => {
      for (const edit of p.edits ?? []) {
        const m = members.find((x) => x.id === edit.memberId)!;
        const v = views.get(m.id)!;
        const before = m.chosen ? (JSON.parse(m.chosen) as CandidateView) : null;
        const standby = (JSON.parse(m.standby) as CandidateView[]).filter((s) => s.profileId !== v.profileId);
        this.db.exec("update crew_members set chosen = ?, standby = ?, edited = 1 where id = ?", JSON.stringify(v), JSON.stringify(standby), m.id);
        // Edits are remembered as preferences (PLAN.md §9 step 6).
        if (before?.profileId !== v.profileId) {
          this.db.bumpPreference(project.id, m.role, v.profileId, 1);
          if (before) this.db.bumpPreference(project.id, m.role, before.profileId, -1);
        }
      }
      if (group && groupCands) {
        this.bestOf.replace(group.id, groupCands);
        this.db.exec("update crew_members set chosen = ? where id = ?", JSON.stringify(groupCands[0]), group.member_id);
      }
      const estimate = sumEstimates([...views.entries()].flatMap(([id, v]) => (groupCands && group?.member_id === id ? groupCands.map((g) => g.estimate) : [v?.estimate ?? { usd: null, provenance: "unknown" as const }])));
      this.db.exec("update crews set approved_at = ?, estimate_usd = ?, estimate_provenance = ? where id = ?", this.iso(), estimate.usd, estimate.provenance, crew.id);
      if (p.fallback) this.db.exec("update tasks set fallback = ? where id = ?", p.fallback, task.id);
      if (p.accountSwitch !== undefined) this.switches.setTask(task.id, p.accountSwitch);
    });
    this.audit(task.id, null, "task.approved", { edits: p.edits ?? [], bestOf: groupCands?.map((g) => g.profileId) ?? null });
    this.emitTask(task.id, "approved");
    await this.deps.tick();
    return this.get(task.id);
  }

  /** Lets the task's steps switch to another account of the same provider, or holds them out (docs/adr/0009). */
  setAccountSwitch(taskId: string, enabled: boolean): TaskDetail {
    const task = this.db.task(taskId);
    this.switches.setTask(task.id, enabled);
    this.audit(task.id, null, "task.account_switch", { enabled });
    this.emitTask(task.id, "account_switch");
    return this.get(task.id);
  }

  /** Stops every run, closes open requests and handoffs. Worktrees are kept. */
  async cancel(taskId: string): Promise<TaskDetail> {
    const task = this.db.task(taskId);
    if (!task.cancelled_at) {
      this.db.exec("update tasks set cancelled_at = ? where id = ?", this.iso(), task.id);
      for (const r of this.db.runs(task.id).filter((r) => r.ended_at && r.resume_at)) this.deps.cancelAutoRetry(r.id);
      for (const r of this.db.runs(task.id).filter((r) => !r.ended_at)) await this.deps.stopRun(r.id, "task_cancelled");
      for (const q of this.db.requests({ taskId: task.id })) this.deps.closeRequest(q, "system");
      for (const h of this.db.handoffs(task.id).filter((h) => !h.closed_at)) this.deps.closeHandoff(h.id, "cancelled", null);
      // The variants of a Best of N group go with their task; their worktrees stay, like the task's.
      for (const id of this.bestOf.variantTasksOf(task.id)) await this.cancel(id);
      this.audit(task.id, null, "task.cancelled", {});
      this.emitTask(task.id, "cancelled");
    }
    return this.get(task.id);
  }
}
