import type { AccountRow, CredentialSummary, ProfileSummary, TaskStatus, TaskSummary, ToolCheck, ToolId } from "@crewyard/core";

// The Getting started checklist (PLAN.md §11.1). Every rule reads state the daemon already has;
// `null` means "not known yet" (still loading or the read failed), never "not done".

export type ChecklistItemId = "agents" | "plan" | "github" | "claudeKey" | "firstTask";

export interface ChecklistItem {
  id: ChecklistItemId;
  done: boolean | null;
}

export interface ChecklistInput {
  /** One entry per agent CLI checked so far; undefined while its check runs. */
  agents: Partial<Record<ToolId, Pick<ToolCheck, "found"> | undefined>>;
  accounts: AccountRow[] | undefined;
  profiles: ProfileSummary[] | undefined;
  credentials: CredentialSummary[] | undefined;
  githubSignedIn: boolean | undefined;
  tasks: TaskSummary[] | undefined;
}

export const AGENT_TOOLS: ToolId[] = ["claude", "codex", "opencode", "gemini"];

/** A task in one of these states has been approved and started at least once. */
const STARTED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["queued", "running", "needs_input", "limited", "handing_off", "failed", "review", "merged", "done"]);
/** The checklist's job ends once a task finishes. */
const FINISHED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["review", "merged", "done"]);

function agentsFound(agents: ChecklistInput["agents"]): boolean | null {
  const checks = AGENT_TOOLS.map((id) => agents[id]);
  if (checks.some((c) => c?.found)) return true;
  return checks.every((c) => c !== undefined) ? false : null;
}

/** Claude Code runs on API keys only (PLAN.md §6), so the key must be stored, not just named. */
function claudeKey(profiles: ProfileSummary[] | undefined, credentials: CredentialSummary[] | undefined): boolean | null {
  if (!profiles || !credentials) return null;
  const stored = new Set(credentials.filter((c) => c.kind === "api_key" && c.isSet).map((c) => c.id));
  return profiles.some((p) => p.runner === "claude-code" && p.credentialId !== null && stored.has(p.credentialId));
}

export function checklist(input: ChecklistInput): ChecklistItem[] {
  return [
    { id: "agents", done: agentsFound(input.agents) },
    { id: "plan", done: input.accounts ? input.accounts.some((a) => a.kind === "plan") : null },
    { id: "github", done: input.githubSignedIn ?? null },
    { id: "claudeKey", done: claudeKey(input.profiles, input.credentials) },
    { id: "firstTask", done: input.tasks ? input.tasks.some((t) => STARTED.has(t.status)) : null },
  ];
}

/** Shown until the first task finishes; while tasks are loading it stays, so it never flickers away. */
export const showChecklist = (tasks: TaskSummary[] | undefined): boolean => !tasks?.some((t) => FINISHED.has(t.status));
