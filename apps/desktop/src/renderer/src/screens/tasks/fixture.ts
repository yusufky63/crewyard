import { reviewFixture } from "./reviewFixture.ts";
import { NO_RUN_CONTROLS, type CandidateView, type CrewMemberView, type IpcMethod, type IpcParams, type IpcResult, type LimitNoticePayload, type RequestView, type RoleId, type RunView, type TaskDetail, type TaskSummary } from "@crewyard/core";

// Screenshot data. Used only when the page URL has `fixture`, which the main process sets only
// in screenshot mode (CREWYARD_SHOT_QUERY); a normal run never reads anything from this file.

export const FIXTURE = typeof location !== "undefined" && new URLSearchParams(location.search).has("fixture");

const T0 = Date.now();
const ago = (min: number) => new Date(T0 - min * 60_000).toISOString();
const ahead = (min: number) => new Date(T0 + min * 60_000).toISOString();

const cand = (profileId: string, alias: string, runner: CandidateView["runner"], providerId: string, model: string, usd: number | null, pct: number | null, reasons: CandidateView["reasons"]): CandidateView => ({
  profileId,
  alias,
  runner,
  providerId,
  model,
  score: 70,
  headroom: { pct, window: pct === null ? null : "5h", provenance: pct === null ? "unknown" : "reported" },
  estimate: { usd, provenance: usd === null ? "unknown" : "estimated" },
  reasons,
});

const OPUS = cand("p-opus", "anthropic-main", "claude-code", "anthropic", "claude-opus-5-5", 1.2, null, [{ code: "history.accepted", params: { accepted: 11, total: 12 } }, { code: "cost.estimate", params: { usd: 1.2 } }]);
const SOL = cand("p-sol", "work", "codex", "openai", "gpt-6.1-sol", 0, 14, [{ code: "history.accepted", params: { accepted: 7, total: 8 } }, { code: "headroom", params: { pct: 14, provenance: "reported", window: "5h" } }]);
const GLM = cand("p-glm", "zai-plan", "claude-code", "zai-coding-plan", "glm-5.3", 0, null, [{ code: "independence.provider" }, { code: "cost.plan" }]);
const FLASH = cand("p-flash", "ds-primary", "opencode", "deepseek", "deepseek-flash", 0.4, null, [{ code: "cost.estimate", params: { usd: 0.4 } }, { code: "fit.context", params: { context: 128000 } }]);
const ARGON = cand("p-argon", "google", "gemini-cli", "google", "gemini-4-argon", 0, null, [{ code: "fit.reasoning" }, { code: "headroom.unknown" }]);

let seq = 0;
const member = (role: RoleId, step: number, chosen: CandidateView, standby: CandidateView[], dependsOn: string[] = [], writesCode = false): CrewMemberView => ({
  id: `m${++seq}`,
  step: role,
  role,
  dependsOn,
  required: true,
  writesCode,
  chosen,
  standby,
  reasons: [],
  edited: false,
  blockedBy: step < 0 ? { code: "admission.project_slots", params: { used: 4, slots: 4 } } : null,
});

const run = (taskId: string, m: CrewMemberView, c: CandidateView, over: Partial<RunView>): RunView => ({
  id: `r-${m.id}`,
  taskId,
  memberId: m.id,
  role: m.role,
  profileId: c.profileId,
  runner: c.runner,
  model: c.model,
  state: "running",
  cwd: "C:\\Projeler\\.mc\\worktrees\\crewyard\\login-rate-limit",
  worktreeId: "w1",
  startedAt: ago(14),
  endedAt: null,
  endReason: null,
  endDetail: null,
  lastActivityAt: ago(0),
  pausedAt: null,
  resumeAt: null,
  limitReached: false,
  pendingRequestId: null,
  handoffId: null,
  resumedFrom: null,
  nativeSessionId: "s1",
  queuedMessages: 0,
  queue: [],
  controls: NO_RUN_CONTROLS,
  transcriptPath: null,
  tokensIn: 0,
  tokensOut: 0,
  cost: { usd: 0, provenance: "estimated" },
  plan: null,
  diff: null,
  ...over,
});

function build(projectId: string): { tasks: TaskDetail[]; requests: RequestView[] } {
  seq = 0;
  const summary = (id: string, title: string, over: Partial<TaskSummary>): TaskSummary => ({
    id,
    projectId,
    title,
    kind: "code",
    size: "M",
    status: "running",
    fallback: "ask",
    budgetUsd: 4,
    spend: { usd: 0, provenance: "estimated" },
    createdAt: ago(20),
    cancelledAt: null,
    openRequests: 0,
    activeRuns: 0,
    resumableRunIds: [],
    ...over,
  });
  const detail = (s: TaskSummary, members: CrewMemberView[], runs: RunView[], over: Partial<TaskDetail> = {}): TaskDetail => ({
    ...s,
    description: "",
    baseBranch: "main",
    waitResetMinutes: 20,
    classification: [{ code: "classify.keyword", params: { keyword: "add", kind: "code" } }],
    crew: { id: `c-${s.id}`, proposedAt: s.createdAt, approvedAt: s.status === "proposed" ? null : s.createdAt, estimate: { usd: 1.6, provenance: "estimated" }, members },
    runs,
    worktree: runs.length ? { id: "w1", path: `C:\\Projeler\\.mc\\worktrees\\crewyard\\${s.id}`, branch: `crewyard/${s.id}`, baseSha: "4f2c1aa", ownerRunId: runs[0]!.id, createdAt: s.createdAt } : null,
    handoffs: [],
    ...over,
  });

  // 1. Proposed: the crew waits for approval.
  const p = [member("planner", 1, OPUS, [GLM]), member("implementer", 2, SOL, [OPUS, FLASH], ["planner"], true), member("reviewer", 3, GLM, [ARGON], ["implementer"]), member("tester", 4, FLASH, [SOL], ["implementer"])];
  const proposed = detail(summary("t-proposed", "Optimize unit pathfinding for 2,000 units and keep the frame time under 16 ms", { status: "proposed", createdAt: ago(1) }), p, []);

  // 2. Running, with the implementer near its 5-hour window.
  const r = [member("planner", 1, OPUS, [GLM]), member("implementer", 2, SOL, [OPUS, FLASH], ["planner"], true), member("tester", -1, FLASH, [SOL], ["implementer"]), member("reviewer", 4, GLM, [ARGON], ["implementer"])];
  const runningRuns = [
    run("t-running", r[0]!, OPUS, { state: "ended", startedAt: ago(14), endedAt: ago(11), endReason: "completed", tokensIn: 41200, tokensOut: 3900, cost: { usd: 0.31, provenance: "estimated" }, plan: [{ title: "Add a token bucket per account", status: "completed" }, { title: "Return 429 with a retry hint", status: "pending" }, { title: "Tests for limiter and handler", status: "pending" }] }),
    run("t-running", r[1]!, SOL, {
      startedAt: ago(11),
      tokensIn: 62400,
      tokensOut: 8100,
      cost: { usd: 0, provenance: "estimated" },
      plan: [{ title: "Add a token bucket per account", status: "completed" }, { title: "Return 429 with a retry hint", status: "in_progress" }, { title: "Tests for limiter and handler", status: "pending" }],
      diff: [{ path: "src/auth/limiter.ts", added: 64, removed: 0 }, { path: "src/auth/login.ts", added: 18, removed: 6 }, { path: "src/auth/limiter.test.ts", added: 43, removed: 0 }],
    }),
  ];
  const running = detail(summary("t-running", "Add rate limiting to the login endpoint", { status: "running", activeRuns: 1, spend: { usd: 0.31, provenance: "estimated" } }), r, runningRuns);

  // 3. Needs approval.
  const a = [member("implementer", 1, FLASH, [SOL], [], true), member("reviewer", 2, GLM, [ARGON], ["implementer"])];
  const approvalRun = run("t-approval", a[0]!, FLASH, { state: "waiting_approval", startedAt: ago(6), pendingRequestId: "q-approval", tokensIn: 18300, tokensOut: 2100, cost: { usd: 0.012, provenance: "estimated" } });
  const approval = detail(summary("t-approval", "Fix the typo in the login error message", { size: "S", status: "needs_input", openRequests: 1, activeRuns: 1, spend: { usd: 0.012, provenance: "estimated" }, createdAt: ago(7) }), a, [approvalRun]);

  // 4. Paused at a spend cap.
  const c = [member("implementer", 1, OPUS, [FLASH, SOL], [], true), member("reviewer", 2, GLM, [ARGON], ["implementer"])];
  const cappedRun = run("t-capped", c[0]!, OPUS, { state: "rate_limited", startedAt: ago(48), limitReached: true, pausedAt: ago(3), pendingRequestId: "q-cap", tokensIn: 512000, tokensOut: 41000, cost: { usd: 2.03, provenance: "estimated" } });
  const capped = detail(summary("t-capped", "Move settings to the new config loader", { status: "needs_input", openRequests: 1, activeRuns: 1, spend: { usd: 2.03, provenance: "estimated" }, createdAt: ago(50) }), c, [cappedRun]);

  // 4b. A capped task on a model without a price waits for your approval before it starts.
  const u = [member("researcher", 1, ARGON, [OPUS])];
  const unpricedRun = run("t-unpriced", u[0]!, ARGON, { state: "rate_limited", startedAt: ago(4), limitReached: true, pausedAt: ago(4), pendingRequestId: "q-unpriced", nativeSessionId: null, cwd: "C:\\Projeler\\crewyard", worktreeId: null });
  const unpriced = detail(summary("t-unpriced", "Compare the retry policies of three HTTP clients", { kind: "research", size: "S", status: "needs_input", openRequests: 1, activeRuns: 1, budgetUsd: 1, createdAt: ago(5) }), u, [unpricedRun], { worktree: null });

  // 5. Ready for review.
  const v = [member("implementer", 1, SOL, [OPUS], [], true), member("reviewer", 2, OPUS, [GLM], ["implementer"])];
  const reviewRuns = [
    run("t-review", v[0]!, SOL, { state: "ended", startedAt: ago(96), endedAt: ago(64), endReason: "completed", diff: [{ path: "src/session/store.ts", added: 88, removed: 14 }, { path: "src/session/store.test.ts", added: 37, removed: 4 }] }),
    run("t-review", v[1]!, OPUS, { state: "ended", startedAt: ago(64), endedAt: ago(58), endReason: "completed", cost: { usd: 0.42, provenance: "estimated" } }),
  ];
  const review = detail(summary("t-review", "Refactor the session store", { status: "review", spend: { usd: 0.42, provenance: "estimated" }, createdAt: ago(100) }), v, reviewRuns);

  // 6. Done, no code.
  const d = [member("researcher", 1, ARGON, [OPUS])];
  const doneRuns = [run("t-done", d[0]!, ARGON, { state: "ended", startedAt: ago(26 * 60), endedAt: ago(25 * 60), endReason: "completed", cwd: "C:\\Projeler\\crewyard", worktreeId: null })];
  const done = detail(summary("t-done", "Research how other tools store API keys on Windows", { kind: "research", size: "S", status: "done", createdAt: ago(26 * 60) }), d, doneRuns, { worktree: null });

  const requests: RequestView[] = [
    {
      id: "q-approval",
      taskId: "t-approval",
      projectId,
      runId: approvalRun.id,
      sessionId: approvalRun.nativeSessionId,
      kind: "approval",
      risk: "medium",
      payload: { kind: "approval", toolCallId: "tc1", command: "pnpm vitest run src/auth", cwd: "C:\\Projeler\\.mc\\worktrees\\crewyard\\t-approval", paths: [], network: false, policy: null },
      createdAt: ago(2),
      answeredAt: null,
      answer: null,
      answeredBy: null,
    },
    {
      id: "q-cap",
      taskId: "t-capped",
      projectId,
      runId: cappedRun.id,
      sessionId: cappedRun.nativeSessionId,
      kind: "handoff",
      risk: null,
      payload: { kind: "handoff", trigger: "budget", window: "budget-day", resetsAt: ahead(9 * 60), proposedTarget: null, candidates: [FLASH, SOL], detail: null, cap: { kind: "daily_cap", spentUsd: 2.03, capUsd: 2, credentialId: "cred-anthropic" } },
      createdAt: ago(3),
      answeredAt: null,
      answer: null,
      answeredBy: null,
    },
    {
      id: "q-unpriced",
      taskId: "t-unpriced",
      projectId,
      runId: unpricedRun.id,
      sessionId: null,
      kind: "handoff",
      risk: null,
      payload: { kind: "handoff", trigger: "unpriced", window: null, resetsAt: null, proposedTarget: null, candidates: [OPUS], detail: null, cap: null, unpriced: { model: ARGON.model, caps: ["daily_cap", "task_budget"] } },
      createdAt: ago(4),
      answeredAt: null,
      answer: null,
      answeredBy: null,
    },
  ];
  return { tasks: [proposed, running, approval, capped, unpriced, review, done], requests };
}

let cache: { projectId: string; data: ReturnType<typeof build> } | null = null;
const data = (projectId: string) => {
  if (!cache || cache.projectId !== projectId) cache = { projectId, data: build(projectId) };
  return cache.data;
};
const anyProject = () => cache?.projectId ?? "fixture";

/** Reads answered from the fixture; writes change nothing and return what is there. */
export function fixtureCall<M extends IpcMethod>(method: M, params: IpcParams<M>): IpcResult<M> {
  const p = (params ?? {}) as { projectId?: string; taskId?: string };
  const d = data(p.projectId ?? anyProject());
  const strip = ({ description: _d, baseBranch: _b, waitResetMinutes: _w, classification: _c, crew: _cr, runs: _r, worktree: _wt, handoffs: _h, ...s }: TaskDetail): TaskSummary => s;
  const task = (id: string | undefined) => d.tasks.find((t) => t.id === id) ?? d.tasks[0]!;
  switch (method) {
    case "tasks.list":
      return d.tasks.map(strip) as IpcResult<M>;
    case "tasks.get":
      return task(p.taskId) as IpcResult<M>;
    case "requests.list":
      return d.requests.filter((q) => !p.taskId || q.taskId === p.taskId) as IpcResult<M>;
    case "github.repo":
    case "github.issues":
    case "github.issue":
    case "github.linkIssue":
    case "github.taskIssue":
    case "github.taskDiff":
    case "github.reviewDrafts":
    case "github.addReviewComment":
    case "github.removeReviewComment":
    case "github.sendReview":
      return reviewFixture(method, params, task) as IpcResult<M>;
    default:
      return task(p.taskId) as IpcResult<M>;
  }
}

/** The live notice the running task's implementer would have produced. */
export function fixtureNotices(): LimitNoticePayload[] {
  return [{ kind: "warn", profileId: "p-sol", window: "5h", usedPct: 86, resetsAt: ahead(95), provenance: "reported", minutesUntilFull: null, runId: "r-m6", taskId: "t-running", observedAt: ago(1) }];
}
