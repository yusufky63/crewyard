import type { RunRow, TaskRow } from "./db.ts";
import type { RoleTemplate } from "./roles.ts";

// Agent-facing text. It is read by models, not shown as UI copy, so it stays English and is not
// translated. Task text written by the user is passed through as data inside clear delimiters. A
// contract from a role file is capped when the file is read (role-files.ts).

type Plan = Array<{ title: string; status: string }>;

export function rolePrompt(tpl: RoleTemplate, task: TaskRow, ctx: { plan: Plan | null; branch: string | null }): string {
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
  /** The role the source ran as. */
  role: RoleTemplate;
  trigger: string;
  plan: Plan | null;
  diffStat: string | null;
  checkpointSha: string | null;
  openQuestions: string[];
  transcript: string;
}

/**
 * The first message of a forked session (feature scan A11): the conversation above it is a copy of
 * the previous agent's, compacted where the runner can, so only what changed at the handoff is new.
 */
export function forkPrompt(p: { trigger: string; packagePath: string; checkpointSha: string | null }): string {
  return [
    `The conversation above was continued by another agent until now; you take over this task from here. Reason for the handoff: ${p.trigger}.`,
    p.checkpointSha ? `Its work in progress is committed locally as ${p.checkpointSha}.` : "It left no uncommitted changes.",
    `A written summary of the task state is at ${p.packagePath} if anything above is unclear.`,
    "Run `git status`, then continue where it stopped.",
  ].join("\n");
}

/** PLAN.md §8.2 step 5. Cross-provider handoff never claims to carry hidden model state. */
export function handoffPackage(p: HandoffPackageInput): string {
  const done = p.plan?.filter((s) => s.status === "completed").map((s) => `- ${s.title}`) ?? [];
  const todo = p.plan?.filter((s) => s.status !== "completed").map((s) => `- ${s.title}`) ?? [];
  return [
    `Role: ${p.role.title}`,
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
    `Your output: ${p.role.contract}`,
  ].join("\n");
}
