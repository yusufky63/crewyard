import { NO_RUN_CONTROLS, type CandidateView, type CrewMemberView, type RunView, type TaskDetail } from "@crewyard/core";

// Screenshot and test fixture only. CrewScreen loads it solely when the `fixture` query param is
// present, which the main process passes only in screenshot mode (CREWYARD_SHOT_QUERY). A normal
// run never shows this data.

const at = (min: number) => new Date(Date.UTC(2026, 9, 30, 9, 0) + min * 60_000).toISOString();

function candidate(profileId: string, alias: string, runner: CandidateView["runner"], providerId: string, model: string, usd: number | null): CandidateView {
  return {
    profileId,
    alias,
    runner,
    providerId,
    model,
    score: 0.8,
    headroom: { pct: 60, window: "5h", provenance: "estimated" },
    estimate: { usd, provenance: usd === null ? "unknown" : "estimated" },
    reasons: [],
  };
}

const opus = candidate("p-anthropic", "anthropic-api", "claude-code", "anthropic", "claude-opus-5-5", 0.42);
const sonnet = candidate("p-anthropic-2", "anthropic-api", "claude-code", "anthropic", "claude-sonnet-5-5", 0.18);
const codex = candidate("p-codex", "codex-work", "codex", "openai", "gpt-6.1-codex", null);
const glm = candidate("p-zai", "zai-plan", "claude-code", "zai", "glm-5.3", 0);
const deepseek = candidate("p-deepseek", "deepseek-key", "opencode", "deepseek", "deepseek-v4-flash", 0.01);
const gemini = candidate("p-gemini", "gemini-key", "gemini-cli", "google", "gemini-3.1-pro", 0.12);

function member(id: string, role: CrewMemberView["role"], dependsOn: string[], chosen: CandidateView, standby: CandidateView[]): CrewMemberView {
  return { id, step: role, role, dependsOn, required: true, writesCode: role === "implementer", chosen, standby, reasons: [], edited: false, blockedBy: null };
}

function run(id: string, memberId: string, role: RunView["role"], c: CandidateView, patch: Partial<RunView>): RunView {
  return {
    id,
    taskId: "fixture-task",
    memberId,
    role,
    profileId: c.profileId,
    runner: c.runner,
    model: c.model,
    state: "running",
    cwd: "C:\\Projeler\\terrain lab\\.crewyard\\worktrees\\terrain-seams",
    worktreeId: "w1",
    startedAt: at(0),
    endedAt: null,
    endReason: null,
    endDetail: null,
    lastActivityAt: at(14),
    pausedAt: null,
    resumeAt: null,
    limitReached: false,
    pendingRequestId: null,
    handoffId: null,
    resumedFrom: null,
    nativeSessionId: null,
    queuedMessages: 0,
    queue: [],
    controls: NO_RUN_CONTROLS,
    transcriptPath: null,
    tokensIn: 0,
    tokensOut: 0,
    cost: { usd: null, provenance: "unknown" },
    plan: null,
    diff: null,
    ...patch,
  };
}

export function crewFixture(): TaskDetail {
  const members = [
    member("m-plan", "planner", [], opus, [gemini]),
    member("m-impl", "implementer", ["planner"], codex, [sonnet, deepseek]),
    member("m-test", "tester", ["planner"], deepseek, []),
    member("m-review", "reviewer", ["implementer", "tester"], glm, [gemini]),
  ];
  return {
    id: "fixture-task",
    projectId: "fixture-project",
    title: "Fix terrain seam artifacts",
    kind: "code",
    size: "M",
    status: "limited",
    fallback: "ask",
    budgetUsd: 5,
    spend: { usd: 0.36, provenance: "estimated" },
    createdAt: at(-2),
    cancelledAt: null,
    openRequests: 0,
    activeRuns: 2,
    resumableRunIds: [],
    description: "",
    baseBranch: "main",
    waitResetMinutes: 30,
    classification: [],
    crew: { id: "c1", proposedAt: at(-2), approvedAt: at(-1), estimate: { usd: 0.73, provenance: "estimated" }, members },
    runs: [
      run("r-plan", "m-plan", "planner", opus, { state: "ended", endedAt: at(4), endReason: "completed", tokensIn: 16_200, tokensOut: 2_900, cost: { usd: 0.31, provenance: "estimated" } }),
      run("r-impl", "m-impl", "implementer", codex, { startedAt: at(4), tokensIn: 54_000, tokensOut: 8_100, cost: { usd: null, provenance: "unknown" } }),
      run("r-test", "m-test", "tester", deepseek, {
        startedAt: at(5),
        state: "rate_limited",
        limitReached: true,
        resumeAt: at(100),
        tokensIn: 7_400,
        tokensOut: 600,
        cost: { usd: 0.01, provenance: "reported" },
      }),
    ],
    worktree: { id: "w1", path: "C:\\Projeler\\terrain lab\\.crewyard\\worktrees\\terrain-seams", branch: "agent/terrain-seams", baseSha: "4f1c2aa", ownerRunId: "r-impl", createdAt: at(4) },
    handoffs: [],
  };
}
