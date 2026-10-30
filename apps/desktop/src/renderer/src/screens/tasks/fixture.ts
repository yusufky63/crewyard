import { reviewFixture } from "./reviewFixture.ts";
import { NO_RUN_CONTROLS, type BestOfVariantView, type CandidateView, type ScheduleRunView, type ScheduleView, type CrewMemberView, type IpcMethod, type IpcParams, type IpcResult, type LimitNoticePayload, type LoopDecisionView, type RequestView, type RoleId, type RunView, type StallAlertView, type TaskDetail, type TaskSummary, type UndoPreview } from "@crewyard/core";

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
const decision = (m: CrewMemberView, runId: string, kind: LoopDecisionView["kind"], iteration: number, reason: LoopDecisionView["reason"], at: string): LoopDecisionView => ({
  id: `d-${runId}-${kind}-${iteration}`,
  memberId: m.id,
  runId,
  iteration,
  maxIterations: 3,
  kind,
  reason,
  at,
});
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
    loop: { maxIterations: 3, decisions: [], tests: [], verdicts: [] },
    ...over,
  });

  // 1. Proposed: the crew waits for approval.
  // The reviewer was pinned to the implementer's account, so the proposal says why it picked another.
  const p = [
    member("planner", 1, OPUS, [GLM]),
    member("implementer", 2, SOL, [OPUS, FLASH], ["planner"], true),
    { ...member("reviewer", 3, GLM, [ARGON], ["implementer"]), reasons: [{ code: "pin.dropped" as const, params: { alias: SOL.alias, cause: "independence" } }] },
    member("tester", 4, FLASH, [SOL], ["implementer"]),
  ];
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
      queuedMessages: 2,
      queue: [
        { id: "qm-1", text: "Return the retry hint in seconds, not milliseconds.", createdAt: ago(3), editedAt: null, kind: "user" },
        { id: "qm-2", text: "Keep the old error text as a fallback for clients that parse it.", createdAt: ago(1), editedAt: ago(0), kind: "user" },
      ],
      controls: { steer: { ok: true, reason: null }, undo: { ok: false, reason: "undo.turn_running", turnId: null } },
    }),
  ];
  // The tests failed twice at the implementer's turn boundary; each failure went back to the same session.
  const failed = { code: "loop.tests_failed" as const, params: { command: "pnpm vitest run src/auth", exitCode: 1 } };
  const runningLoop = {
    maxIterations: 3,
    decisions: [decision(r[1]!, runningRuns[1]!.id, "tests_failed", 1, failed, ago(7)), decision(r[1]!, runningRuns[1]!.id, "tests_failed", 2, failed, ago(3))],
    tests: [],
    verdicts: [],
  };
  const running = detail(summary("t-running", "Add rate limiting to the login endpoint", { status: "running", activeRuns: 1, spend: { usd: 0.31, provenance: "estimated" } }), r, runningRuns, { loop: runningLoop });

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
    run("t-review", v[0]!, SOL, {
      state: "ended",
      startedAt: ago(96),
      endedAt: ago(64),
      endReason: "completed",
      diff: [{ path: "src/session/store.ts", added: 88, removed: 14 }, { path: "src/session/store.test.ts", added: 37, removed: 4 }],
      controls: { steer: { ok: false, reason: "steer.no_turn" }, undo: { ok: true, reason: null, turnId: "turn-fx" } },
      transcriptPath: "C:\\Users\\you\\AppData\\Roaming\\Crewyard\\tasks\\t-review\\transcripts\\codex-thr-1.jsonl",
    }),
    run("t-review", v[1]!, OPUS, { state: "ended", startedAt: ago(64), endedAt: ago(58), endReason: "completed", cost: { usd: 0.42, provenance: "estimated" } }),
  ];
  const reviewLoop = {
    maxIterations: 3,
    decisions: [
      decision(v[0]!, reviewRuns[0]!.id, "tests_passed", 0, { code: "loop.tests_passed", params: { command: "pnpm test" } }, ago(64)),
      decision(v[0]!, reviewRuns[1]!.id, "review_passed", 0, { code: "loop.review_passed", params: { sha: "7d1e09a4c2b8" } }, ago(58)),
    ],
    tests: [],
    verdicts: [{ runId: reviewRuns[1]!.id, memberId: v[1]!.id, verdict: "pass" as const, summary: "The store keeps its API and the new tests cover expiry.", comments: [], headSha: "7d1e09a4c2b8f31d", native: false, stale: false, at: ago(58) }],
  };
  const review = detail(summary("t-review", "Refactor the session store", { status: "review", spend: { usd: 0.42, provenance: "estimated" }, createdAt: ago(100) }), v, reviewRuns, { loop: reviewLoop });

  // 6. Done, no code.
  const d = [member("researcher", 1, ARGON, [OPUS])];
  const doneRuns = [run("t-done", d[0]!, ARGON, { state: "ended", startedAt: ago(26 * 60), endedAt: ago(25 * 60), endReason: "completed", cwd: "C:\\Projeler\\crewyard", worktreeId: null })];
  const done = detail(summary("t-done", "Research how other tools store API keys on Windows", { kind: "research", size: "S", status: "done", createdAt: ago(26 * 60) }), d, doneRuns, { worktree: null });

  // 7. Failed with a provider's raw error: one long JSON line the row must cut and the inspector show whole.
  const g = [member("researcher", 1, ARGON, [FLASH])];
  const creditRun = run("t-credit", g[0]!, ARGON, {
    state: "ended",
    startedAt: ago(9),
    endedAt: ago(8),
    endReason: "failed",
    endDetail:
      'API Error: 402 {"error":{"code":402,"message":"Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.","status":"FAILED_PRECONDITION","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"BILLING_NOT_ACTIVE","domain":"generativelanguage.googleapis.com"}]}}',
    cwd: "C:\\Projeler\\crewyard",
    worktreeId: null,
  });
  const credit = detail(summary("t-credit", "Summarize how the three runners report token usage", { kind: "research", size: "S", status: "failed", resumableRunIds: [creditRun.id], createdAt: ago(10) }), g, [creditRun], { worktree: null });

  // 8. A runner that never started: the daemon keeps why, redacted.
  const s = [member("implementer", 1, FLASH, [SOL], [], true), member("reviewer", 2, GLM, [ARGON], ["implementer"])];
  const startRun = run("t-nostart", s[0]!, FLASH, {
    state: "ended",
    startedAt: ago(3),
    endedAt: ago(3),
    endReason: "failed",
    endDetail: "adapter.failed: OpenCode needs the model as provider/model, got deepseek-flash",
    nativeSessionId: null,
  });
  const noStart = detail(summary("t-nostart", "Add a retry hint to the 429 response", { size: "S", status: "failed", resumableRunIds: [startRun.id], createdAt: ago(4) }), s, [startRun]);

  // 10. Best of N, choosing: three implementers ran in their own worktrees; two finished.
  const bo = [member("implementer", 1, SOL, [OPUS, FLASH], [], true), member("reviewer", 2, GLM, [ARGON], ["implementer"])];
  const wt = (position: number) => `C:\\Projeler\\.mc\\worktrees\\crewyard\\cache-layer-v${position}`;
  const variant = (position: number, c: CandidateView, over: Partial<BestOfVariantView>): BestOfVariantView => ({
    id: `v${position}`,
    position,
    candidate: c,
    taskId: `t-bestof-v${position}`,
    status: "review",
    run: run(`t-bestof-v${position}`, { ...bo[0]!, id: `m-bo-v${position}` }, c, { state: "ended", startedAt: ago(40), endedAt: ago(12 + position), endReason: "completed", cwd: wt(position) }),
    resumableRunIds: [],
    spend: { usd: c.estimate.usd ?? 0, provenance: "estimated" },
    diffStat: null,
    test: null,
    decisions: [],
    branch: `crewyard/cache-layer-v${position}`,
    worktreePath: wt(position),
    outcome: null,
    parkedAt: null,
    parkError: null,
    ...over,
  });
  const test = (runId: string, passed: boolean, durationMs: number) => ({ id: `t-${runId}`, runId, command: "pnpm vitest run", exitCode: passed ? 0 : 1, passed, tail: passed ? "" : "FAIL src/cache.test.ts > evicts the oldest entry\nexpected 3 entries, got 4", durationMs, headSha: null, at: ago(13) });
  const variants: BestOfVariantView[] = [
    variant(1, SOL, {
      diffStat: { files: [{ path: "src/cache/lru.ts", added: 84, removed: 0 }, { path: "src/cache/index.ts", added: 12, removed: 3 }, { path: "src/cache.test.ts", added: 41, removed: 0 }], added: 137, removed: 3 },
      test: test("r-v1", true, 18_400),
      decisions: [decision(bo[0]!, "r-v1", "tests_passed", 0, { code: "loop.tests_passed", params: { command: "pnpm vitest run" } }, ago(13))],
    }),
    variant(2, OPUS, {
      diffStat: { files: [{ path: "src/cache/store.ts", added: 120, removed: 18 }, { path: "src/cache.test.ts", added: 52, removed: 0 }, { path: "docs/cache.md", added: 20, removed: 0 }], added: 192, removed: 18 },
      spend: { usd: 0.94, provenance: "estimated" },
      test: test("r-v2", true, 21_100),
      decisions: [
        decision(bo[0]!, "r-v2", "tests_failed", 1, { code: "loop.tests_failed", params: { command: "pnpm vitest run", exitCode: 1 } }, ago(20)),
        decision(bo[0]!, "r-v2", "tests_passed", 1, { code: "loop.tests_passed", params: { command: "pnpm vitest run" } }, ago(14)),
      ],
    }),
    variant(3, FLASH, {
      status: "failed",
      run: run("t-bestof-v3", { ...bo[0]!, id: "m-bo-v3" }, FLASH, { state: "ended", startedAt: ago(40), endedAt: ago(16), endReason: "failed", endDetail: "loop.iteration_cap", cwd: wt(3) }),
      resumableRunIds: ["r-m-bo-v3"],
      spend: { usd: 0.31, provenance: "estimated" },
      diffStat: { files: [{ path: "src/cache/lru.ts", added: 66, removed: 0 }], added: 66, removed: 0 },
      test: test("r-v3", false, 9_800),
      decisions: [decision(bo[0]!, "r-v3", "stop_iteration_cap", 3, { code: "loop.iteration_cap", params: { max: 3 } }, ago(16))],
    }),
  ];
  const bestOf = detail(summary("t-bestof", "Add an LRU cache in front of the pricing lookups", { status: "needs_input", size: "S", bestOf: { n: 3, phase: "choosing" }, spend: { usd: 1.25, provenance: "estimated" }, createdAt: ago(42) }), bo, [], {
    bestOfGroup: { id: "g1", memberId: bo[0]!.id, n: 3, phase: "choosing", estimate: { usd: 2.1, provenance: "estimated" }, variants, startedAt: ago(40), keptVariantId: null, keptAt: null },
  });

  // 11. Hibernated: the process stopped while the run waits on a question; it wakes with the answer.
  const h = [member("researcher", 1, ARGON, [OPUS])];
  const asleepRun = run("t-asleep", h[0]!, ARGON, { state: "waiting_input", startedAt: ago(95), lastActivityAt: ago(80), pendingRequestId: "q-asleep", hibernatedAt: ago(50), worktreeId: null, cwd: "C:\\Projeler\\crewyard" });
  const asleep = detail(summary("t-asleep", "Compare Redis and an in-process cache for the pricing service", { kind: "research", size: "S", status: "needs_input", openRequests: 1, activeRuns: 1, scheduled: { scheduleId: "s1", title: "Weekly cache review", autoApproved: false }, createdAt: ago(96) }), h, [asleepRun], { worktree: null });

  const requests: RequestView[] = [
    {
      id: "q-asleep",
      taskId: "t-asleep",
      projectId,
      runId: asleepRun.id,
      sessionId: asleepRun.nativeSessionId,
      kind: "question",
      risk: null,
      payload: { kind: "question", questions: [{ prompt: "Should the comparison include memory use under load?", options: [{ label: "Yes" }, { label: "No" }], allowFreeText: true }] },
      createdAt: ago(80),
      answeredAt: null,
      answer: null,
      answeredBy: null,
    },
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
  // The failed rows first, so a 1280 px shot of the list shows how their errors fit.
  return { tasks: [bestOf, asleep, noStart, credit, proposed, running, approval, capped, unpriced, review, done], requests };
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
  const strip = ({ description: _d, baseBranch: _b, waitResetMinutes: _w, classification: _c, crew: _cr, runs: _r, worktree: _wt, handoffs: _h, loop: _l, ...s }: TaskDetail): TaskSummary => s;
  const task = (id: string | undefined) => d.tasks.find((t) => t.id === id) ?? d.tasks[0]!;
  switch (method) {
    case "tasks.list":
      return d.tasks.map(strip) as IpcResult<M>;
    case "tasks.get":
      return task(p.taskId) as IpcResult<M>;
    case "requests.list":
      return d.requests.filter((q) => !p.taskId || q.taskId === p.taskId) as IpcResult<M>;
    case "stalls.list":
      return fixtureStalls(p.projectId ?? anyProject()).filter((a) => !p.taskId || a.taskId === p.taskId) as IpcResult<M>;
    case "schedules.list":
      return fixtureSchedules(p.projectId ?? anyProject()) as IpcResult<M>;
    case "schedules.runs":
      return fixtureScheduleRuns((params as { id: string }).id) as IpcResult<M>;
    case "runs.undoPreview":
      return fixtureUndo((params as { runId: string }).runId) as IpcResult<M>;
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

/** Two schedules: a weekly one with a precheck that skipped a slot, and a daily auto-approved one, off. */
function fixtureSchedules(projectId: string): ScheduleView[] {
  const base = { projectId, kind: "code" as const, size: "S" as const, fallback: "ask" as const, budgetUsd: 2, bestOf: null, timeZone: "Europe/Istanbul", precheckTimeoutSec: 60, createdAt: ago(9 * 1440), updatedAt: ago(2 * 1440), pending: 0 };
  return [
    {
      ...base,
      id: "s1",
      title: "Weekly cache review",
      description: "Read the pricing service's cache hit rates and suggest changes.",
      kind: "research",
      cadence: "weekly",
      weekday: 1,
      time: "09:00",
      precheck: "gh pr list --label cache --limit 1",
      autoApprove: false,
      enabled: true,
      nextAt: ahead(3 * 1440),
      lastRun: fixtureScheduleRuns("s1")[0]!,
    },
    {
      ...base,
      id: "s2",
      title: "Update outdated dev dependencies",
      description: "Bump patch versions of dev dependencies and run the tests.",
      bestOf: 2,
      cadence: "daily",
      weekday: null,
      time: "07:30",
      precheck: null,
      autoApprove: true,
      enabled: false,
      nextAt: null,
      lastRun: null,
    },
  ];
}

function fixtureScheduleRuns(id: string): ScheduleRunView[] {
  if (id !== "s1") return [];
  const r = (n: number, over: Partial<ScheduleRunView>): ScheduleRunView => ({ id: `sr${n}`, scheduleId: id, slotAt: ago(n * 7 * 1440), startedAt: ago(n * 7 * 1440), finishedAt: ago(n * 7 * 1440 - 1), outcome: "proposed", precheckExit: 0, precheckTail: null, taskId: null, count: 1, detail: null, manual: false, ...over });
  return [r(0, { outcome: "proposed", taskId: "t-asleep", slotAt: ago(96), startedAt: ago(96) }), r(1, { outcome: "skipped_precheck", precheckExit: 1, precheckTail: "no pull requests match" }), r(2, { outcome: "skipped_missed", count: 2 })];
}

/** One quiet run and one step that keeps failing, as the stall rules would raise them. */
function fixtureStalls(projectId: string): StallAlertView[] {
  const base = { projectId, requestId: null, dismissedAt: null, clearedAt: null };
  return [
    { ...base, alertId: "st-1", rule: "no_events", taskId: "t-running", runId: "r-m6", minutes: 12, count: null, detail: null, observedAt: ago(2) },
    { ...base, alertId: "st-2", rule: "request_unanswered", taskId: "t-approval", runId: "r-m9", requestId: "q-approval", minutes: 34, count: null, detail: null, observedAt: ago(1) },
  ];
}

/** What undoing the review task's last implementer turn would change. */
function fixtureUndo(runId: string): UndoPreview {
  return {
    runId,
    turnId: "turn-fx",
    turnStartedAt: ago(70),
    files: [
      { path: "src/session/store.ts", change: "restore", added: 14, removed: 88 },
      { path: "src/session/store.test.ts", change: "delete", added: 0, removed: 37 },
    ],
    commits: 1,
    native: { files: false, history: true },
    noteQueued: false,
  };
}

/** The live notice the running task's implementer would have produced. */
export function fixtureNotices(): LimitNoticePayload[] {
  return [{ kind: "warn", profileId: "p-sol", window: "5h", usedPct: 86, resetsAt: ahead(95), provenance: "reported", minutesUntilFull: null, runId: "r-m6", taskId: "t-running", observedAt: ago(1) }];
}
