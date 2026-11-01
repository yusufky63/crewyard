import { reviewFixture } from "./reviewFixture.ts";
import { fixtureReport } from "./reportFixture.ts";
import { NO_RUN_CONTROLS, type AccountSwitchView, type AttachmentView, type CandidateView, type CrewMemberView, type IpcMethod, type IpcParams, type IpcResult, type LimitNoticePayload, type LoopDecisionView, type RequestView, type RoleId, type RunView, type StallAlertView, type TaskDetail, type TaskSummary, type UndoPreview, type BestOfVariantView, type ScheduleRunView, type ScheduleView } from "@crewyard/core";
import { fixtureReports, fixtureServers, fixtureUsage } from "../../shell/mcpFixture.ts";
import { fixtureTaskPreview, goalFixtureCall } from "./goalFixture.ts";

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
// Codex takes images but no other files, as its adapter says (packages/adapter-codex/src/input.ts).
const SOL = { ...cand("p-sol", "work", "codex", "openai", "gpt-6.1-sol", 0, 14, [{ code: "history.accepted", params: { accepted: 7, total: 8 } }, { code: "headroom", params: { pct: 14, provenance: "reported", window: "5h" } }]), attachments: { images: true, files: false } };
const GLM = cand("p-glm", "zai-plan", "claude-code", "zai-coding-plan", "glm-5.3", 0, null, [{ code: "independence.provider" }, { code: "cost.plan" }]);
const FLASH = cand("p-flash", "ds-primary", "opencode", "deepseek", "deepseek-flash", 0.4, null, [{ code: "cost.estimate", params: { usd: 0.4 } }, { code: "fit.context", params: { context: 128000 } }]);
const ARGON = cand("p-argon", "google", "gemini-cli", "google", "gemini-4-argon", 0, null, [{ code: "fit.reasoning" }, { code: "headroom.unknown" }]);
// Second accounts of two providers, for the same-provider account switch (docs/adr/0009).
const SOL_HOME = cand("p-sol-home", "personal", "codex", "openai", "gpt-6.1-sol", 0, 64, [{ code: "headroom", params: { pct: 64, provenance: "reported", window: "5h" } }]);
const FLASH_B = cand("p-flash-b", "ds-backup", "opencode", "deepseek", "deepseek-flash", 0.41, null, [{ code: "cost.estimate", params: { usd: 0.41 } }]);

const attachment = (id: string, kind: AttachmentView["kind"], name: string, mime: string, bytes: number): AttachmentView => ({ id, kind, name, mime, bytes, createdAt: ago(2) });
const SHOT = attachment("a-shot", "image", "frame-time spike.png", "image/png", 184_320);
const TRACE = attachment("a-trace", "file", "pathfinding-trace.log", "text/plain", 41_210);
const HINT = attachment("a-hint", "image", "429 response.png", "image/png", 96_512);

/**
 * A stand-in screenshot for attachment thumbnails, drawn once in the theme's own colors: a panel
 * with a chart line and a spike, which is what a pasted profiler capture tends to look like.
 */
let shot: string | null = null;
function fixtureShot(): string {
  if (shot) return shot;
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 120;
  const g = canvas.getContext("2d");
  if (!g) return "";
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  g.fillStyle = v("--surface");
  g.fillRect(0, 0, 160, 120);
  g.strokeStyle = v("--line");
  g.strokeRect(0.5, 0.5, 159, 119);
  g.fillStyle = v("--ink-3");
  g.fillRect(10, 10, 60, 6);
  g.strokeStyle = v("--accent");
  g.lineWidth = 2;
  g.beginPath();
  [96, 92, 94, 90, 93, 40, 91, 89, 92, 90].forEach((y, i) => (i === 0 ? g.moveTo(10 + i * 15.5, y) : g.lineTo(10 + i * 15.5, y)));
  g.stroke();
  g.fillStyle = v("--bad");
  g.fillRect(84, 34, 4, 4);
  shot = canvas.toDataURL("image/png");
  return shot;
}

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
  cwd: "C:\\Projeler\\.crewyard\\worktrees\\crewyard\\login-rate-limit",
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
    worktree: runs.length ? { id: "w1", path: `C:\\Projeler\\.crewyard\\worktrees\\crewyard\\${s.id}`, branch: `crewyard/${s.id}`, baseSha: "4f2c1aa", ownerRunId: runs[0]!.id, createdAt: s.createdAt } : null,
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
  const proposed = detail(summary("t-proposed", "Optimize unit pathfinding for 2,000 units and keep the frame time under 16 ms", { status: "proposed", createdAt: ago(1) }), p, [], { attachments: [SHOT, TRACE] });

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
        { id: "qm-1", text: "Return the retry hint in seconds, not milliseconds. This is what clients see now.", createdAt: ago(3), editedAt: null, kind: "user", attachments: [HINT] },
        { id: "qm-2", text: "Keep the old error text as a fallback for clients that parse it.", createdAt: ago(1), editedAt: ago(0), kind: "user" },
      ],
      controls: { steer: { ok: true, reason: null }, undo: { ok: false, reason: "undo.turn_running", turnId: null }, attach: { image: { ok: true, reason: null }, file: { ok: false, reason: "attach.file_unsupported" } } },
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

  // 5b. Merged from the app: the row's PR chip reads merged (GitHub fixture PR #38), and nothing is left to run.
  const mg = [member("implementer", 1, SOL, [OPUS]), member("reviewer", 2, OPUS, [GLM], ["implementer"])];
  const mergedRuns = [
    run("t-merged", mg[0]!, SOL, { state: "ended", startedAt: ago(28 * 60), endedAt: ago(27 * 60 + 20), endReason: "completed", diff: [{ path: "src/catalog/snapshot.ts", added: 42, removed: 18 }, { path: "src/catalog/snapshot.test.ts", added: 21, removed: 0 }] }),
    run("t-merged", mg[1]!, OPUS, { state: "ended", startedAt: ago(27 * 60 + 20), endedAt: ago(27 * 60), endReason: "completed", cost: { usd: 0.18, provenance: "estimated" } }),
  ];
  const merged = detail(summary("t-merged", "Move the catalog snapshot into the data folder", { status: "merged", spend: { usd: 0.18, provenance: "estimated" }, createdAt: ago(28 * 60) }), mg, mergedRuns);

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
  const wt = (position: number) => `C:\\Projeler\\.crewyard\\worktrees\\crewyard\\cache-layer-v${position}`;
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

  // 10b. The same kind of task as a proposal: three variants with their estimates and the group's total.
  const bp = [member("implementer", 1, SOL, [OPUS, FLASH], [], true), member("reviewer", 2, GLM, [ARGON], ["implementer"])];
  const proposedVariants = [SOL, OPUS, FLASH].map((c, i) => variant(i + 1, c, { taskId: null, status: null, run: null, branch: null, worktreePath: null, spend: { usd: 0, provenance: "estimated" } }));
  const bestOfProposed = detail(summary("t-bestof-proposed", "Rewrite the pricing cache with an LRU and a TTL", { status: "proposed", size: "S", bestOf: { n: 3, phase: "proposed" }, createdAt: ago(1) }), bp, [], {
    crew: { id: "c-t-bestof-proposed", proposedAt: ago(1), approvedAt: null, estimate: { usd: 1.6, provenance: "estimated" }, members: bp },
    bestOfGroup: { id: "g2", memberId: bp[0]!.id, n: 3, phase: "proposed", estimate: { usd: 1.6, provenance: "estimated" }, variants: proposedVariants, startedAt: null, keptVariantId: null, keptAt: null },
  });

  // 11. Hibernated: the process stopped while the run waits on a question; it wakes with the answer.
  const h = [member("researcher", 1, ARGON, [OPUS])];
  const asleepRun = run("t-asleep", h[0]!, ARGON, { state: "waiting_input", startedAt: ago(95), lastActivityAt: ago(80), pendingRequestId: "q-asleep", hibernatedAt: ago(50), worktreeId: null, cwd: "C:\\Projeler\\crewyard" });
  const asleep = detail(summary("t-asleep", "Compare Redis and an in-process cache for the pricing service", { kind: "research", size: "S", status: "needs_input", openRequests: 1, activeRuns: 1, scheduled: { scheduleId: "s1", title: "Weekly cache review", autoApproved: false }, createdAt: ago(96) }), h, [asleepRun], { worktree: null });

  // 12. Running after two automatic account switches: the implementer moved from Codex · work to
  // Codex · personal at its 5-hour limit, the tester from one DeepSeek key to the other at its daily cap.
  const w = [member("planner", 1, OPUS, [GLM]), member("implementer", 2, SOL, [SOL_HOME, OPUS], ["planner"], true), member("tester", 3, FLASH, [FLASH_B], ["implementer"]), member("reviewer", 4, GLM, [ARGON], ["implementer"])];
  const switchedRuns = [
    run("t-switched", w[0]!, OPUS, { state: "ended", startedAt: ago(70), endedAt: ago(62), endReason: "completed", tokensIn: 38100, tokensOut: 3600, cost: { usd: 0.29, provenance: "estimated" } }),
    run("t-switched", w[1]!, SOL, { id: "r-sw-work", state: "ended", startedAt: ago(62), endedAt: ago(41), endReason: "limit", endDetail: "handed_off", limitReached: true, pausedAt: ago(41), handoffId: "h-sw-1", tokensIn: 81200, tokensOut: 9400 }),
    run("t-switched", w[1]!, SOL_HOME, { id: "r-sw-home", state: "ended", startedAt: ago(41), endedAt: ago(24), endReason: "completed", resumedFrom: "r-sw-work", tokensIn: 40300, tokensOut: 5100, diff: [{ path: "src/billing/invoice.ts", added: 72, removed: 9 }, { path: "src/billing/invoice.test.ts", added: 51, removed: 0 }] }),
    run("t-switched", w[2]!, FLASH, { id: "r-sw-ds-a", state: "ended", startedAt: ago(24), endedAt: ago(9), endReason: "limit", endDetail: "handed_off", limitReached: true, pausedAt: ago(9), handoffId: "h-sw-2", tokensIn: 7_400_000, tokensOut: 210_000, cost: { usd: 2.03, provenance: "estimated" } }),
    run("t-switched", w[2]!, FLASH_B, { id: "r-sw-ds-b", startedAt: ago(9), resumedFrom: "r-sw-ds-a", tokensIn: 512_000, tokensOut: 14_000, cost: { usd: 0.14, provenance: "estimated" } }),
  ];
  const handoff = (id: string, fromRunId: string, toRunId: string, target: string, trigger: "limit" | "budget", at: string) => ({ id, fromRunId, toRunId, targetProfileId: target, mode: "auto" as const, kind: "fork" as const, stop: "interrupt" as const, trigger, phase: "closed" as const, packagePath: null, checkpointSha: "9b3e2f1", openedAt: at, closedAt: at, outcome: "completed" as const, detail: null });
  const switched = detail(summary("t-switched", "Split invoices by billing period", { status: "running", activeRuns: 1, spend: { usd: 2.46, provenance: "estimated" }, createdAt: ago(72) }), w, switchedRuns, {
    handoffs: [handoff("h-sw-1", "r-sw-work", "r-sw-home", SOL_HOME.profileId, "limit", ago(41)), handoff("h-sw-2", "r-sw-ds-a", "r-sw-ds-b", FLASH_B.profileId, "budget", ago(9))],
    accountSwitch: true,
  });

  // Orchestra (docs/adr/0019): the hidden planning task of `g-planning`, and the tasks of the running
  // goal `g-run`, which the task list shows under their goal row (goalFixture.ts).
  const goalRef = (goalId: string, number: number, over: Partial<NonNullable<TaskSummary["goal"]>> = {}): TaskSummary["goal"] => ({ goalId, key: `k${number}`, number, waiting: false, hold: null, joined: false, hidden: false, role: "task", ...over });
  const gp = [member("researcher", 1, OPUS, [ARGON])];
  const planTask = detail(summary("t-goal-plan", "Plan: Add passkey sign-in next to passwords and document it", { kind: "research", status: "running", activeRuns: 1, createdAt: ago(1), goal: goalRef("g-planning", 0, { hidden: true, role: "planning", key: "" }) }), gp, [run("t-goal-plan", gp[0]!, OPUS, { startedAt: ago(0.7), cwd: "C:\\Projeler\\crewyard", worktreeId: null, tokensIn: 41_200, cost: { usd: 0.04, provenance: "estimated" } })], { worktree: null });
  const gr1 = [member("researcher", 1, ARGON, [OPUS])];
  const goalResearch = detail(summary("g-run-t1", "Compare rate-limit stores", { kind: "research", size: "S", status: "done", spend: { usd: 0.07, provenance: "reported" }, createdAt: ago(40), goal: goalRef("g-run", 1) }), gr1, [run("g-run-t1", gr1[0]!, ARGON, { state: "ended", startedAt: ago(38), endedAt: ago(30), endReason: "completed", cwd: "C:\\Projeler\\crewyard", worktreeId: null })], { worktree: null });
  const gr2 = [member("implementer", 1, SOL, [OPUS], [], true), member("reviewer", 2, GLM, [ARGON], ["implementer"])];
  const goalCode = detail(summary("g-run-t2", "Token bucket middleware", { status: "running", activeRuns: 1, spend: { usd: 0.41, provenance: "reported" }, createdAt: ago(40), goal: goalRef("g-run", 2) }), gr2, [run("g-run-t2", gr2[0]!, SOL, { startedAt: ago(12), tokensIn: 88_000, tokensOut: 6_100 })]);
  const gr3 = [member("implementer", 1, FLASH, [SOL], [], true), member("reviewer", 2, GLM, [ARGON], ["implementer"])];
  const goalWaiting = detail(summary("g-run-t3", "Per-key limits in the admin screen", { status: "proposed", createdAt: ago(40), goal: goalRef("g-run", 3, { waiting: true, hold: { code: "goal.waits_overlap", params: { task: "02", taskId: "g-run-t2" } } }) }), gr3, []);

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
      payload: { kind: "approval", toolCallId: "tc1", command: "pnpm vitest run src/auth", cwd: "C:\\Projeler\\.crewyard\\worktrees\\crewyard\\t-approval", paths: [], network: false, policy: null },
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
  // New kinds of rows go last, so earlier shots of the list keep their first rows.
  return { tasks: [noStart, credit, proposed, running, approval, capped, unpriced, review, merged, done, bestOf, asleep, bestOfProposed, switched, planTask, goalResearch, goalCode, goalWaiting], requests };
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
    case "switches.list":
      return fixtureSwitches(p.projectId ?? anyProject()).filter((s) => !p.taskId || s.taskId === p.taskId) as IpcResult<M>;
    case "stalls.list":
      return fixtureStalls(p.projectId ?? anyProject()).filter((a) => !p.taskId || a.taskId === p.taskId) as IpcResult<M>;
    case "mcp.reports.list":
      return fixtureReports(p.projectId ?? anyProject()).filter((r) => !p.taskId || r.taskId === p.taskId) as IpcResult<M>;
    case "mcp.servers.list":
      return fixtureServers(p.projectId) as IpcResult<M>;
    case "mcp.servers.usage":
      return fixtureUsage(p.projectId) as IpcResult<M>;
    case "schedules.list":
      return fixtureSchedules(p.projectId ?? anyProject()) as IpcResult<M>;
    case "schedules.runs":
      return fixtureScheduleRuns((params as { id: string }).id) as IpcResult<M>;
    case "runs.undoPreview":
      return fixtureUndo((params as { runId: string }).runId) as IpcResult<M>;
    case "attachments.preview":
      return { dataUrl: fixtureShot() } as IpcResult<M>;
    case "attachments.add":
      return attachment(`a-${Date.now()}`, "image", (params as { name: string }).name, "image/png", 1024) as IpcResult<M>;
    case "attachments.discard":
      return { id: (params as { id: string }).id } as IpcResult<M>;
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
    case "assistant.report":
      return fixtureReport(p.taskId) as IpcResult<M>;
    case "tasks.preview":
      return fixtureTaskPreview() as IpcResult<M>;
    case "activity.events":
      return { events: [], older: null } as IpcResult<M>;
    case "agentfiles.forSteps":
      // Screenshot data: the first profile reads CLAUDE.md and gets AGENTS.md through the bridge (docs/adr/0015).
      return (params as { profileIds: string[] }).profileIds.map((profileId, i) => ({
        profileId,
        runner: null,
        project: i === 0 ? ["CLAUDE.md"] : ["AGENTS.md"],
        bridged: i === 0 ? ["AGENTS.md"] : ["CLAUDE.md"],
        shared: i === 0 ? [{ kind: "skill", name: "release-notes", state: "current" }] : [],
      })) as IpcResult<M>;
    default:
      if (method.startsWith("goals.")) return goalFixtureCall(method, params, p.projectId ?? anyProject(), new URLSearchParams(typeof location === "undefined" ? "" : location.search)) as IpcResult<M>;
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

/** The two switches of the "t-switched" task, newest first, with every kind of label among them. */
export function fixtureSwitches(projectId: string): AccountSwitchView[] {
  const base = { taskId: "t-switched", projectId, outcome: "completed" as const, dismissedAt: null };
  const step = (role: RoleId) => data(projectId).tasks.find((t) => t.id === "t-switched")?.crew?.members.find((m) => m.role === role)?.id ?? role;
  return [
    {
      ...base,
      id: "sw-2",
      memberId: step("tester"),
      fromRunId: "r-sw-ds-a",
      toRunId: "r-sw-ds-b",
      handoffId: "h-sw-2",
      runner: "opencode",
      providerId: "deepseek",
      from: { profileId: FLASH.profileId, alias: FLASH.alias },
      to: { profileId: FLASH_B.profileId, alias: FLASH_B.alias },
      trigger: "spend_cap",
      source: { window: "budget-day", usedPct: 100, provenance: "estimated", cap: { kind: "daily_cap", spentUsd: 2.03, capUsd: 2, credentialId: "cred-ds-a" } },
      headroom: { pct: null, window: null, provenance: "unknown" },
      estimate: { usd: 0.41, provenance: "estimated" },
      skipped: [],
      outcome: "pending",
      at: ago(9),
    },
    {
      ...base,
      id: "sw-1",
      memberId: step("implementer"),
      fromRunId: "r-sw-work",
      toRunId: "r-sw-home",
      handoffId: "h-sw-1",
      runner: "codex",
      providerId: "openai",
      from: { profileId: SOL.profileId, alias: SOL.alias },
      to: { profileId: SOL_HOME.profileId, alias: SOL_HOME.alias },
      trigger: "limit",
      source: { window: "5h", usedPct: 100, provenance: "reported" },
      headroom: { pct: 64, window: "5h", provenance: "reported" },
      estimate: { usd: 0, provenance: "estimated" },
      skipped: [{ profileId: "p-sol-team", alias: "team", reason: "headroom_low" }],
      at: ago(41),
    },
  ];
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
