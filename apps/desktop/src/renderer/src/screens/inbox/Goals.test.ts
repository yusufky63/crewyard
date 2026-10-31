import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import type { GoalSummary, TaskDetail } from "@crewyard/core";
import { initI18n } from "../../i18n.ts";
import { decision, goalDetail } from "../tasks/goalTestData.ts";
import { GoalList, useGoalTaskLabel } from "./Goals.tsx";

// The Inbox's goal list and goal labels (design §3.6), rendered to static markup with real
// translations: goal decisions are their own list, and a goal task's request names its goal.

const i18n = initI18n("en");

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

function render(node: ReactNode, seed?: (qc: QueryClient) => void): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(qc);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const summary = (id: string, over: Partial<GoalSummary>): GoalSummary => {
  const { text: _t, baseBranch: _b, baseSha: _s, maxParallel: _m, maxTasks: _x, plannerProfileId: _p, revisions: _r, tasks: _k, decisions: _d, joins: _j, revisionsLeft: _rl, replansLeft: _pl, integration: _i, stuck: _st, suggestedBudgetUsd: _sb, ...s } = goalDetail();
  return { ...s, id, ...over };
};

describe("GoalList", () => {
  it("lists only goals that need you, with their open decisions and the goal view's buttons", () => {
    const halted = goalDetail({ id: "g1", status: "needs_you", reason: "halted", title: "Geçiş anahtarları", decisions: [decision({ payload: { rule: "same_failure" } }), decision({ id: "old", answeredAt: "x", answer: "resume" })] });
    const html = render(createElement(GoalList, { projectId: "p1" }), (qc) => {
      qc.setQueryData(["goals.list", { projectId: "p1" }], [summary("g1", { status: "needs_you", reason: "halted", title: "Geçiş anahtarları" }), summary("g2", { status: "running", title: "Running goal" })]);
      qc.setQueryData(["goals.get", { goalId: "g1" }], halted);
    });
    const t = text(html);
    expect(t).toContain("Goals · 1");
    expect(t).toContain("Geçiş anahtarları");
    expect(t).toContain("Needs you · Halted");
    expect(t).toContain("Halted: two tasks failed the same way");
    expect(t).toContain("Resume");
    expect(t).toContain("Stop goal…");
    expect(t).toContain("Open goal");
    // Only the open decision shows, and a running goal is not in the Inbox.
    expect(t.match(/Halted: two tasks/g)?.length).toBe(1);
    expect(t).not.toContain("Running goal");
  });

  it("draws nothing when no goal needs you, or when the answer is not a list", () => {
    expect(render(createElement(GoalList, { projectId: "p1" }), (qc) => qc.setQueryData(["goals.list", { projectId: "p1" }], [summary("g2", { status: "running" })]))).toBe("");
    expect(render(createElement(GoalList, { projectId: "p1" }), (qc) => qc.setQueryData(["goals.list", { projectId: "p1" }], { id: "t1" }))).toBe("");
  });
});

function Label({ task }: { task: Pick<TaskDetail, "title" | "goal"> }) {
  return createElement("span", null, useGoalTaskLabel(task));
}

describe("useGoalTaskLabel", () => {
  const ref = { goalId: "g1", key: "k2", number: 2, waiting: false, hold: null, joined: false, hidden: false };

  it("names a goal task's request with its goal and number", () => {
    const html = render(createElement(Label, { task: { title: "Sunucu", goal: ref } }), (qc) => qc.setQueryData(["goals.get", { goalId: "g1" }], goalDetail({ id: "g1", title: "Geçiş anahtarları" })));
    expect(text(html).trim()).toBe("Geçiş anahtarları · 02 Sunucu");
  });

  it("keeps the task's own title without a goal, or until the goal is read", () => {
    expect(text(render(createElement(Label, { task: { title: "Sunucu", goal: null } }))).trim()).toBe("Sunucu");
    expect(text(render(createElement(Label, { task: { title: "Sunucu", goal: ref } }))).trim()).toBe("Sunucu");
  });
});
