import type { CostEstimate, GoalDecisionView, GoalDetail, GoalRevisionView, GoalTaskView, Provenance, RequestView } from "@crewyard/core";

// Builders for the goal view's tests (model.test.ts, GoalView.test.ts). Test data only: nothing in
// the app imports this file. Titles mix English and Turkish, since goal text is the user's own.

export const cost = (usd: number | null, provenance: Provenance = "estimated"): CostEstimate => ({ usd, provenance });

export function goalTask(n: number, over: Partial<GoalTaskView> = {}): GoalTaskView {
  return {
    taskId: `t${n}`,
    key: `k${n}`,
    number: n,
    revision: 1,
    title: `Task ${n}`,
    kind: "code",
    mode: "crew",
    size: "M",
    priority: "medium",
    description: "",
    acceptance: ["It works"],
    basis: "",
    basisMatched: true,
    reason: "",
    paths: ["src/auth flow/session.ts"],
    writes: true,
    edited: false,
    accepted: true,
    discarded: false,
    released: true,
    joined: null,
    reportAcceptedAt: null,
    status: "running",
    dependsOn: [],
    unmet: [],
    hold: null,
    frozen: null,
    crewSteps: 3,
    estimate: cost(0.5),
    shareUsd: 1,
    typedBudgetUsd: null,
    spend: cost(0.2, "reported"),
    ...over,
  };
}

export function revision(over: Partial<GoalRevisionView> = {}): GoalRevisionView {
  return {
    id: "r1",
    revision: 1,
    cause: "initial",
    note: null,
    state: "approved",
    error: null,
    summary: null,
    planTaskId: "tp",
    diff: null,
    overlaps: [],
    planningSpend: cost(0.31, "reported"),
    createdAt: "2026-10-31T09:00:00.000Z",
    approvedAt: "2026-10-31T09:05:00.000Z",
    supersededAt: null,
    ...over,
  };
}

export function decision(over: Partial<GoalDecisionView> = {}): GoalDecisionView {
  return { id: "d1", kind: "stop_rule", taskId: null, payload: {}, actions: ["resume", "replan", "stop"], createdAt: "2026-10-31T10:00:00.000Z", answeredAt: null, answer: null, ...over };
}

/**
 * A running goal of three tasks: 01 research (done, report accepted), 02 code (running), 03 code
 * waiting for 02 on the same files. Spend $1.12 Reported of a $3.00 budget.
 */
export function goalDetail(over: Partial<GoalDetail> = {}): GoalDetail {
  return {
    id: "g1",
    projectId: "p1",
    title: "Parolaların yanına geçiş anahtarı girişi ekle",
    status: "running",
    reason: null,
    outcome: null,
    done: 1,
    total: 3,
    budgetUsd: 3,
    spend: cost(1.12, "reported"),
    planningSpend: cost(0.31, "reported"),
    branch: "crewyard/goal/passkeys-a1b2c3",
    paused: false,
    halted: null,
    latestRevision: 1,
    approvedRevision: 1,
    integrationTaskId: "ti",
    collapsedTaskId: null,
    createdAt: "2026-10-31T09:00:00.000Z",
    text: "Parolaların yanına geçiş anahtarı girişi ekle ve belgele",
    baseBranch: "main",
    baseSha: "0123456789abcdef",
    maxParallel: 2,
    maxTasks: 8,
    plannerProfileId: "pp",
    revisions: [revision()],
    tasks: [
      goalTask(1, { title: "Compare WebAuthn libraries", kind: "research", mode: "solo", crewSteps: 1, writes: false, status: "done", reportAcceptedAt: "2026-10-31T09:30:00.000Z", spend: cost(0.07, "reported") }),
      goalTask(2, { title: "Server: passkey registration and login", dependsOn: [{ taskId: "t1", key: "k1", source: "plan" }], spend: cost(0.41, "reported") }),
      goalTask(3, {
        title: "Client: passkey button",
        released: false,
        status: "proposed",
        spend: cost(0, "estimated"),
        dependsOn: [{ taskId: "t2", key: "k2", source: "overlap" }],
        unmet: [{ taskId: "t2", why: "finish" }],
        hold: { code: "goal.waits_overlap", params: { task: "02", taskId: "t2" } },
      }),
    ],
    decisions: [],
    joins: [],
    revisionsLeft: 5,
    replansLeft: 3,
    integration: { taskId: "ti", status: "proposed", reviewPassed: false, estimate: cost(0.17), shareUsd: 0.2 },
    stuck: null,
    suggestedBudgetUsd: 3,
    reviewEstimate: null,
    ...over,
  };
}

export function approvalRequest(taskId: string, over: Partial<RequestView> = {}): RequestView {
  return {
    id: `q-${taskId}`,
    taskId,
    projectId: "p1",
    runId: "run1",
    sessionId: null,
    kind: "approval",
    risk: "high",
    payload: { kind: "approval", toolCallId: null, command: "pnpm add @simplewebauthn/server", cwd: "C:\\Projeler\\my app", paths: [], network: true, policy: null },
    createdAt: "2026-10-31T10:00:00.000Z",
    answeredAt: null,
    answer: null,
    answeredBy: null,
    ...over,
  };
}
