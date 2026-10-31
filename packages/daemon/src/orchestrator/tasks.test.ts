import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultProjectConfig, type IpcMessage, type ProjectConfig, type StartRequest } from "@crewyard/core";
import type { FakeStep } from "@crewyard/adapter-fake";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHandlers, handleMessage } from "../server.ts";
import { Store } from "../store.ts";
import { AdapterRegistry } from "./adapters.ts";
import { applyCrewEdits, validateCrew, type CrewProblem } from "./crew.ts";
import type { Candidate } from "./directory.ts";
import { OrchestratorError } from "./errors.ts";
import { orchestratorFor } from "./index.ts";
import { Orchestrator, type OrchestratorOptions } from "./orchestrator.ts";
import { ROLES } from "./roles.ts";
import type { TaskFlow } from "./tasks.ts";
import { CANDIDATES, candidate, cleanTemps, git, model, ScriptedAdapter, tempDir, tempRepo, waitFor } from "./testing.ts";

// TaskFlow's run modes, the goal guard and Solo's Start (docs/adr/0019), over a real store and a
// repo whose path has spaces, with scripted runners.

vi.setConfig({ testTimeout: 40_000, hookTimeout: 30_000 });

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
const quick: Picker = (role) => [running, say(`${role} done`)];

/**
 * Runs once, the next time anything asks the directory for candidates, before they are returned:
 * the await every TaskFlow call makes before it writes, where another call can interleave.
 */
type DirectoryHook = { next: ((call: number) => void | Promise<void>) | null; calls: number };

async function setup(opts: { pick?: Picker; candidates?: Candidate[]; config?: (c: ProjectConfig) => void } = {}) {
  const root = tempDir("crewyard tasks flow-");
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
  const project = store.addProject(repo, "demo repo with spaces");
  const adapter = new ScriptedAdapter(opts.pick ?? quick);
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const cands = opts.candidates ?? CANDIDATES();
  const hook: DirectoryHook = { next: null, calls: 0 };
  const options: OrchestratorOptions = {
    store,
    dataDir: join(root, "data"),
    emit: () => undefined,
    adapters,
    directory: {
      candidates: async () => {
        hook.calls++;
        const fn = hook.next;
        hook.next = null;
        await fn?.(hook.calls);
        return cands;
      },
      envFor: () => ({}),
    },
    tickMs: 0,
    freeMemoryMb: () => 64_000,
    stopTimeoutMs: 2_000,
  };
  const o = new Orchestrator(options);
  o.start();
  open.push({ o, store });
  return { o, store, project, adapter, cands, root, repo, hook };
}

/** The part itself, for the calls only other parts make (a goal's materialisation and edits). */
const flowOf = (o: Orchestrator): TaskFlow => (o as unknown as { taskFlow: TaskFlow }).taskFlow;

const refusal = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof OrchestratorError)) throw new Error(`expected a refusal, got ${String(err)}`);
  return err.code;
};

const q = (store: Store, sql: string, ...args: Array<string | number | null>) => store.db.prepare(sql).run(...args);
const count = (store: Store, table: string) => Number((store.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n);
const events = (store: Store, taskId: string, kind: string) => (store.db.prepare("select payload from events where task_id = ? and kind = ? order by seq").all(taskId, kind) as Array<{ payload: string }>).map((r) => JSON.parse(r.payload) as Record<string, unknown>);

/** A goal with one plan revision, as the planner (work item 3) will write it. */
function seedGoal(store: Store, projectId: string, opts: { planTask?: string; integrationTask?: string; collapsedTask?: string } = {}): void {
  q(store, "insert into goals (id, project_id, text, title, budget_usd, integration_task_id, collapsed_task_id, created_at) values ('g1', ?, 'Giriş sayfasına iki adımlı doğrulama ekle', 'İki adımlı doğrulama', 3, ?, ?, 'now')", projectId, opts.integrationTask ?? null, opts.collapsedTask ?? null);
  q(store, "insert into goal_plans (id, goal_id, revision, cause, plan_task_id, plan, created_at) values ('r1', 'g1', 1, 'initial', ?, '{}', 'now')", opts.planTask ?? null);
}

function seedGoalTask(store: Store, taskId: string, key: string, mode: "solo" | "crew" = "crew"): void {
  q(store, "insert into goal_tasks (task_id, goal_id, plan_id, key, position, mode, priority, basis, basis_matched, reason, paths, writes, accepted) values (?, 'g1', 'r1', ?, 0, ?, 'high', 'iki adımlı doğrulama', 1, 'r', '[\"src/user guide/\"]', 1, 1)", taskId, key, mode);
}

const CODE_TR = { title: "Giriş hatasındaki yazım yanlışını düzelt", description: "Kullanıcı ğ, ş ve İ harflerini görmeli." };

describe("run modes", () => {
  it("drafts a Solo task as one step of the kind's main role and records the mode", async () => {
    const { o, store, project } = await setup();
    const expected = { code: "implementer", research: "researcher", review: "reviewer", docs: "docs" } as const;
    for (const kind of ["code", "research", "review", "docs"] as const) {
      const t = await o.propose({ projectId: project.id, ...CODE_TR, kind, size: "L", mode: "solo" });
      expect(t.crew!.members.map((m) => [m.role, m.dependsOn])).toEqual([[expected[kind], []]]);
      expect(events(store, t.id, "task.proposed")[0]).toMatchObject({ kind, mode: "solo" });
    }
    // No mode, or a mode nobody knows, is a full crew, which never starts without approval.
    const crew = await o.propose({ projectId: project.id, ...CODE_TR, kind: "code", size: "M" });
    expect(crew.crew!.members.map((m) => m.role)).toEqual(["planner", "implementer", "tester", "reviewer"]);
    const odd = await o.propose({ projectId: project.id, ...CODE_TR, kind: "code", size: "M", mode: "swarm" as never });
    expect(odd.crew!.members).toHaveLength(4);
    expect(events(store, odd.id, "task.proposed")[0]).toMatchObject({ mode: "crew" });
  });

  it("keeps the mode when a new kind is drafted again", async () => {
    const { o, store, project } = await setup();
    const solo = await o.propose({ projectId: project.id, ...CODE_TR, kind: "code", size: "M", mode: "solo" });
    const docs = await o.edit(solo.id, { kind: "docs" });
    expect(docs.crew!.members.map((m) => m.role)).toEqual(["docs"]);
    expect(events(store, solo.id, "task.edited")[0]).toMatchObject({ kind: "docs", mode: "solo" });
    const back = await o.edit(solo.id, { kind: "code" });
    expect(back.crew!.members.map((m) => m.role)).toEqual(["implementer"]);

    const crew = await o.propose({ projectId: project.id, ...CODE_TR, kind: "research", size: "M" });
    expect((await o.edit(crew.id, { kind: "code" })).crew!.members.map((m) => m.role)).toEqual(["planner", "implementer", "tester", "reviewer"]);
  });

  it("drafts a goal task again in the mode its plan chose, when the goal's own code edits it", async () => {
    const { o, store, project } = await setup();
    const t = await o.propose({ projectId: project.id, ...CODE_TR, kind: "research", size: "M" });
    seedGoal(store, project.id);
    seedGoalTask(store, t.id, "server", "solo");
    expect((await flowOf(o).edit(t.id, { kind: "code" }, { byGoal: true })).crew!.members.map((m) => m.role)).toEqual(["implementer"]);
  });
});

describe("goal tasks start with their plan", () => {
  it("refuses tasks.approve on a waiting goal task and on the goal's integration task", async () => {
    const { o, store, project, adapter } = await setup();
    const planned = await o.propose({ projectId: project.id, ...CODE_TR, kind: "code", size: "S" });
    const integration = await o.propose({ projectId: project.id, title: "Son inceleme", kind: "code", size: "S" });
    seedGoal(store, project.id, { integrationTask: integration.id });
    seedGoalTask(store, planned.id, "server");
    for (const id of [planned.id, integration.id]) {
      const err = await o.approve({ taskId: id }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OrchestratorError);
      expect((err as OrchestratorError).code).toBe("task.goal_managed");
      expect(o.get(id).crew!.approvedAt).toBeNull();
    }
    // Edits do not get around it either, and nothing was launched or audited as approved.
    const impl = planned.crew!.members[0]!;
    await expect(o.approve({ taskId: planned.id, edits: [{ memberId: impl.id, profileId: "deepseek-key" }] })).rejects.toThrow("task.goal_managed");
    await o.settle();
    expect(adapter.started).toEqual([]);
    expect(events(store, planned.id, "task.approved")).toEqual([]);
  });

  it("refuses it through the IPC handler with the error code", async () => {
    const root = tempDir("crewyard tasks ipc-");
    const repo = await tempRepo(root, "demo repo with spaces");
    const store = new Store(join(root, "t.db"));
    const ctx = { store, info: { startedAt: "now", dbPath: "t.db", dataDir: root }, emit: () => {} };
    const o = orchestratorFor(ctx, { tickMs: 0 });
    open.push({ o, store });
    const handlers = createHandlers(ctx);
    const call = (id: number, method: string, params: unknown) => handleMessage(handlers, { kind: "request", id, method, params } as IpcMessage);
    const project = store.addProject(repo, "demo repo with spaces");
    const proposed = (await call(1, "tasks.propose", { projectId: project.id, title: "Araştır" })) as { ok: true; result: { id: string } };
    seedGoal(store, project.id);
    seedGoalTask(store, proposed.result.id, "research");
    expect(await call(2, "tasks.approve", { taskId: proposed.result.id })).toMatchObject({ ok: false, error: "task.goal_managed" });
  });

  it("refuses tasks.edit and crew.edit on a goal task before the goal releases it", async () => {
    const { o, store, project } = await setup();
    const t = await o.propose({ projectId: project.id, ...CODE_TR, kind: "code", size: "S" });
    seedGoal(store, project.id);
    seedGoalTask(store, t.id, "server");
    const before = o.get(t.id);
    expect(await refusal(o.edit(t.id, { kind: "docs" }))).toBe("task.goal_managed");
    expect(await refusal(o.edit(t.id, { title: "Başka bir iş", description: "Plan dışı" }))).toBe("task.goal_managed");
    expect(await refusal(o.crew.edit(t.id, { kind: "add_step", role: "docs", after: ["implementer"] }))).toBe("task.goal_managed");
    const after = o.get(t.id);
    expect([after.title, after.kind, after.crew!.members.map((m) => [m.id, m.role])]).toEqual([before.title, before.kind, before.crew!.members.map((m) => [m.id, m.role])]);
    expect(events(store, t.id, "task.edited")).toEqual([]);
    expect(events(store, t.id, "crew.edited")).toEqual([]);

    // Released (its crew approved by the goal), it is an approved crew like any other and meets
    // the ordinary rules: a follow-up waits for a finished step.
    q(store, "update crews set approved_at = 'now' where task_id = ?", t.id);
    await expect(o.crew.edit(t.id, { kind: "add_step", role: "docs", after: ["implementer"] })).rejects.toThrow("crew.not_finished");
  });

  it("refuses crew.edit on a goal task through the IPC handler", async () => {
    const root = tempDir("crewyard tasks ipc-");
    const repo = await tempRepo(root, "demo repo with spaces");
    const store = new Store(join(root, "t.db"));
    const ctx = { store, info: { startedAt: "now", dbPath: "t.db", dataDir: root }, emit: () => {} };
    const o = orchestratorFor(ctx, { tickMs: 0 });
    open.push({ o, store });
    const handlers = createHandlers(ctx);
    const call = (id: number, method: string, params: unknown) => handleMessage(handlers, { kind: "request", id, method, params } as IpcMessage);
    const project = store.addProject(repo, "demo repo with spaces");
    const proposed = (await call(1, "tasks.propose", { projectId: project.id, title: "Araştır" })) as { ok: true; result: { id: string } };
    seedGoal(store, project.id);
    seedGoalTask(store, proposed.result.id, "research");
    expect(await call(2, "crew.edit", { taskId: proposed.result.id, edit: { kind: "add_step", role: "docs", after: ["researcher"] } })).toMatchObject({ ok: false, error: "task.goal_managed" });
  });

  it("refuses an approve when a goal claims the task while approve awaits the directory", async () => {
    const { o, store, project, hook, adapter } = await setup();
    const t = await o.propose({ projectId: project.id, ...CODE_TR, kind: "code", size: "S" });
    hook.next = () => {
      seedGoal(store, project.id);
      seedGoalTask(store, t.id, "server");
    };
    expect(await refusal(o.approve({ taskId: t.id }))).toBe("task.goal_managed");
    expect(o.get(t.id).crew!.approvedAt).toBeNull();
    expect(events(store, t.id, "task.approved")).toEqual([]);
    await o.settle();
    expect(adapter.started).toEqual([]);
  });

  it("writes the goal row in the transaction that creates the task", async () => {
    const { o, store, project } = await setup();
    seedGoal(store, project.id);
    let seen: string | null = null;
    const t = await flowOf(o).propose(
      { projectId: project.id, ...CODE_TR, kind: "code", size: "S" },
      {
        inTx: (id) => {
          seen = id;
          seedGoalTask(store, id, "server");
        },
      },
    );
    expect(seen).toBe(t.id);
    expect(await refusal(o.approve({ taskId: t.id }))).toBe("task.goal_managed");
    // A hook that fails takes the task with it: no task is ever left without its goal row.
    const tasks = count(store, "tasks");
    const failing = () => {
      throw new Error("goal row refused");
    };
    await expect(flowOf(o).propose({ projectId: project.id, title: "Yarım kalan", kind: "docs" }, { inTx: failing })).rejects.toThrow("goal row refused");
    expect([count(store, "tasks"), count(store, "crews")]).toEqual([tasks, tasks]);
  });

  it("lets a collapsed goal's one task and the planning task through: they are ordinary tasks", async () => {
    const { o, store, project } = await setup();
    const collapsed = await o.propose({ projectId: project.id, ...CODE_TR, kind: "research", size: "M" });
    const planning = await o.propose({ projectId: project.id, title: "Hedefi planla", kind: "research", size: "M" });
    seedGoal(store, project.id, { collapsedTask: collapsed.id, planTask: planning.id });
    expect((await o.approve({ taskId: collapsed.id })).crew!.approvedAt).not.toBeNull();
    expect((await o.approve({ taskId: planning.id })).crew!.approvedAt).not.toBeNull();
  });
});

describe("one approval per crew", () => {
  it("lets exactly one of two concurrent approvals through", async () => {
    const { o, store, project } = await setup();
    const t = await o.propose({ projectId: project.id, ...CODE_TR, kind: "code", size: "S" });
    const impl = t.crew!.members.find((m) => m.role === "implementer")!;
    const rev = t.crew!.members.find((m) => m.role === "reviewer")!;
    const other = CANDIDATES().find((c) => c.profile.id !== impl.chosen!.profileId && c.profile.id !== rev.chosen!.profileId)!.profile.id;
    const results = await Promise.allSettled([o.approve({ taskId: t.id }), o.approve({ taskId: t.id, edits: [{ memberId: impl.id, profileId: other }] })]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(((results[1] as PromiseRejectedResult).reason as OrchestratorError).code).toBe("task.not_proposed");
    expect(events(store, t.id, "task.approved")).toHaveLength(1);
    // The losing call's edit was never written: the stored crew is the one that was approved.
    expect(o.get(t.id).crew!.members.find((m) => m.id === impl.id)!.chosen!.profileId).toBe(impl.chosen!.profileId);
  });

  it("refuses an approve when the task is cancelled while approve awaits the directory", async () => {
    const { o, store, project, hook } = await setup();
    const t = await o.propose({ projectId: project.id, ...CODE_TR, kind: "code", size: "S" });
    hook.next = () => {
      q(store, "update tasks set cancelled_at = 'now' where id = ?", t.id);
    };
    expect(await refusal(o.approve({ taskId: t.id }))).toBe("task.cancelled");
    expect(o.get(t.id).crew!.approvedAt).toBeNull();
  });

  it("refuses an edit whose crew was approved while the new kind was drafted", async () => {
    const { o, store, project, hook } = await setup();
    const t = await o.propose({ projectId: project.id, ...CODE_TR, kind: "code", size: "S" });
    hook.next = async () => {
      await o.approve({ taskId: t.id });
    };
    expect(await refusal(o.edit(t.id, { kind: "docs" }))).toBe("task.not_proposed");
    const after = o.get(t.id);
    // The approved crew is still the one that was approved, not a re-draft nobody approved.
    expect([after.kind, after.crew!.approvedAt !== null, after.crew!.members.map((m) => m.id)]).toEqual(["code", true, t.crew!.members.map((m) => m.id)]);
    expect(events(store, t.id, "task.edited")).toEqual([]);
  });
});

describe("validateCrew matches approve's refusals case by case", () => {
  /** What approve throws for the task, or null when it approved. */
  const approveResult = async (o: Orchestrator, taskId: string, edits?: Array<{ memberId: string; profileId: string }>): Promise<CrewProblem | null> => {
    try {
      await o.approve({ taskId, ...(edits ? { edits } : {}) });
      return null;
    } catch (err) {
      if (!(err instanceof OrchestratorError)) throw err;
      return { code: err.code as CrewProblem["code"], params: err.params };
    }
  };

  /** What the pure functions say about the stored proposal, as approve applies them. */
  const pureResult = (o: Orchestrator, taskId: string, candidates: Candidate[], edits: Array<{ memberId: string; profileId: string }> = []): CrewProblem | null => {
    const crew = o.get(taskId).crew!;
    const members = crew.members.map((m) => ({ id: m.id, role: m.role, template: ROLES[m.role as keyof typeof ROLES] }));
    let views = new Map(crew.members.map((m) => [m.id, m.chosen]));
    const scoring = { size: "S" as const, budgetUsd: null, hasAdapter: () => true, headroom: () => ({ pct: null, window: null, provenance: "unknown" as const }), history: () => ({ accepted: 0, total: 0 }), preference: () => 0 };
    if (edits.length > 0) {
      const r = applyCrewEdits({ members, views, candidates, edits, scoring });
      if (!r.ok) return r.problem;
      views = r.views;
    }
    return validateCrew({ members, views, candidates });
  };

  it("agrees on every refusal, with the same code and params", async () => {
    const cands = CANDIDATES();
    const { o, project } = await setup({ candidates: cands });
    const propose = () => o.propose({ projectId: project.id, ...CODE_TR, kind: "code", size: "S" });
    const t = await propose();
    const impl = t.crew!.members.find((m) => m.role === "implementer")!;
    const rev = t.crew!.members.find((m) => m.role === "reviewer")!;
    const spare = cands.find((c) => c.profile.id !== impl.chosen!.profileId && c.profile.id !== rev.chosen!.profileId)!.profile.id;

    // Each expectation is the old approve's literal refusal (its code and params, in its order of
    // checks: the edits one by one, then every member in crew order), not a value computed here.
    const agree = async (name: string, expected: CrewProblem, edits?: Array<{ memberId: string; profileId: string }>) => {
      expect(await approveResult(o, t.id, edits), name).toEqual(expected);
      expect(pureResult(o, t.id, cands, edits), name).toEqual(expected);
    };
    await agree("member not in the crew", { code: "crew.member_not_found", params: { memberId: "not-a-member" } }, [{ memberId: "not-a-member", profileId: spare }]);
    await agree("edit to a profile that does not exist", { code: "crew.unknown_profile", params: { profileId: "deleted-profile" } }, [{ memberId: impl.id, profileId: "deleted-profile" }]);
    await agree("reviewer edited onto the implementer's model", { code: "crew.independence", params: { role: "reviewer" } }, [{ memberId: rev.id, profileId: impl.chosen!.profileId }]);
    await agree("two bad edits: the first one is reported", { code: "crew.member_not_found", params: { memberId: "not-a-member" } }, [
      { memberId: "not-a-member", profileId: spare },
      { memberId: impl.id, profileId: "deleted-profile" },
    ]);

    // A read-only profile edited into the writing role.
    const ro = cands.findIndex((c) => c.profile.id === spare);
    cands[ro] = { ...cands[ro]!, readOnly: true };
    const edits = [{ memberId: impl.id, profileId: spare }];
    await agree("read-only profile edited into the writing role", { code: "crew.read_only_profile", params: { profileId: spare, role: "implementer" } }, edits);
    // An edit to a profile that is there but cannot take the role (not ready).
    cands[ro] = { ...cands[ro]!, readOnly: false, ready: false };
    await agree("profile that is not ready", { code: "crew.unknown_profile", params: { profileId: spare } }, edits);
    cands[ro] = { ...cands[ro]!, ready: true };

    // The implementer's own profile marked read-only after the proposal.
    const mine = cands.findIndex((c) => c.profile.id === impl.chosen!.profileId);
    const before = cands[mine]!;
    cands[mine] = { ...before, readOnly: true };
    await agree("implementer's profile turned read-only", { code: "crew.read_only_profile", params: { profileId: impl.chosen!.profileId, role: "implementer" } });
    // Two problems at once: that, plus the reviewer moved onto the implementer's model. The old
    // loop met the implementer first, so the read-only refusal is the one reported.
    await agree("read-only implementer and a reviewer on its model", { code: "crew.read_only_profile", params: { profileId: impl.chosen!.profileId, role: "implementer" } }, [{ memberId: rev.id, profileId: impl.chosen!.profileId }]);
    cands[mine] = before;

    // A profile that vanished after the proposal: approve never refused that, and still does not.
    cands.splice(mine, 1);
    expect(pureResult(o, t.id, cands)).toBeNull();
    expect(await approveResult(o, t.id)).toBeNull();
    expect(o.get(t.id).crew!.approvedAt).not.toBeNull();
  });

  it("agrees on a crew with no profile at all", async () => {
    const { o, project } = await setup({ candidates: [] });
    const t = await o.propose({ projectId: project.id, ...CODE_TR, kind: "research", size: "M" });
    const fromApprove = await approveResult(o, t.id);
    expect(fromApprove).toEqual({ code: "crew.missing_profile", params: { role: "researcher" } });
    expect(fromApprove).toEqual(pureResult(o, t.id, []));
  });

  it("keeps refusing a reviewer that shares a Best of N variant's model", async () => {
    const cands = CANDIDATES();
    const { o, project } = await setup({ candidates: cands });
    const t = await o.propose({ projectId: project.id, ...CODE_TR, kind: "code", size: "S", bestOf: 2 });
    const rev = t.crew!.members.find((m) => m.role === "reviewer")!;
    const variants = t.bestOfGroup!.variants.map((v) => v.candidate.profileId);
    await expect(o.approve({ taskId: t.id, edits: [{ memberId: rev.id, profileId: variants[1]! }] })).rejects.toThrow("crew.independence");
  });
});

describe("Solo's Start", () => {
  const priced = (id: string, providerId: string) => candidate(id, providerId, model(`${id}-model`, { cost: { input: 1, output: 2, cacheRead: 0.1 } }));

  it("proposes and approves one step in one call when the estimate is known and fits", async () => {
    const { o, store, project, adapter } = await setup({ candidates: [priced("key-a", "anthropic")] });
    const res = await o.startTask({ projectId: project.id, ...CODE_TR, kind: "research", size: "S" });
    expect(res.started).toBe(true);
    expect(res.held).toBeNull();
    expect(res.task.crew!.members.map((m) => m.role)).toEqual(["researcher"]);
    expect(res.task.crew!.approvedAt).not.toBeNull();
    expect(res.task.crew!.estimate.provenance).toBe("estimated");
    expect(events(store, res.task.id, "task.approved")[0]).toMatchObject({ by: "start" });
    await waitFor(() => adapter.started.find((s) => s.role === "researcher"));
  });

  it("treats a plan sign-in ($0 Estimated) as known", async () => {
    const { o, project } = await setup({ candidates: [candidate("plan-a", "openai", model("gpt-5"), "plan_signin")] });
    const res = await o.startTask({ projectId: project.id, ...CODE_TR, kind: "research", size: "S" });
    expect(res).toMatchObject({ started: true, held: null });
    expect(res.task.crew!.estimate).toEqual({ usd: 0, provenance: "estimated" });
  });

  it("returns the proposal when the estimate is Unknown", async () => {
    const { o, store, project, adapter } = await setup({ candidates: [candidate("mystery", "local", null)] });
    const res = await o.startTask({ projectId: project.id, ...CODE_TR, kind: "research", size: "S" });
    expect(res).toMatchObject({ started: false, held: { code: "estimate_unknown" } });
    expect(res.task.status).toBe("proposed");
    expect(res.task.crew!.approvedAt).toBeNull();
    expect(events(store, res.task.id, "task.start_held")[0]).toEqual({ hold: { code: "estimate_unknown" } });
    await o.settle();
    expect(adapter.started).toEqual([]);
    // Your click on the proposal is what starts it.
    expect((await o.approve({ taskId: res.task.id })).crew!.approvedAt).not.toBeNull();
  });

  it("returns the proposal when the step would pass the task's budget", async () => {
    const { o, project, adapter } = await setup({ candidates: [priced("key-a", "anthropic")] });
    const res = await o.startTask({ projectId: project.id, ...CODE_TR, kind: "research", size: "L", budgetUsd: 0.01 });
    expect(res).toMatchObject({ started: false, held: { code: "over_cap", params: { cap: "task_budget" } } });
    expect(res.task.crew!.approvedAt).toBeNull();
    await o.settle();
    expect(adapter.started).toEqual([]);
  });

  it("returns the proposal when the step would pass the key's daily cap", async () => {
    const { o, store, project } = await setup({ candidates: [{ ...priced("key-a", "deepseek"), credentialId: "cred-a" }] });
    q(store, "insert into credentials (id, alias, provider_id, kind, daily_cap_usd, task_cap_usd, created_at) values ('cred-a', 'a', 'deepseek', 'api_key', 0.0001, null, '2026-10-30T00:00:00Z')");
    const res = await o.startTask({ projectId: project.id, ...CODE_TR, kind: "research", size: "S" });
    expect(res).toMatchObject({ started: false, held: { code: "over_cap", params: { cap: "daily_cap" } } });
  });

  it("returns the proposal with the crew problem when nothing can take the step", async () => {
    const { o, project } = await setup({ candidates: [] });
    const res = await o.startTask({ projectId: project.id, ...CODE_TR, kind: "code", size: "S" });
    expect(res).toMatchObject({ started: false, held: { code: "crew", params: { code: "crew.missing_profile", role: "implementer" } } });
  });

  it("returns the proposal when the step would pass the key's per-task cap", async () => {
    const { o, store, project, adapter } = await setup({ candidates: [{ ...priced("key-a", "deepseek"), credentialId: "cred-a" }] });
    q(store, "insert into credentials (id, alias, provider_id, kind, daily_cap_usd, task_cap_usd, created_at) values ('cred-a', 'a', 'deepseek', 'api_key', null, 0.0001, '2026-10-30T00:00:00Z')");
    const res = await o.startTask({ projectId: project.id, ...CODE_TR, kind: "research", size: "S" });
    expect(res).toMatchObject({ started: false, held: { code: "over_cap", params: { cap: "task_cap" } } });
    expect(res.task.crew!.approvedAt).toBeNull();
    expect(events(store, res.task.id, "task.approved")).toEqual([]);
    await o.settle();
    expect(adapter.started).toEqual([]);
  });

  it("returns the proposal when the profile turns read-only between the check and the approval", async () => {
    const cands = [priced("key-a", "anthropic")];
    const { o, store, project, hook, adapter } = await setup({ candidates: cands });
    // propose drafts (directory call 1), the hold check reads it again (2), then approve (3).
    const turnReadOnly = (call: number): void => {
      if (call < 3) {
        hook.next = turnReadOnly;
        return;
      }
      cands[0] = { ...cands[0]!, readOnly: true };
    };
    hook.next = turnReadOnly;
    const res = await o.startTask({ projectId: project.id, ...CODE_TR, kind: "code", size: "S" });
    expect(res).toMatchObject({ started: false, held: { code: "crew", params: { code: "crew.read_only_profile", profileId: "key-a", role: "implementer" } } });
    expect(res.task.status).toBe("proposed");
    expect(res.task.crew!.approvedAt).toBeNull();
    expect(events(store, res.task.id, "task.start_held")).toHaveLength(1);
    await o.settle();
    expect(adapter.started).toEqual([]);
  });

  it("refuses any mode but Solo and writes nothing", async () => {
    const { o, store, project } = await setup({ candidates: [priced("key-a", "anthropic"), priced("key-b", "openai")] });
    const before = { tasks: count(store, "tasks"), events: count(store, "events") };
    for (const mode of ["crew", "swarm"]) {
      expect(await refusal(o.startTask({ projectId: project.id, ...CODE_TR, kind: "code", size: "M", mode } as never))).toBe("task.start_solo_only");
    }
    expect({ tasks: count(store, "tasks"), events: count(store, "events") }).toEqual(before);
    const solo = await o.startTask({ projectId: project.id, ...CODE_TR, kind: "code", size: "M", mode: "solo" });
    expect(solo.task.crew!.members.map((m) => m.role)).toEqual(["implementer"]);
  });

  it("never takes Best of N or other propose fields nobody declared", async () => {
    const { o, store, project, adapter } = await setup({ candidates: [priced("key-a", "anthropic"), priced("key-b", "openai"), priced("key-c", "google")] });
    const res = await o.startTask({ projectId: project.id, ...CODE_TR, kind: "code", size: "S", bestOf: 3 } as never);
    expect(res.started).toBe(true);
    expect(res.task.bestOfGroup).toBeNull();
    expect(res.task.crew!.members.map((m) => m.role)).toEqual(["implementer"]);
    expect(events(store, res.task.id, "task.proposed")[0]).toMatchObject({ mode: "solo", bestOf: null });
    await waitFor(() => adapter.started.find((s) => s.role === "implementer"));
    await o.settle();
    expect(adapter.started.map((s) => s.role)).toEqual(["implementer"]);
  });
});

describe("tasks.preview", () => {
  it("returns classification, crew and estimate and writes nothing", async () => {
    const { o, store, project } = await setup({ candidates: [candidate("key-a", "anthropic", model("claude-sonnet")), candidate("key-b", "openai", model("gpt-5"))] });
    const before = { tasks: count(store, "tasks"), crews: count(store, "crews"), members: count(store, "crew_members"), events: count(store, "events") };
    const p = await o.preview({ projectId: project.id, ...CODE_TR, kind: "code", size: "S", mode: "solo" });
    expect(p).toMatchObject({ kind: "code", size: "S", mode: "solo", hold: null });
    expect(p.members.map((m) => [m.id, m.role, m.writesCode])).toEqual([["preview-0", "implementer", true]]);
    expect(p.estimate.provenance).toBe("estimated");
    const crew = await o.preview({ projectId: project.id, ...CODE_TR, kind: "code", size: "S" });
    expect(crew.members.map((m) => m.role)).toEqual(["implementer", "reviewer"]);
    expect(crew.mode).toBe("crew");
    expect({ tasks: count(store, "tasks"), crews: count(store, "crews"), members: count(store, "crew_members"), events: count(store, "events") }).toEqual(before);
  });

  it("says when Start would propose instead: Unknown, over a cap, or no profile", async () => {
    const unknown = await setup({ candidates: [candidate("mystery", "local", null)] });
    expect((await unknown.o.preview({ projectId: unknown.project.id, ...CODE_TR, kind: "research", mode: "solo" })).hold).toEqual({ code: "estimate_unknown" });
    const capped = await setup({ candidates: [candidate("key-a", "anthropic", model("claude-sonnet"))] });
    expect((await capped.o.preview({ projectId: capped.project.id, ...CODE_TR, kind: "research", size: "L", mode: "solo", budgetUsd: 0.01 })).hold).toEqual({ code: "over_cap", params: { cap: "task_budget" } });
    const keyCap = await setup({ candidates: [{ ...candidate("key-a", "deepseek", model("deepseek-chat")), credentialId: "cred-a" }] });
    q(keyCap.store, "insert into credentials (id, alias, provider_id, kind, daily_cap_usd, task_cap_usd, created_at) values ('cred-a', 'a', 'deepseek', 'api_key', null, 0.0001, '2026-10-30T00:00:00Z')");
    expect((await keyCap.o.preview({ projectId: keyCap.project.id, ...CODE_TR, kind: "research", mode: "solo" })).hold).toEqual({ code: "over_cap", params: { cap: "task_cap" } });
    const none = await setup({ candidates: [] });
    expect((await none.o.preview({ projectId: none.project.id, ...CODE_TR, kind: "docs", mode: "solo" })).hold).toEqual({ code: "crew", params: { code: "crew.missing_profile", role: "docs" } });
  });

  it("is served with tasks.start through the daemon's handler map", async () => {
    const root = tempDir("crewyard tasks ipc-");
    const repo = await tempRepo(root, "demo repo with spaces");
    const store = new Store(join(root, "t.db"));
    const ctx = { store, info: { startedAt: "now", dbPath: "t.db", dataDir: root }, emit: () => {} };
    const o = orchestratorFor(ctx, { tickMs: 0 });
    open.push({ o, store });
    const handlers = createHandlers(ctx);
    const call = (id: number, method: string, params: unknown) => handleMessage(handlers, { kind: "request", id, method, params } as IpcMessage);
    const project = store.addProject(repo, "demo repo with spaces");
    expect(await call(1, "tasks.preview", { projectId: project.id, title: "Araştır", mode: "solo" })).toMatchObject({ ok: true, result: { mode: "solo", hold: { code: "crew" } } });
    // No providers are wired here, so Start proposes with the reason instead of inventing a profile.
    expect(await call(2, "tasks.start", { projectId: project.id, title: "Araştır" })).toMatchObject({ ok: true, result: { started: false, held: { code: "crew", params: { code: "crew.missing_profile" } } } });
  });
});

describe("Solo code still runs until green", () => {
  /** A test command that fails on its first run and passes on the second; its folder has a space. */
  function testScript(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const script = join(dir, "check tests.mjs");
    writeFileSync(
      script,
      [
        'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        `const counter = ${JSON.stringify(join(dir, "runs.txt"))};`,
        'const n = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;',
        "writeFileSync(counter, String(n));",
        'if (n >= 2) { console.log("all green"); process.exit(0); }',
        'console.error("FAIL giriş.test.ts: beklenen 429, gelen 200");',
        "process.exit(1);",
      ].join("\n"),
    );
    return `node "${script}"`;
  }

  it("sends the failing tests back to the one implementer and finishes once they pass", async () => {
    const { o, project, adapter } = await setup({
      candidates: [candidate("key-a", "anthropic", model("claude-sonnet"))],
      config: (c) => {
        c.commands.test = testScript(join(c.worktreeRoot, "..", "solo tests"));
      },
    });
    const res = await o.startTask({ projectId: project.id, ...CODE_TR, kind: "code", size: "M" });
    expect(res.started).toBe(true);
    const done = await waitFor(() => {
      const t = o.get(res.task.id);
      return t.loop.decisions.some((d) => d.kind === "tests_passed") && t.runs.every((r) => r.endedAt) ? t : null;
    }, 30_000);
    expect(done.loop.decisions.map((d) => d.kind)).toEqual(["tests_failed", "tests_passed"]);
    // One implementer run took the failure as its next turn; no other role ever ran.
    expect(done.runs.map((r) => [r.role, r.endReason])).toEqual([["implementer", "completed"]]);
    const impl = adapter.started.find((s) => s.role === "implementer")!;
    expect(adapter.inspect(impl.runId).inputs[0]!.text).toContain("beklenen 429, gelen 200");
    expect(adapter.started.map((s) => s.role)).toEqual(["implementer"]);
  });
});
