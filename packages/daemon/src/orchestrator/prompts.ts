import type { RoleId } from "@crewyard/core";
import type { RunRow, TaskRow } from "./db.ts";
import { ROLES } from "./roles.ts";

// Agent-facing text. It is read by models, not shown as UI copy, so it stays English and is not
// translated. Task text written by the user is passed through as data inside clear delimiters.

type Plan = Array<{ title: string; status: string }>;

export function rolePrompt(role: RoleId, task: TaskRow, ctx: { plan: Plan | null; branch: string | null }): string {
  const tpl = ROLES[role];
  return [
    `Role: ${tpl.title}`,
    "",
    `You are the ${tpl.title} in a crew working on one task. Your output: ${tpl.contract}`,
    ctx.branch ? `You work in a git worktree on branch ${ctx.branch}. Commit locally; never push.` : "You work in the project folder and must not change files.",
    "",
    "Task:",
    "<<<",
    task.title,
    task.description,
    ">>>",
    ...(ctx.plan && ctx.plan.length > 0 ? ["", "Approved plan:", ...ctx.plan.map((s, i) => `${i + 1}. ${s.title}`)] : []),
  ].join("\n");
}

export interface HandoffPackageInput {
  task: TaskRow;
  source: RunRow;
  trigger: string;
  plan: Plan | null;
  diffStat: string | null;
  checkpointSha: string | null;
  openQuestions: string[];
  transcript: string;
}

/** PLAN.md §8.2 step 5. Cross-provider handoff never claims to carry hidden model state. */
export function handoffPackage(p: HandoffPackageInput): string {
  const done = p.plan?.filter((s) => s.status === "completed").map((s) => `- ${s.title}`) ?? [];
  const todo = p.plan?.filter((s) => s.status !== "completed").map((s) => `- ${s.title}`) ?? [];
  return [
    `Role: ${ROLES[p.source.role].title}`,
    "",
    "# Handoff package",
    "",
    `You continue work another agent (${p.source.runner}, ${p.source.model ?? "default model"}) started on this task. Reason for the handoff: ${p.trigger}.`,
    "You do not have its memory; everything you need is below and in the worktree. Read it, run `git status`, then continue.",
    "",
    "## Goal",
    "<<<",
    p.task.title,
    p.task.description,
    ">>>",
    "",
    "## Plan",
    ...(p.plan ? [] : ["(no plan was reported)"]),
    ...(done.length ? ["Completed:", ...done] : []),
    ...(todo.length ? ["Remaining:", ...todo] : []),
    "",
    "## Changes so far",
    p.checkpointSha ? `Work in progress is committed locally as ${p.checkpointSha}.` : "No worktree changes.",
    "```",
    p.diffStat || "(no diff)",
    "```",
    "",
    "## Open questions",
    ...(p.openQuestions.length ? p.openQuestions.map((q) => `- ${q}`) : ["(none)"]),
    "",
    "## Transcript",
    p.transcript,
    "",
    `Your output: ${ROLES[p.source.role].contract}`,
  ].join("\n");
}
