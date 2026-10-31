import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "@crewyard/adapter-fake";
import { defaultProjectConfig, type GoalPriority, type ProjectConfig, type RoleId, type RunOutput, type StartRequest, type TaskKind, type TaskMode, type TaskSize } from "@crewyard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubClient } from "../../github/client.ts";
import { PrFlow, type TaskSource } from "../../github/flow.ts";
import type { GithubService } from "../../github/service.ts";
import { Store } from "../../store.ts";
import { AdapterRegistry } from "../adapters.ts";
import type { Candidate } from "../directory.ts";
import { defaultWorktreeRoot, taskSlug } from "../git.ts";
import { Orchestrator, type OrchestratorOptions } from "../orchestrator.ts";
import type { TaskFlow } from "../tasks.ts";
import { CANDIDATES, candidate, cleanTemps, git, ScriptedAdapter, tempDir, tempRepo, waitFor } from "../testing.ts";
import { GoalError } from "./events.ts";
import { GoalJoin } from "./join.ts";

// The goal scheduler end to end (docs/adr/0019, design §4.5 to §4.9 and §5): a real store, a repo
// whose path has spaces, real git merges into the goal branch, and scripted runners. Goals and
// their plan tasks are written here the way the planner (work item 3) materialises them.

vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });

type Picker = (role: string, req: StartRequest, resumed: boolean) => FakeStep[];

const open: Array<{ o: Orchestrator; store: Store }> = [];
afterEach(async () => {
  const all = open.splice(0);
  all.forEach(({ o }) => o.shutdown());
  for (const { o } of all) await o.settle();
  new Set(all.map((x) => x.store)).forEach((s) => s.close());
  cleanTemps();
});

const running: FakeStep = { emit: { type: "run.state", state: "running" } };
const say = (text: string): FakeStep => ({ emit: { type: "message.delta", text } });
const fail = (detail: string): FakeStep => ({ emit: { type: "run.ended", reason: "failed", detail } });
const verdict = (v: "pass" | "changes"): RunOutput => ({ ok: true, value: { verdict: v, summary: v === "pass" ? "Doğru görünüyor." : "Bir hata var.", comments: v === "pass" ? [] : [{ file: "README.md", line: 1, severity: "major", body: "Boş girişi ele al." }] } });
const findings = (summary: string): RunOutput => ({ ok: true, value: { summary, findings: [] } });

/** The task title a role prompt carries ("Task:\n<<<\n<title>"), so a script can tell tasks apart. */
const titleOf = (req: StartRequest): string => req.prompt.split("Task:\n<<<\n")[1]?.split("\n")[0] ?? "";

interface Setup {
  pick?: Picker;
  result?: (role: string, nth: number, req: StartRequest) => RunOutput | undefined;
  candidates?: Candidate[];
  config?: (c: ProjectConfig) => void;
  memory?: () => number;
  /** Throws from the directory for this project when it returns true. */
  failCandidates?: (projectId: string) => boolean;
}

async function setup(opts: Setup = {}) {
  const root = tempDir("crewyard goal runner-");
  const repo = await tempRepo(root, "demo repo with spaces");
  if (opts.config) {
    const cfg = defaultProjectConfig("demo repo with spaces", defaultWorktreeRoot(repo));
    opts.config(cfg);
    mkdirSync(join(repo, ".crewyard"), { recursive: true });
    writeFileSync(join(repo, ".crewyard", "project.json"), JSON.stringify(cfg));
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "project config");
  }
  const store = new Store(join(root, "t.db"));
  const project = store.addProject(repo, "demo repo with spaces");
  const adapter = new ScriptedAdapter(opts.pick ?? ((role) => [running, say(`${role} bitti`)]), { result: opts.result ?? ((role) => (role === "reviewer" ? verdict("pass") : role === "researcher" ? findings("Özet: hiçbir sorun yok.") : undefined)) });
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const cands = opts.candidates ?? CANDIDATES();
  const emitted: Array<{ topic: string; payload: unknown }> = [];
  const options: OrchestratorOptions = {
    store,
    dataDir: join(root, "data"),
    emit: (topic, payload) => emitted.push({ topic, payload }),
    adapters,
    directory: {
      candidates: async (projectId) => {
        if (opts.failCandidates?.(projectId)) throw new Error("directory unavailable");
        return cands;
      },
      envFor: () => ({}),
    },
    tickMs: 0,
    freeMemoryMb: opts.memory ?? (() => 64_000),
    stopTimeoutMs: 2_000,
  };
  const o = new Orchestrator(options);
  o.start();
  open.push({ o, store });
  return { o, store, project, adapter, cands, root, repo, emitted };
}

const flowOf = (o: Orchestrator): TaskFlow => (o as unknown as { taskFlow: TaskFlow }).taskFlow;
const q = (store: Store, sql: string, ...args: Array<string | number | null>) => store.db.prepare(sql).run(...args);
const row = <T>(store: Store, sql: string, ...args: Array<string | number | null>) => store.db.prepare(sql).get(...args) as T;
const rows = <T>(store: Store, sql: string, ...args: Array<string | number | null>) => store.db.prepare(sql).all(...args) as T[];

interface Spec {
  key: string;
  title: string;
  kind: TaskKind;
  mode?: TaskMode;
  size?: TaskSize;
  deps?: string[];
  overlap?: string[];
  paths?: string[];
  priority?: GoalPriority;
  pins?: Partial<Record<RoleId, string>>;
}

const GOAL_TEXT = "Giriş sayfasına iki adımlı doğrulama ekle ve kullanım kılavuzunu güncelle";

/** A goal with one plan revision and its tasks, materialised as the planner does: one transaction per task. */
async function seedGoal(o: Orchestrator, store: Store, projectId: string, specs: Spec[], opts: { text?: string; baseBranch?: string | null } = {}) {
  const goalId = randomUUID();
  const planId = randomUUID();
  const text = opts.text ?? GOAL_TEXT;
  q(store, "insert into goals (id, project_id, text, title, base_branch, created_at) values (?, ?, ?, ?, ?, ?)", goalId, projectId, text, text.split("\n")[0]!.slice(0, 60), opts.baseBranch === undefined ? "main" : opts.baseBranch, new Date().toISOString());
  q(store, "insert into goal_plans (id, goal_id, revision, cause, plan, created_at) values (?, ?, 1, 'initial', ?, ?)", planId, goalId, JSON.stringify({ summary: "Önce sunucu, sonra arayüz.", tasks: [] }), new Date().toISOString());
  const ids: Record<string, string> = {};
  for (const [i, s] of specs.entries()) {
    const t = await flowOf(o).propose(
      { projectId, title: s.title, description: `${s.title}: ayrıntılar`, kind: s.kind, size: s.size ?? "S", mode: s.mode ?? "solo", fallback: "manual", ...(s.pins ? { pins: s.pins } : {}) },
      {
        inTx: (taskId) => {
          const writes = row<{ w: number | null }>(store, "select max(m.writes_code) as w from crew_members m join crews c on c.id = m.crew_id where c.task_id = ?", taskId).w ?? 0;
          q(
            store,
            "insert into goal_tasks (task_id, goal_id, plan_id, key, position, mode, priority, basis, basis_matched, reason, paths, writes) values (?, ?, ?, ?, ?, ?, ?, ?, 1, 'gerekli', ?, ?)",
            taskId,
            goalId,
            planId,
            s.key,
            i,
            s.mode ?? "solo",
            s.priority ?? "medium",
            "iki adımlı doğrulama",
            JSON.stringify(s.paths ?? (s.kind === "code" || s.kind === "docs" ? [`src/${s.key} dosyası.ts`] : [])),
            writes,
          );
        },
      },
    );
    ids[s.key] = t.id;
  }
  for (const s of specs) {
    for (const d of s.deps ?? []) q(store, "insert into goal_task_deps (goal_id, task_id, depends_on, source) values (?, ?, ?, 'plan')", goalId, ids[s.key]!, ids[d]!);
    for (const d of s.overlap ?? []) q(store, "insert into goal_task_deps (goal_id, task_id, depends_on, source) values (?, ?, ?, 'overlap')", goalId, ids[s.key]!, ids[d]!);
  }
  return { goalId, ids };
}

const approve = (o: Orchestrator, goalId: string, accept: string[], extra: { budgetUsd?: number; maxParallel?: number; taskBudgets?: Record<string, number>; revision?: number } = {}) =>
  o.goals.approve({ goalId, revision: extra.revision ?? 1, accept, budgetUsd: extra.budgetUsd ?? 50, maxParallel: extra.maxParallel ?? 2, ...(extra.taskBudgets ? { taskBudgets: extra.taskBudgets } : {}) });

const goalRefusal = async (p: Promise<unknown>): Promise<{ code: string; params: Record<string, string | number> }> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof GoalError)) throw new Error(`expected a goal refusal, got ${String(err)}`);
  return { code: err.code, params: err.params };
};

const released = (store: Store, taskId: string) => row<{ r: string | null }>(store, "select released_at as r from goal_tasks where task_id = ?", taskId).r !== null;
const joinedSha = (store: Store, taskId: string) => row<{ s: string | null }>(store, "select joined_sha as s from goal_tasks where task_id = ?", taskId).s;
const decisions = (store: Store, goalId: string) => rows<{ id: string; kind: string; task_id: string | null; payload: string; answered_at: string | null; answer: string | null }>(store, "select * from goal_decisions where goal_id = ? order by created_at, rowid", goalId);
const goalRow = (store: Store, goalId: string) => row<{ integration_task_id: string | null; halted_at: string | null; paused_at: string | null; stopped_at: string | null; base_sha: string | null; title: string; id: string }>(store, "select * from goals where id = ?", goalId);
const goalBranch = (store: Store, goalId: string) => GoalJoin.branchFor(goalRow(store, goalId));
const startedTitles = (adapter: ScriptedAdapter, role: string) => adapter.started.filter((s) => s.role === role).map((s) => titleOf(s.req));

/** An implementer that writes `file` in its worktree; pinHead commits it when the run completes. */
const writer =
  (files: Record<string, { file: string; text: string; extra?: FakeStep[] }>, fallback: Picker = (role) => [running, say(`${role} bitti`)]): Picker =>
  (role, req, resumed) => {
    const hit = Object.entries(files).find(([marker]) => titleOf(req).includes(marker));
    if (hit && (role === "implementer" || role === "docs") && !resumed) {
      const path = join(req.cwd, hit[1].file);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, hit[1].text);
      return [running, ...(hit[1].extra ?? []), say("yazdım")];
    }
    return fallback(role, req, resumed);
  };

describe("release in dependency order", () => {
  it("merges a writing prerequisite into the goal branch before its dependent starts, and branches the dependent from there", async () => {
    const seen: Record<string, boolean> = {};
    const pick: Picker = (role, req, resumed) => {
      if (titleOf(req).includes("[B]")) seen.bHadA = existsSync(join(req.cwd, "a dosyası.txt"));
      return writer({ "[A]": { file: "a dosyası.txt", text: "A\n" }, "[B]": { file: "b dosyası.txt", text: "B\n" } })(role, req, resumed);
    };
    const { o, store, project, adapter, repo } = await setup({ pick });
    const { goalId, ids } = await seedGoal(o, store, project.id, [
      { key: "a", title: "[A] Sunucu doğrulaması", kind: "code" },
      { key: "b", title: "[B] Arayüz doğrulaması", kind: "code", deps: ["a"] },
    ]);
    await approve(o, goalId, ["a", "b"]);
    // Only the task with no prerequisite is released; the other waits for it to finish and join.
    expect([released(store, ids.a!), released(store, ids.b!)]).toEqual([true, false]);
    expect(o.get(ids.b!).goal).toMatchObject({ goalId, key: "b", number: 2, waiting: true, hidden: false, role: "task" });
    expect(o.get(ids.b!).goal!.hold).toMatchObject({ code: "goal.waits_finish", params: { task: "01" } });
    expect(o.get(ids.b!).status).toBe("proposed");

    await waitFor(() => joinedSha(store, ids.b!), 40_000);
    expect(startedTitles(adapter, "implementer")).toEqual(["[A] Sunucu doğrulaması", "[B] Arayüz doğrulaması"]);
    expect(seen.bHadA).toBe(true);
    // B's prompt names the commits A merged, quoted as data, and its place in the plan.
    const bPrompt = adapter.started.find((s) => titleOf(s.req).includes("[B]"))!.req.prompt;
    expect(bPrompt).toContain(GOAL_TEXT);
    expect(bPrompt).toContain("task 02 of 2; it waits for 01");
    expect(bPrompt).toContain("Task 01 ([A] Sunucu doğrulaması) is merged into the goal branch with these commits:");

    // Both merges advanced the goal branch with --no-ff; the user's main branch never moved.
    const branch = goalBranch(store, goalId);
    const files = (await git(repo, "-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", branch)).split("\n");
    expect(files).toEqual(expect.arrayContaining(["a dosyası.txt", "b dosyası.txt"]));
    const joins = rows<{ task_id: string; outcome: string; before_sha: string; after_sha: string }>(store, "select * from goal_joins where goal_id = ? order by at, rowid", goalId);
    expect(joins.map((j) => [j.task_id, j.outcome])).toEqual([
      [ids.a, "joined"],
      [ids.b, "joined"],
    ]);
    expect(joins[1]!.before_sha).toBe(joins[0]!.after_sha);
    expect((await git(repo, "rev-parse", "main")).trim()).toBe(goalRow(store, goalId).base_sha);
    expect(o.get(ids.a!).goal!.joined).toBe(true);
  });
});

describe("the parallel cap", () => {
  it("releases at most max_parallel goal tasks at once and holds the rest with the cap as the reason", async () => {
    const pick: Picker = (role) => [running, { wait: 300 }, say(`${role} bitti`)];
    const { o, store, project } = await setup({ pick });
    const { goalId, ids } = await seedGoal(o, store, project.id, [
      { key: "r1", title: "[R1] Araştır bir", kind: "research", priority: "low" },
      { key: "r2", title: "[R2] Araştır iki", kind: "research", priority: "high" },
      { key: "r3", title: "[R3] Araştır üç", kind: "research", priority: "medium" },
    ]);
    await approve(o, goalId, ["r1", "r2", "r3"], { maxParallel: 2 });
    // Priority decides who goes first: high, then medium; low waits for a slot.
    expect([released(store, ids.r1!), released(store, ids.r2!), released(store, ids.r3!)]).toEqual([false, true, true]);
    expect(o.get(ids.r1!).goal!.hold).toEqual({ code: "goal.parallel_cap", params: { running: 2, max: 2 } });
    await waitFor(() => released(store, ids.r1!), 20_000);
    await waitFor(() => o.goals.state(goalId).status === "finished", 20_000);
    expect(o.goals.state(goalId)).toMatchObject({ status: "finished", outcome: "done", done: 3, total: 3 });
    // A goal with no writing task has no branch and no integration task.
    expect(goalRow(store, goalId).integration_task_id).toBeNull();
  });

  it("refuses a parallel limit outside 1 to 4", async () => {
    const { o, store, project } = await setup();
    const { goalId } = await seedGoal(o, store, project.id, [{ key: "r", title: "[R] Araştır", kind: "research" }]);
    expect(await goalRefusal(approve(o, goalId, ["r"], { maxParallel: 5 }))).toMatchObject({ code: "goal.bad_budget", params: { field: "maxParallel" } });
    expect(await goalRefusal(approve(o, goalId, ["r"], { maxParallel: 0 }))).toMatchObject({ code: "goal.bad_budget" });
  });
});

describe("one goal's failure", () => {
  it("does not stop an unrelated task from dispatching in the same pass", async () => {
    const { o, store, project, adapter, repo } = await setup();
    const { goalId, ids } = await seedGoal(o, store, project.id, [{ key: "a", title: "[A] Sunucu", kind: "code" }]);
    // Someone's files sit where the goal branch's worktree would go: git refuses to create it.
    const g = goalRow(store, goalId);
    const blocked = join(defaultWorktreeRoot(repo), `goal-${taskSlug(g.title, g.id)}`);
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, "başkasının notu.txt"), "dokunma\n");
    await approve(o, goalId, ["a"]);
    expect(released(store, ids.a!)).toBe(false);
    const stuck = decisions(store, goalId).find((d) => d.kind === "stuck")!;
    expect(JSON.parse(stuck.payload)).toEqual({ detail: "worktree.path_taken" });

    const other = await o.propose({ projectId: project.id, title: "Bağımsız araştırma", kind: "research", size: "S", mode: "solo" });
    await o.approve({ taskId: other.id });
    await waitFor(() => adapter.started.find((s) => titleOf(s.req) === "Bağımsız araştırma"));
    // The broken goal asked once, held its task, and its files were left alone.
    expect(decisions(store, goalId).filter((d) => d.kind === "stuck")).toHaveLength(1);
    expect(readFileSync(join(blocked, "başkasının notu.txt"), "utf8")).toBe("dokunma\n");
    expect(adapter.started.some((s) => titleOf(s.req).includes("[A]"))).toBe(false);
  });

  it("keeps scheduling when the directory fails for one goal's project", async () => {
    let failing = false;
    const { o, store, project, adapter } = await setup({ failCandidates: (id) => failing && id === projectA });
    const projectA = project.id;
    const { goalId, ids } = await seedGoal(o, store, project.id, [
      { key: "r1", title: "[R1] Araştır bir", kind: "research" },
      { key: "r2", title: "[R2] Araştır iki", kind: "research" },
    ]);
    await o.goals.pauseAll(true);
    await approve(o, goalId, ["r1", "r2"]);
    failing = true;
    await o.goals.pauseAll(false);
    expect([released(store, ids.r1!), released(store, ids.r2!)]).toEqual([false, false]);
    expect(decisions(store, goalId).map((d) => d.kind)).toEqual(["stuck"]);
    expect(adapter.started).toEqual([]);
  });
});

describe("pause", () => {
  it("holds a goal task's queued step until you resume the goal", async () => {
    let mem = 64_000;
    const pick: Picker = (role) => {
      if (role === "implementer") mem = 100;
      return role === "implementer" ? [running, { wait: 200 }, say("yazdım")] : [running, say(`${role} bitti`)];
    };
    const { o, store, project, adapter } = await setup({ pick, memory: () => mem });
    const { goalId, ids } = await seedGoal(o, store, project.id, [{ key: "a", title: "[A] Sunucu", kind: "code", mode: "crew", size: "S" }]);
    await approve(o, goalId, ["a"]);
    // The review step is ready but admission holds it (memory), so nothing of the goal is running.
    await waitFor(() => o.get(ids.a!).crew!.members.find((m) => m.role === "reviewer")!.blockedBy?.code === "admission.memory", 20_000);
    await o.goals.pause(goalId);
    expect(o.goals.state(goalId).status).toBe("paused");
    mem = 64_000;
    await o.tick();
    await o.settle();
    expect(adapter.started.map((s) => s.role)).toEqual(["implementer"]);
    expect(o.get(ids.a!).goal!.hold).toEqual({ code: "goal.paused" });

    await o.goals.resume(goalId);
    await waitFor(() => adapter.started.find((s) => s.role === "reviewer"), 20_000);
    expect(await goalRefusal(o.goals.resume(goalId))).toMatchObject({ code: "goal.not_paused" });
  });

  it("pauses every goal with Pause all goals, and releases again only when you lift it", async () => {
    const { o, store, project, adapter } = await setup();
    const { goalId, ids } = await seedGoal(o, store, project.id, [{ key: "r", title: "[R] Araştır", kind: "research" }]);
    expect(await o.goals.pauseAll(true)).toEqual({ pausedAll: true });
    await approve(o, goalId, ["r"]);
    await o.settle();
    expect(released(store, ids.r!)).toBe(false);
    expect(o.get(ids.r!).goal!.hold).toEqual({ code: "goal.paused_all" });
    expect(o.goals.state(goalId).status).toBe("paused");
    expect(adapter.started).toEqual([]);
    await o.goals.pauseAll(false);
    await waitFor(() => o.goals.state(goalId).status === "finished", 20_000);
  });

  it("pauses running steps of the goal at their turn boundary", async () => {
    const pick: Picker = (role) => [running, { awaitAnswer: "never" }, say(`${role} bitti`)];
    const { o, store, project } = await setup({ pick });
    const { goalId, ids } = await seedGoal(o, store, project.id, [{ key: "r", title: "[R] Araştır", kind: "research" }]);
    await approve(o, goalId, ["r"]);
    const run = await waitFor(() => o.get(ids.r!).runs[0]);
    await o.goals.pause(goalId);
    expect(o.get(ids.r!).runs.find((r) => r.id === run.id)!.pausedAt).not.toBeNull();
    expect(goalRow(store, goalId).paused_at).not.toBeNull();
  });
});

describe("the goal budget", () => {
  const priced = CANDIDATES();
  const withMystery = (): Candidate[] => [...priced, candidate("mystery", "local", null)];

  it("splits the goal budget into task budgets that sum to at most the goal budget", async () => {
    const { o, store, project, emitted } = await setup({ pick: (role) => [running, { awaitAnswer: "never" }, say(role)] });
    const { goalId, ids } = await seedGoal(o, store, project.id, [
      { key: "r1", title: "[R1] Araştır", kind: "research", size: "M" },
      { key: "k", title: "[K] Kodla", kind: "code", size: "M", deps: ["r1"] },
      { key: "d", title: "[D] Belgele", kind: "docs", size: "S", deps: ["k"] },
    ]);
    await approve(o, goalId, ["r1", "k", "d"], { budgetUsd: 7.5 });
    const integration = goalRow(store, goalId).integration_task_id!;
    expect(integration).not.toBeNull();
    const shares = [ids.r1!, ids.k!, ids.d!, integration].map((id) => row<{ b: number }>(store, "select budget_usd as b from tasks where id = ?", id).b);
    expect(shares.every((s) => s > 0)).toBe(true);
    expect(shares.reduce((a, s) => a + s, 0)).toBeLessThanOrEqual(7.5);
    // Each share is its estimate scaled by the same ratio.
    const est = [ids.r1!, ids.k!, ids.d!].map((id) => o.get(id).crew!.estimate.usd!);
    expect(shares[0]! / est[0]!).toBeCloseTo(shares[1]! / est[1]!, 2);
    const approved = rows<{ payload: string }>(store, "select payload from events where kind = 'goal.approved'").map((r) => JSON.parse(r.payload) as { shares: Record<string, number>; accepted: string[] });
    expect(approved).toHaveLength(1);
    expect(Object.keys(approved[0]!.shares).sort()).toEqual(["d", "k", "r1", "review"]);
    expect(emitted.some((e) => e.topic === "goals.changed" && (e.payload as { cause: string }).cause === "approved")).toBe(true);

    // Raising the budget scales the unfinished shares in proportion.
    o.goals.setLimits(goalId, { budgetUsd: 15 });
    const after = [ids.r1!, ids.k!, ids.d!, integration].map((id) => row<{ b: number }>(store, "select budget_usd as b from tasks where id = ?", id).b);
    after.forEach((s, i) => expect(s).toBeCloseTo(shares[i]! * 2, 2));
    expect(after.reduce((a, s) => a + s, 0)).toBeLessThanOrEqual(15);
    expect(await goalRefusal(Promise.resolve().then(() => o.goals.setLimits(goalId, { budgetUsd: -1 })))).toMatchObject({ code: "goal.bad_budget" });
  });

  it("needs a typed budget for a task whose estimate is Unknown, and keeps it as typed", async () => {
    const { o, store, project } = await setup({ candidates: withMystery(), pick: (role) => [running, { awaitAnswer: "never" }, say(role)] });
    const { goalId, ids } = await seedGoal(o, store, project.id, [
      { key: "r", title: "[R] Araştır", kind: "research", pins: { researcher: "anthropic-key" } },
      { key: "u", title: "[U] Yerel model araştırması", kind: "research", pins: { researcher: "mystery" } },
    ]);
    expect(o.get(ids.u!).crew!.estimate.provenance).toBe("unknown");
    expect(await goalRefusal(approve(o, goalId, ["r", "u"], { budgetUsd: 10 }))).toEqual({ code: "goal.needs_budget", params: { task: "u" } });
    expect(await goalRefusal(approve(o, goalId, ["r", "u"], { budgetUsd: 10, taskBudgets: { u: 20 } }))).toMatchObject({ code: "goal.typed_over" });
    expect(await goalRefusal(approve(o, goalId, ["r", "u"], { budgetUsd: 0.000_01, taskBudgets: { u: 0.000_01 } }))).toMatchObject({ code: "goal.bad_budget" });
    // Nothing was approved by the refusals.
    expect(row<{ a: string | null }>(store, "select approved_at as a from goal_plans where goal_id = ?", goalId).a).toBeNull();
    await approve(o, goalId, ["r", "u"], { budgetUsd: 10, taskBudgets: { u: 2 } });
    expect(row<{ b: number }>(store, "select budget_usd as b from tasks where id = ?", ids.u!).b).toBe(2);
    expect(row<{ b: number }>(store, "select budget_usd as b from tasks where id = ?", ids.r!).b).toBeLessThanOrEqual(8);
  });

  it("refuses a known total that does not fit, and a missing or bad budget", async () => {
    const { o, store, project } = await setup();
    const { goalId } = await seedGoal(o, store, project.id, [{ key: "r", title: "[R] Araştır", kind: "research", size: "L" }]);
    expect(await goalRefusal(approve(o, goalId, ["r"], { budgetUsd: 0.000_1 }))).toMatchObject({ code: "goal.bad_budget" });
    expect(await goalRefusal(approve(o, goalId, ["r"], { budgetUsd: 0.01 }))).toMatchObject({ code: "goal.over_budget" });
    expect(await goalRefusal(approve(o, goalId, ["r"], { budgetUsd: 100_000 }))).toMatchObject({ code: "goal.bad_budget" });
    expect(await goalRefusal(approve(o, goalId, ["r"], { budgetUsd: Number.NaN }))).toMatchObject({ code: "goal.bad_budget" });
  });
});

describe("approval", () => {
  it("is idempotent per revision and refuses stale, unknown, empty, oversized and skipped-prerequisite approvals", async () => {
    const { o, store, project } = await setup({ pick: (role) => [running, { awaitAnswer: "never" }, say(role)] });
    const { goalId, ids } = await seedGoal(o, store, project.id, [
      { key: "r", title: "[R] Araştır", kind: "research" },
      { key: "k", title: "[K] Kodla", kind: "code", deps: ["r"] },
      { key: "x", title: "[X] Ayrı iş", kind: "research" },
    ]);
    expect(await goalRefusal(approve(o, goalId, ["r"], { revision: 2 }))).toEqual({ code: "goal.stale_revision", params: { revision: 2, latest: 1 } });
    expect(await goalRefusal(approve(o, goalId, ["nope"]))).toMatchObject({ code: "goal.task_not_found" });
    expect(await goalRefusal(approve(o, goalId, []))).toMatchObject({ code: "goal.no_accepted" });
    expect(await goalRefusal(approve(o, goalId, ["k", "x"]))).toEqual({ code: "goal.skipped_dependency", params: { task: "k", dependsOn: "r" } });
    q(store, "update goals set max_tasks = 1 where id = ?", goalId);
    expect(await goalRefusal(approve(o, goalId, ["r", "x"]))).toEqual({ code: "goal.too_many", params: { max: 1 } });
    q(store, "update goals set max_tasks = 8 where id = ?", goalId);

    // Two clicks at once approve once: one integration task, one approval event.
    await Promise.all([approve(o, goalId, ["r", "x"]), approve(o, goalId, ["r", "x"])]);
    await approve(o, goalId, ["r", "x"]);
    expect(rows(store, "select 1 from events where kind = 'goal.approved'")).toHaveLength(1);
    // A goal with no accepted writing task gets no branch.
    expect(goalRow(store, goalId).integration_task_id).toBeNull();
    // The skipped task never ran: its proposal is cancelled, and it is hidden in its goal.
    expect(o.get(ids.k!).status).toBe("cancelled");
    expect(o.get(ids.k!).goal).toMatchObject({ hidden: true, waiting: false });
    expect(row<{ a: number }>(store, "select accepted as a from goal_tasks where task_id = ?", ids.k!).a).toBe(0);
    // A goal task is never started through tasks.approve.
    await expect(o.approve({ taskId: ids.x! })).rejects.toThrow();
  });

  it("refuses an approval when an accepted task's crew has no profile", async () => {
    const { o, store, project } = await setup({ candidates: [] });
    const { goalId } = await seedGoal(o, store, project.id, [{ key: "r", title: "[R] Araştır", kind: "research" }]);
    expect(await goalRefusal(approve(o, goalId, ["r"]))).toEqual({ code: "goal.crew", params: { task: "r", code: "crew.missing_profile" } });
  });

  it("asks you when a task's profile went away between approval and release", async () => {
    const cands = CANDIDATES();
    const { o, store, project } = await setup({ candidates: cands });
    const { goalId, ids } = await seedGoal(o, store, project.id, [{ key: "r", title: "[R] Araştır", kind: "research", pins: { researcher: "deepseek-key" } }]);
    await o.goals.pauseAll(true);
    await approve(o, goalId, ["r"]);
    cands.splice(
      cands.findIndex((c) => c.profile.id === "deepseek-key"),
      1,
    );
    await o.goals.pauseAll(false);
    expect(released(store, ids.r!)).toBe(false);
    const d = decisions(store, goalId).find((x) => x.kind === "profile_gone")!;
    expect(JSON.parse(d.payload)).toEqual({ detail: "crew.unknown_profile", profileId: "deepseek-key" });
    // Asked once, not on every pass.
    await o.tick();
    expect(decisions(store, goalId).filter((x) => x.kind === "profile_gone")).toHaveLength(1);
  });
});

describe("prerequisites that are not satisfied", () => {
  it("holds the dependents of a failed task while independent tasks go on", async () => {
    const pick: Picker = (role, req) => (titleOf(req).includes("[A]") ? [running, fail("boom")] : [running, say(`${role} bitti`)]);
    const { o, store, project, adapter } = await setup({ pick });
    const { goalId, ids } = await seedGoal(o, store, project.id, [
      { key: "a", title: "[A] Araştır", kind: "research" },
      { key: "b", title: "[B] Sonra araştır", kind: "research", deps: ["a"] },
      { key: "c", title: "[C] Ayrı araştırma", kind: "research" },
    ]);
    await approve(o, goalId, ["a", "b", "c"]);
    await waitFor(() => o.get(ids.a!).status === "failed" && o.get(ids.c!).status === "done", 20_000);
    await o.tick();
    expect(released(store, ids.b!)).toBe(false);
    expect(o.get(ids.b!).goal!.hold).toEqual({ code: "goal.prereq_failed", params: { task: "01", taskId: ids.a } });
    expect(startedTitles(adapter, "researcher")).not.toContain("[B] Sonra araştır");
    expect(o.goals.state(goalId)).toMatchObject({ status: "needs_you", reason: "failed" });
    // One failure is recorded once, however many passes see it.
    await o.tick();
    expect(rows(store, "select 1 from events where kind = 'goal.task_failed'")).toHaveLength(1);
  });

  it("asks what to do when a prerequisite is cancelled, and runs the dependent without it on your answer", async () => {
    const pick: Picker = (role, req) => (titleOf(req).includes("[A]") ? [running, { awaitAnswer: "never" }] : [running, say(`${role} bitti`)]);
    const { o, store, project } = await setup({ pick });
    const { goalId, ids } = await seedGoal(o, store, project.id, [
      { key: "a", title: "[A] Uzun araştırma", kind: "research" },
      { key: "b", title: "[B] Sonra araştır", kind: "research", deps: ["a"] },
    ]);
    await approve(o, goalId, ["a", "b"]);
    await waitFor(() => o.get(ids.a!).runs[0]);
    await o.cancel(ids.a!);
    await o.tick();
    const d = await waitFor(() => decisions(store, goalId).find((x) => x.kind === "prerequisite"));
    expect([d.task_id, JSON.parse(d.payload)]).toEqual([ids.a, { waiting: [ids.b] }]);
    expect(o.get(ids.b!).goal!.hold).toMatchObject({ code: "goal.prereq_cancelled" });
    expect(await goalRefusal(o.goals.decide(goalId, d.id, "resume"))).toEqual({ code: "goal.action", params: { action: "resume", kind: "prerequisite" } });
    await o.goals.decide(goalId, d.id, "run_without");
    await waitFor(() => o.get(ids.b!).status === "done", 20_000);
    expect(await goalRefusal(o.goals.decide(goalId, d.id, "run_without"))).toMatchObject({ code: "goal.decision_answered" });
    expect(await goalRefusal(o.goals.decide(goalId, "no-such-decision", "run_without"))).toMatchObject({ code: "goal.decision_not_found" });
  });

  it("cancels the tasks that wait for a cancelled prerequisite on your answer", async () => {
    const pick: Picker = (role, req) => (titleOf(req).includes("[A]") ? [running, { awaitAnswer: "never" }] : [running, say(`${role} bitti`)]);
    const { o, store, project } = await setup({ pick });
    const { goalId, ids } = await seedGoal(o, store, project.id, [
      { key: "a", title: "[A] Uzun araştırma", kind: "research" },
      { key: "b", title: "[B] Sonra araştır", kind: "research", deps: ["a"] },
      { key: "c", title: "[C] En son", kind: "research", deps: ["b"] },
    ]);
    await approve(o, goalId, ["a", "b", "c"]);
    await waitFor(() => o.get(ids.a!).runs[0]);
    await o.cancel(ids.a!);
    await o.tick();
    const d = await waitFor(() => decisions(store, goalId).find((x) => x.kind === "prerequisite"));
    await o.goals.decide(goalId, d.id, "cancel_dependents");
    expect([o.get(ids.b!).status, o.get(ids.c!).status]).toEqual(["cancelled", "cancelled"]);
  });

  it("halts the goal after two tasks fail the same way, and counts only new failures after you resume", async () => {
    const pick: Picker = (role, req) => (/\[A\]|\[B\]/.test(titleOf(req)) ? [running, fail("HTTP 400: invalid tool schema")] : [running, say(`${role} bitti`)]);
    const { o, store, project } = await setup({ pick });
    const { goalId, ids } = await seedGoal(o, store, project.id, [
      { key: "a", title: "[A] Araştır", kind: "research", priority: "high" },
      { key: "b", title: "[B] Araştır", kind: "research", priority: "high" },
      { key: "c", title: "[C] Sonraki", kind: "research", priority: "low" },
    ]);
    // One at a time, so the third task is still waiting when the second failure halts the goal.
    await approve(o, goalId, ["a", "b", "c"], { maxParallel: 1 });
    await waitFor(() => goalRow(store, goalId).halted_at, 20_000);
    expect(o.goals.state(goalId)).toMatchObject({ status: "needs_you", reason: "halted" });
    const d = decisions(store, goalId).find((x) => x.kind === "stop_rule")!;
    expect(JSON.parse(d.payload)).toMatchObject({ rule: "same_failure", waiting: expect.arrayContaining([ids.a, ids.b]) });
    // Halted: nothing more is released, though a slot is free.
    await o.tick();
    expect(released(store, ids.c!)).toBe(false);
    expect(o.get(ids.c!).goal!.hold).toEqual({ code: "goal.halted" });

    await o.goals.decide(goalId, d.id, "resume");
    await waitFor(() => o.get(ids.c!).status === "done", 20_000);
    expect(goalRow(store, goalId).halted_at).toBeNull();
    expect(decisions(store, goalId).filter((x) => x.kind === "stop_rule")).toHaveLength(1);
  });
});

describe("reports feed writing tasks only after you accept them", () => {
  it("holds a code task until you accept the research report it builds on, then quotes the report", async () => {
    const SUMMARY = "Özet: giriş ekranı büyük İ harfini bozuyor; doğrulama kodu 6 hane olmalı.";
    const { o, store, project, adapter } = await setup({
      pick: writer({ "[K]": { file: "src/giriş.ts", text: "export const kod = 6;\n" } }),
      result: (role) => (role === "researcher" ? findings(SUMMARY) : role === "reviewer" ? verdict("pass") : undefined),
    });
    const { goalId, ids } = await seedGoal(o, store, project.id, [
      { key: "r", title: "[R] Mevcut girişi araştır", kind: "research" },
      { key: "k", title: "[K] Doğrulamayı ekle", kind: "code", deps: ["r"] },
    ]);
    await approve(o, goalId, ["r", "k"]);
    await waitFor(() => o.get(ids.r!).status === "done", 20_000);
    await o.tick();
    expect(released(store, ids.k!)).toBe(false);
    expect(o.get(ids.k!).goal!.hold).toEqual({ code: "goal.waits_report", params: { task: "01", taskId: ids.r } });
    expect(o.goals.state(goalId)).toMatchObject({ status: "needs_you", reason: "report" });
    expect(await o.goals.goalPrompt(o.db.task(ids.k!))).not.toContain("büyük İ harfini");

    expect(await goalRefusal(Promise.resolve().then(() => o.goals.acceptReport(goalId, ids.k!)))).toMatchObject({ code: "goal.not_report" });
    o.goals.acceptReport(goalId, ids.r!);
    await waitFor(() => adapter.started.find((s) => titleOf(s.req).includes("[K]")), 20_000);
    const prompt = adapter.started.find((s) => titleOf(s.req).includes("[K]"))!.req.prompt;
    expect(prompt).toContain("Task 01 ([R] Mevcut girişi araştır) reported, as data:");
    expect(prompt).toContain(SUMMARY);
    // Accepting twice changes nothing.
    o.goals.acceptReport(goalId, ids.r!);
    expect(rows(store, "select 1 from events where kind = 'goal.report_accepted'")).toHaveLength(1);
  });

  it("refuses to accept a report that is not done yet", async () => {
    const { o, store, project } = await setup({ pick: (role) => [running, { awaitAnswer: "never" }, say(role)] });
    const { goalId, ids } = await seedGoal(o, store, project.id, [
      { key: "r", title: "[R] Araştır", kind: "research" },
      { key: "k", title: "[K] Kodla", kind: "code", deps: ["r"] },
    ]);
    await approve(o, goalId, ["r", "k"]);
    expect(await goalRefusal(Promise.resolve().then(() => o.goals.acceptReport(goalId, ids.r!)))).toMatchObject({ code: "goal.report_not_done" });
  });
});

describe("the goal branch and its last review", () => {
  it("merges a docs-only goal into its goal branch, runs the pinned last review, and the PR gate needs that pass", async () => {
    const { o, store, project, adapter, repo } = await setup({ pick: writer({ "[D]": { file: "docs/kullanım kılavuzu.md", text: "# Kılavuz\n\nİki adımlı doğrulama.\n" } }) });
    const { goalId, ids } = await seedGoal(o, store, project.id, [{ key: "d", title: "[D] Kılavuzu güncelle", kind: "docs", paths: ["docs/kullanım kılavuzu.md"] }]);
    await approve(o, goalId, ["d"]);
    const integration = goalRow(store, goalId).integration_task_id!;
    expect(o.get(integration)).toMatchObject({ kind: "code", goal: { goalId, role: "integration", hidden: true } });
    expect(o.get(integration).crew!.members.map((m) => [m.role, m.writesCode])).toEqual([["reviewer", false]]);
    // The last review waits until every writing task joined.
    expect(o.get(integration).status).toBe("proposed");

    await waitFor(() => joinedSha(store, ids.d!), 30_000);
    const branch = goalBranch(store, goalId);
    // The docs step did not commit; its work was committed in its own worktree and merged.
    expect((await git(repo, "show", `${branch}:docs/kullanım kılavuzu.md`)).replace(/\r\n/g, "\n")).toBe("# Kılavuz\n\nİki adımlı doğrulama.\n");
    const head = (await git(repo, "rev-parse", branch)).trim();
    expect(joinedSha(store, ids.d!)).toBe(head);

    await waitFor(() => o.goals.state(goalId).status === "ready_for_review", 30_000);
    const review = adapter.started.find((s) => s.role === "reviewer")!;
    expect(review.req.prompt).toContain(`last review of all changes of the goal, merged into branch ${branch}`);
    expect(o.get(integration).loop.verdicts).toMatchObject([{ verdict: "pass", headSha: head }]);
    expect(o.get(integration).status).toBe("review");

    // The existing PR gate for the goal branch includes the pinned review, and passes it for this head.
    const tasks = o as unknown as TaskSource;
    const flow = new PrFlow({ store, service: { repoRef: () => null } as unknown as GithubService, client: {} as GithubClient, tasks: () => tasks, projectPath: () => repo, emit: () => undefined });
    expect(flow.reviewedHead(project.id, branch, head)).toBe("pass");
    const draft = await flow.draft(o.get(integration));
    expect(draft.head).toBe(branch);
    expect(draft.gate.items.find((i) => i.id === "reviewed")).toEqual({ id: "reviewed", status: "pass" });
    expect(draft.gate.items.find((i) => i.id === "review")).toEqual({ id: "review", status: "pass" });

    // Anything that moves the goal branch after the review leaves the gate without a pass.
    const gwt = o.get(integration).worktree!.path;
    writeFileSync(join(gwt, "elle eklenen.txt"), "x\n");
    await git(gwt, "add", "-A");
    await git(gwt, "commit", "-q", "-m", "elle");
    expect(flow.reviewedHead(project.id, branch, (await git(repo, "rev-parse", branch)).trim())).toBe("stale");
    expect((await flow.draft(o.get(integration))).gate.items.find((i) => i.id === "reviewed")).toEqual({ id: "reviewed", status: "fail" });
    // Goal task branches stay out of the PR list; the integration task owns the goal branch.
    expect((await flow.views(project.id).catch(() => [])).map((v) => v.taskId)).not.toContain(ids.d);
  });

  it("raises a conflict decision, and the follow-up re-runs Test and Review before the merge", async () => {
    const tests = join(tempDir("crewyard goal tests-"), "testler geçer.mjs");
    writeFileSync(tests, "console.log('tamam');\n");
    const pick: Picker = (role, req, resumed) => {
      if (resumed && req.prompt.includes("conflicts with the goal branch")) {
        writeFileSync(join(req.cwd, "README.md"), "X içerik\n");
        return [running, say("birleştirdim")];
      }
      return writer({ "[X]": { file: "README.md", text: "X içerik\n" }, "[Y]": { file: "README.md", text: "Y içerik\n", extra: [{ wait: 400 }] } })(role, req, resumed);
    };
    const { o, store, project, adapter } = await setup({
      pick,
      config: (c) => {
        c.commands.test = `node "${tests}"`;
      },
    });
    const { goalId, ids } = await seedGoal(o, store, project.id, [
      { key: "x", title: "[X] Sunucu", kind: "code", paths: ["src/x.ts"] },
      { key: "y", title: "[Y] Arayüz", kind: "code", mode: "crew", size: "S", paths: ["src/y.ts"] },
    ]);
    await approve(o, goalId, ["x", "y"]);
    const conflict = await waitFor(() => decisions(store, goalId).find((d) => d.kind === "conflict"), 40_000);
    expect(joinedSha(store, ids.x!)).not.toBeNull();
    expect([conflict.task_id, JSON.parse(conflict.payload)]).toEqual([ids.y, { paths: ["README.md"] }]);
    expect(o.get(ids.y!).goal!.hold).toMatchObject({ code: "goal.conflict", params: { paths: "README.md" } });
    expect(o.goals.state(goalId)).toMatchObject({ status: "needs_you", reason: "decision" });
    // Asked once: the merge is not retried while the decision is open.
    await o.tick();
    expect(decisions(store, goalId).filter((d) => d.kind === "conflict")).toHaveLength(1);

    // "I'll merge it" keeps the decision open for Check again.
    await o.goals.decide(goalId, conflict.id, "merge_myself");
    expect(decisions(store, goalId).find((d) => d.id === conflict.id)!.answered_at).toBeNull();

    await o.goals.decide(goalId, conflict.id, "send_to_implementer");
    await waitFor(() => joinedSha(store, ids.y!), 40_000);
    const y = o.get(ids.y!);
    // The implementer got one more run in its own session; Test and Review ran again on the new head.
    expect(y.runs.filter((r) => r.role === "implementer")).toHaveLength(2);
    expect(y.runs.filter((r) => r.role === "reviewer")).toHaveLength(2);
    expect(y.loop.decisions.filter((d) => d.kind === "tests_passed")).toHaveLength(2);
    const followUp = adapter.started.find((s) => s.resumed && s.req.prompt.includes("conflicts with the goal branch"))!;
    expect(followUp.req.prompt).toContain("README.md");
    expect(rows<{ task_id: string; outcome: string }>(store, "select task_id, outcome from goal_joins where goal_id = ? order by at, rowid", goalId).map((j) => [j.task_id, j.outcome])).toEqual([
      [ids.x, "joined"],
      [ids.y, "conflict"],
      [ids.y, "joined"],
    ]);
    expect(decisions(store, goalId).find((d) => d.id === conflict.id)!.answer).toBe("send_to_implementer");
  });

  it("asks you when the last review wants changes, and never replans by itself", async () => {
    const { o, store, project, adapter } = await setup({
      pick: writer({ "[A]": { file: "a.txt", text: "A\n" } }),
      result: (role) => (role === "reviewer" ? verdict("changes") : undefined),
    });
    const { goalId } = await seedGoal(o, store, project.id, [{ key: "a", title: "[A] Sunucu", kind: "code" }]);
    await approve(o, goalId, ["a"]);
    const d = await waitFor(() => decisions(store, goalId).find((x) => x.kind === "changes"), 40_000);
    expect(JSON.parse(d.payload)).toMatchObject({ detail: "Bir hata var.", findings: expect.stringContaining("Boş girişi ele al.") });
    await o.tick();
    await o.settle();
    expect(adapter.started.filter((s) => s.role === "reviewer")).toHaveLength(1);
    expect(o.goals.state(goalId)).toMatchObject({ status: "needs_you", reason: "decision" });
    // Replan is recorded as your answer; the planning run itself is goals.replan's.
    await o.goals.decide(goalId, d.id, "replan");
    expect(decisions(store, goalId).find((x) => x.id === d.id)!.answer).toBe("replan");
    expect(rows(store, "select 1 from tasks where title like 'Hedef%'")).toEqual([]);
  });

  it("leaves the conflicted task out of the goal on your answer", async () => {
    const { o, store, project } = await setup({ pick: writer({ "[X]": { file: "README.md", text: "X\n" }, "[Y]": { file: "README.md", text: "Y\n", extra: [{ wait: 300 }] } }) });
    const { goalId, ids } = await seedGoal(o, store, project.id, [
      { key: "x", title: "[X] Sunucu", kind: "code", paths: ["src/x.ts"] },
      { key: "y", title: "[Y] Arayüz", kind: "code", paths: ["src/y.ts"] },
    ]);
    await approve(o, goalId, ["x", "y"]);
    const conflict = await waitFor(() => decisions(store, goalId).find((d) => d.kind === "conflict"), 40_000);
    await o.goals.decide(goalId, conflict.id, "leave_out");
    expect(o.get(ids.y!).status).toBe("cancelled");
    expect(row<{ d: string | null }>(store, "select discarded_at as d from goal_tasks where task_id = ?", ids.y!).d).not.toBeNull();
    await waitFor(() => o.goals.state(goalId).status === "ready_for_review", 40_000);
  });
});

describe("stop", () => {
  it("previews and cancels every unfinished task of the goal, keeping worktrees", async () => {
    const pick: Picker = (role) => [running, { awaitAnswer: "never" }, say(role)];
    const { o, store, project } = await setup({ pick });
    const { goalId, ids } = await seedGoal(o, store, project.id, [
      { key: "a", title: "[A] Sunucu", kind: "code" },
      { key: "b", title: "[B] Arayüz", kind: "code", deps: ["a"] },
    ]);
    await approve(o, goalId, ["a", "b"]);
    await waitFor(() => o.get(ids.a!).runs[0]);
    expect(o.goals.stopPreview(goalId)).toMatchObject({ cancelTasks: 3, runningRuns: 1 });
    await o.goals.stop(goalId);
    expect([o.get(ids.a!).status, o.get(ids.b!).status, o.get(goalRow(store, goalId).integration_task_id!).status]).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(o.goals.state(goalId).status).toBe("stopped");
    expect(existsSync(o.get(ids.a!).worktree!.path)).toBe(true);
    expect(await goalRefusal(approve(o, goalId, ["a", "b"]))).toMatchObject({ code: "goal.stopped" });
    expect(await goalRefusal(o.goals.pause(goalId))).toMatchObject({ code: "goal.stopped" });
  });
});
