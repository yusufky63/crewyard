import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import type { ActivityPage, GoalDetail, GoalPreview, GoalStopPreview, GoalSummary, RequestView, TaskDetail, TaskSummary } from "@crewyard/core";
import { initI18n } from "../../i18n.ts";
import { approvalRequest, cost, decision, goalDetail } from "./goalTestData.ts";
import { GoalRow } from "./GoalRow.tsx";
import { AddTaskForm, capRow, GoalFeed, GoalView, ROW_TEXT_MAX, StopConfirm } from "./GoalView.tsx";
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
const seedPreview = (goal: GoalDetail, preview: Partial<GoalPreview>) => (qc: QueryClient) => qc.setQueryData(["goals.preview", { projectId: goal.projectId, text: goal.text }], preview);
const halted = (over: Partial<GoalDetail> = {}) => goalDetail({ status: "needs_you", reason: "halted", halted: { reason: "same_failure", at: "2026-10-31T10:00:00.000Z" }, ...over });

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
    const priced = view(goal, [], seedPreview(goal, { canPlan: true, estimate: cost(0.31), ceilingUsd: 0.93 }));
    // The estimate and the planning run's ceiling, on the decision's button and on the goal bar's.
    expect(enabled(priced, "Replan · ~$0.31 Estimated, up to $0.93")).toBe(true);
    expect(text(priced)).toContain("Replan · 3 left · ~$0.31 Estimated, up to $0.93");
    // The halt is said once, by its decision.
    expect(text(priced).match(/Halted:/g)?.length).toBe(1);
  });

  it("Replan says no API cost for a sign-in planner, cost unknown with its ceiling, and why no planner can run", () => {
    const goal = halted({ decisions: [decision({ payload: { rule: "same_failure" } })] });
    expect(enabled(view(goal, [], seedPreview(goal, { canPlan: true, estimate: cost(0), ceilingUsd: 0.25 })), "Replan · no API cost")).toBe(true);
    expect(enabled(view(goal, [], seedPreview(goal, { canPlan: true, estimate: cost(null, "unknown"), ceilingUsd: 0.75 })), "Replan · cost unknown, up to $0.75")).toBe(true);
    const blocked = view(goal, [], seedPreview(goal, { canPlan: false, reason: { code: "goal.no_planner" as never }, estimate: cost(null, "unknown"), ceilingUsd: null }));
    expect(enabled(blocked, "Replan", true)).toBe(false);
    expect(text(blocked)).toContain("No profile can plan read-only here. Add one, or use Crew.");
  });

  it("halted after its decision was answered: the halt in words, never the rule's code, with Replan and Stop goal…", () => {
    const answered = decision({ payload: { rule: "same_failure" }, answeredAt: "2026-10-31T10:05:00.000Z", answer: "replan" });
    const html = view(halted({ decisions: [answered] }));
    const t = text(html);
    expect(t).toContain("Halted: two tasks failed the same way");
    expect(t).not.toContain("same_failure");
    expect(button(html, "Replan · 3 left")).not.toBeNull();
    expect(html.split("Stop goal…").length - 1).toBe(2);
    expect(text(view(halted({ halted: { reason: "failed_tasks", at: "2026-10-31T10:00:00.000Z" } })))).toContain("Halted: three tasks failed");
    expect(text(view(halted({ halted: { reason: "something_new", at: "2026-10-31T10:00:00.000Z" } })))).toContain("Halted: a stop rule fired");
  });

  it("a decision's Stop goal opens the same confirm as the goal bar's, never a fixed sentence", () => {
    const html = view(halted({ decisions: [decision({ payload: { rule: "same_failure" } })] }));
    expect(text(html)).not.toContain("Unfinished tasks are cancelled");
    expect(button(html, "Stop goal…")).toContain('aria-expanded="false"');
  });

  it("Stop goal… names the tasks it cancels, the running agents and the spend so far with its label", () => {
    const preview: GoalStopPreview = { cancelTasks: 3, runningRuns: 1, spend: cost(1.12, "reported") };
    const props = { goal: { id: "g1" }, onConfirm: async () => undefined, onDone: () => undefined };
    const html = render(createElement(StopConfirm, props), (qc) => qc.setQueryData(["goals.stopPreview", { goalId: "g1" }], preview));
    expect(text(html)).toContain("Stop this goal? It cancels 3 tasks and stops 1 running agent. Spent so far: $1.12. Worktrees and branches are kept. Reported");
    expect(enabled(html, "Stop goal", true)).toBe(true);
    const loading = render(createElement(StopConfirm, props));
    expect(text(loading)).toContain("Counting what it stops");
    expect(enabled(loading, "Stop goal", true)).toBe(false);
  });

  it("stuck with no decision open still offers the task it waits for, Replan and Stop goal…", () => {
    const goal = goalDetail({ status: "needs_you", reason: "stuck", stuck: { taskId: "t3", waitsFor: "t2", why: "finish" } });
    const html = view(goal);
    expect(text(html)).toContain("Stuck: 03 waits for 02, which has not finished");
    expect(button(html, "Open 02")).not.toBeNull();
    expect(html.split("Stop goal…").length - 1).toBe(2);
  });

  it("the last review shows its spend with a label once it runs, Unknown until that is read", () => {
    const goal = goalDetail({ integration: { taskId: "ti", status: "running", reviewPassed: false, estimate: cost(0.17), shareUsd: 0.2 } });
    expect(text(view(goal))).toContain("Last review of all changes Running Unknown");
    const t = text(view(goal, [], (qc) => qc.setQueryData(["tasks.get", { taskId: "ti" }], { id: "ti", spend: cost(0.05, "reported") })));
    expect(t).toMatch(/Last review of all changes Running \$0\.050? Reported/);
  });

  it("caps untrusted decision text at 600 characters, Turkish included", () => {
    const long = "Doğrulama başarısız; çıktı şöyle: ".repeat(40);
    expect(long.length).toBeGreaterThan(1000);
    const capped = capRow(long);
    expect(capped.length).toBe(ROW_TEXT_MAX);
    expect(capped.endsWith("…")).toBe(true);
    const t = text(view(goalDetail({ status: "needs_you", reason: "decision", decisions: [decision({ kind: "changes", payload: { findings: long } })] })));
    expect(t).toContain(capped.trim());
    expect(t).not.toContain(long.slice(0, 700).trim());
  });

  it("Add task says a Turkish title over the byte cap is too long instead of a bare disabled button", () => {
    const apply = async () => undefined;
    const tooLong = render(createElement(AddTaskForm, { goal: goalDetail(), apply, onDone: () => undefined, initialTitle: "Şifre sıfırlama akışını güçlendir ".repeat(4) }));
    expect(text(tooLong)).toContain("The title is too long: at most 120 bytes");
    expect(enabled(tooLong, "Add to the goal")).toBe(false);
    const fits = render(createElement(AddTaskForm, { goal: goalDetail(), apply, onDone: () => undefined, initialTitle: "Şifre sıfırlama" }));
    expect(text(fits)).not.toContain("too long");
    expect(enabled(fits, "Add to the goal")).toBe(true);
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
    expect(t).toContain("Read the report of 01 Compare WebAuthn libraries, then accept it");
    expect(enabled(html, "Accept report")).toBe(true);
    expect(t).toContain("Waits for you to accept 01's report");
    expect(t).toContain("Done · report waits for you");
  });

  it("a stuck decision names its tasks: Retry 02, Run 03 without 02, Replan from here", async () => {
    const base = goalDetail();
    const goal = goalDetail({
      status: "needs_you",
      reason: "decision",
      stuck: { taskId: "t3", waitsFor: "t2", why: "failed" },
      tasks: base.tasks.map((x) => (x.taskId === "t2" ? { ...x, status: "failed" as const } : x)),
      decisions: [decision({ id: "s1", kind: "stuck", taskId: null, payload: { waiting: ["t3"], detail: "failed:t2" }, actions: ["retry", "replan", "run_without", "stop"] })],
    });
    const html = view(goal, [], seedPreview(goal, { canPlan: true, estimate: cost(0.31), ceilingUsd: 0.93 }));
    expect(enabled(html, "Retry 02", true)).toBe(true);
    expect(enabled(html, "Run 03 without 02", true)).toBe(true);
    expect(enabled(html, "Replan from here · ~$0.31 Estimated, up to $0.93", true)).toBe(true);
    // Replan opens its form (which states the cost and starts the run); it is never a bare answer.
    expect(button(html, "Replan from here", false)).toContain('aria-expanded="false"');
    await i18n.changeLanguage("tr");
    const tr = view(goal);
    expect(button(tr, "02 görevini yeniden dene", true)).not.toBeNull();
    expect(button(tr, "03 görevini 02 olmadan çalıştır", true)).not.toBeNull();
  });

  it("keeps Retry and Send back disabled while the goal or every goal is paused, and says why", () => {
    const conflict = decision({ id: "c1", kind: "conflict", taskId: "t2", payload: { paths: ["CHANGELOG.md"] }, actions: ["send_to_implementer", "merge_myself", "check_again", "leave_out"] });
    const paused = view(goalDetail({ status: "needs_you", reason: "decision", paused: true, decisions: [conflict] }));
    expect(enabled(paused, "Send to 02's implementer", true)).toBe(false);
    // Answers that start no run stay open to you.
    expect(enabled(paused, "I will merge it myself", true)).toBe(true);
    expect(enabled(paused, "Leave 02 out of the goal", true)).toBe(true);
    expect(text(paused)).toContain("The goal is paused. Retry and Send back start a run, so they wait until you resume it.");
    const all = view(goalDetail({ status: "needs_you", reason: "decision", decisions: [conflict] }), [], (qc) => qc.setQueryData(["goals.state", undefined], { enabled: true, pausedAll: true }));
    expect(enabled(all, "Send to 02's implementer", true)).toBe(false);
    expect(text(all)).toContain("All goals are paused.");
  });

  it("lists a follow-up a goal task proposed under Needs you, with Add to the goal", () => {
    const goal = goalDetail();
    const followup = { id: "rep1", projectId: goal.projectId, taskId: "t2", runId: "r2", memberId: "m2", type: "followup", text: "Oturum aramaları iki kez çalışıyor.", title: "Oturum aramalarını önbelleğe al", artifacts: [], createdAt: "2026-10-31T10:00:00.000Z", closedAt: null, closedBy: null, taskCreated: null };
    const other = { ...followup, id: "rep2", taskId: "not-in-goal", title: "Başka bir öneri" };
    const html = view(goal, [], (qc) => qc.setQueryData(["mcp.reports.list", { projectId: goal.projectId }], [followup, other]));
    const t = text(html);
    expect(t).toContain("Needs you · 1");
    expect(t).toContain("02 proposes a follow-up task");
    expect(t).toContain("Oturum aramalarını önbelleğe al");
    expect(t).not.toContain("Başka bir öneri");
    expect(enabled(html, "Add to the goal", true)).toBe(true);
  });

  it("a conflicted merge offers its three ways, the buttons naming the task they act on (design §4.9)", async () => {
    const goal = goalDetail({ status: "needs_you", reason: "decision", decisions: [decision({ id: "c1", kind: "conflict", taskId: "t2", payload: { paths: ["CHANGELOG.md", "docs/giriş kılavuzu.md"] }, actions: ["send_to_implementer", "merge_myself", "check_again", "leave_out"] })] });
    const html = view(goal);
    expect(text(html)).toContain("Conflicted files: CHANGELOG.md, docs/giriş kılavuzu.md");
    expect(enabled(html, "Send to 02's implementer", true)).toBe(true);
    expect(enabled(html, "I will merge it myself", true)).toBe(true);
    expect(enabled(html, "Check again", true)).toBe(true);
    expect(enabled(html, "Leave 02 out of the goal", true)).toBe(true);
    // A decision with no task keeps the plain label.
    const plain = view(goalDetail({ decisions: [decision({ id: "p1", kind: "profile_gone", taskId: null, payload: { profileId: "gone" }, actions: ["replan", "leave_out", "stop"] })] }));
    expect(button(plain, "Leave it out", true)).not.toBeNull();
    await i18n.changeLanguage("tr");
    const tr = view(goal);
    expect(button(tr, "02 görevini uygulayıcısına geri gönder", true)).not.toBeNull();
    expect(button(tr, "02 görevini hedefin dışında bırak", true)).not.toBeNull();
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
  const { text: _t, baseBranch: _b, baseSha: _s, maxParallel: _m, maxTasks: _x, plannerProfileId: _p, revisions: _r, tasks: _k, decisions: _d, joins: _j, revisionsLeft: _rl, replansLeft: _pl, integration: _i, stuck: _st, suggestedBudgetUsd: _sb, reviewEstimate: _re, ...s } = goalDetail();
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

describe("GoalFeed", () => {
  const goal = { id: "g1", projectId: "p1" };
  const key = (before: number | null) => ["activity.events", { projectId: "p1", kind: "goal.", goalId: "g1", limit: 40, before }];
  const event = (seq: number, kind: string, preview: string) => ({ seq, at: "2026-10-31T10:00:00.000Z", kind, source: "orchestrator", taskId: null, runId: null, preview, size: preview.length });

  it("lists the goal's events newest first in pages of 40, as plain lines, with Show older", () => {
    const page: ActivityPage = { events: [event(12, "goal.paused", '{"goalId":"g1"}'), event(11, "goal.joined", "aaaaaaa"), event(10, "goal.created", "Geçiş anahtarları")], older: 10 };
    const html = render(createElement(GoalFeed, { goal, defaultOpen: true }), (qc) => qc.setQueryData(key(null), page));
    const t = text(html);
    expect(t).toContain("Details");
    expect(t.indexOf("Paused")).toBeLessThan(t.indexOf("Merged into the goal branch"));
    expect(t).toContain("Goal created");
    expect(t).toContain("Geçiş anahtarları");
    // A payload without readable text is the Activity drawer's business, not a raw JSON line here.
    expect(t).not.toContain("goalId");
    expect(button(html, "Show older")).not.toBeNull();
  });

  it("reads nothing while folded, and says when there is nothing yet", () => {
    expect(text(render(createElement(GoalFeed, { goal }))).trim()).toBe("Details");
    const empty = render(createElement(GoalFeed, { goal, defaultOpen: true }), (qc) => qc.setQueryData(key(null), { events: [], older: null }));
    expect(text(empty)).toContain("No goal events yet.");
    expect(button(empty, "Show older")).toBeNull();
  });
});

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
