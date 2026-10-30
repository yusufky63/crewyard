import { isBuiltinRole, type BuiltinRoleId, type CustomRoleStep, type ProjectConfig, type RoleId, type RolePolicy, type RunnerId, type TaskKind, type TaskSize } from "@crewyard/core";

// Built-in role templates (PLAN.md §9.1). Permissions are never enforced by the prompt: each
// runner's own engine refuses a read-only role's writes (sandbox, permission mode or ruleset), and
// the approval layer denies any write request that still gets through before anyone sees it.
// Planner and reviewer end with a schema-checked JSON result (results.ts). Role files can override
// a built-in's contract or add roles of their own (role-files.ts).

export interface RoleTemplate {
  id: RoleId;
  title: string;
  policy: RolePolicy;
  /** Gets the task's worktree as its own lease; only one writer at a time. */
  writesCode: boolean;
  /** Runner must support read-only enforcement (its own engine plus our approval layer). */
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

export const ROLES: Record<BuiltinRoleId, RoleTemplate> = {
  planner: {
    id: "planner",
    title: "Planner",
    policy: readOnly(),
    writesCode: false,
    needsReadOnly: true,
    prefersReasoning: true,
    tokenShare: 0.15,
    independentOf: [],
    contract: "A plan with numbered steps, acceptance criteria and risks, given as the JSON result your final answer must be. Do not change any file.",
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
    contract: "A verdict, pass or changes, with a summary and comments with file, line and severity, given as the JSON result your final answer must be. Do not change any file; you may run the project's test command where your tools allow it.",
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

/**
 * What a role id with no template resolves to (a custom role whose snapshot is gone): read-only on
 * a runner that enforces it, so a lost definition can only take permissions away.
 */
export const readOnlyStub = (id: RoleId): RoleTemplate => ({
  id,
  title: id,
  policy: readOnly(),
  writesCode: false,
  needsReadOnly: true,
  prefersReasoning: false,
  tokenShare: 0.15,
  independentOf: [],
  contract: "A short report of what you found. Do not change any file.",
});

/** A role by id (built-ins only; anything else fails closed) or a template already resolved for a project. */
export type RoleRef = RoleId | RoleTemplate;

export const templateOf = (role: RoleRef): RoleTemplate => (typeof role === "string" ? ((ROLES as Partial<Record<RoleId, RoleTemplate>>)[role] ?? readOnlyStub(role)) : role);

const NETWORK_RANK: Record<RolePolicy["network"], number> = { denied: 0, ask: 1, allowed: 2 };
const RUNS_PROJECT_COMMANDS: RoleId[] = ["implementer", "tester", "reviewer"];

/**
 * The policy a run gets: the role's own, narrowed by the project's rules. A built-in (or a file
 * that overrides one, which can only narrow it) gets the project's allowlist, plus the build and
 * test commands for the roles that run them. A custom role gets only the commands it lists that the
 * project also allows, and the lower of its network and the project's: a role file never grants
 * itself what .crewyard/project.json does not.
 */
export function effectivePolicy(tpl: RoleTemplate, config: Pick<ProjectConfig, "commands" | "rules">): RolePolicy {
  const commands = [config.commands.build, config.commands.test].filter((c): c is string => Boolean(c));
  if (isBuiltinRole(tpl.id)) {
    return {
      writes: tpl.policy.writes,
      allowCommands: [...config.rules.allowCommands, ...(RUNS_PROJECT_COMMANDS.includes(tpl.id) ? commands : [])],
      network: tpl.policy.network === "ask" && config.rules.network === "allowed" ? "allowed" : tpl.policy.network,
    };
  }
  const permitted = new Set([...config.rules.allowCommands, ...commands]);
  return {
    writes: tpl.policy.writes,
    allowCommands: tpl.policy.allowCommands.filter((c) => permitted.has(c)),
    network: NETWORK_RANK[tpl.policy.network] <= NETWORK_RANK[config.rules.network] ? tpl.policy.network : config.rules.network,
  };
}

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

/**
 * The custom steps a template gets, in list order, after the built-in ones. A step joins only when
 * it matches the task's kind and size and every step it waits for is already in the plan.
 */
export function customPlanSteps(plan: PlanStep[], steps: CustomRoleStep[], kind: TaskKind, size: TaskSize): PlanStep[] {
  const have = new Set(plan.map((s) => s.step));
  const added: PlanStep[] = [];
  for (const s of steps) {
    if (!s.kinds.includes(kind) || (s.sizes && !s.sizes.includes(size)) || have.has(s.role)) continue;
    if (!s.after.every((dep) => have.has(dep))) continue;
    added.push({ step: s.role, role: s.role, dependsOn: [...s.after], required: true });
    have.add(s.role);
  }
  return added;
}

/** Expected tokens for a whole task, before the role share. Heuristic, labelled Estimated. */
export const TOKENS_BY_SIZE: Record<TaskSize, { tokensIn: number; tokensOut: number; context: number; turns: number }> = {
  S: { tokensIn: 80_000, tokensOut: 10_000, context: 32_000, turns: 8 },
  M: { tokensIn: 300_000, tokensOut: 40_000, context: 128_000, turns: 25 },
  L: { tokensIn: 1_000_000, tokensOut: 120_000, context: 200_000, turns: 60 },
};

/**
 * Input tokens a runner sends on every turn before any task text (its own system prompt).
 * Codex: about 14.8k per turn, measured by the Codex adapter work on 2026-10-30.
 */
export const TURN_OVERHEAD_TOKENS: Partial<Record<RunnerId, number>> = { codex: 14_800 };

const DOC_PATH = /(^|[\\/])(docs?|documentation)([\\/]|$)|\.(md|mdx|txt|rst)$|(^|[\\/])(README|CHANGELOG|LICENSE|NOTICE)[^\\/]*$/i;

/** True when every path is documentation, the only thing the Docs role may write. */
export const onlyDocPaths = (paths: string[]) => paths.length > 0 && paths.every((p) => DOC_PATH.test(p));
