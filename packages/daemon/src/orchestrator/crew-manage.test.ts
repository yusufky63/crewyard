import { join } from "node:path";
import type { FakeStep } from "@crewyard/adapter-fake";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { AdapterRegistry } from "./adapters.ts";
import { Orchestrator } from "./orchestrator.ts";
import { CANDIDATES, cleanTemps, ScriptedAdapter, tempDir, tempRepo, waitFor } from "./testing.ts";

// Managing a crew from the Crew graph through the orchestrator: proposal edits are stored on the
// draft and priced again, a follow-up waits for its own approval, a skipped step lets what waits
// for it go on, and Pause all / Resume all reach every open run.

const open: Array<{ o: Orchestrator; store: Store }> = [];
afterEach(async () => {
  const all = open.splice(0);
  all.forEach(({ o }) => o.shutdown());
  for (const { o } of all) await o.settle();
  all.forEach(({ store }) => store.close());
  cleanTemps();
});

const running: FakeStep = { emit: { type: "run.state", state: "running" } };
const said: FakeStep = { emit: { type: "message.delta", text: "done" } };

async function setup(script: (role: string) => FakeStep[] = () => [running, said]) {
  const root = tempDir("crewyard crew manage ");
  const repo = await tempRepo(root, "my repo");
  const store = new Store(join(root, "t.db"));
  const project = store.addProject(repo, "my repo");
  const adapter = new ScriptedAdapter((role) => script(role));
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const o = new Orchestrator({ store, dataDir: join(root, "data dir"), emit: () => {}, adapters, directory: { candidates: () => CANDIDATES(), envFor: () => ({}) }, tickMs: 0, freeMemoryMb: () => 64_000, stopTimeoutMs: 2_000 });
  o.start();
  open.push({ o, store });
  return { o, store, project, adapter };
}

const TASK = { title: "Implement rate limiting for the login endpoint", description: "Five attempts per minute per account, with tests.", kind: "code" as const, size: "M" as const };
const sum = (usd: Array<number | null | undefined>) => Math.round(usd.reduce<number>((a, u) => a + (u ?? 0), 0) * 10_000) / 10_000;
const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe("proposal edits", () => {
  it("adds, rewires and removes steps on the draft and prices the crew again", async () => {
    const { o, project } = await setup();
    const proposed = await o.propose({ projectId: project.id, ...TASK });
    expect(proposed.crew!.members.map((m) => m.step)).toEqual(["planner", "implementer", "tester", "reviewer"]);

    const added = await o.crew.edit(proposed.id, { kind: "add_step", role: "docs", after: ["implementer"] });
    const docs = added.crew!.members.at(-1)!;
    expect(docs).toMatchObject({ step: "docs", role: "docs", dependsOn: ["implementer"], writesCode: true, edited: true });
    expect(docs.chosen).not.toBeNull();
    expect(added.crew!.estimate.usd).toBe(sum(added.crew!.members.map((m) => m.chosen?.estimate.usd)));
    expect(added.crew!.approvedAt).toBeNull();

    // Removing the implementer makes the reviewer wait for what the implementer waited for.
    const removed = await o.crew.edit(proposed.id, { kind: "remove_step", memberId: added.crew!.members[1]!.id });
    expect(removed.crew!.members.find((m) => m.step === "reviewer")?.dependsOn).toEqual(["planner"]);
    expect(removed.crew!.members.find((m) => m.step === "docs")?.dependsOn).toEqual(["planner"]);
    expect(removed.crew!.estimate.usd).toBe(sum(removed.crew!.members.map((m) => m.chosen?.estimate.usd)));
  });

  it("refuses a loop and a reviewer on the implementer's model, and keeps the draft as it was", async () => {
    const { o, project } = await setup();
    const proposed = await o.propose({ projectId: project.id, ...TASK });
    const [planner, implementer, , reviewer] = proposed.crew!.members;
    expect(await rejects(o.crew.edit(proposed.id, { kind: "add_dependency", memberId: planner!.id, dependsOn: "reviewer" }))).toBe("crew.cycle");
    expect(await rejects(o.crew.edit(proposed.id, { kind: "set_candidate", memberId: reviewer!.id, profileId: implementer!.chosen!.profileId }))).toBe("crew.independence");
    expect(await rejects(o.crew.edit(proposed.id, { kind: "add_step", role: "ghost", after: [] }))).toBe("crew.unknown_role");
    expect(o.get(proposed.id).crew!.members).toEqual(proposed.crew!.members);
  });

  it("remembers a changed profile as a preference and orders the standby chain", async () => {
    const { o, project } = await setup();
    const proposed = await o.propose({ projectId: project.id, ...TASK });
    const tester = proposed.crew!.members.find((m) => m.role === "tester")!;
    const ranked = await o.crew.rankCandidates(proposed.id, "tester");
    const other = ranked.find((c) => c.profileId !== tester.chosen!.profileId)!;
    const changed = await o.crew.edit(proposed.id, { kind: "set_candidate", memberId: tester.id, profileId: other.profileId });
    const after = changed.crew!.members.find((m) => m.id === tester.id)!;
    expect(after.chosen?.profileId).toBe(other.profileId);
    expect(after.standby[0]?.profileId).toBe(tester.chosen!.profileId);
    expect(o.db.preference(project.id, "tester", other.profileId)).toBe(1);
    expect(o.db.preference(project.id, "tester", tester.chosen!.profileId)).toBe(-1);

    const chain = ranked.filter((c) => c.profileId !== other.profileId).map((c) => c.profileId).reverse();
    const ordered = await o.crew.edit(proposed.id, { kind: "set_standby", memberId: tester.id, profileIds: chain });
    expect(ordered.crew!.members.find((m) => m.id === tester.id)!.standby.map((s) => s.profileId)).toEqual(chain);

    // Approve and start still takes the edited crew as it stands.
    const approved = await o.approve({ taskId: proposed.id });
    expect(approved.crew!.approvedAt).not.toBeNull();
    expect(approved.crew!.members.find((m) => m.id === tester.id)!.chosen?.profileId).toBe(other.profileId);
  });
});

describe("running crew", () => {
  it("holds a follow-up until you approve it, then runs it", async () => {
    const { o, project, adapter } = await setup();
    const proposed = await o.propose({ projectId: project.id, title: "Compare rate limiter libraries", kind: "research", size: "S" });
    expect(proposed.crew!.members.map((m) => m.role)).toEqual(["researcher"]);
    await o.approve({ taskId: proposed.id });
    await waitFor(() => o.get(proposed.id).status === "done", 30_000);

    const followed = await o.crew.edit(proposed.id, { kind: "add_step", role: "tester", after: ["researcher"] });
    const tester = followed.crew!.members.at(-1)!;
    expect(tester.pendingApproval).toBe(true);
    // Approved steps keep their place; only the follow-up may change.
    expect(await rejects(o.crew.edit(proposed.id, { kind: "remove_step", memberId: followed.crew!.members[0]!.id }))).toBe("crew.started");
    await o.tick();
    expect(adapter.started.some((s) => s.role === "tester")).toBe(false);

    const approved = await o.crew.approveSteps(proposed.id);
    expect(approved.crew!.members.at(-1)!.pendingApproval).toBeUndefined();
    await waitFor(() => adapter.started.some((s) => s.role === "tester"), 30_000);
  }, 60_000);

  it("skips a step that has not started, and what waits for it goes on", async () => {
    // The researcher takes a moment, so the tester is skipped before it could start.
    const { o, project, adapter } = await setup((role) => (role === "researcher" ? [running, { wait: 1_500 }, said] : [running, said]));
    const proposed = await o.propose({ projectId: project.id, title: "Compare rate limiter libraries", kind: "research", size: "S" });
    await o.crew.edit(proposed.id, { kind: "add_step", role: "tester", after: ["researcher"] });
    const two = await o.crew.edit(proposed.id, { kind: "add_step", role: "tester", after: ["tester"] });
    expect(two.crew!.members.map((m) => m.step)).toEqual(["researcher", "tester", "tester-2"]);
    expect(await rejects(o.crew.skip(proposed.id, two.crew!.members[1]!.id))).toBe("crew.not_approved");

    await o.approve({ taskId: proposed.id });
    const [researcher, tester, tester2] = two.crew!.members;
    const skipped = await o.crew.skip(proposed.id, tester!.id);
    expect(skipped.crew!.members[1]!.skippedAt).toBeTruthy();
    await waitFor(() => o.get(proposed.id).runs.some((r) => r.memberId === researcher!.id), 10_000);
    expect(await rejects(o.crew.skip(proposed.id, researcher!.id))).toBe("crew.started");
    await waitFor(() => o.get(proposed.id).runs.some((r) => r.memberId === tester2!.id), 30_000);
    expect(o.get(proposed.id).runs.some((r) => r.memberId === tester!.id)).toBe(false);
    expect(adapter.started.filter((s) => s.role === "tester")).toHaveLength(1);
  }, 60_000);

  it("changes the AI of an approved step before it starts, and refuses once it has a run", async () => {
    // The researcher takes a moment, so the tester is still waiting for it when its AI changes.
    const { o, project, adapter } = await setup((role) => (role === "researcher" ? [running, { wait: 1_500 }, said] : [running, said]));
    const proposed = await o.propose({ projectId: project.id, title: "Compare rate limiter libraries", kind: "research", size: "S" });
    const two = await o.crew.edit(proposed.id, { kind: "add_step", role: "tester", after: ["researcher"] });
    const [researcher, tester] = two.crew!.members;
    await o.approve({ taskId: proposed.id });
    // crew.edit keeps the approved crew as it is; changeProfile is the path for a step that waits.
    const ranked = await o.crew.rankCandidates(proposed.id, "tester");
    const other = ranked.find((c) => c.profileId !== tester!.chosen!.profileId)!;
    expect(await rejects(o.crew.edit(proposed.id, { kind: "set_candidate", memberId: tester!.id, profileId: other.profileId }))).toBe("crew.approved");
    const changed = await o.crew.changeProfile(proposed.id, tester!.id, other.profileId);
    const after = changed.crew!.members.find((m) => m.id === tester!.id)!;
    expect(after.chosen?.profileId).toBe(other.profileId);
    expect(after.standby[0]?.profileId).toBe(tester!.chosen!.profileId);
    expect(changed.crew!.approvedAt).not.toBeNull();
    expect(after.pendingApproval).toBeUndefined();
    expect(await rejects(o.crew.changeProfile(proposed.id, tester!.id, "no-such-profile"))).toBe("crew.unknown_candidate");

    await waitFor(() => o.get(proposed.id).runs.some((r) => r.memberId === researcher!.id), 10_000);
    expect(await rejects(o.crew.changeProfile(proposed.id, researcher!.id, other.profileId))).toBe("crew.started");
    // The tester runs on the profile chosen while it waited.
    await waitFor(() => o.get(proposed.id).runs.some((r) => r.memberId === tester!.id), 30_000);
    expect(o.get(proposed.id).runs.find((r) => r.memberId === tester!.id)!.profileId).toBe(other.profileId);
    expect(adapter.started.filter((s) => s.role === "tester")).toHaveLength(1);
  }, 60_000);

  it("refuses to change the AI of a skipped step or a stopped task", async () => {
    const { o, project } = await setup((role) => (role === "researcher" ? [running, { wait: 1_500 }, said] : [running, said]));
    const proposed = await o.propose({ projectId: project.id, title: "Compare rate limiter libraries", kind: "research", size: "S" });
    const two = await o.crew.edit(proposed.id, { kind: "add_step", role: "tester", after: ["researcher"] });
    const tester = two.crew!.members[1]!;
    const other = (await o.crew.rankCandidates(proposed.id, "tester")).find((c) => c.profileId !== tester.chosen!.profileId)!;
    // A proposal step changes the same way, and stays a proposal.
    const draft = await o.crew.changeProfile(proposed.id, tester.id, other.profileId);
    expect(draft.crew!.approvedAt).toBeNull();
    await o.approve({ taskId: proposed.id });
    await o.crew.skip(proposed.id, tester.id);
    expect(await rejects(o.crew.changeProfile(proposed.id, tester.id, tester.chosen!.profileId))).toBe("crew.skipped");
    await o.cancel(proposed.id);
    expect(await rejects(o.crew.changeProfile(proposed.id, tester.id, tester.chosen!.profileId))).toBe("task.cancelled");
  }, 30_000);

  it("pauses and resumes every open run of the task", async () => {
    const { o, project } = await setup(() => [running, { awaitAnswer: "never" }]);
    const proposed = await o.propose({ projectId: project.id, title: "Compare rate limiter libraries", kind: "research", size: "S" });
    await o.approve({ taskId: proposed.id });
    await waitFor(() => o.get(proposed.id).runs[0]?.state === "running", 10_000);
    const paused = await o.crew.pauseAll(proposed.id);
    expect(paused.runIds).toHaveLength(1);
    await waitFor(() => o.get(proposed.id).runs[0]?.state === "paused", 10_000);
    expect((await o.crew.pauseAll(proposed.id)).runIds).toEqual([]);
    const resumed = await o.crew.resumeAll(proposed.id);
    expect(resumed.runIds).toEqual(paused.runIds);
    await o.cancel(proposed.id);
  }, 30_000);
});
