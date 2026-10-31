import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "@crewyard/adapter-fake";
import { defaultProjectConfig, GOAL_LIMITS, parseGoalPlan, type McpServerSpec, type ProjectConfig, type RunOutput, type StartRequest } from "@crewyard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpHook } from "../../mcp/service.ts";
import { Store } from "../../store.ts";
import { AdapterRegistry } from "../adapters.ts";
import type { Candidate } from "../directory.ts";
import { OrchestratorError } from "../errors.ts";
import { Orchestrator, type OrchestratorOptions } from "../orchestrator.ts";
import { GOAL_PLANNER } from "../roles.ts";
import { CANDIDATES, candidate, cleanTemps, git, model, ScriptedAdapter, tempDir, tempRepo, waitFor } from "../testing.ts";
import { smallChange } from "./planner.ts";

// The Orchestra planner over a real store and a repo whose path has spaces, with a scripted
// planner (docs/adr/0019, design §4.3 to §4.5 and §4.10). ScriptedAdapter names a run's role from
// the first word of its title: the goal planner's runs are "goal".

vi.setConfig({ testTimeout: 40_000, hookTimeout: 30_000 });

type Picker = (role: string, req: StartRequest, resumed: boolean) => FakeStep[];
type Result = (role: string, nth: number, req: StartRequest) => RunOutput | undefined;

const open: Array<{ o: Orchestrator; store: Store }> = [];
afterEach(async () => {
  const all = open.splice(0);
  all.forEach(({ o }) => o.shutdown());
  for (const { o } of all) await o.settle();
  new Set(all.map((x) => x.store)).forEach((s) => s.close());
  cleanTemps();
});

const running: FakeStep = { emit: { type: "run.state", state: "running" } };
const quick: Picker = () => [running];

const GOAL = "Giriş sayfasına iki adımlı doğrulama ekle ve belgeleri güncelle.";

type PlanTask = { key: string; title: string; kind: string; mode: string; size: string; description: string; acceptance: string[]; basis: string; dependsOn: string[]; paths: string[]; reason: string; priority: string };
const task = (over: Partial<PlanTask> & { key: string }): PlanTask => ({
  title: `Görev ${over.key}`,
  kind: "code",
  mode: "crew",
  size: "M",
  description: `${over.key} için yapılacaklar.`,
  acceptance: ["Testler geçer"],
  basis: "iki adımlı doğrulama",
  dependsOn: [],
  paths: [`src/${over.key}/index.ts`],
  reason: "Hedef bunu istiyor.",
  priority: "medium",
  ...over,
});

/** Four tasks: an API, a UI that builds on it, tests that plan to touch the API's folder, and docs. */
const PLAN = {
  summary: "Oturum deposu var sayıldı.",
  tasks: [
    task({ key: "api", title: "Oturum API'si", paths: ["src/auth/session.ts"], priority: "high" }),
    task({ key: "ui", title: "Giriş ekranı", mode: "solo", size: "S", dependsOn: ["api"], paths: ["src/ui/login page.tsx"] }),
    task({ key: "tests", title: "Doğrulama testleri", paths: ["src/auth/"] }),
    task({ key: "docs", title: "Belgeleri güncelle", kind: "docs", basis: "something the goal never said", paths: ["docs/auth.md"], priority: "low" }),
  ],
};

const ok = (value: unknown): RunOutput => ({ ok: true, value });

/**
 * The planner's results in order, the last one repeating. A corrective turn resumes the session
 * with only the refusal as its prompt, so planner runs are told apart by the schema they ask for.
 */
const planner =
  (...outputs: Array<RunOutput | undefined>): Result =>
  (() => {
    let n = 0;
    return (_role: string, _nth: number, req: StartRequest) => (req.outputSchema?.name === "goal_plan" ? outputs[Math.min(n++, outputs.length - 1)] : undefined);
  })();

async function setup(opts: { pick?: Picker; result?: Result; candidates?: Candidate[]; config?: (c: ProjectConfig) => void; mcp?: McpHook; enabled?: boolean; limits?: OrchestratorOptions["limits"]; freeMb?: () => number } = {}) {
  const root = tempDir("crewyard goal planner-");
  const repo = await tempRepo(root, "demo repo with spaces");
  if (opts.config) {
    const cfg = defaultProjectConfig("demo repo with spaces", join(root, ".crewyard", "worktrees", "demo repo with spaces"));
    opts.config(cfg);
    mkdirSync(join(repo, ".crewyard"), { recursive: true });
    writeFileSync(join(repo, ".crewyard", "project.json"), JSON.stringify(cfg));
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "project config");
  }
  const store = new Store(join(root, "t.db"));
  if (opts.enabled !== false) store.db.prepare("insert into settings (key, value) values ('orchestra.enabled', 'true')").run();
  const project = store.addProject(repo, "demo repo with spaces");
  const adapter = new ScriptedAdapter(opts.pick ?? quick, { result: opts.result ?? planner(ok(PLAN)) });
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const cands = opts.candidates ?? [candidate("anthropic-key", "anthropic", model("claude-sonnet"))];
  const options: OrchestratorOptions = {
    store,
    dataDir: join(root, "data"),
    emit: () => undefined,
    adapters,
    directory: { candidates: async () => cands, envFor: () => ({}) },
    tickMs: 0,
    freeMemoryMb: opts.freeMb ?? (() => 64_000),
    stopTimeoutMs: 2_000,
    ...(opts.mcp ? { mcp: opts.mcp } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
  };
  const o = new Orchestrator(options);
  o.start();
  open.push({ o, store });
  return { o, store, project, adapter, root, repo, options };
}

const rows = <T>(store: Store, sql: string, ...args: Array<string | number | null>) => store.db.prepare(sql).all(...args) as unknown as T[];
const row = <T>(store: Store, sql: string, ...args: Array<string | number | null>) => store.db.prepare(sql).get(...args) as unknown as T;
const q = (store: Store, sql: string, ...args: Array<string | number | null>) => store.db.prepare(sql).run(...args);

type GoalTask = { task_id: string; key: string; position: number; mode: string; priority: string; basis_matched: number; paths: string; writes: number; plan_id: string; discarded_at: string | null };
const goalTasks = (store: Store, goalId: string) => rows<GoalTask>(store, "select * from goal_tasks where goal_id = ? and discarded_at is null order by position", goalId);
const byKey = (store: Store, goalId: string) => new Map(goalTasks(store, goalId).map((t) => [t.key, t]));
const plans = (store: Store, goalId: string) => rows<{ id: string; revision: number; cause: string; plan: string | null; error: string | null; superseded_at: string | null; plan_task_id: string | null }>(store, "select * from goal_plans where goal_id = ? order by revision", goalId);
const goalEvents = (store: Store, kind: string) => rows<{ payload: string }>(store, "select payload from events where kind = ? and task_id is null order by seq", kind).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
const plannerRuns = (adapter: ScriptedAdapter) => adapter.started.filter((s) => s.req.outputSchema?.name === "goal_plan");

const refusal = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof OrchestratorError)) throw new Error(`expected a refusal, got ${String(err)}`);
  return err.code;
};

/**
 * Approves the latest revision with all its tasks accepted, as GoalRunner's goals.approve does
 * (work item 4): in one transaction, the tasks the revision replaces go first.
 */
function approve(o: Orchestrator, store: Store, goalId: string): string[] {
  const latest = plans(store, goalId).at(-1)!;
  return o.db.tx(() => {
    const discarded = o.applyGoalReplacements(goalId, latest.revision);
    q(store, "update goal_plans set approved_at = 'now' where id = ?", latest.id);
    q(store, "update goals set approved_revision = ?, approved_at = 'now' where id = ?", latest.revision, goalId);
    q(store, "update goal_tasks set accepted = 1 where plan_id = ? and discarded_at is null", latest.id);
    return discarded;
  });
}

/** Every live row of the goal, duplicates by key included, as key@revision. */
const liveKeys = (store: Store, goalId: string) =>
  rows<{ key: string; revision: number }>(store, "select gt.key, p.revision from goal_tasks gt join goal_plans p on p.id = gt.plan_id where gt.goal_id = ? and gt.discarded_at is null order by p.revision, gt.position", goalId).map((r) => `${r.key}@${r.revision}`);

/** The planner's propose dependency, wrapped so a test can act while a plan's tasks are drafted. */
function onPropose(o: Orchestrator, before: (n: number) => void): void {
  const planner = (o as unknown as { goalPlanner: { deps: { propose: (...a: unknown[]) => Promise<unknown> } } }).goalPlanner;
  const original = planner.deps.propose.bind(planner.deps);
  let n = 0;
  planner.deps.propose = (...a: unknown[]) => {
    before(n++);
    return original(...a);
  };
}

describe("planning a goal", () => {
  it("runs one read-only planning step and turns its plan into proposed tasks with their order", async () => {
    const env = await setup();
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();

    // The planning task: one approved goal-planner step whose member keeps the template as its role snapshot.
    const plan = plans(store, start.goalId)[0]!;
    expect(plan).toMatchObject({ revision: 1, cause: "initial", error: null });
    expect(plan.plan_task_id).toBe(start.planTaskId);
    const member = row<{ id: string; role: string; writes_code: number }>(store, "select m.* from crew_members m join crews c on c.id = m.crew_id where c.task_id = ?", start.planTaskId!);
    expect(member).toMatchObject({ role: GOAL_PLANNER.id, writes_code: 0 });
    const snap = row<{ template: string; source: string }>(store, "select template, source from crew_member_roles where member_id = ?", member.id);
    expect(JSON.parse(snap.template)).toEqual(GOAL_PLANNER);
    expect(o.db.roleTemplate(member.id, GOAL_PLANNER.id)).toEqual(GOAL_PLANNER);
    expect(o.get(start.planTaskId!)).toMatchObject({ kind: "research", status: "done" });

    // The run read the goal as data, under the read-only policy, and was asked for the goal plan schema.
    const runs = plannerRuns(adapter);
    expect(runs).toHaveLength(1);
    const req = runs[0]!.req;
    expect(req.prompt).toMatch(/^Role: Goal planner/);
    expect(req.prompt).toContain(`<<<\n${GOAL}\n>>>`);
    expect(req.outputSchema?.name).toBe("goal_plan");
    expect(req.policy).toEqual({ writes: "none", allowCommands: [], network: "denied" });
    // The brief is set as plain text: its rules are not inside a data fence, and fences never nest.
    expect(req.prompt).not.toContain("Task:");
    const fences = req.prompt.split(String.fromCharCode(10)).filter((l) => l === "<<<" || l === ">>>");
    fences.forEach((f, i) => expect(f).toBe(i % 2 === 0 ? "<<<" : ">>>"));
    const lines = req.prompt.split(String.fromCharCode(10));
    expect(lines.findIndex((l) => l.startsWith("Limits: at most"))).toBeLessThan(lines.indexOf("<<<"));

    // Four proposed tasks, none approved, each with its goal row and the plan's fields.
    const tasks = byKey(store, start.goalId);
    expect([...tasks.keys()]).toEqual(["api", "ui", "tests", "docs"]);
    for (const t of tasks.values()) {
      expect(t.plan_id).toBe(plan.id);
      expect(o.get(t.task_id).status).toBe("proposed");
      expect(o.get(t.task_id).crew?.approvedAt).toBeNull();
    }
    expect(o.get(tasks.get("api")!.task_id)).toMatchObject({ title: "Oturum API'si", kind: "code", size: "M" });
    // Solo is one step of the kind's main role; Crew M code has the full plan.
    expect(o.get(tasks.get("ui")!.task_id).crew?.members.map((m) => m.role)).toEqual(["implementer"]);
    expect(o.get(tasks.get("api")!.task_id).crew?.members.map((m) => m.role)).toContain("reviewer");
    expect(tasks.get("ui")).toMatchObject({ mode: "solo", writes: 1, position: 1 });
    expect(tasks.get("api")).toMatchObject({ priority: "high", basis_matched: 1 });
    // The basis check is soft: a miss is recorded, the plan is still accepted.
    expect(tasks.get("docs")).toMatchObject({ basis_matched: 0, writes: 1 });
    expect(JSON.parse(tasks.get("ui")!.paths)).toEqual(["src/ui/login page.tsx"]);

    // Plan edges, plus the automatic overlap ordering: tests plan to touch the API's folder.
    const deps = rows<{ task_id: string; depends_on: string; source: string }>(store, "select task_id, depends_on, source from goal_task_deps where goal_id = ? order by source", start.goalId);
    expect(deps).toEqual([
      { task_id: tasks.get("tests")!.task_id, depends_on: tasks.get("api")!.task_id, source: "overlap" },
      { task_id: tasks.get("ui")!.task_id, depends_on: tasks.get("api")!.task_id, source: "plan" },
    ]);
    // An older build shows the order in the description.
    expect(o.get(tasks.get("ui")!.task_id).description).toMatch(/Acceptance criteria:\n- Testler geçer[\s\S]*\[Goal: waits for 01\]$/);
    expect(o.get(tasks.get("docs")!.task_id).description).not.toContain("[Goal:");

    // Goal tasks start with their plan: the task path refuses them.
    expect(await refusal(o.approve({ taskId: tasks.get("api")!.task_id }))).toBe("task.goal_managed");
    expect(o.goalState(start.goalId)).toMatchObject({ status: "needs_you", reason: "plan_ready", total: 0 });
    expect(goalEvents(store, "goal.planned")).toEqual([expect.objectContaining({ goalId: start.goalId, revision: 1, tasks: 4, added: ["api", "ui", "tests", "docs"], overlaps: 1 })]);
  });

  it("gives the planning run no MCP server at all, so no propose_followup and none of your servers", async () => {
    const spec: McpServerSpec = { name: "crewyard", command: "relay.exe", args: [], env: {}, tools: null, builtin: true };
    const serversFor = vi.fn(async () => [spec]);
    const env = await setup({ mcp: { serversFor, runEnded: () => undefined } });
    const { o, project, adapter } = env;
    await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    expect(plannerRuns(adapter)[0]!.req.mcpServers).toBeUndefined();
    expect(serversFor).not.toHaveBeenCalled();
    // An ordinary task's run still gets its servers: the hook works, the planner is the exception.
    const t = await o.propose({ projectId: project.id, title: "Bağımlılıkları incele", kind: "research", size: "S" });
    await o.approve({ taskId: t.id });
    await o.settle();
    expect(serversFor).toHaveBeenCalledTimes(1);
    expect(adapter.started.find((s) => s.role === "researcher")!.req.mcpServers).toEqual([spec]);
  });

  it("budgets the planning task at the ceiling the preview states", async () => {
    const env = await setup();
    const { o, store, project } = env;
    const preview = await o.previewGoal({ projectId: project.id, text: GOAL });
    // 80,000 in and 8,000 out at $3 / $15 per million: $0.36 Estimated, ceiling 3 x estimate.
    expect(preview).toMatchObject({ canPlan: true, estimate: { usd: 0.36, provenance: "estimated" }, ceilingUsd: 1.08, introDue: true, defaultBudgetUsd: null, smallHint: false });
    const start = await o.createGoal({ projectId: project.id, text: GOAL, defaultBudgetUsd: 12 });
    expect(row<{ budget_usd: number }>(store, "select budget_usd from tasks where id = ?", start.planTaskId!).budget_usd).toBe(preview.ceilingUsd);
    expect(o.get(start.planTaskId!).crew?.estimate).toEqual({ usd: 0.36, provenance: "estimated" });
    await o.settle();
    // The first-goal card is done and its budget is the project default.
    expect(await o.previewGoal({ projectId: project.id, text: "typo in the README" })).toMatchObject({ introDue: false, defaultBudgetUsd: 12, smallHint: true });
  });

  it("caps the planning budget at the project's per-task cap", async () => {
    const env = await setup({ config: (c) => (c.budget.perTaskUsd = 0.5) });
    const { o, store, project } = env;
    const preview = await o.previewGoal({ projectId: project.id, text: GOAL });
    expect(preview.ceilingUsd).toBe(0.5);
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    expect(row<{ budget_usd: number }>(store, "select budget_usd from tasks where id = ?", start.planTaskId!).budget_usd).toBe(0.5);
    await o.settle();
  });

  it("leaves unpriced paid models out unless you pick one, prefers reasoning, and refuses what cannot plan", async () => {
    const unpriced = candidate("mystery-key", "mystery", null);
    const plan = candidate("claude-plan", "anthropic", model("claude-opus"), "plan_signin");
    const env = await setup({ candidates: [unpriced, plan, ...CANDIDATES()] });
    const { o, project } = env;
    const preview = await o.previewGoal({ projectId: project.id, text: GOAL });
    expect(preview.candidates.map((c) => c.profileId)).not.toContain("mystery-key");
    // A plan sign-in costs nothing per call and is a reasoning model: it leads.
    expect(preview.planner).toMatchObject({ profileId: "claude-plan", estimate: { usd: 0, provenance: "estimated" } });
    // $0 for a sign-in reads as Plan, not as a free API call.
    expect(preview.billing).toBe("plan");
    // A model without reasoning stays a candidate, ranked after the reasoning ones.
    const ids = preview.candidates.map((c) => c.profileId);
    expect(ids.indexOf("deepseek-key")).toBeGreaterThan(ids.indexOf("openai-key"));
    const picked = await o.previewGoal({ projectId: project.id, text: GOAL, plannerProfileId: "mystery-key" });
    expect(picked.planner).toMatchObject({ profileId: "mystery-key", estimate: { usd: null, provenance: "unknown" } });
    expect(picked.billing).toBe("api");
    expect(await refusal(o.createGoal({ projectId: project.id, text: GOAL, plannerProfileId: "nobody" }))).toBe("goal.planner_unknown");
    expect(await refusal(o.createGoal({ projectId: project.id, text: "   " }))).toBe("goal.text");
    expect(await refusal(o.createGoal({ projectId: project.id, text: GOAL, defaultBudgetUsd: -1 }))).toBe("goal.bad_budget");
  });

  it("refuses a goal when Orchestra is off or no profile can plan read-only", async () => {
    const off = await setup({ enabled: false });
    expect(await refusal(off.o.createGoal({ projectId: off.project.id, text: GOAL }))).toBe("goal.disabled");
    expect(await off.o.previewGoal({ projectId: off.project.id, text: GOAL })).toMatchObject({ canPlan: false, reason: { code: "goal.disabled" } });
    const writer = { ...candidate("no-ro", "x", model("m")), capabilities: { ...candidate("no-ro", "x", model("m")).capabilities, readOnlyMode: false } };
    const none = await setup({ candidates: [writer] });
    expect(await refusal(none.o.createGoal({ projectId: none.project.id, text: GOAL }))).toBe("goal.no_planner");
    expect(await none.o.previewGoal({ projectId: none.project.id, text: GOAL })).toMatchObject({ canPlan: false, reason: { code: "goal.no_planner" }, ceilingUsd: null, estimate: { provenance: "unknown" } });
  });
});

describe("a refused plan", () => {
  // tasks[1] depends on a key listed after it: a cycle the parser refuses by construction.
  const BAD = { summary: "", tasks: [task({ key: "a" }), task({ key: "b", dependsOn: ["c"] }), task({ key: "c" })] };
  const words = (() => {
    const p = parseGoalPlan(BAD);
    if (p.ok) throw new Error("BAD must be refused");
    return p.error;
  })();

  it("gets one corrective turn in the same session, then fails with the parser's words", async () => {
    const env = await setup({ result: planner(ok(BAD)) });
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    const runs = plannerRuns(adapter);
    expect(runs).toHaveLength(1 + GOAL_LIMITS.correctiveTurns);
    expect(runs[1]!.resumed).toBe(true);
    expect(runs[1]!.req.prompt).toBe(`Your plan was refused: ${words}. Return the corrected plan.`);
    expect(plans(store, start.goalId)[0]).toMatchObject({ plan: null, error: words });
    expect(goalTasks(store, start.goalId)).toEqual([]);
    expect(o.goalState(start.goalId)).toMatchObject({ status: "needs_you", reason: "plan_failed" });
    expect(goalEvents(store, "goal.plan_refused")).toHaveLength(1);
    expect(goalEvents(store, "goal.plan_failed")).toEqual([expect.objectContaining({ revision: 1, error: words })]);
    // Nothing relaunches the planner by itself.
    await o.tick();
    await o.settle();
    expect(plannerRuns(adapter)).toHaveLength(2);
  });

  it("takes the corrected plan from the corrective turn and clears the error", async () => {
    const env = await setup({ result: planner(ok({ ...PLAN, extra: true }), ok(PLAN)) });
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    expect(plannerRuns(adapter)[1]!.req.prompt).toBe('Your plan was refused: the plan has an unknown field "extra". Return the corrected plan.');
    expect(plans(store, start.goalId)[0]).toMatchObject({ error: null });
    expect(goalTasks(store, start.goalId)).toHaveLength(4);
    expect(o.goalState(start.goalId).reason).toBe("plan_ready");
  });

  it("refuses more tasks than the goal allows, and a run with no result, through the same corrective turn", async () => {
    const many = { summary: "", tasks: Array.from({ length: GOAL_LIMITS.maxTasks + 1 }, (_, i) => task({ key: `t${i}` })) };
    const env = await setup({ result: planner(ok(many), undefined) });
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    expect(plannerRuns(adapter)[1]!.req.prompt).toContain(`the plan has ${GOAL_LIMITS.maxTasks + 1} tasks; the limit is ${GOAL_LIMITS.maxTasks}`);
    expect(plans(store, start.goalId)[0]!.error).toBe("the runner returned no result");
    expect(plannerRuns(adapter)).toHaveLength(2);
  });

  it("reads failed after a restart mid-planning and does not relaunch the planner", async () => {
    const env = await setup({ pick: (role) => (role === "goal" ? [running, { awaitAnswer: "never" }] : [running]) });
    const { o, store, project, adapter, options } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await waitFor(() => plannerRuns(adapter).length === 1);
    expect(o.goalState(start.goalId).status).toBe("planning");
    // The daemon exits; its processes go, the facts stay.
    o.shutdown();
    open.splice(open.findIndex((x) => x.o === o), 1);
    const o2 = new Orchestrator(options);
    open.push({ o: o2, store });
    o2.start();
    await o2.settle();
    expect(row<{ end_reason: string }>(store, "select end_reason from runs where task_id = ?", start.planTaskId!).end_reason).toBe("interrupted");
    expect(o2.goalState(start.goalId)).toMatchObject({ status: "needs_you", reason: "plan_failed" });
    expect(plannerRuns(adapter)).toHaveLength(1);
    // Retry planning is your click: a revision of the failed plan, counted like any paid run.
    const retry = await o2.reviseGoal(start.goalId, 1, "");
    expect(retry.revision).toBe(2);
    expect(row<{ revisions_used: number }>(store, "select revisions_used from goals where id = ?", start.goalId).revisions_used).toBe(1);
  });

  it("does not hand a failed planning run off or retry it", async () => {
    const env = await setup({ pick: (role) => (role === "goal" ? [running, { emit: { type: "run.ended", reason: "failed", detail: "HTTP 503 Service Unavailable" } }] : [running]) });
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    expect(plannerRuns(adapter)).toHaveLength(1);
    expect(row<{ resume_at: string | null }>(store, "select resume_at from runs where task_id = ?", start.planTaskId!).resume_at).toBeNull();
    expect(o.requests({ taskId: start.planTaskId! })).toEqual([]);
    expect(o.goalState(start.goalId).reason).toBe("plan_failed");
    expect(goalEvents(store, "goal.plan_failed")).toEqual([expect.objectContaining({ revision: 1, reason: "failed" })]);
  });
});

describe("revising and replanning", () => {
  it("keeps a task you edited through Revise and replaces the rest", async () => {
    const revised = {
      summary: "Notunuza göre güncellendi.",
      tasks: [PLAN.tasks[0]!, { ...PLAN.tasks[1]!, title: "Giriş ekranı ve kod alanı" }, task({ key: "audit", title: "Denetim kaydı", kind: "research", paths: [] })],
    };
    const env = await setup({ result: planner(ok(PLAN), ok(revised)) });
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    const first = byKey(store, start.goalId);
    // What goals.editTask records: the tile was edited, so a revision may not change it.
    q(store, "update goal_tasks set edited = 1 where task_id = ?", first.get("api")!.task_id);
    const next = await o.reviseGoal(start.goalId, 1, "Kod alanını ekranda göster.");
    await o.settle();

    const prompt = plannerRuns(adapter)[1]!.req.prompt;
    expect(prompt).toContain("- api (edited, now proposed): Oturum API'si");
    expect(prompt).toContain("<<<\nKod alanını ekranda göster.\n>>>");
    const [r1, r2] = plans(store, start.goalId);
    expect(r2).toMatchObject({ revision: 2, cause: "revise", error: null });
    expect(r1!.superseded_at).not.toBeNull();
    expect(next.revision).toBe(2);

    const now = byKey(store, start.goalId);
    expect([...now.keys()]).toEqual(["api", "ui", "audit"]);
    // The edited task is the same task, moved into the new revision; the others are new proposals.
    expect(now.get("api")!.task_id).toBe(first.get("api")!.task_id);
    expect(now.get("api")!.plan_id).toBe(r2!.id);
    expect(now.get("ui")!.task_id).not.toBe(first.get("ui")!.task_id);
    expect(o.get(now.get("ui")!.task_id).title).toBe("Giriş ekranı ve kod alanı");
    for (const k of ["ui", "tests", "docs"]) expect(o.get(first.get(k)!.task_id).status).toBe("cancelled");
    expect(rows(store, "select 1 from goal_tasks where goal_id = ? and discarded_at is not null", start.goalId)).toHaveLength(3);
    // The new UI task waits for the kept API task.
    expect(rows<{ depends_on: string }>(store, "select depends_on from goal_task_deps where task_id = ?", now.get("ui")!.task_id)).toEqual([{ depends_on: first.get("api")!.task_id }]);
    expect(goalEvents(store, "goal.planned")[1]).toMatchObject({ revision: 2, kept: ["api"], changed: ["ui"], removed: ["tests", "docs"], added: ["audit"] });
  });

  it("refuses a revision that changes an edited task, through the corrective turn", async () => {
    const changed = { ...PLAN, tasks: [{ ...PLAN.tasks[0]!, title: "Başka bir şey" }, ...PLAN.tasks.slice(1)] };
    const env = await setup({ result: planner(ok(PLAN), ok(changed), ok(PLAN)) });
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    const api = byKey(store, start.goalId).get("api")!.task_id;
    q(store, "update goal_tasks set edited = 1 where task_id = ?", api);
    await o.reviseGoal(start.goalId, 1, "");
    await o.settle();
    expect(plannerRuns(adapter)[2]!.req.prompt).toBe('Your plan was refused: task "api" is frozen (edited) and cannot change. Return the corrected plan.');
    expect(byKey(store, start.goalId).get("api")!.task_id).toBe(api);
    expect(plans(store, start.goalId)[1]!.error).toBeNull();
  });

  it("holds Revise to the latest revision, one planning run at a time and five before approval", async () => {
    const env = await setup({ pick: (role, _req, resumed) => (role === "goal" && !resumed ? [running, { wait: 50 }] : [running]) });
    const { o, store, project } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    expect(await refusal(o.reviseGoal(start.goalId, 1, ""))).toBe("goal.not_ready");
    await o.settle();
    expect(await refusal(o.reviseGoal(start.goalId, 2, ""))).toBe("goal.stale_revision");
    expect(await refusal(o.reviseGoal(start.goalId, 1, "x".repeat(GOAL_LIMITS.noteBytes + 1)))).toBe("goal.text");
    q(store, "update goals set revisions_used = ? where id = ?", GOAL_LIMITS.revisionsBeforeApproval, start.goalId);
    expect(await refusal(o.reviseGoal(start.goalId, 1, ""))).toBe("goal.revisions_used");
    expect(await refusal(o.replanGoal(start.goalId))).toBe("goal.not_approved");
    approve(o, store, start.goalId);
    expect(await refusal(o.reviseGoal(start.goalId, 1, ""))).toBe("goal.approved");
  });

  it("replans after approval with released tasks frozen, at most three times", async () => {
    const replanned = { summary: "", tasks: [PLAN.tasks[0]!, task({ key: "rate", title: "Hız sınırı", dependsOn: ["api"], paths: ["src/auth/rate.ts"] })] };
    const env = await setup({ result: planner(ok(PLAN), ok(replanned)) });
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    approve(o, store, start.goalId);
    const api = byKey(store, start.goalId).get("api")!.task_id;
    // Released by the goal scheduler (work item 4): a released task is frozen.
    q(store, "update goal_tasks set released_at = 'now' where task_id = ?", api);
    await o.replanGoal(start.goalId, "Hız sınırı ekle.");
    await o.settle();
    expect(plannerRuns(adapter)[1]!.req.prompt).toContain("- api (released, now proposed): Oturum API'si");
    const r1 = plans(store, start.goalId)[0]!;
    const first = new Map(rows<GoalTask>(store, "select * from goal_tasks where plan_id = ?", r1.id).map((t) => [t.key, t]));
    // Until you approve the replan, the approved plan keeps running: its tasks stay live and on
    // revision 1, and only the replan's new task is on revision 2.
    expect(liveKeys(store, start.goalId)).toEqual(["api@1", "ui@1", "tests@1", "docs@1", "rate@2"]);
    for (const k of ["ui", "tests", "docs"]) expect(o.get(first.get(k)!.task_id).status).toBe("proposed");
    expect(row<{ plan_id: string }>(store, "select plan_id from goal_tasks where task_id = ?", api).plan_id).toBe(r1.id);
    const goal = row<{ replans_used: number; revisions_used: number }>(store, "select replans_used, revisions_used from goals where id = ?", start.goalId);
    expect(goal).toEqual({ replans_used: 1, revisions_used: 0 });
    // The approved revision stays approved; the new one waits for your approval.
    expect(o.goalState(start.goalId).reason).toBe("plan_ready");
    const pending = o.goalReplacements(start.goalId, 2);
    expect(new Set(pending.discard)).toEqual(new Set(["ui", "tests", "docs"].map((k) => first.get(k)!.task_id)));
    expect(pending.started).toEqual([]);

    // Your approval replaces what the replan dropped; the released task stays where it was approved.
    expect(new Set(approve(o, store, start.goalId))).toEqual(new Set(["ui", "tests", "docs"].map((k) => first.get(k)!.task_id)));
    expect(liveKeys(store, start.goalId)).toEqual(["api@1", "rate@2"]);
    for (const k of ["ui", "tests", "docs"]) expect(o.get(first.get(k)!.task_id).status).toBe("cancelled");
    const rate = byKey(store, start.goalId).get("rate")!.task_id;
    expect(rows(store, "select depends_on, source from goal_task_deps where task_id = ?", rate)).toEqual([{ depends_on: api, source: "plan" }]);
    expect(o.get(rate).description).toMatch(/\[Goal: waits for 01\]$/);
    q(store, "update goals set replans_used = ? where id = ?", GOAL_LIMITS.replans, start.goalId);
    expect(await refusal(o.replanGoal(start.goalId))).toBe("goal.replans_used");
  });

  it("refuses to approve a replan once a task it replaces has started, and changes nothing", async () => {
    const replanned = { summary: "", tasks: [PLAN.tasks[0]!, task({ key: "rate", title: "Hız sınırı", dependsOn: ["api"], paths: ["src/auth/rate.ts"] })] };
    const env = await setup({ result: planner(ok(PLAN), ok(replanned)) });
    const { o, store, project } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    approve(o, store, start.goalId);
    await o.replanGoal(start.goalId);
    await o.settle();
    // The approved plan went on meanwhile: the scheduler released the tests task.
    const tests = rows<GoalTask>(store, "select * from goal_tasks where goal_id = ? and key = 'tests'", start.goalId)[0]!.task_id;
    q(store, "update goal_tasks set released_at = 'now' where task_id = ?", tests);
    expect(o.goalReplacements(start.goalId, 2).started).toEqual([{ key: "tests", taskId: tests, because: "released" }]);
    expect(() => approve(o, store, start.goalId)).toThrow("goal.plan_moved");
    // The transaction rolled back: nothing was discarded and revision 2 is not approved.
    expect(liveKeys(store, start.goalId)).toEqual(["api@1", "ui@1", "tests@1", "docs@1", "api@2", "rate@2"]);
    expect(plans(store, start.goalId)[1]!.superseded_at).toBeNull();
    expect(row<{ approved_revision: number }>(store, "select approved_revision from goals where id = ?", start.goalId).approved_revision).toBe(1);
  });

  it("refuses a revision that drops a task you edited, through the corrective turn", async () => {
    const dropped = { ...PLAN, tasks: PLAN.tasks.filter((t) => t.key !== "docs") };
    const env = await setup({ result: planner(ok(PLAN), ok(dropped), ok(PLAN)) });
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    const docs = byKey(store, start.goalId).get("docs")!.task_id;
    q(store, "update goal_tasks set edited = 1 where task_id = ?", docs);
    await o.reviseGoal(start.goalId, 1, "");
    await o.settle();
    expect(plannerRuns(adapter)[2]!.req.prompt).toBe('Your plan was refused: task "docs" is frozen (edited) and cannot be removed. Return the corrected plan.');
    expect(byKey(store, start.goalId).get("docs")!.task_id).toBe(docs);
    expect(o.get(docs).status).toBe("proposed");
  });

  it("rewrites a kept task's waits-for line when its number and prerequisite change", async () => {
    // The UI task you edited stays; the API task before it changes, and a new task goes first.
    const revised = { summary: "", tasks: [task({ key: "setup", title: "Kurulum", paths: ["package.json"] }), { ...PLAN.tasks[0]!, title: "Oturum API'si v2" }, PLAN.tasks[1]!] };
    const env = await setup({ result: planner(ok(PLAN), ok(revised)) });
    const { o, store, project } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    const ui = byKey(store, start.goalId).get("ui")!.task_id;
    expect(o.get(ui).description).toMatch(/\[Goal: waits for 01\]$/);
    q(store, "update goal_tasks set edited = 1 where task_id = ?", ui);
    await o.reviseGoal(start.goalId, 1, "");
    await o.settle();
    const now = byKey(store, start.goalId);
    expect(now.get("ui")).toMatchObject({ task_id: ui, position: 2 });
    expect(rows(store, "select depends_on from goal_task_deps where task_id = ?", ui)).toEqual([{ depends_on: now.get("api")!.task_id }]);
    const description = o.get(ui).description;
    expect(description).toMatch(/\[Goal: waits for 02\]$/);
    expect(description.match(/\[Goal:/g)).toHaveLength(1);
  });
});

describe("a plan arriving while the goal changes", () => {
  it("drafts again when a task is edited while the revision's tasks are proposed, and never discards it", async () => {
    // The revision drops docs; you edit docs while its tasks are being drafted.
    const dropped = { ...PLAN, tasks: PLAN.tasks.filter((t) => t.key !== "docs") };
    const env = await setup({ result: planner(ok(PLAN), ok(dropped), ok(PLAN)) });
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    const docs = byKey(store, start.goalId).get("docs")!.task_id;
    onPropose(o, (n) => {
      if (n === 0) q(store, "update goal_tasks set edited = 1 where task_id = ?", docs);
    });
    await o.reviseGoal(start.goalId, 1, "");
    await o.settle();
    // The first drafts were dropped; the plan, checked again, removes a frozen task and gets the corrective turn.
    expect(plannerRuns(adapter)[2]!.req.prompt).toContain('task "docs" is frozen (edited) and cannot be removed');
    expect(row<{ discarded_at: string | null }>(store, "select discarded_at from goal_tasks where task_id = ?", docs).discarded_at).toBeNull();
    expect(o.get(docs).status).toBe("proposed");
    expect(liveKeys(store, start.goalId)).toEqual(["api@2", "ui@2", "tests@2", "docs@2"]);
    expect(byKey(store, start.goalId).get("docs")!.task_id).toBe(docs);
  });

  it("never cancels a task the scheduler releases while a replan's tasks are proposed", async () => {
    const replanned = { summary: "", tasks: [PLAN.tasks[0]!, PLAN.tasks[1]!, task({ key: "rate", title: "Hız sınırı", paths: ["src/auth/rate.ts"] })] };
    const env = await setup({ result: planner(ok(PLAN), ok(replanned), ok({ ...replanned, tasks: [...replanned.tasks, PLAN.tasks[2]!] })) });
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    approve(o, store, start.goalId);
    const tests = byKey(store, start.goalId).get("tests")!.task_id;
    onPropose(o, (n) => {
      if (n === 0) q(store, "update goal_tasks set released_at = 'now' where task_id = ?", tests);
    });
    await o.replanGoal(start.goalId);
    await o.settle();
    expect(plannerRuns(adapter)[2]!.req.prompt).toContain('task "tests" is frozen (released) and cannot be removed');
    expect(row<{ discarded_at: string | null }>(store, "select discarded_at from goal_tasks where task_id = ?", tests).discarded_at).toBeNull();
    expect(row<{ cancelled_at: string | null }>(store, "select cancelled_at from tasks where id = ?", tests).cancelled_at).toBeNull();
    // The corrected plan keeps tests where it was approved; nothing of revision 1 is discarded before approval.
    expect(liveKeys(store, start.goalId)).toEqual(["api@1", "ui@1", "tests@1", "docs@1", "api@2", "ui@2", "rate@2"]);
    expect(o.goalReplacements(start.goalId, 2).discard).toHaveLength(3);
  });
});

describe("overlap ordering in a replan", () => {
  it("puts a new task that touches a released task's files after it, never the released task after the new one", async () => {
    // The planner lists the new task first; a released task is past the release step all the same.
    const replanned = { summary: "", tasks: [task({ key: "hotfix", title: "Oturum düzeltmesi", paths: ["src/auth/session.ts"] }), PLAN.tasks[0]!] };
    const env = await setup({ result: planner(ok(PLAN), ok(replanned)) });
    const { o, store, project } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    approve(o, store, start.goalId);
    const api = byKey(store, start.goalId).get("api")!.task_id;
    q(store, "update goal_tasks set released_at = 'now' where task_id = ?", api);
    await o.replanGoal(start.goalId);
    await o.settle();
    const hotfix = byKey(store, start.goalId).get("hotfix")!.task_id;
    expect(rows(store, "select depends_on, source from goal_task_deps where task_id = ?", hotfix)).toEqual([{ depends_on: api, source: "overlap" }]);
    expect(rows(store, "select 1 from goal_task_deps where task_id = ?", api)).toEqual([]);
  });
});

describe("adding a task", () => {
  it("adds one task you wrote as its own revision, with no planner call, ordered after what it waits for", async () => {
    const env = await setup();
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    const api = byKey(store, start.goalId).get("api")!.task_id;
    expect(await refusal(o.addGoalTask(start.goalId, { title: "Kayıt", kind: "code", mode: "crew" }, []))).toBe("goal.not_approved");
    approve(o, store, start.goalId);
    const added = await o.addGoalTask(start.goalId, { title: "Oturum kayıtları", kind: "code", mode: "solo", paths: ["src/auth/session log.ts"] }, [api]);
    expect(plannerRuns(adapter)).toHaveLength(1);
    const rev = plans(store, start.goalId).at(-1)!;
    expect(rev).toMatchObject({ revision: 2, cause: "add", plan_task_id: null });
    expect(JSON.parse(rev.plan!).tasks[0]).toMatchObject({ key: "added-5", title: "Oturum kayıtları", dependsOn: ["api"], size: "M", priority: "medium" });
    const row5 = byKey(store, start.goalId).get("added-5")!;
    expect(row5).toMatchObject({ task_id: added.taskId, position: 4, mode: "solo", basis_matched: 1, plan_id: rev.id });
    expect(o.get(added.taskId!).status).toBe("proposed");
    // Your edge, plus the overlap with the tests task that plans to touch src/auth/.
    const deps = rows<{ depends_on: string; source: string }>(store, "select depends_on, source from goal_task_deps where task_id = ? order by source", added.taskId!);
    expect(deps).toEqual([
      { depends_on: byKey(store, start.goalId).get("tests")!.task_id, source: "overlap" },
      { depends_on: api, source: "user" },
    ]);
    // No task already in the goal gained a prerequisite.
    expect(rows(store, "select 1 from goal_task_deps where depends_on = ?", added.taskId!)).toEqual([]);
    expect(o.get(added.taskId!).description).toContain("[Goal: waits for 01, 03]");
    expect(o.goalState(start.goalId).reason).toBe("plan_ready");
    expect(row<{ replans_used: number }>(store, "select replans_used from goals where id = ?", start.goalId).replans_used).toBe(0);
    // A newer revision waits for you: no second Add task on top of it.
    expect(await refusal(o.addGoalTask(start.goalId, { title: "Bir tane daha", kind: "docs", mode: "crew" }, []))).toBe("goal.not_ready");
  });

  it("checks what you wrote with the plan's rules and the goal's task limit", async () => {
    const env = await setup();
    const { o, store, project } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    approve(o, store, start.goalId);
    expect(await refusal(o.addGoalTask(start.goalId, { title: "Kötü yol", kind: "code", mode: "crew", paths: ["C:/Windows/system32"] }, []))).toBe("goal.invalid_task");
    expect(await refusal(o.addGoalTask(start.goalId, { title: "Yabancı", kind: "code", mode: "crew" }, ["not-a-goal-task"]))).toBe("goal.task_not_found");
    q(store, "update goals set max_tasks = 4 where id = ?", start.goalId);
    expect(await refusal(o.addGoalTask(start.goalId, { title: "Fazla", kind: "code", mode: "crew" }, []))).toBe("goal.too_many");
  });
});

describe("Run as one task", () => {
  it("turns a plan of one task into that ordinary task, which then starts through the normal crew review", async () => {
    const one = { summary: "Tek görev yeter.", tasks: [PLAN.tasks[0]!] };
    const env = await setup({ result: planner(ok(one)), candidates: CANDIDATES() });
    const { o, store, project } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    const only = goalTasks(store, start.goalId)[0]!.task_id;
    const res = await o.collapseGoal(start.goalId);
    expect(res.taskId).toBe(only);
    expect(rows(store, "select 1 from goal_tasks where task_id = ?", only)).toEqual([]);
    expect(row<{ collapsed_task_id: string }>(store, "select collapsed_task_id from goals where id = ?", start.goalId).collapsed_task_id).toBe(only);
    expect(o.goalState(start.goalId)).toMatchObject({ status: "finished", outcome: "collapsed" });
    // No goal row, no goal guard: your approval of its crew starts it, as for any task.
    expect((await o.approve({ taskId: only })).crew?.approvedAt).not.toBeNull();
    // Idempotent, and nothing more is planned for it.
    expect((await o.collapseGoal(start.goalId)).taskId).toBe(only);
    expect(await refusal(o.reviseGoal(start.goalId, 1, ""))).toBe("goal.stopped");
  });

  it("stops planning in flight and proposes one Crew task from your goal text", async () => {
    const env = await setup({ pick: (role) => (role === "goal" ? [running, { awaitAnswer: "never" }] : [running]) });
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await waitFor(() => plannerRuns(adapter).length === 1);
    const res = await o.collapseGoal(start.goalId);
    await o.settle();
    expect(row<{ end_reason: string }>(store, "select end_reason from runs where task_id = ?", start.planTaskId!).end_reason).toBe("stopped");
    const t = o.get(res.taskId!);
    expect(t).toMatchObject({ description: GOAL, status: "proposed" });
    expect(t.crew?.members.length).toBeGreaterThan(1);
    expect(o.goalState(start.goalId)).toMatchObject({ status: "finished", outcome: "collapsed" });
    // A late plan from the stopped run changes nothing.
    expect(goalTasks(store, start.goalId)).toEqual([]);
  });

  it("is refused after approval", async () => {
    const env = await setup();
    const { o, store, project } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    approve(o, store, start.goalId);
    expect(await refusal(o.collapseGoal(start.goalId))).toBe("goal.collapse_after_approval");
  });
});

describe("corrective turns", () => {
  const BAD = { summary: "", tasks: [task({ key: "a" }), task({ key: "b", dependsOn: ["c"] }), task({ key: "c" })] };

  it("gives the corrective turn no MCP server either", async () => {
    const spec: McpServerSpec = { name: "crewyard", command: "relay.exe", args: [], env: {}, tools: null, builtin: true };
    const serversFor = vi.fn(async () => [spec]);
    const env = await setup({ result: planner(ok(BAD)), mcp: { serversFor, runEnded: () => undefined } });
    const { o, project, adapter } = env;
    await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    expect(plannerRuns(adapter)).toHaveLength(2);
    for (const r of plannerRuns(adapter)) expect(r.req.mcpServers).toBeUndefined();
    expect(serversFor).not.toHaveBeenCalled();
  });

  it("never relaunches the planner in a fresh session when the corrective turn's session is gone", async () => {
    const gone: FakeStep = { emit: { type: "run.ended", reason: "failed", detail: "session.gone: no conversation found" } };
    const env = await setup({ result: planner(ok(BAD)), pick: (_role, req, resumed) => (resumed && req.outputSchema?.name === "goal_plan" ? [running, gone] : [running]) });
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    await o.tick();
    await o.settle();
    expect(plannerRuns(adapter)).toHaveLength(2);
    expect(rows(store, "select 1 from runs where task_id = ?", start.planTaskId!)).toHaveLength(2);
    expect(goalEvents(store, "goal.plan_failed")).toEqual([expect.objectContaining({ revision: 1, reason: "failed" })]);
    expect(o.goalState(start.goalId).reason).toBe("plan_failed");
  });

  it("starts the corrective turn only when admission lets it, reading planning until then", async () => {
    let free = 64_000;
    const env = await setup({ result: planner(ok(BAD)), freeMb: () => free, pick: (role, _req, resumed) => (role === "goal" && !resumed ? [running, { wait: 100 }] : [running]) });
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await waitFor(() => plannerRuns(adapter).length === 1);
    // Memory runs low while the planner works: admission (D7) holds every new run, the corrective turn too.
    free = 100;
    await waitFor(() => plans(store, start.goalId)[0]!.error !== null);
    await o.tick();
    await o.settle();
    expect(plannerRuns(adapter)).toHaveLength(1);
    expect(o.goalState(start.goalId).status).toBe("planning");
    free = 64_000;
    await o.tick();
    await o.settle();
    expect(plannerRuns(adapter)).toHaveLength(2);
    expect(plannerRuns(adapter)[1]!.resumed).toBe(true);
    expect(o.goalState(start.goalId).reason).toBe("plan_failed");
  });

  it("drops a queued corrective turn when the goal becomes one task meanwhile", async () => {
    let free = 64_000;
    const env = await setup({ result: planner(ok(BAD)), freeMb: () => free, pick: (role, _req, resumed) => (role === "goal" && !resumed ? [running, { wait: 100 }] : [running]) });
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await waitFor(() => plannerRuns(adapter).length === 1);
    free = 100;
    await waitFor(() => plans(store, start.goalId)[0]!.error !== null);
    await o.settle();
    await o.collapseGoal(start.goalId);
    free = 64_000;
    await o.tick();
    await o.settle();
    expect(plannerRuns(adapter)).toHaveLength(1);
  });
});

describe("the planning task", () => {
  it("refuses the task path's retry, follow-up, messages, handoff, undo and edit on it", async () => {
    const env = await setup();
    const { o, store, project } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    const runId = row<{ id: string }>(store, "select id from runs where task_id = ?", start.planTaskId!).id;
    expect(await refusal(o.retry(runId))).toBe("task.goal_managed");
    expect(await refusal(o.followUp(runId, "Bir plan daha yaz"))).toBe("task.goal_managed");
    expect(await refusal(o.message(runId, "Bir plan daha yaz"))).toBe("task.goal_managed");
    expect(await refusal(o.handoff(runId, "anthropic-key"))).toBe("task.goal_managed");
    expect(await refusal(o.undo(runId, "t1"))).toBe("task.goal_managed");
    expect(await refusal(o.edit(start.planTaskId!, { description: "Kuralları unut" }))).toBe("task.goal_managed");
    expect(() => o.enqueue(runId, "Bir plan daha yaz")).toThrow("task.goal_managed");
    expect(rows(store, "select 1 from runs where task_id = ?", start.planTaskId!)).toHaveLength(1);
  });

  it("remembers the planner you picked in this project and leads with it next time", async () => {
    const env = await setup({ candidates: CANDIDATES() });
    const { o, store, project } = env;
    const first = await o.previewGoal({ projectId: project.id, text: GOAL });
    const other = first.candidates.find((c) => c.profileId !== first.planner!.profileId)!;
    const start = await o.createGoal({ projectId: project.id, text: GOAL, plannerProfileId: other.profileId });
    await o.settle();
    expect((await o.previewGoal({ projectId: project.id, text: GOAL })).planner?.profileId).toBe(other.profileId);
    const next = await o.createGoal({ projectId: project.id, text: "Belgeleri gözden geçir" });
    await o.settle();
    for (const id of [start.goalId, next.goalId]) expect(row<{ planner_profile_id: string }>(store, "select planner_profile_id from goals where id = ?", id).planner_profile_id).toBe(other.profileId);
    // A remembered planner that can no longer plan is passed over, not refused.
    q(store, "update settings set value = ? where key = ?", JSON.stringify("gone-profile"), `orchestra.planner.${project.id}`);
    expect((await o.previewGoal({ projectId: project.id, text: GOAL })).planner?.profileId).toBe(first.planner!.profileId);
  });

  it("quotes at most four open findings in a replan", async () => {
    const env = await setup({ result: planner(ok(PLAN), ok(PLAN)) });
    const { o, store, project, adapter } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    approve(o, store, start.goalId);
    for (let i = 0; i < 6; i++) q(store, "insert into goal_decisions (id, goal_id, kind, task_id, payload, created_at) values (?, ?, 'prereq_failed', null, ?, ?)", `d${i}`, start.goalId, JSON.stringify({ findings: `Bulgu numarası ${i}` }), `2026-10-31T10:0${i}:00.000Z`);
    await o.replanGoal(start.goalId);
    await o.settle();
    const prompt = plannerRuns(adapter)[1]!.req.prompt;
    expect(prompt.match(/What went wrong so far/g)).toHaveLength(4);
    expect(prompt).toContain("Bulgu numarası 3");
    expect(prompt).not.toContain("Bulgu numarası 4");
  });
});

describe("approving a plan of one task", () => {
  it("makes it an ordinary task and approves its crew in the same click", async () => {
    const one = { summary: "Tek görev yeter.", tasks: [PLAN.tasks[0]!] };
    const env = await setup({ result: planner(ok(one)), candidates: CANDIDATES() });
    const { o, store, project } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    const only = goalTasks(store, start.goalId)[0]!.task_id;
    expect(await refusal(o.approveOneTaskGoal(start.goalId, 2))).toBe("goal.stale_revision");
    const detail = await o.approveOneTaskGoal(start.goalId, 1);
    expect(detail.id).toBe(only);
    expect(detail.crew?.approvedAt).not.toBeNull();
    expect(rows(store, "select 1 from goal_tasks where task_id = ?", only)).toEqual([]);
    expect(row<{ collapsed_task_id: string }>(store, "select collapsed_task_id from goals where id = ?", start.goalId).collapsed_task_id).toBe(only);
    expect(o.goalState(start.goalId)).toMatchObject({ status: "finished", outcome: "collapsed" });
    // The same click again changes nothing.
    expect((await o.approveOneTaskGoal(start.goalId, 1)).id).toBe(only);
  });

  it("is refused for a plan of several tasks", async () => {
    const env = await setup();
    const { o, project } = env;
    const start = await o.createGoal({ projectId: project.id, text: GOAL });
    await o.settle();
    expect(await refusal(o.approveOneTaskGoal(start.goalId, 1))).toBe("goal.not_one_task");
  });
});

describe("the small-change hint", () => {
  it("follows the classifier's small-change keywords in English and Turkish, and never a large one", () => {
    expect(smallChange("Fix a typo in the login page")).toBe(true);
    expect(smallChange("Giriş sayfasında küçük bir düzeltme")).toBe(true);
    expect(smallChange(GOAL)).toBe(false);
    expect(smallChange("Küçük ama tüm modülleri kapsayan bir refactor")).toBe(false);
  });
});
