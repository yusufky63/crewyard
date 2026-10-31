import { describe, expect, it } from "vitest";
import {
  GOAL_DECISION_ACTIONS,
  GOAL_LIMITS,
  applyPlanRevision,
  clampMaxTasks,
  defaultGoalBudget,
  derivePlanState,
  deriveGoalStatus,
  frozenBecause,
  globBase,
  goalBasisMatches,
  goalDependents,
  goalReportExcerpt,
  goalStopRule,
  goalTitle,
  layers,
  overlapPairs,
  parseGoalLimits,
  parseGoalNote,
  parseGoalPlan,
  parseGoalTask,
  parseGoalText,
  pathsOverlap,
  planRevisionRefusal,
  plannedPathError,
  planningBudget,
  prerequisiteHold,
  readySet,
  releaseRoom,
  rescaleShares,
  skippedDependency,
  splitBudget,
  unmetPrerequisites,
  wouldCycle,
  type GoalPlan,
  type GoalPlanTask,
  type GoalStatusFacts,
  type GoalTaskFacts,
  type OverlapTask,
} from "./goals.ts";
import { GOAL_PLAN_OUTPUT } from "./results.ts";

// Orchestra's pure rules (docs/adr/0019): the plan's checks, the task graph, the overlap ordering,
// the budget split, revisions, the stop rule and the derived goal status.

const task = (key: string, over: Partial<GoalPlanTask> = {}): GoalPlanTask => ({
  key,
  title: `Task ${key}`,
  kind: "code",
  mode: "crew",
  size: "M",
  description: "Do the work.",
  acceptance: ["It works"],
  basis: "add passkey sign-in",
  dependsOn: [],
  paths: [`src/${key}/`],
  reason: "The goal needs it.",
  priority: "medium",
  ...over,
});

const plan = (...tasks: GoalPlanTask[]): GoalPlan => ({ summary: "Server first, then client, then docs.", tasks });

const refusal = (value: unknown, opts?: { maxTasks?: number }) => {
  const r = parseGoalPlan(value, opts);
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};

describe("parseGoalPlan (design §4.3)", () => {
  it("accepts a valid plan and cleans its text", () => {
    const r = parseGoalPlan({
      summary: "  Plan\r\nwith\u0007 steps ",
      tasks: [task("server"), task("client", { dependsOn: ["server", "server"], reason: "Needs\n  the server", paths: ["src/Client/", "src/client/"] })],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.summary).toBe("Plan\nwith steps");
    expect(r.value.tasks[1]).toMatchObject({ dependsOn: ["server"], reason: "Needs the server", paths: ["src/Client/"] });
  });

  it("refuses unknown fields at both levels and anything that is not an object", () => {
    expect(refusal({ ...plan(task("a")), extra: 1 })).toBe('the plan has an unknown field "extra"');
    expect(refusal(plan({ ...task("a"), spawn: true } as GoalPlanTask))).toBe('tasks[0] has an unknown field "spawn"');
    expect(refusal(null)).toBe("the plan must be an object");
    expect(refusal([])).toBe("the plan must be an object");
    expect(refusal({ summary: "", tasks: "a" })).toBe("tasks must be an array");
    expect(refusal({ summary: "", tasks: [5] })).toBe("tasks[0] must be an object");
  });

  it("holds the task count to 1 through the goal's limit, 8 by default and never past 12", () => {
    expect(refusal(plan())).toContain("at least 1");
    const nine = Array.from({ length: 9 }, (_, i) => task(`t${i}`, { kind: "research", paths: [] }));
    const r = parseGoalPlan(plan(...nine));
    expect(r).toEqual({ ok: false, error: "the plan has 9 tasks; the limit is 8", code: "too_many_tasks", count: 9, limit: 8 });
    expect(parseGoalPlan(plan(...nine), { maxTasks: 12 }).ok).toBe(true);
    const thirteen = Array.from({ length: 13 }, (_, i) => task(`t${i}`, { kind: "research", paths: [] }));
    expect(parseGoalPlan(plan(...thirteen), { maxTasks: 50 })).toMatchObject({ ok: false, code: "too_many_tasks", limit: 12 });
    expect(GOAL_LIMITS.maxTasksHard).toBe(12);
    expect(clampMaxTasks(0)).toBe(1);
    expect(clampMaxTasks(undefined)).toBe(8);
    expect(clampMaxTasks(Number.NaN)).toBe(8);
  });

  it("checks keys: pattern, length and uniqueness", () => {
    expect(refusal(plan(task("Server")))).toContain("lowercase letters");
    expect(refusal(plan(task("a".repeat(17))))).toContain("1 to 16");
    expect(refusal(plan(task("a"), task("a")))).toBe('tasks[1].key "a" is used twice');
    expect(parseGoalPlan(plan(task("a".repeat(16)), task("x-1"))).ok).toBe(true);
  });

  it("makes a DAG by construction: dependencies only on keys listed earlier", () => {
    expect(refusal(plan(task("a", { dependsOn: ["a"] })))).toBe('tasks[0] ("a") must not depend on itself');
    expect(refusal(plan(task("a", { dependsOn: ["b"] }), task("b")))).toContain("not a task listed before it");
    expect(refusal(plan(task("a", { dependsOn: ["ghost"] })))).toContain('"ghost"');
    expect(refusal(plan(task("a", { dependsOn: [3 as unknown as string] })))).toContain("array of keys");
  });

  it("refuses text past its cap rather than cutting it, counting bytes (Turkish letters are two)", () => {
    expect(refusal(plan(task("a", { title: "ş".repeat(61) })))).toBe("tasks[0].title is 122 bytes; the limit is 120");
    expect(parseGoalPlan(plan(task("a", { title: "ş".repeat(60) }))).ok).toBe(true);
    expect(refusal(plan(task("a", { title: "two\nlines" })))).toBe("tasks[0].title must be one line");
    expect(refusal(plan(task("a", { title: "   " })))).toBe("tasks[0].title must not be empty");
    expect(refusal(plan(task("a", { description: "x".repeat(4_001) })))).toContain("4001 bytes; the limit is 4000");
    expect(refusal(plan(task("a", { basis: "b".repeat(301) })))).toContain("basis is 301 bytes");
    expect(refusal(plan(task("a", { reason: "r".repeat(301) })))).toContain("reason is 301 bytes");
    expect(refusal(plan(task("a", { reason: "" })))).toBe("tasks[0].reason must not be empty");
    expect(refusal({ summary: "s".repeat(601), tasks: [task("a")] })).toBe("summary is 601 bytes; the limit is 600");
    expect(refusal({ tasks: [task("a")] })).toBe("summary is required");
    expect(refusal(plan(task("a", { title: 5 as unknown as string })))).toBe("tasks[0].title must be a string");
  });

  it("checks acceptance: 1 to 12 single lines of at most 300 bytes, blanks and repeats dropped", () => {
    expect(refusal(plan(task("a", { acceptance: [] })))).toContain("at least 1");
    expect(refusal(plan(task("a", { acceptance: ["", "  "] })))).toContain("at least 1");
    expect(refusal(plan(task("a", { acceptance: Array.from({ length: 13 }, (_, i) => `c${i}`) })))).toContain("13 lines; the limit is 12");
    expect(refusal(plan(task("a", { acceptance: ["c".repeat(301)] })))).toContain("301 bytes; the limit is 300");
    expect(refusal(plan(task("a", { acceptance: ["one\ntwo"] })))).toContain("must be one line");
    const r = parseGoalPlan(plan(task("a", { acceptance: ["Works", "", "Works", "Giriş çalışıyor"] })));
    expect(r.ok && r.value.tasks[0]!.acceptance).toEqual(["Works", "Giriş çalışıyor"]);
  });

  it("checks enums", () => {
    expect(refusal(plan(task("a", { kind: "deploy" as GoalPlanTask["kind"] })))).toContain("kind must be one of");
    expect(refusal(plan(task("a", { mode: "swarm" as GoalPlanTask["mode"] })))).toContain("mode must be one of");
    expect(refusal(plan(task("a", { size: "XL" as GoalPlanTask["size"] })))).toContain("size must be one of");
    expect(refusal(plan(task("a", { priority: "urgent" as GoalPlanTask["priority"] })))).toContain("priority must be one of");
  });

  it("needs at least one planned path for code and docs tasks, none for research and review, at most 20", () => {
    expect(refusal(plan(task("a", { kind: "code", paths: [] })))).toContain("at least one path for a code task");
    expect(refusal(plan(task("a", { kind: "docs", paths: [] })))).toContain("at least one path for a docs task");
    expect(parseGoalPlan(plan(task("a", { kind: "research", paths: [] }), task("b", { kind: "review", paths: [] }))).ok).toBe(true);
    expect(refusal(plan(task("a", { paths: Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`) })))).toContain("21 paths; the limit is 20");
  });

  it("refuses paths that could name a place outside the repository, and accepts spaces and globs", () => {
    expect(plannedPathError("docs/user guide/intro.md")).toBeNull();
    expect(plannedPathError("src/**/*.ts")).toBeNull();
    expect(plannedPathError("src/auth/")).toBeNull();
    expect(plannedPathError("src/a?.ts")).toBeNull();
    expect(plannedPathError("belgeler/kullanım kılavuzu.md")).toBeNull();
    expect(plannedPathError("src\\auth\\session.ts")).toContain("forward slashes");
    expect(plannedPathError("/etc/passwd")).toContain("not absolute");
    expect(plannedPathError("//server/share/x")).toContain("not absolute");
    expect(plannedPathError("C:/Users/x")).toContain(":");
    expect(plannedPathError("notes.txt:secret")).toContain(":");
    expect(plannedPathError("../outside")).toContain('".."');
    expect(plannedPathError("src/../../x")).toContain('".."');
    expect(plannedPathError("./src")).toContain('"."');
    expect(plannedPathError("src//a.ts")).toContain("empty part");
    expect(plannedPathError("con")).toContain("device");
    expect(plannedPathError("src/NUL.txt")).toContain("device");
    expect(plannedPathError("src/com1")).toContain("device");
    expect(plannedPathError("src/[ab].ts")).toContain("wildcards");
    expect(plannedPathError("src/{a,b}.ts")).toContain("wildcards");
    expect(plannedPathError("!src/a.ts")).toContain("wildcards");
    expect(plannedPathError("a\tb")).toContain("one line");
    expect(plannedPathError("")).toContain("empty");
    expect(plannedPathError(`src/${"x".repeat(197)}`)).toContain("201 bytes; the limit is 200");
    expect(refusal(plan(task("a", { paths: ["../x"] })))).toContain("tasks[0].paths:");
    expect(refusal(plan(task("a", { paths: [7 as unknown as string] })))).toContain("array of strings");
  });

  it("matches the strict, simple structured-output schema: every field required, no bounds", () => {
    const valid = plan(task("server"), task("client", { dependsOn: ["server"] }));
    expect(GOAL_PLAN_OUTPUT.check(valid)).toBeNull();
    expect(GOAL_PLAN_OUTPUT.check({ ...valid, extra: 1 })).not.toBeNull();
    const schema = GOAL_PLAN_OUTPUT.jsonSchema as { required: string[]; properties: { tasks: { items: { required: string[]; properties: object; additionalProperties: boolean } } } };
    expect(schema.required.sort()).toEqual(["summary", "tasks"]);
    const item = schema.properties.tasks.items;
    expect(item.required.sort()).toEqual(Object.keys(item.properties).sort());
    expect(item.additionalProperties).toBe(false);
    const json = JSON.stringify(GOAL_PLAN_OUTPUT.jsonSchema);
    for (const bound of ["maxItems", "minItems", "maxLength", "minLength", "pattern", "minimum", "maximum"]) expect(json).not.toContain(bound);
  });
});

describe("parseGoalTask (Add task and tile edits)", () => {
  it("checks one task with the plan's rules, depending only on the goal's other tasks", () => {
    const others = new Set(["server", "client"]);
    expect(parseGoalTask(task("docs", { kind: "docs", dependsOn: ["server"], paths: ["docs/kullanım kılavuzu/"] }), others)).toMatchObject({ ok: true, value: { key: "docs", dependsOn: ["server"] } });
    expect(parseGoalTask(task("docs", { dependsOn: ["ghost"] }), others)).toMatchObject({ ok: false, error: expect.stringContaining('"ghost"') });
    expect(parseGoalTask(task("server"), others)).toMatchObject({ ok: false, error: 'task.key "server" is used twice' });
    expect(parseGoalTask(task("docs", { paths: ["C:/x"] }), others)).toMatchObject({ ok: false });
    expect(parseGoalTask({ ...task("docs"), run: "now" }, others)).toMatchObject({ ok: false, error: 'task has an unknown field "run"' });
  });
});

describe("notes and report excerpts", () => {
  it("caps your note to the planner and allows it empty", () => {
    expect(parseGoalNote(undefined)).toEqual({ ok: true, value: "" });
    expect(parseGoalNote("  Önce sunucu tarafı  ")).toEqual({ ok: true, value: "Önce sunucu tarafı" });
    expect(parseGoalNote("n".repeat(2_001))).toMatchObject({ ok: false, error: "note is 2001 bytes; the limit is 2000" });
    expect(parseGoalNote(5)).toMatchObject({ ok: false });
  });

  it("cuts an accepted report's summary to 4 KB at whole characters for a writing task's prompt", () => {
    expect(goalReportExcerpt("Short report")).toBe("Short report");
    const long = goalReportExcerpt("ş".repeat(3_000));
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(GOAL_LIMITS.reportSummaryBytes);
    expect(long).toContain("[truncated, 6000 bytes]");
    expect(long).not.toContain("�");
  });
});

describe("basis, a soft check", () => {
  const goal = "Giriş sayfasına İki adımlı doğrulama ekle ve   belgele";

  it("matches your words verbatim, whitespace and case normalised", () => {
    expect(goalBasisMatches("doğrulama ekle ve belgele", goal)).toBe(true);
    expect(goalBasisMatches("Add passkey sign-in", "Please add passkey sign-in next to passwords")).toBe(true);
  });

  it("tolerates Turkish casing and dotless i that a planner re-types", () => {
    expect(goalBasisMatches("iki adımlı doğrulama", goal)).toBe(true);
    expect(goalBasisMatches("İKİ ADIMLI DOĞRULAMA", goal)).toBe(true);
    expect(goalBasisMatches("iki adimli dogrulama", goal)).toBe(true);
  });

  it("does not match a paraphrase or a basis too short to mean anything", () => {
    expect(goalBasisMatches("çift faktörlü kimlik doğrulama", goal)).toBe(false);
    expect(goalBasisMatches("ekle", goal)).toBe(false);
    expect(goalBasisMatches("", goal)).toBe(false);
  });
});

describe("goal text", () => {
  it("is cleaned, required and capped", () => {
    expect(parseGoalText("  Hedef\u0000 metni ")).toEqual({ ok: true, value: "Hedef metni" });
    expect(parseGoalText("   ")).toMatchObject({ ok: false });
    expect(parseGoalText("ğ".repeat(4_001))).toMatchObject({ ok: false, error: "goal is 8002 bytes; the limit is 8000" });
    expect(parseGoalText(undefined)).toMatchObject({ ok: false, error: "goal is required" });
  });

  it("titles a goal by its first line, cut at whole characters within 120 bytes", () => {
    expect(goalTitle("\n  Passkey   sign-in \nand docs")).toBe("Passkey sign-in");
    const long = goalTitle("ç".repeat(100));
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(120);
    expect(long.endsWith("...")).toBe(true);
    expect(long).not.toContain("\uFFFD");
  });
});

// ---------------------------------------------------------------- graph

const node = (id: string, dependsOn: string[] = []) => ({ id, dependsOn });

describe("task graph", () => {
  const graph = [node("01"), node("02", ["01"]), node("03", ["01"]), node("04", ["02", "03"])];

  it("names the loop an edge would close, and lets a safe edge through", () => {
    expect(wouldCycle(graph, "01", "04")).toEqual(["01", "04", "02", "01"]);
    expect(wouldCycle(graph, "02", "02")).toEqual(["02", "02"]);
    expect(wouldCycle(graph, "03", "02")).toBeNull();
    expect(wouldCycle(graph, "04", "01")).toBeNull();
  });

  it("puts each task in the step of its longest path from a root, ignoring discarded prerequisites", () => {
    expect(layers(graph)).toEqual([["01"], ["02", "03"], ["04"]]);
    expect(layers([node("a", ["gone"]), node("b", ["a"])])).toEqual([["a"], ["b"]]);
    expect(layers([node("a"), node("b"), node("c", ["a"]), node("d", ["c", "b"])])).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(() => layers([node("a", ["b"]), node("b", ["a"])])).toThrow(/cycle/);
  });

  it("cascades a skip to every task that waits for it, and refuses an accepted task that waits for a skipped one", () => {
    expect(goalDependents(graph, "02")).toEqual(["04"]);
    expect(goalDependents(graph, "01")).toEqual(["02", "03", "04"]);
    expect(skippedDependency(graph, new Set(["01", "02", "04"]))).toEqual({ taskId: "04", dependsOn: "03" });
    expect(skippedDependency(graph, new Set(["01", "03"]))).toBeNull();
  });
});

// ---------------------------------------------------------------- readiness (design §4.6)

const facts = (id: string, over: Partial<GoalTaskFacts> = {}): GoalTaskFacts => ({
  id,
  label: id,
  position: Number(id),
  priority: "medium",
  writes: true,
  accepted: true,
  discarded: false,
  released: false,
  joined: false,
  reportAccepted: false,
  status: "proposed",
  deps: [],
  ...over,
});
const dep = (on: string, source: "plan" | "user" | "overlap" = "plan") => ({ on, source });

describe("readySet and holds", () => {
  it("releases a task waiting for a writing task only once that task is merged into the goal branch", () => {
    const running = facts("01", { released: true, status: "running" });
    const gatesPassed = facts("01", { released: true, status: "review" });
    const joined = facts("01", { released: true, status: "review", joined: true });
    const next = facts("02", { deps: [dep("01")] });
    expect(readySet([running, next])).toEqual([]);
    expect(prerequisiteHold(next, [running, next])).toEqual({ code: "goal.waits_finish", params: { task: "01", taskId: "01" } });
    expect(readySet([gatesPassed, next])).toEqual([]);
    expect(prerequisiteHold(next, [gatesPassed, next])?.code).toBe("goal.waits_join");
    expect(readySet([joined, next])).toEqual(["02"]);
    expect(prerequisiteHold(next, [joined, next])).toBeNull();
  });

  it("passes a report from a task that writes nothing to a writing task only after you accept it", () => {
    const report = facts("01", { writes: false, released: true, status: "done" });
    const code = facts("02", { deps: [dep("01")] });
    const review = facts("03", { writes: false, deps: [dep("01")] });
    expect(readySet([report, code, review])).toEqual(["03"]);
    expect(prerequisiteHold(code, [report, code])?.code).toBe("goal.waits_report");
    expect(readySet([{ ...report, reportAccepted: true }, code, review])).toEqual(["02", "03"]);
    expect(readySet([{ ...report, status: "running" }, code, review])).toEqual([]);
  });

  it("never treats a failed, cancelled, skipped or discarded prerequisite as satisfied", () => {
    const next = facts("02", { deps: [dep("01")] });
    const cases: Array<[Partial<GoalTaskFacts>, string]> = [
      [{ released: true, status: "failed" }, "goal.prereq_failed"],
      [{ released: true, status: "cancelled" }, "goal.prereq_cancelled"],
      [{ accepted: false }, "goal.prereq_skipped"],
      [{ discarded: true }, "goal.prereq_skipped"],
    ];
    for (const [over, code] of cases) {
      const pre = facts("01", over);
      expect(readySet([pre, next])).toEqual([]);
      expect(prerequisiteHold(next, [pre, next])?.code).toBe(code);
    }
    expect(prerequisiteHold(next, [next])?.code).toBe("goal.prereq_skipped");
    expect(unmetPrerequisites(next, new Map([["02", next]]))).toEqual([{ on: "01", source: "plan", why: "skipped" }]);
  });

  it("names an overlap ordering as same files", () => {
    const first = facts("01", { released: true, status: "running" });
    const next = facts("02", { deps: [dep("01", "overlap")] });
    expect(prerequisiteHold(next, [first, next])?.code).toBe("goal.waits_overlap");
  });

  it("leaves out released, discarded, skipped and undecided tasks, and orders by priority, fewer prerequisites, then position", () => {
    const done = facts("00", { released: true, status: "review", joined: true });
    const tasks = [
      done,
      facts("01", { released: true, status: "running" }),
      facts("02", { discarded: true }),
      facts("03", { accepted: false }),
      facts("04", { accepted: null }),
      facts("05", { priority: "low" }),
      facts("06", { deps: [dep("00")] }),
      facts("07"),
      facts("08", { priority: "high", deps: [dep("00")] }),
      facts("09", { status: "cancelled" }),
    ];
    expect(readySet(tasks)).toEqual(["08", "07", "06", "05"]);
  });

  it("counts released, unfinished tasks against the goal's parallel cap", () => {
    const tasks = [
      facts("01", { released: true, status: "running" }),
      facts("02", { released: true, status: "queued" }),
      facts("03", { released: true, status: "failed" }),
      facts("04", { released: true, status: "review" }),
      facts("05", { released: true, status: "review", joined: true }),
      facts("06"),
    ];
    expect(releaseRoom(tasks, 2)).toBe(0);
    expect(releaseRoom(tasks, 3)).toBe(1);
    expect(releaseRoom(tasks.slice(2), 2)).toBe(2);
    expect(GOAL_LIMITS.maxParallel).toBe(2);
  });
});

// ---------------------------------------------------------------- overlap (design §4.8)

describe("pathsOverlap", () => {
  it("compares literal paths case-insensitively, as Windows does, and by folder", () => {
    expect(pathsOverlap("SRC/Auth/Session.ts", "src/auth/session.ts")).toBe(true);
    expect(pathsOverlap("src/auth", "src/auth/session.ts")).toBe(true);
    expect(pathsOverlap("src/auth/", "src/auth/session.ts")).toBe(true);
    expect(pathsOverlap("src/auth", "src/authz.ts")).toBe(false);
    expect(pathsOverlap("src/a.ts", "src/b.ts")).toBe(false);
    expect(pathsOverlap("src\\auth\\x.ts", "src/auth/x.ts")).toBe(true);
  });

  it("handles folders and files with spaces", () => {
    expect(pathsOverlap("docs/user guide", "docs/user guide/intro.md")).toBe(true);
    expect(pathsOverlap("docs/user guide", "docs/user guides/intro.md")).toBe(false);
    expect(pathsOverlap("docs/User Guide/**", "docs/user guide/intro.md")).toBe(true);
  });

  it("reduces a glob to its literal folder before the first wildcard", () => {
    expect(globBase("src/auth/**")).toBe("src/auth/");
    expect(globBase("src/a*.ts")).toBe("src/");
    expect(globBase("**/*.ts")).toBe("");
    expect(pathsOverlap("src/auth/**", "src/auth/session.ts")).toBe(true);
    expect(pathsOverlap("src/auth/**", "src")).toBe(true);
    expect(pathsOverlap("src/auth/**", "src/client/button.tsx")).toBe(false);
    expect(pathsOverlap("src/a*.ts", "src/b.ts")).toBe(true);
    expect(pathsOverlap("**/*.ts", "docs/readme.md")).toBe(true);
    expect(pathsOverlap("src/**", "tests/**")).toBe(false);
    expect(pathsOverlap("src/**", "src/auth/*.ts")).toBe(true);
  });
});

describe("overlapPairs", () => {
  const w = (id: string, paths: string[], dependsOn: string[] = [], over: Partial<OverlapTask> = {}): OverlapTask => ({ id, position: Number(id), writes: true, paths, dependsOn, ...over });

  it("puts the later of two parallel writing tasks with overlapping paths after the earlier one", () => {
    const edges = overlapPairs([w("1", ["docs/"], [], { writes: false }), w("2", ["src/auth/**"], ["1"]), w("3", ["src/auth/session.ts", "src/client/"], ["1"])]);
    expect(edges).toEqual([{ taskId: "3", dependsOn: "2", cause: "paths", paths: ["src/auth/**", "src/auth/session.ts"] }]);
  });

  it("leaves pairs that are already ordered, tasks that write nothing, skipped tasks and pairs you run side by side", () => {
    expect(overlapPairs([w("1", ["src/"]), w("2", ["src/a.ts"], ["1"])])).toEqual([]);
    expect(overlapPairs([w("1", ["src/"], [], { writes: false }), w("2", ["src/a.ts"])])).toEqual([]);
    expect(overlapPairs([w("1", ["src/"], [], { accepted: false }), w("2", ["src/a.ts"])])).toEqual([]);
    expect(overlapPairs([w("1", ["src/"]), w("2", ["src/a.ts"])], { sideBySide: [["2", "1"]] })).toEqual([]);
    expect(overlapPairs([w("1", ["src/a.ts"]), w("2", ["src/b.ts"])])).toEqual([]);
  });

  it("puts a writing task with no planned paths after the other writing tasks, in plan order between two of them", () => {
    const edges = overlapPairs([w("1", []), w("2", ["src/a.ts"]), w("3", []), w("4", ["src/b.ts"], ["1"])]);
    expect(edges).toEqual([
      // 4 already waits for 1, so 1 cannot also wait for 4.
      { taskId: "1", dependsOn: "2", cause: "no_paths" },
      { taskId: "3", dependsOn: "1", cause: "no_paths" },
      { taskId: "3", dependsOn: "4", cause: "no_paths" },
    ]);
  });

  it("never closes a loop, even against an ordering you drew that runs against plan order", () => {
    // 1 waits for 3 (your edge). 2 overlaps both; ordering 2 after 1 and 3 after 2 would loop.
    const tasks = [w("1", ["src/a.ts"], ["3"]), w("2", ["src/a.ts", "src/c.ts"]), w("3", ["src/c.ts"])];
    const edges = overlapPairs(tasks);
    const graph = tasks.map((t) => ({ id: t.id, dependsOn: [...t.dependsOn, ...edges.filter((e) => e.taskId === t.id).map((e) => e.dependsOn)] }));
    expect(() => layers(graph)).not.toThrow();
    expect(edges.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- revisions (design §4.10)

describe("revisions", () => {
  it("freezes joined, done, running, released and edited tasks", () => {
    const t = { status: "proposed" as const, released: false, joined: false, edited: false };
    expect(frozenBecause(t)).toBeNull();
    expect(frozenBecause({ ...t, edited: true })).toBe("edited");
    expect(frozenBecause({ ...t, released: true, status: "queued" })).toBe("running");
    expect(frozenBecause({ ...t, released: true, status: "failed" })).toBe("released");
    expect(frozenBecause({ ...t, released: true, status: "done" })).toBe("done");
    expect(frozenBecause({ ...t, released: true, status: "review", joined: true })).toBe("joined");
  });

  const base = [
    { task: task("server"), frozen: "done" as const },
    { task: task("client", { dependsOn: ["server"] }), frozen: "edited" as const },
    { task: task("docs", { kind: "docs" }), frozen: null },
    { task: task("tests"), frozen: null },
  ];

  it("lets a revision add, change and remove unfrozen tasks, with new tasks depending on frozen ones", () => {
    const next = plan(base[0]!.task, { ...base[1]!.task, reason: "Restated by the planner" }, task("docs", { kind: "docs", title: "Passkeys guide" }), task("e2e", { dependsOn: ["server", "client"] }));
    expect(applyPlanRevision(base, next)).toEqual({ ok: true, diff: { added: ["e2e"], changed: ["docs"], removed: ["tests"], kept: ["server", "client"] } });
  });

  it("refuses a revision that changes or removes a frozen task", () => {
    const changed = plan(task("server", { title: "Different" }), base[1]!.task);
    expect(applyPlanRevision(base, changed)).toMatchObject({ ok: false, code: "frozen_changed", key: "server", because: "done" });
    const removed = plan(base[0]!.task);
    expect(applyPlanRevision(base, removed)).toMatchObject({ ok: false, code: "frozen_removed", key: "client", because: "edited" });
  });

  it("does not count path order or case as a change", () => {
    const cur = [{ task: task("a", { paths: ["src/A.ts", "src/b.ts"] }), frozen: "edited" as const }];
    expect(applyPlanRevision(cur, plan(task("a", { paths: ["src/b.ts", "src/a.ts"] })))).toMatchObject({ ok: true, diff: { kept: ["a"] } });
  });

  it("caps Revise at 5 before approval and Replan at 3 after it, and Add task at the goal's task limit", () => {
    const g = { stopped: false, approved: false, revisionsUsed: 0, replansUsed: 0, taskCount: 3, maxTasks: 8 };
    expect(planRevisionRefusal("revise", g)).toBeNull();
    expect(planRevisionRefusal("revise", { ...g, revisionsUsed: 4 })).toBeNull();
    expect(planRevisionRefusal("revise", { ...g, revisionsUsed: 5 })).toBe("revisions_used");
    expect(planRevisionRefusal("revise", { ...g, approved: true })).toBe("approved");
    expect(planRevisionRefusal("replan", g)).toBe("not_approved");
    expect(planRevisionRefusal("replan", { ...g, approved: true, replansUsed: 2 })).toBeNull();
    expect(planRevisionRefusal("replan", { ...g, approved: true, replansUsed: 3 })).toBe("replans_used");
    expect(planRevisionRefusal("add", { ...g, approved: true, replansUsed: 3 })).toBeNull();
    expect(planRevisionRefusal("add", { ...g, taskCount: 8 })).toBe("too_many");
    expect(planRevisionRefusal("add", { ...g, taskCount: 11, maxTasks: 12 })).toBeNull();
    expect(planRevisionRefusal("replan", { ...g, approved: true, stopped: true })).toBe("stopped");
  });
});

// ---------------------------------------------------------------- budget (design §4.5)

const est = (usd: number | null) => ({ usd, provenance: usd === null ? ("unknown" as const) : ("estimated" as const) });
const sum = (shares: Record<string, number>) => Object.values(shares).reduce((a, b) => a + b, 0);

describe("splitBudget", () => {
  it("splits the goal budget in proportion to known estimates, the last review included, never past the budget", () => {
    const r = splitBudget(3, [
      { id: "02", estimate: est(0.92) },
      { id: "03", estimate: est(0.61) },
      { id: "01", estimate: est(0.08) },
      { id: "review", estimate: est(0.17) },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.knownTotalUsd).toBe(1.78);
    expect(r.shares["02"]).toBeCloseTo(0.92 * (3 / 1.78), 3);
    expect(sum(r.shares)).toBeLessThanOrEqual(3);
    expect(sum(r.shares)).toBeGreaterThan(2.999);
    const thirds = splitBudget(1, [{ id: "a", estimate: est(0.1) }, { id: "b", estimate: est(0.1) }, { id: "c", estimate: est(0.1) }]);
    expect(thirds.ok && sum(thirds.shares)).toBeLessThanOrEqual(1);
  });

  it("needs a typed budget for an Unknown estimate, keeps typed budgets and splits the rest", () => {
    expect(splitBudget(3, [{ id: "a", estimate: est(1) }, { id: "b", estimate: est(null) }])).toEqual({ ok: false, code: "needs_budget", id: "b" });
    expect(splitBudget(3, [{ id: "b", estimate: { usd: 0.5, provenance: "unknown" } }])).toEqual({ ok: false, code: "needs_budget", id: "b" });
    const r = splitBudget(3, [{ id: "a", estimate: est(1) }, { id: "b", estimate: est(null), typedUsd: 1 }]);
    expect(r).toMatchObject({ ok: true, shares: { a: 2, b: 1 }, typedTotalUsd: 1, knownTotalUsd: 1 });
  });

  it("refuses a budget that does not cover the known total, typed budgets past it, and bad numbers", () => {
    expect(splitBudget(3, [{ id: "a", estimate: est(4.1) }])).toEqual({ ok: false, code: "over_budget", totalUsd: 4.1, budgetUsd: 3 });
    expect(splitBudget(3, [{ id: "a", estimate: est(1) }, { id: "b", estimate: est(null), typedUsd: 2.5 }])).toEqual({ ok: false, code: "over_budget", totalUsd: 3.5, budgetUsd: 3 });
    expect(splitBudget(3, [{ id: "a", estimate: est(null), typedUsd: 4 }])).toEqual({ ok: false, code: "typed_over", typedTotalUsd: 4, budgetUsd: 3 });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10_001]) expect(splitBudget(bad, [])).toEqual({ ok: false, code: "bad_budget", id: null });
    expect(splitBudget(3, [{ id: "a", estimate: est(null), typedUsd: 0 }])).toEqual({ ok: false, code: "bad_budget", id: "a" });
  });

  it("gives a $0 estimate (a plan or local model) a $0 share, so a paid fallback asks first", () => {
    expect(splitBudget(3, [{ id: "plan", estimate: est(0) }, { id: "paid", estimate: est(1) }])).toMatchObject({ ok: true, shares: { plan: 0, paid: 3 } });
    expect(splitBudget(3, [{ id: "plan", estimate: est(0) }])).toMatchObject({ ok: true, shares: { plan: 0 } });
  });

  it("scales unfinished shares when you change the goal budget and keeps finished ones", () => {
    const shares = [
      { id: "a", shareUsd: 1, finished: true },
      { id: "b", shareUsd: 1, finished: false },
      { id: "c", shareUsd: 1, finished: false },
    ];
    const up = rescaleShares(3, 5, shares)!;
    expect(up).toEqual({ a: 1, b: 2, c: 2 });
    const down = rescaleShares(3, 2, shares)!;
    expect(down).toEqual({ a: 1, b: 0.5, c: 0.5 });
    expect(rescaleShares(3, 0.5, shares)).toBeNull();
    expect(rescaleShares(3, 0, shares)).toBeNull();
    const overflow = rescaleShares(2, 4, [{ id: "a", shareUsd: 3, finished: false }])!;
    expect(sum(overflow)).toBeLessThanOrEqual(4);
  });

  it("prefills the goal budget as max(project default, the total rounded up x 1.5)", () => {
    expect(defaultGoalBudget(1.78, null)).toBe(3);
    expect(defaultGoalBudget(1.78, 5)).toBe(5);
    expect(defaultGoalBudget(2.01, 3)).toBe(4.5);
    expect(defaultGoalBudget(0, null)).toBe(1.5);
    expect(defaultGoalBudget(1_000_000, null)).toBe(GOAL_LIMITS.budgetMaxUsd);
  });

  it("sets the planning run's budget to min(project per-task cap, max(3 x estimate, $0.25))", () => {
    expect(planningBudget(0.36, null)).toBe(1.08);
    expect(planningBudget(0.36, 0.5)).toBe(0.5);
    expect(planningBudget(0.01, null)).toBe(0.25);
    expect(planningBudget(null, 2)).toBe(0.25);
  });

  it("checks the limits you set: a positive budget and 1 to 4 at once", () => {
    expect(parseGoalLimits({ budgetUsd: 3.456, maxParallel: 4 })).toEqual({ ok: true, value: { budgetUsd: 3.46, maxParallel: 4 } });
    expect(parseGoalLimits({ maxParallel: 1 })).toEqual({ ok: true, value: { maxParallel: 1 } });
    for (const bad of [0, 5, 2.5, "2"]) expect(parseGoalLimits({ maxParallel: bad }).ok).toBe(false);
    for (const bad of [0, -2, 0.001, "3", Number.NaN]) expect(parseGoalLimits({ budgetUsd: bad }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- stop rule and decisions

describe("goalStopRule", () => {
  it("halts after two tasks fail the same way, ignoring ids, numbers and paths", () => {
    expect(goalStopRule([{ taskId: "a", detail: "Tests failed in C:\\Projeler\\demo\\x.ts after 3 tries" }])).toEqual({ halt: false });
    const r = goalStopRule([
      { taskId: "a", detail: "Tests failed in C:\\Projeler\\demo\\x.ts after 3 tries" },
      { taskId: "b", detail: "Tests failed in /home/u/y.ts after 7 tries" },
    ]);
    expect(r).toMatchObject({ halt: true, reason: "same_failure", taskIds: ["a", "b"] });
  });

  it("counts a task that failed twice once, and halts at three failed tasks", () => {
    expect(goalStopRule([{ taskId: "a", detail: "x" }, { taskId: "a", detail: "x" }])).toEqual({ halt: false });
    expect(goalStopRule([{ taskId: "a", detail: "one" }, { taskId: "b", detail: "two" }])).toEqual({ halt: false });
    expect(goalStopRule([{ taskId: "a", detail: "one" }, { taskId: "b", detail: "two" }, { taskId: "c", detail: "three" }])).toMatchObject({ halt: true, reason: "failed_tasks", taskIds: ["a", "b", "c"] });
  });

  it("offers at least one answer for every decision", () => {
    for (const actions of Object.values(GOAL_DECISION_ACTIONS)) expect(actions.length).toBeGreaterThan(0);
    expect(GOAL_DECISION_ACTIONS.changes).not.toContain("accept_report");
  });
});

// ---------------------------------------------------------------- status (design §4.2)

describe("derivePlanState", () => {
  const p = { hasPlan: false, error: null, supersededAt: null, approvedAt: null, runs: [] as Array<{ endedAt: string | null }> };
  it("derives planning, failed, ready, approved and superseded from facts", () => {
    expect(derivePlanState(p)).toBe("planning");
    expect(derivePlanState({ ...p, runs: [{ endedAt: null }] })).toBe("planning");
    // A restart marks the planning run interrupted: the plan fails instead of planning forever.
    expect(derivePlanState({ ...p, runs: [{ endedAt: "t" }] })).toBe("failed");
    expect(derivePlanState({ ...p, error: "the plan has 15 tasks; the limit is 8", runs: [{ endedAt: "t" }] })).toBe("failed");
    expect(derivePlanState({ ...p, hasPlan: true, runs: [{ endedAt: "t" }] })).toBe("ready");
    expect(derivePlanState({ ...p, hasPlan: true, approvedAt: "t" })).toBe("approved");
    expect(derivePlanState({ ...p, hasPlan: true, supersededAt: "t" })).toBe("superseded");
    expect(derivePlanState({ ...p, hasPlan: true, runs: null })).toBe("ready");
  });
});

describe("deriveGoalStatus", () => {
  const g = (over: Partial<GoalStatusFacts> = {}): GoalStatusFacts => ({
    stopped: false,
    paused: false,
    pausedAll: false,
    halted: false,
    collapsed: false,
    latestPlan: "approved",
    openDecisions: [],
    tasks: [],
    integration: null,
    ...over,
  });
  const joined = (id: string, deps: string[] = []) => facts(id, { released: true, status: "review", joined: true, deps: deps.map((d) => dep(d)) });

  it("goes stopped, planning, then the plan's own state first", () => {
    expect(deriveGoalStatus(g({ stopped: true, latestPlan: "planning" })).status).toBe("stopped");
    expect(deriveGoalStatus(g({ latestPlan: "planning", halted: true })).status).toBe("planning");
    expect(deriveGoalStatus(g({ latestPlan: "ready" }))).toMatchObject({ status: "needs_you", reason: "plan_ready" });
    expect(deriveGoalStatus(g({ latestPlan: "failed" }))).toMatchObject({ status: "needs_you", reason: "plan_failed" });
    expect(deriveGoalStatus(g({ collapsed: true }))).toMatchObject({ status: "finished", outcome: "collapsed" });
  });

  it("needs you when halted, a decision is open, a task needs you or failed, or a report waits", () => {
    const run = facts("01", { released: true, status: "running" });
    expect(deriveGoalStatus(g({ halted: true, tasks: [run] }))).toMatchObject({ status: "needs_you", reason: "halted" });
    expect(deriveGoalStatus(g({ openDecisions: [{ kind: "conflict" }], tasks: [run] }))).toMatchObject({ reason: "decision" });
    expect(deriveGoalStatus(g({ tasks: [facts("01", { released: true, status: "needs_input" })] }))).toMatchObject({ reason: "request" });
    expect(deriveGoalStatus(g({ tasks: [facts("01", { released: true, status: "limited" })] }))).toMatchObject({ reason: "request" });
    expect(deriveGoalStatus(g({ tasks: [facts("01", { released: true, status: "failed" }), run] }))).toMatchObject({ reason: "failed" });
    const report = facts("01", { writes: false, released: true, status: "done" });
    expect(deriveGoalStatus(g({ tasks: [report, facts("02", { deps: [dep("01")] })] }))).toMatchObject({ reason: "report" });
    expect(deriveGoalStatus(g({ tasks: [{ ...report, reportAccepted: true }, facts("02", { deps: [dep("01")] })] })).status).toBe("running");
  });

  it("is stuck when open tasks remain but none is active or releasable, and names the chain", () => {
    const state = deriveGoalStatus(g({ tasks: [facts("01", { status: "cancelled", released: true }), facts("02"), facts("04", { deps: [dep("02"), dep("01")] })] }));
    // 02 is releasable, so not stuck yet.
    expect(state.status).toBe("running");
    const stuck = deriveGoalStatus(g({ tasks: [facts("02", { status: "cancelled", released: true }), facts("04", { deps: [dep("02")] })] }));
    expect(stuck).toMatchObject({ status: "needs_you", reason: "stuck", stuck: { taskId: "04", waitsFor: "02", why: "cancelled" } });
  });

  it("is paused, then running while tasks work, wait for release or wait to be merged", () => {
    const run = facts("01", { released: true, status: "running" });
    expect(deriveGoalStatus(g({ paused: true, tasks: [run] })).status).toBe("paused");
    expect(deriveGoalStatus(g({ pausedAll: true, tasks: [run] })).status).toBe("paused");
    expect(deriveGoalStatus(g({ tasks: [run] }))).toMatchObject({ status: "running", done: 0, total: 1 });
    expect(deriveGoalStatus(g({ tasks: [joined("01"), facts("02", { deps: [dep("01")] })] }))).toMatchObject({ status: "running", done: 1, total: 2 });
    expect(deriveGoalStatus(g({ tasks: [facts("01", { released: true, status: "review" })] })).status).toBe("running");
  });

  it("is ready for review only when every writer joined and the last review passed, and merged only from the goal PR", () => {
    const tasks = [joined("01"), joined("02", ["01"]), facts("03", { accepted: false })];
    expect(deriveGoalStatus(g({ tasks, integration: { status: "running", reviewPassed: false } })).status).toBe("running");
    expect(deriveGoalStatus(g({ tasks, integration: { status: "proposed", reviewPassed: false } })).status).toBe("running");
    expect(deriveGoalStatus(g({ tasks, integration: { status: "review", reviewPassed: true } }))).toMatchObject({ status: "ready_for_review", done: 2, total: 2 });
    expect(deriveGoalStatus(g({ tasks, integration: { status: "merged", reviewPassed: true } }))).toMatchObject({ status: "finished", outcome: "merged" });
    expect(deriveGoalStatus(g({ tasks, integration: { status: "failed", reviewPassed: false } }))).toMatchObject({ status: "needs_you", reason: "failed" });
    expect(deriveGoalStatus(g({ tasks: [facts("01", { released: true, status: "review" })], integration: { status: "review", reviewPassed: true } })).status).toBe("running");
  });

  it("is done for a goal with no branch when every accepted task is done, and never because a limit stopped one", () => {
    const research = (id: string, status: GoalTaskFacts["status"]) => facts(id, { writes: false, released: true, status });
    expect(deriveGoalStatus(g({ tasks: [research("01", "done"), research("02", "done")] }))).toMatchObject({ status: "finished", outcome: "done", done: 2, total: 2 });
    expect(deriveGoalStatus(g({ tasks: [research("01", "done"), research("02", "limited")] }))).toMatchObject({ status: "needs_you", reason: "request", done: 1 });
  });
});
