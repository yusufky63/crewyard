import type { TaskKind, TaskSize } from "./ipc/tasks.ts";

// Ready-made analysis tasks (docs/adr/0014): local templates, no model call. Each is a research
// task whose researcher must end with schema-checked findings (results.ts ResearchFindings), so
// "review the project" lands as findings with severity, file and line and a suggested task per
// finding, never as a code-review verdict. The description is the agent-facing contract, in
// English like every prompt; the UI shows a translated title.

export type TaskPresetId = "review" | "optimize" | "bugs" | "security" | "deps" | "tests";

export interface TaskPreset {
  id: TaskPresetId;
  /** The task title as stored, in English; the panel shows its own translation. */
  title: string;
  kind: TaskKind;
  size: TaskSize;
  /** The goal and the output contract the researcher reads. */
  description: string;
}

const CONTRACT = [
  "Read the project; do not change any file.",
  "End with findings: for each one a short title, a severity (critical, high, medium, low or info), the file and line it is about (null for the whole project), what you saw, and the task you suggest to deal with it (null when nothing needs doing).",
  "Start the summary with the two or three things that matter most. Cite files you read; do not guess at code you did not open.",
].join("\n");

const preset = (id: TaskPresetId, title: string, goal: string): TaskPreset => ({ id, title, kind: "research", size: "M", description: `${goal}\n\n${CONTRACT}` });

export const TASK_PRESETS: readonly TaskPreset[] = [
  preset("review", "Review the project and comment", "Review this project as a new senior maintainer would: structure, clarity, the riskiest parts, and what you would change first."),
  preset("optimize", "Suggest optimizations", "Find where this project wastes time, memory, bundle size or money (paid API calls, CI minutes), and how much each change would save."),
  preset("bugs", "Find bugs and problems", "Find bugs and likely failures: wrong logic, unhandled errors, race conditions, edge cases, and code paths no test reaches."),
  preset("security", "Find security issues", "Find security issues: secrets in code or logs, injection, unsafe process spawning, path traversal, missing input checks, risky dependencies and permissions."),
  preset("deps", "Audit dependencies and licences", "Audit the dependencies: outdated or unmaintained packages, versions that are not pinned, known vulnerabilities you can see from the versions, and licences that do not fit the project's own."),
  preset("tests", "Find test coverage gaps", "Find what the tests do not cover: important modules without tests, branches and failure paths never exercised, and the tests you would add first."),
];

export const presetById = (id: string): TaskPreset | undefined => TASK_PRESETS.find((p) => p.id === id);

/** What Crewyard knows about a project locally; nothing here costs a model call or a network request. */
export interface ProjectFacts {
  /** From the setup detector (`node`, `godot`, `rust`, ...); null when it found nothing. */
  projectType: string | null;
  testCommand: string | null;
  /** A dependency manifest or lockfile exists (package.json, Cargo.toml, a *.csproj, ...). */
  hasDependencies: boolean;
  /** Commits on the current branch in the last 14 days; null when git could not tell. */
  recentCommits: number | null;
  hasRemote: boolean;
}

export type SuggestionReason = "no_test_command" | "dependencies" | "recent_activity" | "remote" | "general";

export interface PresetSuggestion {
  id: TaskPresetId;
  reason: SuggestionReason;
  /** For `recent_activity`: the commit count. */
  count?: number;
}

/** A few presets that fit this project, most useful first, from local facts only. */
export function suggestPresets(f: ProjectFacts, max = 3): PresetSuggestion[] {
  const out: PresetSuggestion[] = [];
  const add = (s: PresetSuggestion) => {
    if (!out.some((o) => o.id === s.id)) out.push(s);
  };
  if (!f.testCommand) add({ id: "tests", reason: "no_test_command" });
  if (f.recentCommits !== null && f.recentCommits >= 10) add({ id: "review", reason: "recent_activity", count: f.recentCommits });
  if (f.hasDependencies) add({ id: "deps", reason: "dependencies" });
  if (f.hasRemote) add({ id: "security", reason: "remote" });
  for (const id of ["review", "bugs", "security"] as const) add({ id, reason: "general" });
  return out.slice(0, max);
}
