import type { RoleId, RolePolicy, TaskKind, TaskSize } from "@crewyard/core";

// Built-in role templates (PLAN.md §9.1). Permissions are enforced by the approval layer in
// requests.ts, never by the prompt: a read-only role's write request is denied before anyone sees it.

export interface RoleTemplate {
  id: RoleId;
  title: string;
  policy: RolePolicy;
  /** Gets the task's worktree as its own lease; only one writer at a time. */
  writesCode: boolean;
  /** Runner must support read-only enforcement through our approval layer. */
  needsReadOnly: boolean;
  /** Reasoning models score higher for this role. */
  prefersReasoning: boolean;
  /** Share of the task's expected tokens this role spends. Heuristic, used only for estimates. */
  tokenShare: number;
  /** Roles whose model this role must not share (the independence rule). */
  independentOf: RoleId[];
  /** Agent-facing output contract, put in the prompt. */
  contract: string;
}

const readOnly = (network: RolePolicy["network"] = "denied"): RolePolicy => ({ writes: "none", allowCommands: [], network });

export const ROLES: Record<RoleId, RoleTemplate> = {
  planner: {
    id: "planner",
    title: "Planner",
    policy: readOnly(),
    writesCode: false,
    needsReadOnly: true,
    prefersReasoning: true,
    tokenShare: 0.15,
    independentOf: [],
    contract: "A plan with numbered steps, acceptance criteria and risks. Do not change any file.",
  },
  implementer: {
    id: "implementer",
    title: "Implementer",
    policy: { writes: "worktree", allowCommands: [], network: "ask" },
    writesCode: true,
    needsReadOnly: false,
    prefersReasoning: false,
    tokenShare: 0.45,
    independentOf: [],
    contract: "Commits in this worktree and a short summary of what changed. Never push.",
  },
  reviewer: {
    id: "reviewer",
    title: "Reviewer",
    policy: readOnly(),
    writesCode: false,
    needsReadOnly: true,
    prefersReasoning: true,
    tokenShare: 0.2,
    independentOf: ["implementer"],
    contract: "A verdict, pass or changes, and comments with file and line. Do not change any file; you may run the tests.",
  },
  tester: {
    id: "tester",
    title: "Tester",
    policy: readOnly(),
    writesCode: false,
    needsReadOnly: true,
    prefersReasoning: false,
    tokenShare: 0.15,
    independentOf: [],
    contract: "Test results and benchmark numbers with the environment they ran in. Do not change any file.",
  },
  researcher: {
    id: "researcher",
    title: "Researcher",
    policy: readOnly("allowed"),
    writesCode: false,
    needsReadOnly: true,
    prefersReasoning: true,
    tokenShare: 0.8,
    independentOf: [],
    contract: "A report with sources. No code changes.",
  },
  docs: {
    id: "docs",
    title: "Docs",
    policy: { writes: "docs", allowCommands: [], network: "denied" },
    writesCode: true,
    needsReadOnly: false,
    prefersReasoning: false,
    tokenShare: 0.4,
    independentOf: [],
    contract: "Changed documentation only, committed in this worktree.",
  },
  security: {
    id: "security",
    title: "Security",
    policy: readOnly(),
    writesCode: false,
    needsReadOnly: true,
    prefersReasoning: true,
    tokenShare: 0.15,
    independentOf: ["implementer"],
    contract: "Findings with severity and evidence. Do not change any file.",
  },
};

export interface PlanStep {
  step: string;
  role: RoleId;
  dependsOn: string[];
  required: boolean;
}

const s = (role: RoleId, dependsOn: RoleId[] = []): PlanStep => ({ step: role, role, dependsOn, required: true });

/**
 * The DAG per task class (PLAN.md §9 step 2). Code M is Plan → Implement → Test ∥ Review; the
 * PR step belongs to the GitHub work and is not a run.
 */
export function planFor(kind: TaskKind, size: TaskSize, security: boolean): PlanStep[] {
  switch (kind) {
    case "code":
      if (size === "S") return [s("implementer"), s("reviewer", ["implementer"])];
      return [
        s("planner"),
        s("implementer", ["planner"]),
        s("tester", ["implementer"]),
        s("reviewer", ["implementer"]),
        ...(size === "L" || security ? [s("security", ["implementer"])] : []),
      ];
    case "research":
      return size === "L" ? [s("researcher"), s("reviewer", ["researcher"])] : [s("researcher")];
    case "review":
      return security || size === "L" ? [s("reviewer"), s("security")] : [s("reviewer")];
    case "docs":
      return size === "S" ? [s("docs")] : [s("docs"), s("reviewer", ["docs"])];
  }
}

/** Expected tokens for a whole task, before the role share. Heuristic, labelled Estimated. */
export const TOKENS_BY_SIZE: Record<TaskSize, { tokensIn: number; tokensOut: number; context: number }> = {
  S: { tokensIn: 80_000, tokensOut: 10_000, context: 32_000 },
  M: { tokensIn: 300_000, tokensOut: 40_000, context: 128_000 },
  L: { tokensIn: 1_000_000, tokensOut: 120_000, context: 200_000 },
};

const DOC_PATH = /(^|[\\/])(docs?|documentation)([\\/]|$)|\.(md|mdx|txt|rst)$|(^|[\\/])(README|CHANGELOG|LICENSE|NOTICE)[^\\/]*$/i;

/** True when every path is documentation, the only thing the Docs role may write. */
export const onlyDocPaths = (paths: string[]) => paths.length > 0 && paths.every((p) => DOC_PATH.test(p));
