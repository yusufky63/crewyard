import { join } from "node:path";
import type { FallbackMode, StartRequest } from "@crewyard/core";
import type { FakeStep } from "@crewyard/adapter-fake";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsHandlers } from "../handlers/settings.ts";
import { Store } from "../store.ts";
import { taskTimeline } from "../usage/index.ts";
import { accountOf, AccountSwitches, isClaudeSubscription, refusalOf, sameProviderAccounts, sourceOf, switchOrder, switchTrigger, type SwitchFacts } from "./account-switch.ts";
import { AdapterRegistry } from "./adapters.ts";
import type { Candidate } from "./directory.ts";
import { Orchestrator } from "./orchestrator.ts";
import { candidate, cleanTemps, model, ScriptedAdapter, tempDir, tempRepo, waitFor } from "./testing.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// docs/adr/0009: every rule of same-provider account switching has a test here, first the pure
// rules, then the whole flow through the orchestrator with scripted runs.

const plan = (id: string, providerId = "openai", over: Partial<Candidate> = {}): Candidate => ({ ...candidate(id, providerId, model("gpt-5"), "plan_signin"), ...over });
const key = (id: string, credentialId: string, providerId = "deepseek", over: Partial<Candidate> = {}): Candidate => ({ ...candidate(id, providerId, model("deepseek-chat", { reasoning: false, cost: { input: 0.27, output: 1.1, cacheRead: 0.07 } })), credentialId, ...over });

describe("account switch rules", () => {
  it("counts an API key as one account and a plan sign-in as its own profile; local providers have none", () => {
    expect(accountOf(key("a", "cred-1"))).toBe("key:cred-1");
    expect(accountOf(key("b", "cred-1"))).toBe("key:cred-1");
    expect(accountOf(plan("work"))).toBe("profile:work");
    const local = candidate("ollama", "ollama", null);
    expect(accountOf({ ...local, profile: { ...local.profile, credential: { kind: "local", secretRef: null } } })).toBeNull();
  });

  it("finds only other accounts of the same runner and provider", () => {
    const source = key("ds-a", "cred-1");
    const all = [source, key("ds-a-pro", "cred-1"), key("ds-b", "cred-2"), key("or-b", "cred-3", "openrouter"), { ...key("ds-c", "cred-4"), profile: { ...key("ds-c", "cred-4").profile, runner: "opencode" as const } }];
    expect(sameProviderAccounts(source, all).map((c) => c.profile.id)).toEqual(["ds-b"]);
  });

  it("never treats a Claude subscription as a target", () => {
    expect(isClaudeSubscription(plan("claude-pro", "anthropic"))).toBe(true);
    expect(isClaudeSubscription({ ...plan("cc"), profile: { ...plan("cc").profile, runner: "claude-code" } })).toBe(true);
    expect(isClaudeSubscription(key("anthropic-key", "cred-a", "anthropic"))).toBe(false);
    expect(isClaudeSubscription(plan("codex-work"))).toBe(false);
  });

  it("acts on a limit, an empty credit and a key's cap, never on the task budget, an unknown price or a crash", () => {
    const cap = (kind: "task_budget" | "daily_cap" | "task_cap") => ({ kind, spentUsd: 1, capUsd: 1, credentialId: "c" });
    expect(switchTrigger({ trigger: "limit" })).toBe("limit");
    expect(switchTrigger({ trigger: "limit", failure: "credit" })).toBe("credit");
    expect(switchTrigger({ trigger: "budget", cap: cap("daily_cap") })).toBe("spend_cap");
    expect(switchTrigger({ trigger: "budget", cap: cap("task_cap") })).toBe("spend_cap");
    expect(switchTrigger({ trigger: "budget", cap: cap("task_budget") })).toBeNull();
    expect(switchTrigger({ trigger: "unpriced" })).toBeNull();
    expect(switchTrigger({ trigger: "crashed", failure: "transient" })).toBeNull();
  });

  it("refuses a target that fails any preflight rule, in a fixed order, and lets Unknown headroom pass", () => {
    const ok: SwitchFacts = { sameKind: true, ready: true, claudeSubscription: false, roleOk: true, independent: true, leftBefore: false, overCap: false, overBudget: false, headroom: { pct: null, window: null, provenance: "unknown" } };
    expect(refusalOf(ok)).toBeNull();
    expect(refusalOf({ ...ok, claudeSubscription: true, ready: false })).toBe("claude_subscription");
    expect(refusalOf({ ...ok, sameKind: false, ready: false })).toBe("other_kind");
    expect(refusalOf({ ...ok, ready: false })).toBe("not_ready");
    expect(refusalOf({ ...ok, roleOk: false })).toBe("role");
    expect(refusalOf({ ...ok, independent: false })).toBe("independence");
    expect(refusalOf({ ...ok, leftBefore: true })).toBe("left_before");
    expect(refusalOf({ ...ok, overCap: true })).toBe("over_cap");
    expect(refusalOf({ ...ok, overBudget: true })).toBe("over_budget");
    // More than 20% left is needed (PLAN.md §8.2).
    expect(refusalOf({ ...ok, headroom: { pct: 20, window: "5h", provenance: "reported" } })).toBe("headroom_low");
    expect(refusalOf({ ...ok, headroom: { pct: 21, window: "5h", provenance: "estimated" } })).toBeNull();
  });

  it("tries the standby chain first, then the rest by rank", () => {
    const accounts = [plan("c"), plan("b"), plan("a"), plan("d")];
    expect(switchOrder(accounts, ["b"], ["a", "c"]).map((c) => c.profile.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("says where the source's number came from", () => {
    const unknown = { pct: null, window: null, provenance: "unknown" as const };
    expect(sourceOf("limit", { window: "5h" }, { pct: 0, window: "5h", provenance: "reported" })).toEqual({ window: "5h", usedPct: 100, provenance: "reported" });
    expect(sourceOf("limit", { window: null }, unknown)).toEqual({ window: null, usedPct: null, provenance: "unknown" });
    expect(sourceOf("credit", { window: null }, unknown)).toEqual({ window: null, usedPct: null, provenance: "reported" });
    const cap = { kind: "daily_cap" as const, spentUsd: 0.27, capUsd: 0.1, credentialId: "c" };
    expect(sourceOf("spend_cap", { window: "budget-day", cap }, unknown)).toEqual({ window: "budget-day", usedPct: 100, provenance: "estimated", cap });
  });
});

describe("account switch settings and records", () => {
  const stores: Store[] = [];
  afterEach(() => {
    stores.splice(0).forEach((s) => s.close());
    cleanTemps();
  });

  it("is off by default, follows the setting, and holds out a task you turned off", async () => {
    const dir = tempDir("crewyard switch-");
    const store = new Store(join(dir, "t.db"));
    stores.push(store);
    // Task rows are not the point here.
    store.db.exec("pragma foreign_keys = off");
    const sw = new AccountSwitches(store.db, () => new Date(), () => {});
    expect(sw.enabledInSettings()).toBe(false);
    expect([sw.taskEnabled("t1"), sw.allowed("t1")]).toEqual([true, false]);
    const settings = createSettingsHandlers({ store, info: { startedAt: "now", dbPath: join(dir, "t.db"), dataDir: dir }, emit: () => {} });
    await settings["settings.update"]({ accountSwitch: { enabled: true, acceptTerms: true } });
    expect(sw.allowed("t1")).toBe(true);
    sw.setTask("t1", false);
    expect([sw.taskEnabled("t1"), sw.allowed("t1"), sw.allowed("t2")]).toEqual([false, false, true]);
  });
});

// ---------------------------------------------------------------- through the orchestrator

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
const hold: FakeStep = { awaitAnswer: "never" };
const limitHit = (): FakeStep => ({ emit: { type: "limit.update", window: "5h", usedPct: 100, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), provenance: "reported", reached: true } });
const failWith = (detail: string): FakeStep => ({ emit: { type: "run.ended", reason: "failed", detail } });
const usage = (tokensIn: number): FakeStep => ({ emit: { type: "usage.update", tokensIn, tokensOut: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, contextUsed: null, contextSize: null, costUsd: null, costProvenance: "unknown" } });

/** Each profile runs its own script; anything not listed finishes at once. */
const byProfile =
  (scripts: Record<string, FakeStep[]>): Picker =>
  (_role, req) =>
    scripts[req.profile.id] ?? [running, say(`${req.profile.id} done`)];

async function setup(opts: { pick: Picker; candidates: Candidate[]; switching?: boolean }) {
  const root = tempDir("crewyard switch-");
  const repo = await tempRepo(root);
  const store = new Store(join(root, "t.db"));
  const project = store.addProject(repo, "demo repo");
  const adapter = new ScriptedAdapter(opts.pick);
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const topics: Array<{ topic: string; payload: unknown }> = [];
  const o = new Orchestrator({
    store,
    dataDir: join(root, "data"),
    emit: (topic, payload) => topics.push({ topic, payload }),
    adapters,
    directory: { candidates: () => opts.candidates, envFor: () => ({}) },
    tickMs: 0,
    freeMemoryMb: () => 64_000,
    stopTimeoutMs: 2_000,
  });
  o.start();
  open.push({ o, store });
  if (opts.switching) {
    const settings = createSettingsHandlers({ store, info: { startedAt: "now", dbPath: join(root, "t.db"), dataDir: root }, emit: () => {} });
    await settings["settings.update"]({ accountSwitch: { enabled: true, acceptTerms: true } });
  }
  return { o, store, project, adapter, topics };
}

async function research(env: Awaited<ReturnType<typeof setup>>, pin: string, fallback: FallbackMode, accountSwitch?: boolean) {
  const t = await env.o.propose({ projectId: env.project.id, title: "Research A", pins: { researcher: pin }, fallback });
  await env.o.approve({ taskId: t.id, ...(accountSwitch === undefined ? {} : { accountSwitch }) });
  return t;
}

const events = (store: Store, kind: string) => (store.db.prepare("select payload from events where kind = ? order by seq").all(kind) as Array<{ payload: string }>).map((r) => JSON.parse(r.payload) as Record<string, unknown>);

describe("account switch flow", () => {
  it("is off by default: even Auto mode does not move to another account of the provider, and the Inbox offers it by hand", async () => {
    const env = await setup({ pick: byProfile({ work: [running, limitHit(), hold] }), candidates: [plan("work"), plan("home")] });
    const t = await research(env, "work", "auto");
    const q = await waitFor(() => env.o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    expect(q.payload).toMatchObject({ kind: "handoff", trigger: "limit" });
    expect(q.payload.kind === "handoff" && q.payload.candidates.map((c) => c.profileId)).toEqual(["home"]);
    expect(env.o.get(t.id).handoffs).toEqual([]);
    expect(env.o.switches.list({ taskId: t.id })).toEqual([]);
    expect(env.o.get(t.id).accountSwitch).toBe(true);
    // Picked by hand it goes through as any handoff.
    await env.o.answer(q.id, { kind: "handoff", decision: "hand_off", targetProfileId: "home" });
    await waitFor(() => env.o.get(t.id).status === "done");
    expect(env.o.switches.list({ taskId: t.id })).toEqual([]);
  });

  it("with the setting on, the next account takes over on a limit, in Manual mode too, and the switch is recorded with its labels", async () => {
    const env = await setup({ pick: byProfile({ work: [running, limitHit(), hold] }), candidates: [plan("work"), plan("home")], switching: true });
    const t = await research(env, "work", "manual");
    await waitFor(() => env.o.get(t.id).status === "done");
    const d = env.o.get(t.id);
    expect(d.runs.map((r) => r.profileId)).toEqual(["work", "home"]);
    expect(env.o.requests({ taskId: t.id, includeAnswered: true })).toEqual([]);
    const h = d.handoffs[0]!;
    expect([h.mode, h.trigger, h.outcome, h.targetProfileId]).toEqual(["auto", "limit", "completed", "home"]);

    const [s] = env.o.switches.list({ projectId: env.project.id });
    expect(s).toMatchObject({
      taskId: t.id,
      handoffId: h.id,
      toRunId: h.toRunId,
      from: { profileId: "work", alias: "work" },
      to: { profileId: "home", alias: "home" },
      trigger: "limit",
      source: { window: "5h", usedPct: 100, provenance: "reported" },
      // Nothing reported for home yet: Unknown passes and says so.
      headroom: { pct: null, provenance: "unknown" },
      estimate: { usd: 0, provenance: "estimated" },
      skipped: [],
      outcome: "completed",
      dismissedAt: null,
    });
    expect(env.topics.some((x) => x.topic === "switches.changed")).toBe(true);
    const tl = taskTimeline(env.store.db, t.id).events.filter((e) => e.kind === "account_switch");
    expect(tl).toMatchObject([{ kind: "account_switch", phase: "switched", switchId: s!.id, from: { alias: "work" }, to: { alias: "home" }, source: { provenance: "reported" }, headroom: { provenance: "unknown" } }]);

    // Dismissed, it leaves the Inbox and stays on record.
    env.o.switches.dismiss(s!.id);
    expect(env.o.switches.list({ taskId: t.id })).toEqual([]);
    expect(env.o.switches.list({ taskId: t.id, includeDismissed: true })).toHaveLength(1);
  });

  it("a task you turned off keeps asking, and turning it off later holds it out too", async () => {
    const env = await setup({ pick: byProfile({ work: [running, limitHit(), hold] }), candidates: [plan("work"), plan("home")], switching: true });
    const t = await research(env, "work", "manual", false);
    expect(env.o.get(t.id).accountSwitch).toBe(false);
    await waitFor(() => env.o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    expect(env.o.get(t.id).handoffs).toEqual([]);
    expect(env.o.switches.list({ taskId: t.id })).toEqual([]);
    expect(env.o.setAccountSwitch(t.id, true).accountSwitch).toBe(true);
    expect(events(env.store, "task.account_switch").map((p) => p.enabled)).toEqual([true]);
  });

  it("refuses accounts that fail preflight, records why, and lets the task's mode decide", async () => {
    const env = await setup({
      pick: byProfile({ work: [running, limitHit(), hold] }),
      candidates: [plan("work"), plan("tight"), plan("signed-out", "openai", { ready: false }), plan("other-runner"), plan("elsewhere", "google")].map((c) =>
        c.profile.id === "other-runner" ? { ...c, profile: { ...c.profile, runner: "codex" as const } } : c,
      ),
      switching: true,
    });
    // Before the run starts, so the limit already finds it nearly full.
    env.o.ingestSample({ profileId: "tight", window: "5h", usedPct: 85, resetsAt: new Date(Date.now() + 3_600_000).toISOString(), provenance: "reported", observedAt: new Date().toISOString() });
    const t = await research(env, "work", "ask");
    const q =await waitFor(() => env.o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    expect(env.o.get(t.id).handoffs).toEqual([]);
    const [refused] = events(env.store, "account.switch_refused");
    expect(refused).toMatchObject({ phase: "refused", trigger: "limit", from: { profileId: "work" }, to: null });
    expect((refused!.skipped as Array<{ profileId: string; reason: string }>).map((s) => [s.profileId, s.reason]).sort()).toEqual([
      ["signed-out", "not_ready"],
      ["tight", "headroom_low"],
    ]);
    // Ask still names a target of another provider; the refused ones are never proposed on their own.
    expect(q.payload.kind === "handoff" && q.payload.proposedTarget?.profileId).toBe("elsewhere");
    expect(taskTimeline(env.store.db, t.id).events.some((e) => e.kind === "account_switch" && e.phase === "refused")).toBe(true);
  });

  it("never moves a plan sign-in onto a paid key of the same provider", async () => {
    const env = await setup({ pick: byProfile({ work: [running, limitHit(), hold] }), candidates: [plan("work"), key("openai-key", "cred-o", "openai")], switching: true });
    const t = await research(env, "work", "manual");
    await waitFor(() => env.o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    expect(env.o.get(t.id).handoffs).toEqual([]);
    expect(events(env.store, "account.switch_refused")[0]?.skipped).toEqual([{ profileId: "openai-key", alias: "openai-key", reason: "other_kind" }]);
  });

  it("never switches to a Claude subscription", async () => {
    const env = await setup({
      pick: byProfile({ "anthropic-key": [running, limitHit(), hold] }),
      candidates: [key("anthropic-key", "cred-a", "anthropic"), plan("claude-pro", "anthropic")],
      switching: true,
    });
    const t = await research(env, "anthropic-key", "manual");
    await waitFor(() => env.o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    expect(env.o.get(t.id).handoffs).toEqual([]);
    expect(events(env.store, "account.switch_refused")[0]?.skipped).toEqual([{ profileId: "claude-pro", alias: "claude-pro", reason: "claude_subscription" }]);
  });

  it("never switches back to an account the step already left", async () => {
    const env = await setup({ pick: byProfile({ work: [running, limitHit(), hold], home: [running, limitHit(), hold] }), candidates: [plan("work"), plan("home")], switching: true });
    const t = await research(env, "work", "manual");
    await waitFor(() => env.o.requests({ taskId: t.id }).find((r) => r.kind === "handoff"));
    expect(env.o.get(t.id).runs.map((r) => r.profileId)).toEqual(["work", "home"]);
    expect(env.o.switches.list({ taskId: t.id })).toHaveLength(1);
    expect(events(env.store, "account.switch_refused")[0]?.skipped).toEqual([{ profileId: "work", alias: "work", reason: "left_before" }]);
  });

  it("moves to the next key when the first runs out of credit or reaches its daily cap, never past the task budget", async () => {
    const credit = await setup({
      pick: byProfile({ "ds-a": [running, failWith('API Error: 402 {"error":{"message":"Insufficient Balance"}}')] }),
      candidates: [key("ds-a", "cred-a"), key("ds-b", "cred-b")],
      switching: true,
    });
    const t1 = await research(credit, "ds-a", "manual");
    await waitFor(() => credit.o.get(t1.id).status === "done");
    expect(credit.o.switches.list({ taskId: t1.id })[0]).toMatchObject({ trigger: "credit", source: { provenance: "reported" }, to: { profileId: "ds-b" } });

    const capped = await setup({ pick: byProfile({ "ds-a": [running, usage(1_000_000), hold] }), candidates: [key("ds-a", "cred-a"), key("ds-b", "cred-b")], switching: true });
    capped.store.db.prepare("insert into credentials (id, alias, provider_id, kind, daily_cap_usd, task_cap_usd, created_at) values ('cred-a', 'a', 'deepseek', 'api_key', 0.1, null, '2026-10-30T00:00:00Z')").run();
    const t2 = await research(capped, "ds-a", "manual");
    await waitFor(() => capped.o.get(t2.id).status === "done");
    const [s] = capped.o.switches.list({ taskId: t2.id });
    expect(s).toMatchObject({ trigger: "spend_cap", source: { window: "budget-day", usedPct: 100, provenance: "estimated", cap: { kind: "daily_cap", capUsd: 0.1 } }, to: { profileId: "ds-b" }, estimate: { provenance: "estimated" } });

    // The task's own budget is the task's: a second key does not make it bigger.
    const budget = await setup({ pick: byProfile({ "ds-a": [running, usage(1_000_000), hold] }), candidates: [key("ds-a", "cred-a"), key("ds-b", "cred-b")], switching: true });
    const t3 = await budget.o.propose({ projectId: budget.project.id, title: "Research A", pins: { researcher: "ds-a" }, fallback: "auto", budgetUsd: 0.05 });
    await budget.o.approve({ taskId: t3.id });
    const q = await waitFor(() => budget.o.requests({ taskId: t3.id }).find((r) => r.kind === "handoff"));
    expect(q.payload).toMatchObject({ trigger: "budget", cap: { kind: "task_budget" } });
    expect(budget.o.get(t3.id).handoffs).toEqual([]);
    expect(budget.o.switches.list({ taskId: t3.id })).toEqual([]);
  });
});
