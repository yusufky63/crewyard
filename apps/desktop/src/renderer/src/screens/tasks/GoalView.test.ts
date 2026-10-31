import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import type { GoalDetail, GoalPreview, GoalSummary, RequestView, TaskDetail, TaskSummary } from "@crewyard/core";
import { initI18n } from "../../i18n.ts";
import { approvalRequest, cost, decision, goalDetail } from "./goalTestData.ts";
import { GoalRow } from "./GoalRow.tsx";
import { GoalView } from "./GoalView.tsx";
import { TaskRow } from "./TaskRow.tsx";

// Component tests for the goal view, the goal row and a goal task's own row (design §3.3, §3.4).
// The app has no DOM test environment, so each state is rendered to static markup with real
// translations and asserted on its text and buttons.

const i18n = initI18n("en");

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

function render(node: ReactNode, seed?: (qc: QueryClient) => void): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(qc);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

/** The opening tag of the first button whose text contains `label` (or is exactly it), or null. */
function button(html: string, label: string, exact = false): string | null {
  for (const chunk of html.split("<button").slice(1)) {
    const open = chunk.slice(0, chunk.indexOf(">"));
    const inner = text(chunk.slice(chunk.indexOf(">") + 1, chunk.indexOf("</button>"))).trim();
    if (exact ? inner === label : inner.includes(label)) return open;
  }
  return null;
}
const enabled = (html: string, label: string, exact = false) => {
  const b = button(html, label, exact);
  expect(b, `button "${label}"`).not.toBeNull();
  return !/\sdisabled=""/.test(b!);
};

const view = (goal: GoalDetail, requests: RequestView[] = [], seed?: (qc: QueryClient) => void, offline = false) => render(createElement(GoalView, { goal, requests, offline }), seed);

describe("GoalView", () => {
  it("running: status with n of m, spend against the budget with its provenance, branch and why each task waits", () => {
    const html = view(goalDetail());
    const t = text(html);
    expect(t).toContain("Running · 1 of 3");
    expect(t).toMatch(/\$1\.12 of \$3\.00 Reported/);
    expect(t).toContain("crewyard/goal/passkeys-a1b2c3");
    expect(t).toContain("Parolaların yanına geçiş anahtarı girişi ekle");
    expect(t).toContain("01 Compare WebAuthn libraries Solo Done · report accepted $0.070 Reported");
    expect(t).toContain("02 Server: passkey registration and login Crew · 3 steps Running $0.41 Reported");
    expect(t).toContain("03 Client: passkey button Crew · 3 steps Waits for 02 (same files) —");
    expect(t).toContain("Last review of all changes Waits for every task $0.17 Estimated");
    expect(t).not.toContain("Needs you");
    expect(t).not.toContain("Waiting for approval");
    expect(enabled(html, "Pause goal")).toBe(true);
    expect(enabled(html, "Replan · 3 left")).toBe(true);
    expect(button(html, "Open pull request")).toBeNull();
    // The goal's own meter says its share in words for screen readers.
    expect(html).toContain('aria-label="Goal spend: 37% of the goal budget"');
  });

  it("needs you: an Inbox request of a goal task comes first, named with its task, with Open in Inbox", () => {
    const goal = goalDetail({ status: "needs_you", reason: "request", tasks: goalDetail().tasks.map((x) => (x.taskId === "t2" ? { ...x, status: "needs_input" as const } : x)) });
    const html = view(goal, [approvalRequest("t2")]);
    const t = text(html);
    expect(t).toContain("Needs you · A request");
    expect(t).toContain("Needs you · 1");
    expect(t).toContain("02 Server: passkey registration and login · Run pnpm add @simplewebauthn/server?");
    expect(t).toContain("High risk");
    expect(t).toContain("Waiting for your approval");
    expect(button(html, "Open in Inbox")).not.toBeNull();
    // Needs you is listed before the tasks.
    expect(t.indexOf("Open in Inbox")).toBeLessThan(t.indexOf("Tasks"));
  });

  it("paused: Paused by you, Resume goal instead of Pause goal, and waiting tasks say the goal is paused", () => {
    const base = goalDetail();
    const goal = goalDetail({ status: "paused", paused: true, tasks: base.tasks.map((x) => (x.taskId === "t3" ? { ...x, hold: { code: "goal.paused" as const } } : x)) });
    const html = view(goal);
    const t = text(html);
    expect(t).toContain("Paused by you");
    expect(enabled(html, "Resume goal")).toBe(true);
    expect(button(html, "Pause goal")).toBeNull();
    expect(t).toContain("03 Client: passkey button Crew · 3 steps Goal paused");
  });

  it("halted: the stop rule's decision with Resume, Replan at its stated cost, and Stop goal", () => {
    const goal = goalDetail({ status: "needs_you", reason: "halted", halted: { reason: "same_failure", at: "2026-10-31T10:00:00.000Z" }, decisions: [decision({ payload: { rule: "same_failure", detail: "exit 1 · tests failed in src/auth flow" } })] });
    const unpriced = view(goal);
    expect(text(unpriced)).toContain("Needs you · Halted");
    expect(text(unpriced)).toContain("Halted: two tasks failed the same way");
    expect(text(unpriced)).toContain("Details: exit 1 · tests failed in src/auth flow");
    expect(enabled(unpriced, "Resume")).toBe(true);
    expect(button(unpriced, "Stop goal")).not.toBeNull();
    // Every model call starts from a click that showed its cost: no price read yet, no Replan.
    expect(enabled(unpriced, "Replan", true)).toBe(false);
    const preview: Partial<GoalPreview> = { estimate: cost(0.31), ceilingUsd: 0.93 };
    const priced = view(goal, [], (qc) => qc.setQueryData(["goals.preview", { projectId: goal.projectId, text: goal.text }], preview));
    expect(enabled(priced, "Replan · ~$0.31 Estimated")).toBe(true);
    // The halt is said once, by its decision.
    expect(text(priced).match(/Halted:/g)?.length).toBe(1);
  });

  it("stuck: names the task that cannot start and the failed one it waits for", () => {
    const base = goalDetail();
    const goal = goalDetail({
      status: "needs_you",
      reason: "stuck",
      stuck: { taskId: "t3", waitsFor: "t2", why: "failed" },
      tasks: base.tasks.map((x) => (x.taskId === "t2" ? { ...x, status: "failed" as const } : x.taskId === "t3" ? { ...x, hold: { code: "goal.prereq_failed" as const, params: { task: "02", taskId: "t2" } } } : x)),
    });
    const t = text(view(goal));
    expect(t).toContain("Needs you · Stuck");
    expect(t).toContain("02 Server: passkey registration and login failed");
    expect(t).toContain("Stuck: 03 waits for 02, which failed");
    expect(t).toContain("Waits for 02, which failed");
  });

  it("ready for review: Open pull request on the last review, tasks in the goal branch, merge order; never Merged", () => {
    const base = goalDetail();
    const goal = goalDetail({
      status: "ready_for_review",
      done: 3,
      tasks: base.tasks.map((x) => (x.writes ? { ...x, status: "review" as const, released: true, hold: null, joined: { sha: x.taskId === "t2" ? "aaaaaaa1" : "bbbbbbb2", at: "2026-10-31T11:00:00.000Z" } } : x)),
      joins: [
        { id: "j1", taskId: "t2", beforeSha: "0000000", afterSha: "aaaaaaa1", outcome: "joined", conflictPaths: [], at: "2026-10-31T11:00:00.000Z" },
        { id: "j2", taskId: "t3", beforeSha: "aaaaaaa1", afterSha: "bbbbbbb2", outcome: "joined", conflictPaths: [], at: "2026-10-31T11:10:00.000Z" },
      ],
      integration: { taskId: "ti", status: "review", reviewPassed: true, estimate: cost(0.17), shareUsd: 0.2 },
    });
    const html = view(goal);
    const t = text(html);
    expect(t).toContain("Ready for review");
    expect(t).not.toContain("Merged");
    expect(enabled(html, "Open pull request")).toBe(true);
    expect(t).toContain("The last review passed on the goal branch. You open the pull request.");
    expect(t).toContain("Passed on the branch head");
    expect(t.match(/In goal branch/g)?.length).toBe(2);
    expect(t).toContain("(2 tasks added)");
    expect(t).toContain("Merge order");
    expect(t).toContain("02 Server: passkey registration and login · aaaaaaa");
  });

  it("merged: Merged, with every goal action disabled and no pull request button", () => {
    const goal = goalDetail({ status: "finished", outcome: "merged", done: 3, integration: { taskId: "ti", status: "merged", reviewPassed: true, estimate: cost(0.17), shareUsd: 0.2 } });
    const html = view(goal);
    expect(text(html)).toContain("Merged");
    expect(enabled(html, "Pause goal")).toBe(false);
    expect(enabled(html, "Stop goal…")).toBe(false);
    expect(enabled(html, "Add task")).toBe(false);
    expect(button(html, "Open pull request")).toBeNull();
  });

  it("offline: keeps the last state with a note and every action disabled", () => {
    const html = view(goalDetail(), [], undefined, true);
    expect(text(html)).toContain("The daemon is not running.");
    expect(enabled(html, "Pause goal")).toBe(false);
    expect(enabled(html, "Stop goal…")).toBe(false);
  });

  it("a report a writing task waits for asks you to accept it before anything passes it on", () => {
    const base = goalDetail();
    const goal = goalDetail({ status: "needs_you", reason: "report", tasks: base.tasks.map((x) => (x.taskId === "t1" ? { ...x, reportAcceptedAt: null } : x.taskId === "t2" ? { ...x, released: false, status: "proposed" as const, hold: { code: "goal.waits_report" as const, params: { task: "01", taskId: "t1" } } } : x)) });
    const html = view(goal);
    const t = text(html);
    expect(t).toContain("Read 01 Compare WebAuthn libraries's report, then accept it");
    expect(enabled(html, "Accept report")).toBe(true);
    expect(t).toContain("Waits for you to accept 01's report");
    expect(t).toContain("Done · report waits for you");
  });

  it("reads naturally in Turkish", async () => {
    await i18n.changeLanguage("tr");
    const t = text(view(goalDetail()));
    expect(t).toContain("Çalışıyor · 3 görevden 1");
    expect(t).toContain("Hedefi duraklat");
    expect(t).toContain("02 bitince başlayacak (aynı dosyalar)");
  });
});

const summary = (over: Partial<GoalSummary> = {}): GoalSummary => {
  const { text: _t, baseBranch: _b, baseSha: _s, maxParallel: _m, maxTasks: _x, plannerProfileId: _p, revisions: _r, tasks: _k, decisions: _d, joins: _j, revisionsLeft: _rl, replansLeft: _pl, integration: _i, stuck: _st, suggestedBudgetUsd: _sb, ...s } = goalDetail();
  return { ...s, ...over };
};

const taskSummary = (id: string, goal: TaskSummary["goal"], over: Partial<TaskSummary> = {}): TaskSummary => ({
  id,
  projectId: "p1",
  title: `Task ${id}`,
  kind: "code",
  size: "M",
  status: "running",
  fallback: "ask",
  budgetUsd: null,
  spend: cost(0),
  createdAt: "2026-10-31T09:00:00.000Z",
  cancelledAt: null,
  openRequests: 0,
  activeRuns: 0,
  resumableRunIds: [],
  goal,
  ...over,
});
const ref = (number: number, over: Partial<NonNullable<TaskSummary["goal"]>> = {}): NonNullable<TaskSummary["goal"]> => ({ goalId: "g1", key: `k${number}`, number, waiting: false, hold: null, joined: false, hidden: false, role: "task", ...over });

describe("GoalRow", () => {
  const tasks = [taskSummary("t2", ref(2)), taskSummary("t1", ref(1)), taskSummary("tp", ref(0, { hidden: true, role: "planning" })), taskSummary("other", null)];
  const row = (goal: GoalSummary, drawn: string[]) =>
    render(
      createElement(GoalRow, {
        goal,
        tasks,
        requests: [],
        selected: false,
        onSelect: () => undefined,
        renderTask: (x: TaskSummary) => {
          drawn.push(x.id);
          return createElement("span", null, `row ${x.id}`);
        },
      }),
    );

  it("running: one group row with status, n of m and spend against the budget; its visible tasks indented in plan order", () => {
    const drawn: string[] = [];
    const t = text(row(summary(), drawn));
    expect(t).toContain("Goal Parolaların yanına geçiş anahtarı girişi ekle");
    expect(t).toContain("Running · 1 of 3");
    expect(t).toMatch(/\$1\.12 of \$3\.00 Reported/);
    expect(t).toContain("2 tasks");
    expect(drawn).toEqual(["t1", "t2"]);
  });

  it("merged: folds its tasks and says Merged", () => {
    const drawn: string[] = [];
    const t = text(row(summary({ status: "finished", outcome: "merged", done: 3 }), drawn));
    expect(t).toContain("Merged");
    expect(t).toContain("3 of 3");
    expect(drawn).toEqual([]);
  });

  it("needs you, stuck and paused read as their status labels", () => {
    expect(text(row(summary({ status: "needs_you", reason: "stuck" }), []))).toContain("Needs you · Stuck");
    expect(text(row(summary({ status: "needs_you", reason: "halted" }), []))).toContain("Needs you · Halted");
    expect(text(row(summary({ status: "paused", paused: true }), []))).toContain("Paused by you");
    expect(text(row(summary({ status: "ready_for_review" }), []))).toContain("Ready for review");
  });

  it("an unknown spend shows the Unknown badge, never a number", () => {
    const t = text(row(summary({ spend: cost(null, "unknown") }), []));
    expect(t).toContain("Spend unknown Unknown");
  });
});

const detail = (over: Partial<TaskDetail>): TaskDetail => ({
  ...taskSummary("t3", null),
  description: "",
  baseBranch: null,
  waitResetMinutes: 20,
  classification: [],
  crew: null,
  runs: [],
  worktree: null,
  handoffs: [],
  loop: { maxIterations: 3, decisions: [], tests: [], verdicts: [] },
  ...over,
});

describe("TaskRow for a goal task", () => {
  const rowOf = (s: TaskSummary) => render(createElement(TaskRow, { summary: s, requests: [] }), (qc) => qc.setQueryData(["tasks.get", { taskId: s.id }], detail({ ...s })));

  it("a waiting goal task says why it waits, carries its goal chip, and never offers Review crew", () => {
    const s = taskSummary("t3", ref(3, { waiting: true, hold: { code: "goal.waits_finish", params: { task: "02", taskId: "t2" } } }), { status: "proposed" });
    const html = rowOf(s);
    const t = text(html);
    expect(t).toContain("Waits for 02 to finish");
    expect(t).toContain("Goal · 03");
    expect(t).not.toContain("Waiting for approval");
    expect(button(html, "Review crew")).toBeNull();
  });

  it("a task without a goal still offers Review crew", () => {
    const s = taskSummary("t9", null, { status: "proposed" });
    expect(button(rowOf(s), "Review crew")).not.toBeNull();
  });

  it("a merged goal task reads In goal branch", () => {
    const s = taskSummary("t2", ref(2, { joined: true }), { status: "review" });
    expect(text(rowOf(s))).toContain("In goal branch");
  });

  it("hidden goal tasks draw nothing", () => {
    expect(rowOf(taskSummary("tp", ref(0, { hidden: true, role: "planning" })))).toBe("");
  });
});
