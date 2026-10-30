import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultProjectConfig, type CandidateView, type ProjectConfig, type RunOutput, type StartRequest } from "@crewyard/core";
import type { FakeStep } from "@crewyard/adapter-fake";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store.ts";
import { admitGroup } from "./admission.ts";
import { AdapterRegistry } from "./adapters.ts";
import { groupPhase, parseNumstat, pickVariants } from "./best-of.ts";
import { Orchestrator, type OrchestratorOptions } from "./orchestrator.ts";
import { CANDIDATES, cleanTemps, git, ScriptedAdapter, tempDir, tempRepo, waitFor } from "./testing.ts";

// Best of N (feature scan A8) end to end over a real git repo: the variants run in their own
// worktrees as hidden tasks, the group is admitted and reserved as one, and the kept variant's
// worktree and session continue the crew in the parent task.

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
const pass: RunOutput = { ok: true, value: { verdict: "pass", summary: "Looks right.", comments: [] } };

async function setup(opts: { pick: Picker; config?: (c: ProjectConfig) => void; options?: Partial<OrchestratorOptions> }) {
  const root = tempDir("crewyard bestof-");
  const repo = await tempRepo(root);
  const cfg = defaultProjectConfig("demo repo", join(root, ".mc", "worktrees", "demo repo"));
  opts.config?.(cfg);
  mkdirSync(join(repo, ".mission"), { recursive: true });
  writeFileSync(join(repo, ".mission", "project.json"), JSON.stringify(cfg));
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "project config");
  const store = new Store(join(root, "t.db"));
  const project = store.addProject(repo, "demo repo");
  const adapter = new ScriptedAdapter(opts.pick, { result: (role) => (role === "reviewer" ? pass : undefined) });
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const cands = CANDIDATES();
  const o = new Orchestrator({
    store,
    dataDir: join(root, "data"),
    emit: () => undefined,
    adapters,
    directory: { candidates: () => cands, envFor: () => ({}) },
    tickMs: 0,
    freeMemoryMb: () => 64_000,
    stopTimeoutMs: 2_000,
    ...opts.options,
  });
  o.start();
  open.push({ o, store });
  return { o, store, project, adapter, repo };
}

/** Each implementer writes a file named after its profile into its own worktree. */
const writes =
  (hold?: (profileId: string) => boolean): Picker =>
  (role, req) => {
    if (role !== "implementer") return [running, say(`${role} done`)];
    writeFileSync(join(req.cwd, `${req.profile.id}.txt`), `${req.profile.id}\n`);
    if (hold?.(req.profile.id)) return [running, spent, { emit: { type: "request.question", requestId: "q1", questions: [{ prompt: "Which store?", options: [{ label: "redis" }], allowFreeText: false }] } }, { awaitAnswer: "q1" }];
    return [running, say(`${req.profile.id} done`)];
  };

const spent: FakeStep = { emit: { type: "usage.update", tokensIn: 1_000, tokensOut: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, contextUsed: null, contextSize: null, costUsd: 0.01, costProvenance: "reported" } };

const CODE_S = { title: "Rate limiter for the API", description: "Add a token bucket per account.", kind: "code" as const, size: "S" as const };

describe("best of N: choosing variants", () => {
  const view = (profileId: string, model: string): CandidateView => ({ profileId, alias: profileId, runner: "fake", providerId: "p", model, score: 1, headroom: { pct: null, window: null, provenance: "unknown" }, estimate: { usd: 0.1, provenance: "estimated" }, reasons: [] });

  it("keeps the proposal's choice first and prefers models the group does not have", () => {
    const a = view("a", "m1");
    const ranked = [a, view("b", "m1"), view("c", "m2"), view("d", "m3")];
    expect(pickVariants(a, ranked, 3).map((v) => v.profileId)).toEqual(["a", "c", "d"]);
    // Same model on another profile only when nothing else is left.
    expect(pickVariants(a, ranked.slice(0, 2), 2).map((v) => v.profileId)).toEqual(["a", "b"]);
    expect(pickVariants(a, [a], 2)).toHaveLength(1);
  });

  it("admits a group only when every variant fits at once", () => {
    const limits = { projectSlots: 4, globalSlots: 6, perProfile: 2, minFreeMb: 1024 };
    const profiles = [
      { profileId: "a", needed: 1, active: 0 },
      { profileId: "b", needed: 1, active: 0 },
    ];
    expect(admitGroup({ projectActive: 2, globalActive: 2, freeMb: 8_000, profiles }, limits)).toBeNull();
    expect(admitGroup({ projectActive: 3, globalActive: 3, freeMb: 8_000, profiles }, limits)).toEqual({ code: "admission.group_slots", params: { variants: 2, free: 1, scope: "project" } });
    expect(admitGroup({ projectActive: 0, globalActive: 5, freeMb: 8_000, profiles }, limits)?.params?.scope).toBe("global");
    expect(admitGroup({ projectActive: 0, globalActive: 0, freeMb: 8_000, profiles: [{ profileId: "a", needed: 2, active: 1 }] }, limits)?.params?.scope).toBe("profile");
    expect(admitGroup({ projectActive: 0, globalActive: 0, freeMb: 1_500, profiles }, limits)).toEqual({ code: "admission.group_memory", params: { freeMb: 1500, neededMb: 2048 } });
  });

  it("reads the phase from the variants", () => {
    const started = { started_at: "2026-10-30T10:00:00Z", kept_variant_id: null };
    expect(groupPhase({ started_at: null, kept_variant_id: null }, false, [])).toBe("proposed");
    expect(groupPhase({ started_at: null, kept_variant_id: null }, true, [])).toBe("waiting");
    expect(groupPhase(started, true, [{ status: "running", finished: false }, { status: "review", finished: true }])).toBe("running");
    expect(groupPhase(started, true, [{ status: "failed", finished: false }, { status: "review", finished: true }])).toBe("choosing");
    expect(groupPhase(started, true, [{ status: "failed", finished: false }, { status: "cancelled", finished: false }])).toBe("failed");
    expect(groupPhase({ ...started, kept_variant_id: "v" }, true, [])).toBe("kept");
  });

  it("parses git numstat, binary files included", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\n-\t-\tlogo.png\n")).toEqual({ files: [{ path: "src/a.ts", added: 3, removed: 1 }, { path: "logo.png", added: 0, removed: 0 }], added: 3, removed: 1 });
  });
});

describe("best of N: a task", () => {
  it("proposes the variants with the whole group's estimate, and refuses what cannot run", async () => {
    const { o, project } = await setup({ pick: writes() });
    const t = await o.propose({ projectId: project.id, ...CODE_S, bestOf: 2 });
    const group = t.bestOfGroup!;
    expect(group).toMatchObject({ n: 2, phase: "proposed" });
    const impl = t.crew!.members.find((m) => m.role === "implementer")!;
    const reviewer = t.crew!.members.find((m) => m.role === "reviewer")!;
    expect(group.variants[0]!.candidate.profileId).toBe(impl.chosen!.profileId);
    // No variant may be the reviewer's model: any of them may be the one you keep.
    expect(group.variants.map((v) => v.candidate.model)).not.toContain(reviewer.chosen!.model);
    const sum = Math.round((group.variants.reduce((n, v) => n + v.candidate.estimate.usd!, 0) + reviewer.chosen!.estimate.usd!) * 10_000) / 10_000;
    expect(t.crew!.estimate.usd).toBeCloseTo(sum, 4);
    expect(o.list(project.id)[0]!.bestOf).toEqual({ n: 2, phase: "proposed" });
    // Three profiles, one of them reviews: only two can implement.
    await expect(o.propose({ projectId: project.id, ...CODE_S, bestOf: 3 })).rejects.toThrow("best_of.too_few");
    await expect(o.propose({ projectId: project.id, ...CODE_S, bestOf: 5 })).rejects.toThrow("best_of.bad_count");
    await expect(o.propose({ projectId: project.id, ...CODE_S, kind: "research", bestOf: 2 })).rejects.toThrow("best_of.not_found");
  });

  it("refuses a group the task budget or the slots can never hold", async () => {
    const { o, project } = await setup({ pick: writes(), config: (c) => (c.rules.slots = 1) });
    const t = await o.propose({ projectId: project.id, ...CODE_S, bestOf: 2 });
    await expect(o.approve({ taskId: t.id })).rejects.toThrow("best_of.slots");
    const small = await setup({ pick: writes() });
    const b = await small.o.propose({ projectId: small.project.id, ...CODE_S, bestOf: 2, budgetUsd: 0.0001 });
    await expect(small.o.approve({ taskId: b.id })).rejects.toThrow("best_of.over_budget");
  });

  it("starts every variant at once in its own worktree and reserves the whole group on the parent", async () => {
    const { o, store, project } = await setup({ pick: writes(() => true) });
    const t = await o.propose({ projectId: project.id, ...CODE_S, bestOf: 2, budgetUsd: 50 });
    await o.approve({ taskId: t.id });
    const started = o.get(t.id).bestOfGroup!;
    expect(started.phase).toBe("running");
    expect(started.variants.every((v) => v.taskId !== null)).toBe(true);
    // The reservations went in together, before any variant's process started, on the parent task.
    const held = store.db.prepare("select task_id, amount_usd from spend_reservations").all() as Array<{ task_id: string; amount_usd: number }>;
    expect(held.map((r) => r.task_id)).toEqual([t.id, t.id]);
    expect(held.reduce((n, r) => n + r.amount_usd, 0)).toBeCloseTo(started.estimate.usd!, 4);
    // Both variants wait on a question: the parent needs you, and the list shows only the parent.
    await waitFor(() => o.requests({}).length === 2, 30_000);
    const detail = o.get(t.id);
    expect(detail.status).toBe("needs_input");
    expect(o.list(project.id).map((x) => x.id)).toEqual([t.id]);
    const paths = detail.bestOfGroup!.variants.map((v) => v.worktreePath!);
    expect(new Set(paths).size).toBe(2);
    paths.forEach((p) => expect(existsSync(p)).toBe(true));
    // A variant's own task knows its parent.
    expect(o.get(detail.bestOfGroup!.variants[1]!.taskId!).variantOf).toEqual({ taskId: t.id, position: 2, n: 2 });
  });

  it("keeps one variant: its worktree and session continue the crew, the others are stopped and parked", async () => {
    let slow = "";
    const { o, project, adapter, repo } = await setup({ pick: writes((p) => p === slow) });
    const t = await o.propose({ projectId: project.id, ...CODE_S, bestOf: 2 });
    slow = t.bestOfGroup!.variants[0]!.candidate.profileId;
    await o.approve({ taskId: t.id });
    // Variant 2 finishes; variant 1 still waits on its question.
    const ready = await waitFor(() => {
      const g = o.get(t.id).bestOfGroup!;
      return g.variants[1]!.status === "review" && g.variants[1]!.diffStat && o.requests({}).length === 1 ? g : null;
    }, 30_000);
    const keep = ready.variants[1]!;
    expect(keep.diffStat!.files.map((f) => f.path)).toEqual([`${keep.candidate.profileId}.txt`]);
    expect(keep.decisions.map((d) => d.kind)).toEqual(["tests_skipped"]);
    await expect(o.keepVariant(t.id, ready.variants[0]!.id)).rejects.toThrow("best_of.not_finished");

    const kept = await o.keepVariant(t.id, keep.id);
    expect(kept.bestOfGroup).toMatchObject({ phase: "kept", keptVariantId: keep.id });
    // The kept worktree is the task's now, and its run counts as the implement step.
    expect(kept.worktree!.path).toBe(keep.worktreePath);
    const adopted = kept.runs.find((r) => r.role === "implementer")!;
    expect(adopted).toMatchObject({ endReason: "completed", endDetail: "best_of.kept", profileId: keep.candidate.profileId, cwd: keep.worktreePath });
    // The other variant was stopped and parked: folder gone, branch kept, its question closed.
    const lost = kept.bestOfGroup!.variants[0]!;
    expect(lost).toMatchObject({ outcome: "discarded", parkError: null });
    expect(lost.parkedAt).not.toBeNull();
    expect(lost.run!.endDetail).toBe("best_of.discarded");
    expect(existsSync(lost.worktreePath ?? join(repo, "missing"))).toBe(false);
    expect((await git(repo, "branch", "--list")).split("\n").length).toBeGreaterThanOrEqual(3);
    expect(o.requests({})).toEqual([]);
    // The reviewer reads the kept worktree's head, and the task ends ready for review.
    const done = await waitFor(() => (o.get(t.id).status === "review" ? o.get(t.id) : null), 30_000);
    const review = adapter.started.find((s) => s.role === "reviewer")!;
    expect(review.req.cwd.startsWith(keep.worktreePath!)).toBe(true);
    expect(done.loop.verdicts).toMatchObject([{ verdict: "pass" }]);
  });

  it("counts every variant's spend on the parent, and cancelling the parent stops them all", async () => {
    const { o, project } = await setup({ pick: writes(() => true) });
    const t = await o.propose({ projectId: project.id, ...CODE_S, bestOf: 2 });
    await o.approve({ taskId: t.id });
    await waitFor(() => o.requests({}).length === 2, 30_000);
    // Two variants at one cent each: the parent's spend and its budget see both.
    expect(o.get(t.id).spend.usd).toBeCloseTo(0.02, 6);
    const cancelled = await o.cancel(t.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.bestOfGroup!.variants.map((v) => v.status)).toEqual(["cancelled", "cancelled"]);
    expect(o.requests({})).toEqual([]);
  });
});
