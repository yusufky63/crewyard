import { describe, expect, it } from "vitest";
import { GOAL_LIMITS, type GoalTaskView } from "@crewyard/core";
import { cost, goalDetail, goalTask, revision } from "./goalTestData.ts";
import {
  acceptWithPrerequisites,
  approvalCheck,
  approveKeyApplies,
  approveParams,
  diffLines,
  diffMark,
  heldShares,
  keptTasks,
  modeToRemember,
  openingMode,
  overlapLines,
  planSteps,
  planTiles,
  planTotals,
  reportFeeds,
  joinList,
  showsPlanReview,
  skipWithDependents,
  soloAction,
  splitLines,
  submitMode,
  typedUsd,
  waitsForLoop,
} from "./goalsModel.ts";

const LIMITS = { min: GOAL_LIMITS.maxParallelMin, max: GOAL_LIMITS.maxParallelMax };

/** The design's passkeys plan: 01 research feeds 02 and 03; 03 waits for 02 on the same files; 04 docs waits for 02. */
function plan(): GoalTaskView[] {
  const base = { accepted: null, released: false, status: "proposed" as const, shareUsd: null, spend: cost(0) };
  return [
    goalTask(1, { ...base, title: "Compare WebAuthn libraries", kind: "research", mode: "solo", writes: false, paths: [], estimate: cost(0.08) }),
    goalTask(2, { ...base, title: "Server: passkey registration and login", paths: ["src/auth/**"], estimate: cost(0.92), dependsOn: [{ taskId: "t1", key: "k1", source: "plan" }] }),
    goalTask(3, {
      ...base,
      title: "Client: passkey button and flow",
      paths: ["src/auth/client.ts"],
      estimate: cost(0.61),
      dependsOn: [
        { taskId: "t1", key: "k1", source: "plan" },
        { taskId: "t2", key: "k2", source: "overlap" },
      ],
    }),
    goalTask(4, { ...base, title: "Docs: passkeys guide", kind: "docs", mode: "solo", paths: ["docs/passkeys.md"], estimate: cost(0.06), dependsOn: [{ taskId: "t2", key: "k2", source: "plan" }] }),
  ];
}
const all = (tiles: GoalTaskView[]) => new Set(tiles.map((t) => t.key));
const review = { estimate: cost(0.17) };

describe("composer mode", () => {
  it("opens on Orchestra where a profile can plan, on Crew where none can, and on Crew when you last submitted as Crew", () => {
    expect(openingMode(null, true)).toBe("orchestra");
    expect(openingMode("orchestra", true)).toBe("orchestra");
    expect(openingMode("crew", true)).toBe("crew");
    expect(openingMode(null, false)).toBe("crew");
    expect(openingMode("orchestra", false)).toBe("crew");
    // While goals.preview is on its way the control shows the likely mode; Plan goal waits for the answer.
    expect(openingMode(null, null)).toBe("orchestra");
  });

  it("never remembers Solo, so a later Ctrl Enter never starts a paid run you did not pick this time", () => {
    expect(modeToRemember("solo")).toBeNull();
    expect(modeToRemember("crew")).toBe("crew");
    expect(modeToRemember("orchestra")).toBe("orchestra");
    // Solo leaves nothing behind, so the next opening falls back to what was kept before.
    expect(openingMode(modeToRemember("solo") ?? "crew", true)).toBe("crew");
  });

  it("sends ready-made analyses and imported issues to one Crew task, never to the planner and never started by Solo", () => {
    expect(submitMode("orchestra", "preset")).toBe("crew");
    expect(submitMode("orchestra", "issue")).toBe("crew");
    expect(submitMode("orchestra", null)).toBe("orchestra");
    // An issue's text comes from the web: it is proposed for you to read, not started on the same click.
    expect(submitMode("solo", "issue")).toBe("crew");
    expect(submitMode("solo", "preset")).toBe("crew");
    expect(submitMode("solo", null)).toBe("solo");
    expect(submitMode("crew", "preset")).toBe("crew");
  });

  it("turns Solo's Start into Propose when the estimate is Unknown or a cap would hold the step", () => {
    expect(soloAction(undefined)).toBeNull();
    expect(soloAction({ estimate: cost(0.12) })).toBe("start");
    expect(soloAction({ estimate: cost(null, "unknown") })).toBe("propose");
    expect(soloAction({ estimate: cost(0.12), hold: { code: "over_cap", params: { cap: "task_budget" } } })).toBe("propose");
  });
});

describe("plan review", () => {
  it("shows the latest revision's tasks in plan order, and only before the first approval", () => {
    const g = goalDetail({
      approvedRevision: null,
      revisions: [revision({ revision: 1, state: "superseded" }), revision({ id: "r2", revision: 2, state: "ready", approvedAt: null })],
      tasks: [goalTask(2, { revision: 2 }), goalTask(1, { revision: 2 }), goalTask(3, { revision: 1 }), goalTask(4, { revision: 2, discarded: true })],
    });
    expect(planTiles(g).map((t) => t.key)).toEqual(["k1", "k2"]);
    expect(showsPlanReview(g)).toBe(true);
    expect(showsPlanReview({ ...g, approvedRevision: 1 })).toBe(false);
    expect(showsPlanReview({ ...g, collapsedTaskId: "t9" })).toBe(false);
    expect(showsPlanReview({ ...g, status: "stopped" })).toBe(false);
  });

  it("groups tasks into steps by their longest path from a root, overlap orderings included", () => {
    expect(planSteps(plan()).map((s) => s.map((t) => t.key))).toEqual([["k1"], ["k2"], ["k3", "k4"]]);
  });

  it("skipping a task also skips what builds on it, but not a task that only shares its files", () => {
    const tiles = plan();
    expect(skipWithDependents(tiles, new Set(), "k2")).toEqual(["k2", "k4"]);
    // 03 waits for 02 only through the overlap ordering; it still has its own work to do.
    expect(skipWithDependents(tiles, new Set(), "k1")).toEqual(["k1", "k2", "k3", "k4"]);
    // Already skipped tasks are not named again in the "also skipped" line.
    expect(skipWithDependents(tiles, new Set(["k4"]), "k2")).toEqual(["k2"]);
  });

  it("ticking a task again ticks what it builds on, never leaving a task waiting for a skipped one", () => {
    const tiles = plan();
    const skipped = new Set(["k1", "k2", "k3", "k4"]);
    const after = acceptWithPrerequisites(tiles, skipped, "k4");
    expect([...after].sort()).toEqual(["k3"]);
  });

  it("sums known estimates and the last review, never adds Unknown into a number, and counts typed budgets apart", () => {
    const tiles = plan();
    expect(planTotals(tiles, all(tiles), {}, review)).toEqual({ knownUsd: 1.84, unknown: 0, untyped: 0, typedUsd: 0, count: 4, reviewIncluded: true });
    const withUnknown = tiles.map((t) => (t.key === "k3" ? { ...t, estimate: cost(null, "unknown") } : t));
    expect(planTotals(withUnknown, all(tiles), {}, review)).toMatchObject({ knownUsd: 1.23, unknown: 1, untyped: 1, typedUsd: 0 });
    expect(planTotals(withUnknown, all(tiles), { k3: "0,75" }, review)).toMatchObject({ knownUsd: 1.23, unknown: 1, untyped: 0, typedUsd: 0.75 });
    // A plan that writes nothing has no last review.
    const research = [tiles[0]!];
    expect(planTotals(research, all(research), {}, review)).toMatchObject({ knownUsd: 0.08, reviewIncluded: false });
  });

  it("disables Approve with its reason when the budget does not cover the known total, as goals.approve would refuse", () => {
    const tiles = plan();
    const over = approvalCheck(tiles, all(tiles), "1.50", {}, review, 2, LIMITS);
    expect(over).toEqual({ ok: false, block: { code: "over_budget", totalUsd: 1.84, budgetUsd: 1.5 } });
    const ok = approvalCheck(tiles, all(tiles), "3", {}, review, 2, LIMITS);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const sum = Object.values(ok.shares).reduce((a, b) => a + b, 0);
      expect(sum).toBeLessThanOrEqual(3);
      expect(Object.keys(ok.shares).sort()).toEqual(["k1", "k2", "k3", "k4", "review"]);
    }
  });

  it("needs a typed budget on a task whose estimate is Unknown, and takes one only there", () => {
    const tiles = plan().map((t) => (t.key === "k4" ? { ...t, estimate: cost(null, "unknown") } : t));
    expect(approvalCheck(tiles, all(tiles), "3", {}, review, 2, LIMITS)).toEqual({ ok: false, block: { code: "needs_budget", task: "04" } });
    expect(approvalCheck(tiles, all(tiles), "3", { k4: "abc" }, review, 2, LIMITS)).toEqual({ ok: false, block: { code: "bad_task_budget", task: "04" } });
    expect(approvalCheck(tiles, all(tiles), "3", { k4: "0.5" }, review, 2, LIMITS).ok).toBe(true);
    expect(approvalCheck(tiles, all(tiles), "1", { k4: "1.5" }, review, 2, LIMITS)).toEqual({ ok: false, block: { code: "typed_over", typedUsd: 1.5, budgetUsd: 1 } });
    // A budget typed on a known estimate is not sent; the split prices it by its estimate.
    expect(approveParams(tiles, all(tiles), { k4: "0.5", k2: "9" }, review)).toEqual({ accept: ["k1", "k2", "k3", "k4"], taskBudgets: { k4: 0.5 } });
  });

  it("needs a typed budget for the last review when it cannot be priced", () => {
    const tiles = plan();
    const unpriced = { estimate: cost(null, "unknown") };
    expect(approvalCheck(tiles, all(tiles), "3", {}, unpriced, 2, LIMITS)).toEqual({ ok: false, block: { code: "needs_budget", task: "review" } });
    expect(approveParams(tiles, all(tiles), { review: "0.4" }, unpriced).taskBudgets).toEqual({ review: 0.4 });
  });

  it("refuses an approval with no accepted task, an accepted task waiting for a skipped one, or At once out of bounds", () => {
    const tiles = plan();
    expect(approvalCheck(tiles, new Set(), "3", {}, review, 2, LIMITS)).toEqual({ ok: false, block: { code: "none_accepted" } });
    expect(approvalCheck(tiles, new Set(["k2", "k3", "k4"]), "3", {}, review, 2, LIMITS)).toEqual({ ok: false, block: { code: "skipped_dependency", task: "02", dependsOn: "01" } });
    expect(approvalCheck(tiles, all(tiles), "3", {}, review, 0, LIMITS)).toEqual({ ok: false, block: { code: "at_once" } });
    expect(approvalCheck(tiles, all(tiles), "3", {}, review, GOAL_LIMITS.maxParallelMax + 1, LIMITS)).toEqual({ ok: false, block: { code: "at_once" } });
    expect(approvalCheck(tiles, all(tiles), "", {}, review, 2, LIMITS)).toEqual({ ok: false, block: { code: "bad_budget" } });
    expect(approvalCheck(tiles, all(tiles), "-2", {}, review, 2, LIMITS)).toEqual({ ok: false, block: { code: "bad_budget" } });
  });

  it("explains each automatic ordering with the overlapping paths, and drops the line when either task is skipped", () => {
    const tiles = plan();
    const rev = revision({ overlaps: [{ taskId: "t3", dependsOn: "t2", cause: "paths", paths: ["src/auth/client.ts", "src/auth/**"] }] });
    expect(overlapLines(rev, tiles, all(tiles))).toEqual([{ taskKey: "k3", afterKey: "k2", task: "03", after: "02", cause: "paths", paths: "src/auth/client.ts" }]);
    expect(overlapLines(rev, tiles, new Set(["k1", "k3"]))).toEqual([]);
    // A writing task with no planned files runs after the other writers; the line says so.
    const nopaths = tiles.map((t) => (t.key === "k3" ? { ...t, paths: [] } : t));
    expect(overlapLines(revision({ overlaps: [] }), nopaths, all(tiles))[0]).toMatchObject({ cause: "no_paths", paths: null });
  });

  it("names the writing tasks a report feeds, so you know you accept it before they start", () => {
    const tiles = plan();
    expect(reportFeeds(tiles, all(tiles))).toEqual([{ from: "01", to: ["02", "03"] }]);
    expect(reportFeeds(tiles, new Set(["k1"]))).toEqual([]);
  });

  it("lists task numbers as a sentence does in each language, never as a chain of ands", () => {
    expect(joinList(["02"], "en")).toBe("02");
    expect(joinList(["02", "03"], "en")).toBe("02 and 03");
    expect(joinList(["02", "03", "04"], "en")).toBe("02, 03, and 04");
    expect(joinList(["02", "03", "04"], "tr")).toBe("02, 03 ve 04");
    expect(joinList(["02", "03"], "not a tag")).toBe("02 and 03");
  });

  it("shows a revise as added, changed and removed, naming removed tasks by their earlier title and never by key", () => {
    const tiles = plan();
    const rev = revision({ revision: 2, diff: { added: ["k4"], changed: ["k3"], removed: ["old-docs"], kept: ["k1", "k2"] } });
    // Before approval the earlier revision's tasks are not in the goal, so a removed one is only counted.
    expect(diffLines(rev, tiles)).toEqual({ added: ["04"], changed: ["03"], removed: [], removedUnnamed: 1 });
    // After an approval (a replan), the earlier task is there and names itself.
    const earlier = [goalTask(6, { key: "old-docs", revision: 1, title: "Belgeler: eski kılavuz" }), goalTask(7, { key: "old-docs", revision: 3, title: "later" })];
    expect(diffLines(rev, tiles, earlier)).toEqual({ added: ["04"], changed: ["03"], removed: ["Belgeler: eski kılavuz"], removedUnnamed: 0 });
    expect(diffMark(rev, "k3")).toBe("changed");
    expect(diffMark(rev, "k4")).toBe("added");
    expect(diffMark(rev, "k1")).toBeNull();
    expect(diffLines(revision({ diff: { added: [], changed: [], removed: [], kept: ["k1"] } }), tiles)).toBeNull();
  });

  it("a replan counts the shares kept tasks and the last review already hold, as goals.approve does", () => {
    // Goal budget $3 split at the first approval: two kept tasks hold $1.40 and $1.20, the review $0.30.
    const first = [
      goalTask(1, { revision: 1, shareUsd: 1.4, status: "done" }),
      goalTask(2, { revision: 1, shareUsd: 1.2, status: "running" }),
      goalTask(3, { revision: 1, shareUsd: 0.4, status: "proposed", released: false }),
    ];
    const added = goalTask(4, { revision: 2, accepted: null, released: false, status: "proposed", shareUsd: null, estimate: cost(2) });
    const rebuilt = goalTask(5, { key: "k3", revision: 2, accepted: null, released: false, status: "proposed", shareUsd: null, estimate: cost(0.3) });
    const goal = goalDetail({
      approvedRevision: 1,
      budgetUsd: 3,
      tasks: [...first, added, rebuilt, goalTask(9, { revision: 1, accepted: false, shareUsd: 0.9 }), goalTask(8, { revision: 1, shareUsd: 0.5, status: "cancelled" })],
      revisions: [revision({ revision: 1 }), revision({ id: "r2", revision: 2, cause: "replan", state: "ready", approvedAt: null, diff: { added: ["k4"], changed: ["k3"], removed: [], kept: ["k1", "k2"] } })],
    });
    const tiles = planTiles(goal);
    const kept = keptTasks(goal);
    // k3 is rebuilt by the replan, k9 was skipped, k8 is cancelled: only 01 and 02 keep their shares.
    expect(kept.map((t) => t.key)).toEqual(["k1", "k2"]);
    const held = { estimate: cost(0.17), shareUsd: 0.3 };
    expect(heldShares(kept, held)).toBe(2.9);
    // The tiles alone fit in $3; with the held $2.90 the daemon refuses, so Approve says so first.
    expect(approvalCheck(tiles, all(tiles), "3", {}, held, 2, LIMITS).ok).toBe(true);
    expect(approvalCheck(tiles, all(tiles), "3", {}, held, 2, LIMITS, { kept })).toEqual({ ok: false, block: { code: "over_budget", totalUsd: 5.2, budgetUsd: 3 } });
    // Raised to $6, the new tasks split what is left: $6 - $2.90 = $3.10 over $2.30 estimated.
    const ok = approvalCheck(tiles, all(tiles), "6", {}, held, 2, LIMITS, { kept });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.shares.k1).toBe(1.4);
      expect(ok.shares.review).toBe(0.3);
      expect(ok.shares.k4).toBeCloseTo(2.6956, 3);
      expect(Object.values(ok.shares).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(6);
    }
    // An Add task revision replaces nothing: every accepted live task of earlier revisions stays.
    const add = { ...goal, revisions: [goal.revisions[0]!, { ...goal.revisions[1]!, cause: "add" as const, diff: null }] };
    expect(keptTasks(add).map((t) => t.key)).toEqual(["k1", "k2", "k3"]);
    // Before any approval nothing is kept.
    expect(keptTasks({ ...goal, approvedRevision: null })).toEqual([]);
  });

  it("counts kept tasks against the goal's task limit, and a kept task waiting for a skipped rebuilt one", () => {
    const tiles = plan();
    const kept = [goalTask(7, { key: "k7", shareUsd: 0.2, dependsOn: [{ taskId: "t2", key: "k2", source: "plan" }] })];
    expect(approvalCheck(tiles, all(tiles), "9", {}, review, 2, LIMITS, { kept, maxTasks: 4 })).toEqual({ ok: false, block: { code: "too_many", max: 4 } });
    expect(approvalCheck(tiles, all(tiles), "9", {}, review, 2, LIMITS, { kept, maxTasks: 5 }).ok).toBe(true);
    // 07 was approved earlier and waits for 02; skipping the rebuilt 02 would leave it waiting forever.
    expect(approvalCheck(tiles, new Set(["k1", "k3"]), "9", {}, review, 2, LIMITS, { kept })).toMatchObject({ ok: false, block: { code: "skipped_dependency" } });
  });

  it("approves a plan of one task with an Unknown estimate on the goal budget alone, with no last review", () => {
    const one = [goalTask(1, { estimate: cost(null, "unknown"), accepted: null, shareUsd: null })];
    // As a goal task it would need a typed budget; as one task the goal budget is its budget.
    expect(approvalCheck(one, all(one), "3", {}, review, 2, LIMITS)).toEqual({ ok: false, block: { code: "needs_budget", task: "01" } });
    expect(approvalCheck(one, all(one), "3", {}, review, 2, LIMITS, { oneTask: true })).toEqual({ ok: true, shares: { k1: 3 } });
    // A known estimate past the goal budget still says so before the click.
    const dear = [goalTask(1, { estimate: cost(4.5), accepted: null })];
    expect(approvalCheck(dear, all(dear), "3", {}, review, 2, LIMITS, { oneTask: true })).toEqual({ ok: false, block: { code: "over_budget", totalUsd: 4.5, budgetUsd: 3 } });
    expect(approvalCheck(one, all(one), "", {}, null, 2, LIMITS, { oneTask: true })).toEqual({ ok: false, block: { code: "bad_budget" } });
  });

  it("never approves on Ctrl Enter from the task editor or the Revise note, while the editor is open, or while a goal call is pending", () => {
    const at = (inside: string | null) => ({ closest: (sel: string) => (inside && sel.split(",").map((x) => x.trim()).includes(inside) ? {} : null) });
    expect(approveKeyApplies(at(null), { editing: false, pending: false })).toBe(true);
    expect(approveKeyApplies(null, { editing: false, pending: false })).toBe(true);
    expect(approveKeyApplies(at(".gp-editor"), { editing: false, pending: false })).toBe(false);
    expect(approveKeyApplies(at(".gp-revise"), { editing: false, pending: false })).toBe(false);
    expect(approveKeyApplies(at(null), { editing: true, pending: false })).toBe(false);
    expect(approveKeyApplies(at(null), { editing: false, pending: true })).toBe(false);
  });

  it("names the loop a new Waits for would close, as the Crew graph does", () => {
    const tiles = plan();
    expect(waitsForLoop(tiles, "k1", "k3")).toBe("01 → 03 → 01");
    expect(waitsForLoop(tiles, "k4", "k3")).toBeNull();
    expect(waitsForLoop(tiles, "k2", "k2")).toBe("02 → 02");
  });

  it("reads typed amounts with a dot or a Turkish comma, and splits acceptance lines", () => {
    expect(typedUsd("1,5")).toBe(1.5);
    expect(typedUsd(" 2 ")).toBe(2);
    expect(typedUsd("")).toBeNull();
    expect(typedUsd("0")).toBeNull();
    expect(splitLines("  Giriş çalışır \r\n\n Şifre sıfırlanır ")).toEqual(["Giriş çalışır", "Şifre sıfırlanır"]);
  });
});
