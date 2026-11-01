import type { GoalDetail, GoalsIpc, GoalTaskDraft } from "@crewyard/core";
import { orchestratorFor, type OrchestratorOptions } from "../orchestrator/index.ts";
import { OrchestratorError } from "../orchestrator/errors.ts";
import { GoalError } from "../orchestrator/goals/events.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for Orchestra goals (docs/adr/0019, design §6.2). Thin by design: the planner, the goal
// scheduler, the plan editor and the goal view in ../orchestrator/goals hold every rule, so they are
// tested without IPC. IPC params are not checked at runtime, so each handler checks the shape of
// what it passes on and refuses with a `goal.*` code (the error message is the code, translatable
// in the renderer). Every click that changes a goal answers with the goal as it is now.

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** A goal id that cannot name a goal is refused like one that names none. */
function goalId(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) throw new GoalError("goal.not_found");
  return v;
}

/** Ids that cannot name a row are refused with the code a missing row gets, before any lookup binds them. */
function projectId(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) throw new OrchestratorError("project.not_found");
  return v;
}

function taskId(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) throw new GoalError("goal.task_not_found");
  return v;
}

export function createGoalsHandlers(ctx: HandlerContext, overrides?: Partial<OrchestratorOptions>): HandlerMap<GoalsIpc> {
  const o = orchestratorFor(ctx, overrides);
  const detail = (id: string): GoalDetail => o.goalViews.detail(id);
  // Optional numbers stay out when absent, so "not given" never reads as a value.
  const opt = <K extends string>(key: K, v: unknown): Partial<Record<K, number>> => (v === undefined ? {} : ({ [key]: v } as Record<K, number>));

  return {
    "goals.list": (p) => o.goalViews.list(projectId(p?.projectId)),
    "goals.get": (p) => detail(goalId(p?.goalId)),
    "goals.state": () => ({ enabled: o.orchestraEnabled(), pausedAll: o.goals.pausedAllState() }),
    "goals.preview": ({ projectId: pid, text, plannerProfileId }) => o.previewGoal({ projectId: projectId(pid), text: typeof text === "string" ? text : "", ...(typeof plannerProfileId === "string" && plannerProfileId ? { plannerProfileId } : {}) }),
    "goals.create": async ({ projectId: pid, text, plannerProfileId, baseBranch, attachments, defaultBudgetUsd }) => {
      if (attachments !== undefined && !isStringList(attachments)) throw new GoalError("goal.bad_attachments", { error: "attachments must be a list of ids" });
      const start = await o.createGoal({
        projectId: projectId(pid),
        text,
        ...(typeof plannerProfileId === "string" && plannerProfileId ? { plannerProfileId } : {}),
        ...(typeof baseBranch === "string" ? { baseBranch } : {}),
        ...(attachments ? { attachments } : {}),
        ...opt("defaultBudgetUsd", defaultBudgetUsd),
      });
      return detail(start.goalId);
    },
    "goals.revise": async ({ goalId: id, revision, note }) => {
      await o.reviseGoal(goalId(id), revision, note);
      return detail(id);
    },
    "goals.replan": async ({ goalId: id, note }) => {
      await o.replanGoal(goalId(id), note);
      return detail(id);
    },
    "goals.addTask": async ({ goalId: id, draft, dependsOn }) => {
      if (!isRecord(draft)) throw new GoalError("goal.invalid_task", { error: "the task must be an object" });
      if (dependsOn !== undefined && !isStringList(dependsOn)) throw new GoalError("goal.task_not_found", { taskId: String(dependsOn) });
      await o.addGoalTask(goalId(id), draft as unknown as GoalTaskDraft, dependsOn ?? []);
      return detail(id);
    },
    "goals.editTask": async ({ goalId: id, revision, key, patch }) => {
      await o.goalEdits.editTask(goalId(id), revision, key, patch);
      return detail(id);
    },
    "goals.setDependency": async ({ goalId: id, revision, taskKey, dependsOnKey, on }) => {
      await o.goalEdits.setDependency(goalId(id), revision, taskKey, dependsOnKey, on);
      return detail(id);
    },
    "goals.approve": async ({ goalId: id, revision, accept, budgetUsd, maxParallel, taskBudgets }) => {
      if (!isStringList(accept)) throw new GoalError("goal.no_accepted");
      // Both limits are required (design §4.5 step 4): a goal never runs without a budget, and a
      // missing one must be refused here, before the approval resolves the base or makes a task.
      if (typeof budgetUsd !== "number") throw new GoalError("goal.bad_budget", { field: "budgetUsd" });
      if (typeof maxParallel !== "number") throw new GoalError("goal.bad_budget", { field: "maxParallel" });
      if (taskBudgets !== undefined && !isRecord(taskBudgets)) throw new GoalError("goal.bad_budget", { field: "taskBudgets" });
      await o.approveGoalPlan({ goalId: goalId(id), revision, accept, budgetUsd, maxParallel, ...(taskBudgets ? { taskBudgets } : {}) });
      return detail(id);
    },
    "goals.collapse": async ({ goalId: id }) => {
      await o.collapseGoal(goalId(id));
      return detail(id);
    },
    "goals.acceptReport": ({ goalId: id, taskId: tid }) => {
      o.goals.acceptReport(goalId(id), taskId(tid));
      return detail(id);
    },
    "goals.pause": async ({ goalId: id }) => {
      await o.goals.pause(goalId(id));
      return detail(id);
    },
    "goals.resume": async ({ goalId: id }) => {
      await o.goals.resume(goalId(id));
      return detail(id);
    },
    "goals.stopPreview": ({ goalId: id }) => o.goals.stopPreview(goalId(id)),
    "goals.stop": async ({ goalId: id }) => {
      await o.goals.stop(goalId(id));
      return detail(id);
    },
    "goals.setLimits": ({ goalId: id, budgetUsd, maxParallel }) => {
      o.goals.setLimits(goalId(id), { ...opt("budgetUsd", budgetUsd), ...opt("maxParallel", maxParallel) });
      return detail(id);
    },
    "goals.decide": async ({ goalId: id, decisionId, action }) => {
      if (typeof decisionId !== "string" || !decisionId) throw new GoalError("goal.decision_not_found");
      await o.goals.decide(goalId(id), decisionId, action);
      return detail(id);
    },
    "goals.checkMerge": async ({ goalId: id, taskId: tid }) => {
      await o.goals.checkMerge(goalId(id), taskId(tid));
      return detail(id);
    },
    // The kill switch turns on or off only on a real boolean: a malformed call never lifts it.
    "goals.pauseAll": (p) => {
      if (typeof p?.on !== "boolean") throw new GoalError("goal.action", { action: "pauseAll" });
      return o.goals.pauseAll(p.on);
    },
    "goals.setProjectDefaults": ({ projectId: pid, budgetUsd }) => o.goalEdits.setProjectDefaults(projectId(pid), budgetUsd),
  };
}
