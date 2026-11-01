import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { GOAL_LIMITS, type GoalDetail } from "@crewyard/core";
import { initI18n } from "../../i18n.ts";
import { fixtureCall } from "./fixture.ts";
import { fixtureGoals, goalFixtureCall, REVIEW_FIXTURES } from "./goalFixture.ts";
import { GoalIntro } from "./GoalIntro.tsx";
import { GoalPlanReview, TaskEditor, useCostText } from "./GoalPlanReview.tsx";

// The plan review's states from the screenshot fixtures (design §3.2), rendered to static markup
// with real translations, as GoalView.test.ts does (the app has no DOM test environment).

const i18n = initI18n("en");
beforeEach(async () => {
  await i18n.changeLanguage("en");
});

const PROJECT = "p-fixture";
const goals = fixtureGoals(PROJECT);
const g = (id: (typeof REVIEW_FIXTURES)[number]) => goals[id]!;

function render(node: ReactNode, goal?: GoalDetail): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (goal) {
    // What the review reads besides the goal: the planning cost (goals.preview) and the one task's crew.
    qc.setQueryData(["goals.preview", { projectId: goal.projectId, text: goal.text }], goalFixtureCall("goals.preview", { projectId: goal.projectId, text: goal.text }, goal.projectId, new URLSearchParams()));
    for (const t of goal.tasks) qc.setQueryData(["tasks.get", { taskId: t.taskId }], fixtureCall("tasks.get", { taskId: t.taskId }));
  }
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
}
const review = (goal: GoalDetail, offline = false) => render(createElement(GoalPlanReview, { goal, offline, onCollapsed: () => undefined, onClose: () => undefined }), goal);

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

function button(html: string, label: string): string | null {
  for (const chunk of html.split("<button").slice(1)) {
    const inner = text(chunk.slice(chunk.indexOf(">") + 1, chunk.indexOf("</button>"))).trim();
    if (inner.includes(label)) return chunk.slice(0, chunk.indexOf(">"));
  }
  return null;
}
const enabled = (html: string, label: string) => {
  const b = button(html, label);
  expect(b, `button "${label}"`).not.toBeNull();
  return !/\sdisabled=""/.test(b!);
};

const PROVENANCE = /Reported|Estimated|Unknown/;
/**
 * Every dollar amount on screen is a cost with its provenance (Reported, Estimated or Unknown) right
 * after it, or a limit: a budget, a share or a ceiling ("up to $1.08"), marked `gp-limit` or typed
 * in a field. Returns the amounts that break the rule, with what follows them.
 */
function unlabelledCosts(html: string): { found: number; bad: string[] } {
  const stripped = html.replace(/<span class="gp-limit[^"]*">[^<]*<\/span>/g, " ").replace(/<input[^>]*>/g, " ");
  const t = text(stripped);
  const bad: string[] = [];
  let found = 0;
  for (const m of t.matchAll(/\$\d[\d.,]*/g)) {
    found += 1;
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const before = t.slice(Math.max(0, m.index - 40), m.index);
    const ceiling = /(up to|en fazla)\s*$/.test(before);
    if (PROVENANCE.test(after.split(/[·:]/)[0] ?? "") || (ceiling && PROVENANCE.test(before))) continue;
    bad.push(`${m[0]}${after}`.trim());
  }
  return { found, bad };
}

describe("every cost carries its provenance", () => {
  it.each(REVIEW_FIXTURES)("%s", (id) => {
    const r = unlabelledCosts(review(g(id)));
    expect(r.bad).toEqual([]);
  });

  it("is not vacuous: the review states show costs and limits", () => {
    const html = review(g("g-review"));
    expect(unlabelledCosts(html).found).toBeGreaterThan(5);
    expect(html).toContain("gp-limit");
  });

  it("the first-goal card states the planning cost with its label too", () => {
    const html = render(createElement(GoalIntro, { cost: "~$0.36 Estimated", ceiling: "$1.08", budgetUsd: 3, busy: false, onPlan: () => undefined, onCrew: () => undefined, onCancel: () => undefined }));
    expect(unlabelledCosts(html).bad).toEqual([]);
    expect(unlabelledCosts(html).found).toBeGreaterThan(1);
  });

  it("the first-goal card says no ceiling when the planner has none (a sign-in or a local model)", () => {
    const t = text(render(createElement(GoalIntro, { cost: "plan sign-in, $0.00 Estimated", ceiling: null, budgetUsd: 3, busy: false, onPlan: () => undefined, onCrew: () => undefined, onCancel: () => undefined })));
    expect(t).toContain("A planner reads the project and proposes tasks: plan sign-in, $0.00 Estimated.");
    expect(t).not.toContain("up to");
  });

  it("the first-goal card refuses a budget past the goal budget limit, and holds no form", () => {
    const html = render(createElement(GoalIntro, { cost: "~$0.36 Estimated", ceiling: "$1.08", budgetUsd: GOAL_LIMITS.budgetMaxUsd + 1, busy: false, onPlan: () => undefined, onCrew: () => undefined, onCancel: () => undefined }));
    expect(text(html)).toContain(`at most $${GOAL_LIMITS.budgetMaxUsd}`);
    expect(enabled(html, "Plan goal · ~$0.36 Estimated")).toBe(false);
    // No form, so it can never nest inside the composer's, and Enter in the field starts nothing.
    expect(html).not.toContain("<form");
    const ok = render(createElement(GoalIntro, { cost: "~$0.36 Estimated", ceiling: "$1.08", budgetUsd: 3, busy: false, onPlan: () => undefined, onCrew: () => undefined, onCancel: () => undefined }));
    expect(enabled(ok, "Plan goal · ~$0.36 Estimated")).toBe(true);
  });

  it("catches an amount without one", () => {
    expect(unlabelledCosts("<span>Spent $1.20 so far</span>").bad).toEqual(["$1.20 so far"]);
  });
});

describe("plan review states", () => {
  it("planning: who plans, Stop planning and Run as one task, nothing to approve", () => {
    const html = review(g("g-planning"));
    const t = text(html);
    expect(t).toContain("Planning");
    expect(t).toContain("Add passkey sign-in next to passwords and document it");
    expect(t).toContain("Nothing else starts until you approve its plan");
    expect(enabled(html, "Stop planning")).toBe(true);
    expect(enabled(html, "Run as one task")).toBe(true);
    expect(button(html, "Approve and start")).toBeNull();
  });

  it("review: steps, the overlap line with Run side by side anyway, the report line, totals and one approval", () => {
    const html = review(g("g-review"));
    const t = text(html);
    expect(t).toContain("Needs you · Plan ready");
    expect(t).toContain("Planner planning $0.31 Reported");
    expect(t).toContain("4 tasks");
    expect(t).toContain("4 of 4 accepted");
    expect(t).toContain("$1.84 Estimated of goal budget");
    expect(t).toContain("03 runs after 02: both change src/auth/client.ts");
    expect(enabled(html, "Run side by side anyway")).toBe(true);
    expect(t).toContain("01's report feeds 02 and 03: you read and accept it before they start");
    expect(t).toMatch(/Step 1 .*01 Compare WebAuthn libraries.* Step 2 .*02 Server.* Step 3 .*03 Client.*04 Docs/);
    expect(t).toContain("Last review of all changes reviewer, read-only $0.17 Estimated");
    expect(t).toContain("Not tied to your words");
    expect(t).toContain("Nothing starts until you approve. You open the pull request.");
    expect(enabled(html, "Approve and start 4 tasks · $1.84 Estimated")).toBe(true);
    expect(enabled(html, "Revise · ~$0.36 Estimated, up to $1.08")).toBe(true);
    expect(t).toContain("5 revisions left");
    // Each tile states its share of the goal budget once the budget covers the total.
    expect(t).toContain("Share of the goal budget");
  });

  it("one task: One task is enough, its crew, Edit crew and Approve and start", () => {
    const html = review(g("g-one"));
    const t = text(html);
    expect(t).toContain("One task is enough");
    expect(t).toContain("Implement");
    expect(t).toContain("no goal branch");
    expect(enabled(html, "Approve and start · $1.60 Estimated")).toBe(true);
    expect(enabled(html, "Edit crew")).toBe(true);
    expect(t).not.toContain("Step 1");
  });

  it("failed: the parser's words as plain text, Retry planning with its cost, Run as one task, Edit goal", () => {
    const html = review(g("g-failed"));
    const t = text(html);
    expect(t).toContain("Needs you · Plan failed");
    expect(t).toContain("The planner returned 15 tasks; the limit is 8.");
    expect(enabled(html, "Retry planning · ~$0.36 Estimated, up to $1.08")).toBe(true);
    expect(enabled(html, "Run as one task")).toBe(true);
    expect(enabled(html, "Edit goal")).toBe(true);
    expect(button(html, "Approve and start")).toBeNull();
  });

  it("over budget: Approve is disabled with the reason beside it", () => {
    const html = review(g("g-over"));
    const t = text(html);
    expect(t).toContain("$4.10 Estimated is over the goal budget");
    expect(enabled(html, "Approve and start 4 tasks · $4.10 Estimated")).toBe(false);
  });

  it("Unknown task: never summed into a number, and Approve waits for a budget typed on its tile", () => {
    const html = review(g("g-unknown"));
    const t = text(html);
    expect(t).toContain("$1.23 Estimated + 1 task Unknown");
    expect(t).toContain("Cost unknown: type a budget for this task");
    expect(t).toContain("Cost unknown for 03: type a budget for it.");
    expect(enabled(html, "Approve and start 4 tasks")).toBe(false);
  });

  it("revise: the diff with your note, the changed and added marks, and the edited task kept", () => {
    const html = review(g("g-revise"));
    const t = text(html);
    // The removed task is not in the goal before approval: it is counted, never named by its internal key.
    expect(t).toContain("Revised: added 05 · changed 04 · removed 1 task");
    expect(t).not.toContain("k6");
    expect(t).toContain("Your note: Keep the docs short and add a recovery path for lost passkeys.");
    expect(t).toContain("Edited: kept on revise");
    expect(t).toContain("Added");
    expect(t).toContain("Changed");
    expect(t).toContain("4 revisions left");
    expect(t).toContain("5 tasks");
  });

  it("one task with an Unknown estimate: approved on the goal budget, with no typed budget and no last review", () => {
    const goal = g("g-one");
    const unknownOne: GoalDetail = {
      ...goal,
      tasks: goal.tasks.map((x) => ({ ...x, estimate: { usd: null, provenance: "unknown" as const } })),
      integration: { taskId: "t-int", status: "proposed", reviewPassed: false, estimate: { usd: 0.17, provenance: "estimated" }, shareUsd: null },
    };
    const html = review(unknownOne);
    const t = text(html);
    expect(t).toContain("Its cost is Unknown: the goal budget under Limits becomes this task's budget");
    expect(t).not.toContain("Last review of all changes");
    expect(t).not.toContain("type a budget for it");
    expect(enabled(html, "Approve and start · 1 task, cost Unknown")).toBe(true);
    // The goal budget is the fix here, so the Limits fold is open.
    expect(html).toMatch(/<details class="gp-limits" open="">/);
  });

  it("over budget: the Limits fold opens on its own with the hint to raise the budget", () => {
    const html = review(g("g-over"));
    expect(html).toMatch(/<details class="gp-limits" open="">/);
    expect(text(html)).toContain("Raise the goal budget here, or skip a task, to approve.");
    expect(review(g("g-review"))).not.toMatch(/<details class="gp-limits" open="">/);
  });

  it("each tile offers Edit crew, and Revise is a button, not a form a stray Enter submits", () => {
    const html = review(g("g-review"));
    expect(html.match(/class="[^"]*gp-editcrew/g)?.length).toBe(4);
    expect(html).not.toContain("<form");
  });

  it("caps: no revisions left disables Revise, no planning runs left disables Retry planning", () => {
    const html = review({ ...g("g-review"), revisionsLeft: 0 });
    expect(enabled(html, "No revisions left")).toBe(false);
    expect(text(html)).toContain("0 revisions left");
    const failedBefore = review({ ...g("g-failed"), revisionsLeft: 0 });
    expect(enabled(failedBefore, "No planning runs left")).toBe(false);
    // After approval, Retry planning is a replan, capped by the replans left.
    const failedAfter = review({ ...g("g-failed"), approvedRevision: 0, replansLeft: 0, revisionsLeft: 3 });
    expect(enabled(failedAfter, "No planning runs left")).toBe(false);
  });

  it("caps: the editor refuses a title past the byte limit, counted in UTF-8 so Turkish letters count double", () => {
    const goal = g("g-review");
    const tiles = goal.tasks.filter((x) => x.revision === Math.max(...goal.revisions.map((r) => r.revision)));
    // "ğ" is two bytes: half the limit in letters already passes it.
    const long = { ...tiles[1]!, title: "ğ".repeat(Math.ceil(GOAL_LIMITS.titleBytes / 2) + 1) };
    const html = render(createElement(TaskEditor, { goal, tile: long, tiles, onSaved: () => undefined, onClose: () => undefined }));
    expect(text(html)).toContain(String(GOAL_LIMITS.titleBytes));
    expect(html).toContain('aria-invalid="true"');
    expect(enabled(html, "Save")).toBe(false);
    const fine = render(createElement(TaskEditor, { goal, tile: { ...tiles[1]!, title: "Sunucu: geçiş anahtarı" }, tiles, onSaved: () => undefined, onClose: () => undefined }));
    expect(enabled(fine, "Save")).toBe(true);
  });

  it("offline: the last state with every action disabled", () => {
    const html = review(g("g-review"), true);
    expect(text(html)).toContain("The daemon is not running");
    expect(enabled(html, "Approve and start")).toBe(false);
    expect(enabled(html, "Run side by side anyway")).toBe(false);
  });

  it("untrusted plan text stays plain text, never markup", () => {
    const goal = g("g-review");
    const hostile = { ...goal, tasks: goal.tasks.map((x, i) => (i === 0 ? { ...x, title: '<img src=x onerror="alert(1)">', reason: "<b>bold</b>" } : x)) };
    const html = review(hostile);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>bold");
    expect(html).toContain("&lt;img");
  });

  it("reads naturally in Turkish, with its provenance words", async () => {
    await i18n.changeLanguage("tr");
    const t = text(review(g("g-unknown")));
    expect(t).toContain("Maliyet bilinmiyor: bu görev için bir bütçe yazın");
    expect(t).toMatch(/Bilinmiyor/);
    expect(t).toContain("Onayla ve 4 görevi başlat");
    // Harmony that does not depend on the plan number: "02 görevinin raporu", never "02 da".
    const r = text(review(g("g-review")));
    expect(r).toContain("01 görevinin raporu 02 ve 03 görevlerine girdi olur");
  });
});

describe("cost words", () => {
  function costs(): ReturnType<typeof useCostText> {
    let out: ReturnType<typeof useCostText> | null = null;
    const Probe = () => {
      out = useCostText();
      return null;
    };
    render(createElement(Probe));
    return out!;
  }

  it("states a planning run as ~$x Estimated with its ceiling, a sign-in or local model as $0 Estimated, and Unknown without a price", () => {
    const c = costs();
    expect(c.planning({ estimate: { usd: 0.36, provenance: "estimated" }, billing: "api", ceilingUsd: 1.08 })).toEqual({ cost: "~$0.36 Estimated", ceiling: "$1.08" });
    expect(c.planning({ estimate: { usd: 0, provenance: "estimated" }, billing: "plan", ceilingUsd: 0.25 })).toEqual({ cost: "plan sign-in, $0.00 Estimated", ceiling: null });
    expect(c.planning({ estimate: { usd: 0, provenance: "estimated" }, billing: "local", ceilingUsd: 0.25 }).cost).toBe("local model, $0.00 Estimated");
    expect(c.planning({ estimate: { usd: null, provenance: "unknown" }, billing: "api", ceilingUsd: 0.25 })).toEqual({ cost: "cost Unknown", ceiling: "$0.25" });
  });

  it("never sums Unknown into a total", () => {
    const c = costs();
    expect(c.total(1.61, 1)).toBe("$1.61 Estimated + 1 task Unknown");
    expect(c.total(0, 2)).toBe("2 tasks, cost Unknown");
    expect(c.total(1.78, 0)).toBe("$1.78 Estimated");
  });
});
