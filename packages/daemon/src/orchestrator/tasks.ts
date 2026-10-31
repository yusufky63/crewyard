import { randomUUID } from "node:crypto";
import { isBuiltinRole, type BestOfView, type CandidateView, type CostEstimate, type CrewMemberView, type EndReason, type SpendCap, type TaskDetail, type TaskKind, type TaskMode, type TaskPreview, type TaskPreviewParams, type TaskSize, type TaskStartHold, type TaskStartResult, type TaskSummary, type TasksIpc } from "@crewyard/core";
import type { OrchestratorContext, ProposeParams } from "./context.ts";
import { Part } from "./part.ts";
import type { BestOfRunner } from "./best-of.ts";
import { classifyTask } from "./classify.ts";
import { applyCrewEdits, proposeCrew, sumEstimates, validateCrew, type CrewCheckMember, type CrewProblem } from "./crew.ts";
import { OrchestratorError } from "./errors.ts";
import { projectRoles } from "./role-files.ts";
import type { MemberRow, RequestRow, TaskRow } from "./db.ts";
import type { Candidate } from "./directory.ts";
import { reachedCaps, spendCredential } from "./spend.ts";

// A task from proposal to cancel (PLAN.md §9): classify it and store a draft crew (no process, no
// worktree, no network), approve the crew with your edits (remembered as preferences), and
// cancel, which stops every run and closes what is open but keeps the worktrees. A task is
// drafted in one of two modes (docs/adr/0019): Crew, the full plan for its kind, or Solo, one step
// of the kind's main role, which `start` proposes and approves in one click when it can price it.
// A task that belongs to an Orchestra goal is never approved or edited here: it starts with its plan.

/** Solo or Crew from untrusted input; anything else is `fallback`. */
const modeOf = (v: unknown, fallback: TaskMode): TaskMode => (v === "solo" || v === "crew" ? v : fallback);

export interface TaskFlowDeps {
  groupView(task: TaskRow): BestOfView | null;
  groupCandidates: BestOfRunner["groupCandidates"];
  approvedVariants: BestOfRunner["approvedVariants"];
  cancelAutoRetry(runId: string): void;
  stopRun(runId: string, detail: string, reason?: EndReason): Promise<void>;
  closeRequest(q: RequestRow, by: "system" | "policy"): void;
  closeHandoff(id: string, outcome: "completed" | "failed" | "cancelled" | "interrupted", detail: string | null): void;
  /** Budget's cap check: the first spend cap a step of `addUsd` would pass (budget.ts). */
  capFor(taskId: string, runId: string | null, candidate: Candidate | undefined, addUsd: number): SpendCap | null;
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

  /**
   * Classifies the task and stores a draft crew. No process, worktree or network call.
   * `inTx` runs inside the transaction that creates the task, so a goal's materialisation can
   * write the task's `goal_tasks` row there: a goal task is never visible, or approvable, without it.
   */
  async propose(p: ProposeParams, hooks: { inTx?: (taskId: string) => void } = {}): Promise<TaskDetail> {
    const project = this.db.project(p.projectId);
    const { config, fromFile } = this.config(project);
    const description = p.description ?? "";
    const attachmentIds = p.attachments ?? [];
    this.attachments.check(attachmentIds);
    const budgetUsd = p.budgetUsd ?? (fromFile ? config.budget.perTaskUsd : null);
    const mode = modeOf(p.mode, "crew");
    const draft = await this.draftCrew(project, p.title, description, { kind: p.kind, size: p.size }, budgetUsd, mode, p);
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
      hooks.inTx?.(taskId);
    });
    if (attachmentIds.length > 0) this.attachments.claim(attachmentIds, taskId, null);
    this.audit(taskId, null, "task.proposed", { kind: cls.kind, size: cls.size, mode, members: crew.members.map((m) => ({ role: m.role, profileId: m.chosen?.profileId ?? null })), bestOf: draft.group?.candidates.map((c) => c.profileId) ?? null, ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}) });
    this.emitTask(taskId, "proposed");
    return this.get(taskId);
  }

  /** Classification and crew for a task's text, scored on today's candidates; nothing is written. */
  private async draftCrew(project: ReturnType<OrchestratorContext["db"]["project"]>, title: string, description: string, given: { kind?: TaskKind; size?: TaskSize }, budgetUsd: number | null, mode: TaskMode, p: Pick<ProposeParams, "pins" | "exclude" | "bestOf"> = {}) {
    const { config } = this.config(project);
    const cls = classifyTask(title, description, given);
    const candidates = await this.candidates(project);
    const ctx = this.scoring(project.id, cls.size, budgetUsd, p.pins, p.exclude);
    const roles = projectRoles(this.opts.dataDir, project.path, config, null);
    const crew = proposeCrew(cls.kind, cls.security, candidates, ctx, { templates: new Map([...roles.set.roles].map(([id, r]) => [id, r.template])), steps: roles.steps }, mode);
    for (const m of crew.members) {
      const path = roles.set.roles.get(m.role)?.path;
      if (path) m.reasons.unshift({ code: "role.file", params: { path } });
    }
    const group = p.bestOf === undefined ? null : this.deps.groupCandidates(crew.members, candidates, ctx, p.bestOf);
    const estimate = group ? sumEstimates(crew.members.flatMap((m, i) => (i === group.index ? group.candidates.map((c) => c.estimate) : [m.chosen?.estimate ?? { usd: null, provenance: "unknown" as const }]))) : crew.estimate;
    return { cls, crew, roles, group, estimate, candidates };
  }

  /**
   * A dry run of `propose` for the composer's button: classification, the crew it would draft and
   * its estimate, plus why `start` would propose instead. Writes nothing; no process or network.
   */
  async preview(p: TaskPreviewParams): Promise<TaskPreview> {
    const project = this.db.project(p.projectId);
    const { config, fromFile } = this.config(project);
    const budgetUsd = p.budgetUsd ?? (fromFile ? config.budget.perTaskUsd : null);
    const mode = modeOf(p.mode, "crew");
    const draft = await this.draftCrew(project, p.title, p.description ?? "", { kind: p.kind, size: p.size }, budgetUsd, mode, p);
    // Ids exist only for this answer: nothing is stored, so nothing can point at them.
    const ids = draft.crew.members.map((_, i) => `preview-${i}`);
    const members: CrewMemberView[] = draft.crew.members.map((m, i) => ({
      id: ids[i]!,
      step: m.step,
      role: m.role,
      // As tasks.get shows it: built-in roles are translated by id, a custom role brings its title.
      ...(isBuiltinRole(m.role) ? {} : { roleTitle: m.template.title }),
      dependsOn: m.dependsOn,
      required: m.required,
      writesCode: m.writesCode,
      chosen: m.chosen,
      standby: m.standby,
      reasons: m.reasons,
      edited: false,
      blockedBy: null,
    }));
    const problem = validateCrew({ members: draft.crew.members.map((m, i) => ({ id: ids[i]!, role: m.role, template: m.template })), views: new Map(draft.crew.members.map((m, i) => [ids[i]!, m.chosen])), candidates: draft.candidates });
    const hold = this.holdFor(problem, draft.estimate, () => this.previewCap(draft.crew.members.map((m) => m.chosen), draft.candidates, draft.estimate.usd ?? 0, budgetUsd));
    return { kind: draft.cls.kind, size: draft.cls.size, mode, classification: draft.cls.reasons, members, estimate: draft.estimate, hold };
  }

  /**
   * Solo's `Start` (docs/adr/0019): proposes a one-step task and approves its crew in the same call,
   * so the click that showed the profile, model and estimate is the approval. Spend nobody can
   * price still needs a click (feature scan F4): an Unknown estimate, a cap the step would pass, or
   * a crew problem leaves the proposal standing and returns it with the reason. Only Solo starts
   * this way: a Crew or Best of N proposal exists so that you review it, so any other mode is
   * refused and the propose params are copied field by field (IPC params are not checked at
   * runtime, so a stray `bestOf` must not reach `propose`).
   */
  async start(p: TasksIpc["tasks.start"]["params"]): Promise<TaskStartResult> {
    if ((p.mode as unknown) !== undefined && p.mode !== "solo") throw new OrchestratorError("task.start_solo_only");
    const proposed = await this.propose({
      projectId: p.projectId,
      title: p.title,
      description: p.description,
      kind: p.kind,
      size: p.size,
      budgetUsd: p.budgetUsd,
      pins: p.pins,
      exclude: p.exclude,
      baseBranch: p.baseBranch,
      fallback: p.fallback,
      waitResetMinutes: p.waitResetMinutes,
      attachments: p.attachments,
      mode: "solo",
    });
    const held = await this.startHold(proposed.id);
    if (held) return this.heldStart(proposed.id, held);
    try {
      return { task: await this.approveCrew({ taskId: proposed.id }, { by: "start" }), started: true, held: null };
    } catch (err) {
      // A profile changed between the check and the approval: still a proposal, never a half start.
      if (err instanceof OrchestratorError && err.code.startsWith("crew.")) return this.heldStart(proposed.id, { code: "crew", params: { ...err.params, code: err.code } });
      throw err;
    }
  }

  private heldStart(taskId: string, held: TaskStartHold): TaskStartResult {
    this.audit(taskId, null, "task.start_held", { hold: held });
    return { task: this.get(taskId), started: false, held };
  }

  /** Why the stored proposal must not start on its own: a crew problem, an Unknown estimate, a cap. */
  private async startHold(taskId: string): Promise<TaskStartHold | null> {
    const task = this.db.task(taskId);
    const crew = this.db.crew(task.id);
    if (!crew) return { code: "crew", params: { code: "crew.missing_profile" } };
    const project = this.db.project(task.project_id);
    const members = this.db.members(crew.id);
    const views = this.chosenViews(members);
    const candidates = await this.candidates(project);
    const problem = validateCrew({ members: this.checkMembers(members), views, candidates });
    const estimate: CostEstimate = { usd: crew.estimate_usd, provenance: crew.estimate_provenance };
    return this.holdFor(problem, estimate, () => {
      // `start` drafts only Solo, so this checks its one step against the whole estimate.
      for (const v of views.values()) {
        const cap = v ? this.deps.capFor(task.id, null, candidates.find((c) => c.profile.id === v.profileId), estimate.usd ?? 0) : null;
        if (cap) return cap;
      }
      return null;
    });
  }

  private holdFor(problem: CrewProblem | null, estimate: CostEstimate, cap: () => SpendCap | null): TaskStartHold | null {
    if (problem) return { code: "crew", params: { ...problem.params, code: problem.code } };
    if (estimate.usd === null || estimate.provenance === "unknown") return { code: "estimate_unknown" };
    const hit = cap();
    return hit ? { code: "over_cap", params: { cap: hit.kind } } : null;
  }

  /**
   * The caps a task that does not exist yet would meet: each paid key's daily and per-task caps,
   * and the budget it would get. The task has spent nothing, so a fresh id stands in for it.
   * `start` checks again through Budget against the stored proposal; this is the button's hint.
   */
  private previewCap(views: Array<CandidateView | null>, candidates: Candidate[], addUsd: number, budgetUsd: number | null): SpendCap | null {
    const ghost = randomUUID();
    for (const v of views) {
      const c = v ? candidates.find((x) => x.profile.id === v.profileId) : undefined;
      if (c?.profile.credential.kind !== "api_key") continue;
      const cap = reachedCaps(this.opts.store.db, spendCredential(c), ghost, this.now(), { addUsd })[0];
      if (cap) return cap;
      if (budgetUsd !== null && addUsd > budgetUsd) return { kind: "task_budget", spentUsd: 0, capUsd: budgetUsd, credentialId: null, estimateUsd: addUsd };
    }
    return null;
  }

  private chosenViews(members: MemberRow[]): Map<string, CandidateView | null> {
    return new Map(members.map((m) => [m.id, m.chosen ? (JSON.parse(m.chosen) as CandidateView) : null]));
  }

  private checkMembers(members: MemberRow[]): CrewCheckMember[] {
    return members.map((m) => ({ id: m.id, role: m.role, template: this.tpl(m) }));
  }

  /**
   * True for a task an Orchestra goal starts (docs/adr/0019): a plan task, or the goal's
   * integration task. The goal scheduler releases them in dependency order, never this path.
   */
  goalManaged(taskId: string): boolean {
    const db = this.opts.store.db;
    return db.prepare("select 1 as x from goal_tasks where task_id = ?").get(taskId) !== undefined || db.prepare("select 1 as x from goals where integration_task_id = ?").get(taskId) !== undefined;
  }

  /**
   * Refuses unless `crewId` is still the task's crew, unapproved, on a task that is not cancelled
   * and, unless the goal's own code asks, not a goal's. Reads fresh rows every time, so a call
   * inside a transaction sees what is true at the write.
   */
  private assertProposal(taskId: string, crewId: string | null, byGoal: boolean): void {
    if (!byGoal && this.goalManaged(taskId)) throw new OrchestratorError("task.goal_managed");
    if (this.db.task(taskId).cancelled_at) throw new OrchestratorError("task.cancelled");
    const crew = this.db.crew(taskId);
    if (!crew || crewId === null || crew.id !== crewId || crew.approved_at) throw new OrchestratorError("task.not_proposed");
  }

  /**
   * The mode the task's crew was drafted in, so a new kind is drafted the same way: the plan's
   * choice when the goal's own code edits its task, else the last proposal or edit that recorded
   * one, else Crew, which never starts without your approval.
   */
  private draftedMode(taskId: string, byGoal: boolean): TaskMode {
    const db = this.opts.store.db;
    if (byGoal) {
      const goal = db.prepare("select mode from goal_tasks where task_id = ?").get(taskId) as { mode: string } | undefined;
      if (goal) return modeOf(goal.mode, "crew");
    }
    const rows = db.prepare("select payload from events where task_id = ? and kind in ('task.proposed', 'task.edited') order by seq desc").all(taskId) as Array<{ payload: string }>;
    for (const r of rows) {
      try {
        const mode = (JSON.parse(r.payload) as { mode?: unknown } | null)?.mode;
        if (mode === "solo" || mode === "crew") return mode;
      } catch {
        // A payload that does not parse records no mode; look further back.
      }
    }
    return "crew";
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
   * A goal task is refused: what it does was accepted with its plan revision, so its edits go
   * through the goal (`goals.editTask`), whose own code passes `byGoal` (docs/adr/0019).
   */
  async edit(taskId: string, patch: { title?: string; description?: string; kind?: TaskKind; budgetUsd?: number }, how: { byGoal?: boolean } = {}): Promise<TaskDetail> {
    const byGoal = how.byGoal === true;
    const task = this.db.task(taskId);
    const crew = this.db.crew(task.id);
    this.assertProposal(task.id, crew?.id ?? null, byGoal);
    if (!crew) throw new OrchestratorError("task.not_proposed");
    const title = patch.title ?? task.title;
    const description = patch.description ?? task.description;
    const rekind = patch.kind !== undefined && patch.kind !== task.kind;
    if (rekind && this.bestOf.group(task.id)) throw new OrchestratorError("task.best_of_kind");
    const budgetUsd = patch.budgetUsd !== undefined && (task.budget_usd === null || patch.budgetUsd < task.budget_usd) ? patch.budgetUsd : task.budget_usd;
    const project = this.db.project(task.project_id);
    const mode = rekind ? this.draftedMode(task.id, byGoal) : null;
    const draft = rekind ? await this.draftCrew(project, title, description, { kind: patch.kind, size: task.size }, budgetUsd, mode ?? "crew") : null;
    this.db.tx(() => {
      // Drafting awaited the directory: what was checked above may have changed meanwhile.
      this.assertProposal(task.id, crew.id, byGoal);
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
    this.audit(task.id, null, "task.edited", { title: patch.title !== undefined, description: patch.description !== undefined, kind: rekind ? patch.kind : null, ...(mode ? { mode } : {}), ...(budgetUsd !== task.budget_usd ? { budgetUsd } : {}) });
    this.emitTask(task.id, "edited");
    return this.get(task.id);
  }

  /**
   * Approves the crew, with optional edits, then lets the scheduler start ready steps. A goal
   * task is refused: it starts with its plan, in dependency order (docs/adr/0019).
   */
  approve(p: TasksIpc["tasks.approve"]["params"]): Promise<TaskDetail> {
    return this.approveCrew(p, {});
  }

  private async approveCrew(p: TasksIpc["tasks.approve"]["params"], how: { by?: "start" }): Promise<TaskDetail> {
    const task = this.db.task(p.taskId);
    const crew = this.db.crew(task.id);
    this.assertProposal(task.id, crew?.id ?? null, false);
    if (!crew) throw new OrchestratorError("task.not_proposed");
    const project = this.db.project(task.project_id);
    const members = this.db.members(crew.id);
    const checked = this.checkMembers(members);
    let views = this.chosenViews(members);

    const candidates = await this.candidates(project);
    if (p.edits?.length) {
      const edited = applyCrewEdits({ members: checked, views, candidates, edits: p.edits, scoring: this.scoring(project.id, task.size, task.budget_usd) });
      if (!edited.ok) throw new OrchestratorError(edited.problem.code, edited.problem.params);
      views = edited.views;
    }

    const group = this.bestOf.group(task.id);
    if (p.bestOf && !group) throw new OrchestratorError("best_of.not_found");
    const groupCands = group ? this.deps.approvedVariants(task, project, members, views, candidates, group, p) : null;

    const problem = validateCrew({ members: checked, views, candidates, group: group && groupCands ? { memberId: group.member_id, candidates: groupCands } : null });
    if (problem) throw new OrchestratorError(problem.code, problem.params);

    this.db.tx(() => {
      // The checks above ran before awaiting the directory. Meanwhile a goal may have claimed the
      // task, or it was cancelled, approved by another click or re-drafted by an edit; read again
      // here, where nothing else can interleave, so exactly one approval of this crew succeeds.
      this.assertProposal(task.id, crew.id, false);
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
    this.audit(task.id, null, "task.approved", { edits: p.edits ?? [], bestOf: groupCands?.map((g) => g.profileId) ?? null, ...(how.by ? { by: how.by } : {}) });
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
