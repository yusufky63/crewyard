import type { ChecksSummary, FeedbackItem, PullGate, PullSummary, SendChecksBlock, SendChecksState, TaskPull, TaskPullView } from "@crewyard/core";

// Screenshot data for task PRs. Used only when the page URL has `fixture`, which the main process
// sets only in screenshot mode (CREWYARD_SHOT_QUERY); a normal run never reads this file.

const T0 = Date.now();
const ago = (min: number) => new Date(T0 - min * 60_000).toISOString();

const passed: ChecksSummary = { state: "passed", total: 6, passed: 6, failing: 0, pending: 0, failingNames: [], failingRuns: [] };
const failing: ChecksSummary = { state: "failing", total: 6, passed: 4, failing: 2, pending: 0, failingNames: ["test (ubuntu-latest)", "codecov/patch"], failingRuns: [{ id: 3101, name: "test (ubuntu-latest)" }] };

// `sendChecks=<reason>` in CREWYARD_SHOT_QUERY shows the control off with that reason;
// `ownerQueued=<n>` shows a finished owning step with n queued messages.
const query = () => new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const sendState = (): SendChecksState => {
  const reason = query().get("sendChecks");
  return reason && reason !== "ok" ? { ok: false, reason: reason as SendChecksBlock } : { ok: true, reason: null };
};
const gate = (pushed: "pass" | "wait"): PullGate => ({
  items: [
    { id: "review", status: "pass" },
    { id: "reviewed", status: "pass" },
    { id: "commits", status: "pass" },
    { id: "clean", status: "pass" },
    { id: "pushed", status: pushed },
    { id: "no_pull", status: "pass" },
  ],
  ready: pushed === "pass",
});

const pull = (taskId: string, number: number, head: string, state: TaskPull["state"], minutes: number): TaskPull => ({
  taskId,
  number,
  url: `https://github.com/yusufky63/crewyard/pull/${number}`,
  head,
  base: "main",
  headSha: "9c1e4b27d0aa53f1c2e8b7d6a5f4e3d2c1b0a998",
  state,
  origin: "app",
  createdAt: ago(minutes),
  mergedAt: state === "merged" ? ago(minutes - 30) : null,
  mergedSha: state === "merged" ? "51aa0c3" : null,
  syncedAt: ago(1),
  worktreeRemovedAt: null,
});

const live = (p: TaskPull, title: string, checks: ChecksSummary = passed): PullSummary => ({
  number: p.number,
  title,
  url: p.url,
  state: p.state === "merged" ? "merged" : "open",
  head: p.head,
  base: p.base,
  headSha: p.headSha,
  author: "yusufky63",
  behindBy: 0,
  aheadBy: 2,
  // GitHub found a conflict with main, so the merge gate holds the merge and says why.
  mergeState: p.state === "merged" ? null : "dirty",
  mergedAt: p.mergedAt,
  mergedBy: null,
  checks,
  gate:
    p.state === "merged"
      ? null
      : {
          items: [
            { id: "checks", status: checks.state === "failing" ? "fail" : "pass" },
            { id: "up_to_date", status: "pass" },
            { id: "merge_state", status: "fail" },
            { id: "questions", status: "pass" },
            // The branch moved on after the reviewer's verdict, so the pinned review no longer counts.
            { id: "reviewed", status: "fail" },
            { id: "approval", status: "wait" },
          ],
          mergeable: false,
          readyForApproval: false,
        },
});

const feedback: FeedbackItem[] = [
  {
    id: "f2",
    kind: "review_comment",
    source: "yusufky63",
    excerpt: "Keep the old key name readable for one release so existing sessions survive the upgrade.",
    url: null,
    path: "src/session/store.ts",
    line: 42,
    observedAt: ago(9),
    state: "sent",
    runId: "r-m11",
    sentAt: ago(8),
  },
  {
    id: "f1",
    kind: "check",
    source: "test (ubuntu-latest)",
    excerpt: "1 test failed\nFAIL src/session/store.test.ts > migrates v1 sessions\nAssertionError: expected undefined to be 'abc'",
    url: null,
    path: null,
    line: null,
    observedAt: ago(22),
    state: "sent",
    runId: "r-m11",
    sentAt: ago(21),
  },
];

function build(projectId: string): TaskPullView[] {
  const review = pull("t-review", 41, "crewyard/t-review", "open", 50);
  const merged = pull("t-merged", 38, "crewyard/catalog-snapshot", "merged", 26 * 60);
  return [
    {
      taskId: "t-review",
      projectId,
      title: "Refactor the session store",
      status: "review",
      pull: review,
      live: live(review, "Refactor the session store", sendState().reason === "none_failing" ? passed : failing),
      mergeMethod: "squash",
      draft: null,
      cleanup: null,
      feedback,
      routing: true,
      sendChecks: sendState(),
      owner: { runId: "r-m11", role: "implementer", finished: query().has("ownerQueued"), queued: Number(query().get("ownerQueued") ?? 0) },
      problem: null,
    },
    {
      taskId: "t-pr-draft",
      projectId,
      title: "Cache provider balances for five minutes",
      status: "review",
      pull: null,
      live: null,
      mergeMethod: "squash",
      draft: {
        title: "Cache provider balances for five minutes",
        body: "Balances are read at most once every five minutes per credential.\n\n## Changes\n- Cache balance reads per credential\n- Test the cache expiry\n\n2 files changed, +64 -9\n\n## Crew\n- implementer: codex (gpt-6.1-sol)\n- reviewer: claude-code (claude-opus-5-5)",
        head: "crewyard/balance-cache",
        base: "main",
        headSha: "77b0e1d5c4a3f2e1d0c9b8a7f6e5d4c3b2a19087",
        ahead: 2,
        unpushed: 2,
        gate: gate("wait"),
      },
      cleanup: null,
      feedback: [],
      routing: true,
      sendChecks: { ok: false, reason: "no_pull" },
      owner: null,
      problem: null,
    },
    {
      taskId: "t-merged",
      projectId,
      title: "Move the catalog snapshot into the data folder",
      status: "merged",
      pull: merged,
      live: live(merged, "Move the catalog snapshot into the data folder"),
      mergeMethod: "squash",
      draft: null,
      cleanup: { path: "C:\\Projeler\\.crewyard\\worktrees\\crewyard\\catalog-snapshot", branch: "crewyard/catalog-snapshot", ok: true, blocks: [] },
      feedback: [],
      routing: true,
      sendChecks: { ok: false, reason: "no_pull" },
      owner: null,
      problem: null,
    },
  ];
}

export function fixtureTaskPulls(projectId: string): TaskPullView[] {
  return build(projectId);
}

export function fixtureTaskPull(taskId: string): TaskPullView {
  const all = build("fixture");
  return all.find((v) => v.taskId === taskId) ?? all[0]!;
}
